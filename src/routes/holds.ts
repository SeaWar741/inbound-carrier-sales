import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  confirmHoldHeaders,
  confirmHoldParams,
  confirmHoldResponse,
  createHoldBody,
  createHoldResponse,
  idempotencyConflictResponse,
  releaseHoldBody,
  releaseHoldResponse,
  type ConfirmHoldResponse,
  type CreateHoldResponse,
  type ReleaseHoldResponse,
} from "../contract.ts";
import { resolveBooking, type BookingAttempt } from "../domain/holds.ts";
import { dollars } from "../domain/negotiation.ts";
import type { BookingRequest } from "../infra/tms/codec.ts";
import { TmsBusinessError, TmsUnavailableError } from "../infra/tms/errors.ts";
import type { TmsClient } from "../infra/tms/tms-client.ts";
import { sql, TwinError, type TwinClient } from "../infra/twin-client.ts";
import { holdRowSchema, type HoldRow } from "../infra/twin-schemas.ts";
import { invalidRequestHandler } from "../plugins/invalid-request.ts";

export type HoldRouteDeps = { tms: Pick<TmsClient, "getLoad">; twin: Pick<TwinClient, "query"> };
export type ConfirmHoldRouteDeps = { tms: Pick<TmsClient, "bookLoad">; twin: Pick<TwinClient, "query"> };
export type ReleaseHoldRouteDeps = { twin: Pick<TwinClient, "query"> };

const isUniqueViolation = (error: unknown) => error instanceof TwinError && error.isUniqueViolation;

const createMessages = {
  notVerified: "I need to verify your carrier before I can hold a load.",
  noAgreement: "I can't hold the load at that rate. Let's go over the rate once more.",
  mcRequired: "I need your MC number before I can hold a load for you.",
  loadUnavailable: "I'm sorry, that load is no longer available.",
  loadOnHold: "I'm sorry, another carrier is already holding that load.",
  tmsUnavailable: "I can't reach our load board right now. Please give me a moment and try again.",
  serviceUnavailable: "I'm having trouble on my end right now. Please give me a moment and try again.",
  invalid: "I need the load number and the agreed rate in whole dollars to hold it.",
} as const;

const noHold = (status: Exclude<CreateHoldResponse["status"], "ok">, message: string): CreateHoldResponse => ({
  status,
  message,
  holdId: null,
  holdStatus: null,
});

// Never promises the booking: only the operator's confirm books the load.
const holdPlaced = (hold: HoldRow): CreateHoldResponse => ({
  status: "ok",
  message: `That load is on hold for you at ${dollars(hold.agreedRate)}. A senior rep will review it and get back to you shortly to confirm.`,
  holdId: hold.holdId,
  holdStatus: hold.status,
});

const agreementRow = z.object({ verified: z.boolean(), mc_number: z.string().nullable(), agreed: z.boolean() });

export function holdRoutes(deps: HoldRouteDeps): FastifyPluginAsync {
  const activeHold = async (loadId: string): Promise<HoldRow | undefined> => {
    const [hold] = await deps.twin.query(sql`SELECT * FROM holds WHERE load_id = ${loadId} AND status <> 'released'`, holdRowSchema);
    return hold;
  };

  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler(invalidRequestHandler(() => noHold("invalid_request", createMessages.invalid)));

    app.post("/holds", { schema: { body: createHoldBody, response: { 200: createHoldResponse } } }, async (request) => {
      const { callId, loadId, agreedRate } = request.body;
      // The same call asking again gets its hold back; any other call is refused.
      const existingOutcome = (hold: HoldRow) =>
        hold.callId === callId ? holdPlaced(hold) : noHold("load_on_hold", createMessages.loadOnHold);
      try {
        // Only a rate the negotiation itself accepted can be held; the agent cannot invent one.
        const [call] = await deps.twin.query(
          sql`SELECT c.verified, c.mc_number,
                EXISTS (SELECT 1 FROM offers o WHERE o.call_id = c.call_id AND o.load_id = ${loadId}
                  AND o.decision = 'accept' AND o.rate_to_say = ${agreedRate}) AS agreed
              FROM calls c WHERE c.call_id = ${callId}`,
          agreementRow,
        );
        if (call?.verified !== true) return noHold("not_verified", createMessages.notVerified);
        if (!call.agreed) return noHold("no_agreement", createMessages.noAgreement);
        if (call.mc_number === null) return noHold("mc_number_required", createMessages.mcRequired);

        const existing = await activeHold(loadId);
        if (existing) return existingOutcome(existing);

        const load = await deps.tms.getLoad(loadId);
        if (load.status !== "OPEN") return noHold("load_unavailable", createMessages.loadUnavailable);
        if (agreedRate > load.maxBuy) return noHold("no_agreement", createMessages.noAgreement);

        try {
          const [hold] = await deps.twin.query(
            sql`INSERT INTO holds (call_id, load_id, mc_number, agreed_rate, posted_rate, max_buy)
                VALUES (${callId}, ${loadId}, ${call.mc_number}, ${agreedRate}, ${load.rate}, ${load.maxBuy}) RETURNING *`,
            holdRowSchema,
          );
          if (!hold) throw new Error("hold insert returned no row");
          return holdPlaced(hold);
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // Another request won the race for this load between our read and our insert.
          const winner = await activeHold(loadId);
          if (!winner) throw error;
          return existingOutcome(winner);
        }
      } catch (error) {
        request.log.warn({ err: error }, "hold unavailable");
        if (error instanceof TmsBusinessError) return noHold("load_unavailable", createMessages.loadUnavailable);
        if (error instanceof TmsUnavailableError) return noHold("tms_unavailable", createMessages.tmsUnavailable);
        return noHold("service_unavailable", createMessages.serviceUnavailable);
      }
    });
  };
}

const confirmMessages = {
  invalid: "Send a hold id and an Idempotency-Key header of 1 to 128 characters.",
  notFound: "No hold with that id.",
  noMcNumber: "This hold has no MC number and cannot be booked.",
  conflict: "This Idempotency-Key was already used to confirm a different hold.",
  inProgress: "A confirmation for this hold is already in progress.",
  tmsUnavailable: "The TMS did not answer and nothing was booked. The hold is still in place; retry the confirm.",
  unconfirmed: "The TMS may have booked this load but did not confirm it. Check the load in the TMS before acting.",
  serviceUnavailable: "The hold service is unavailable right now. Retry with the same Idempotency-Key.",
} as const;

const noResult = (
  status: Exclude<ConfirmHoldResponse["status"], "booked" | "booked_unconfirmed" | "released">,
  message: string,
  holdId: string | null = null,
): ConfirmHoldResponse => ({ status, message, holdId, holdStatus: null, bookingRef: null, reason: null });

// The hold fields shared by the confirm and release responses.
const holdFields = (hold: HoldRow) => ({
  holdId: hold.holdId,
  holdStatus: hold.status,
  bookingRef: hold.bookingRef,
  reason: hold.releaseReason,
});

// Built from the stored row alone, so a replay returns exactly what the first confirm returned.
function resultFor(hold: HoldRow): ConfirmHoldResponse {
  const base = holdFields(hold);
  switch (hold.status) {
    case "booked":
      return { ...base, status: "booked", message: `Booked in the TMS. Reference ${hold.bookingRef ?? "unknown"}.` };
    case "booked_unconfirmed":
      return { ...base, status: "booked_unconfirmed", message: confirmMessages.unconfirmed };
    case "released":
      return { ...base, status: "released", message: `Not booked (${hold.releaseReason ?? "unknown"}). The hold is released.` };
    case "confirming":
      return { ...base, status: "in_progress", message: confirmMessages.inProgress };
    case "held":
      return { ...base, status: "tms_unavailable", message: confirmMessages.tmsUnavailable };
  }
}

const alreadyProcessed = (hold: HoldRow): ConfirmHoldResponse => {
  const stored = resultFor(hold);
  return { ...stored, status: "already_processed", message: `Already processed. ${stored.message}` };
};

async function attemptBooking(
  tms: ConfirmHoldRouteDeps["tms"],
  booking: BookingRequest,
  log: { warn: (details: object, message: string) => void },
): Promise<BookingAttempt> {
  try {
    const confirmation = await tms.bookLoad(booking);
    return { outcome: "booked", bookingRef: confirmation.bookingRef };
  } catch (error) {
    if (error instanceof TmsBusinessError) {
      log.warn({ err: error }, "load booking rejected");
      return { outcome: "rejected", code: error.code, ambiguous: error.ambiguous };
    }
    if (error instanceof TmsUnavailableError) {
      log.warn({ err: error }, "load booking unavailable");
      return { outcome: "unavailable", ambiguous: error.ambiguous };
    }
    throw error;
  }
}

export function confirmHoldRoutes(deps: ConfirmHoldRouteDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler(invalidRequestHandler(() => noResult("invalid_request", confirmMessages.invalid)));

    app.post(
      "/holds/:holdId/confirm",
      {
        schema: {
          params: confirmHoldParams,
          headers: confirmHoldHeaders,
          response: { 200: confirmHoldResponse, 409: idempotencyConflictResponse },
        },
      },
      async (request, reply) => {
        const { holdId } = request.params;
        const key = request.headers["idempotency-key"];
        const conflict = () => reply.code(409).send({ status: "conflict", message: confirmMessages.conflict });
        try {
          const rows = await deps.twin.query(
            sql`SELECT * FROM holds WHERE hold_id = ${holdId} OR idempotency_key = ${key}`,
            holdRowSchema,
          );
          if (rows.some((row) => row.idempotencyKey === key && row.holdId !== holdId)) return conflict();
          const hold = rows.find((row) => row.holdId === holdId);
          if (!hold) return noResult("not_found", confirmMessages.notFound, holdId);
          if (hold.status !== "held") return hold.idempotencyKey === key ? resultFor(hold) : alreadyProcessed(hold);
          if (hold.mcNumber === null) return noResult("invalid_request", confirmMessages.noMcNumber, holdId);

          // Only the request whose UPDATE flips 'held' to 'confirming' may call LOAD_BOOK.
          let claimed: HoldRow | undefined;
          try {
            [claimed] = await deps.twin.query(
              sql`UPDATE holds SET status = 'confirming', idempotency_key = ${key}, updated_at = now()
                  WHERE hold_id = ${holdId} AND status = 'held' RETURNING *`,
              holdRowSchema,
            );
          } catch (error) {
            if (isUniqueViolation(error)) return conflict();
            throw error;
          }
          if (!claimed) {
            const [current] = await deps.twin.query(sql`SELECT * FROM holds WHERE hold_id = ${holdId}`, holdRowSchema);
            if (!current) return noResult("not_found", confirmMessages.notFound, holdId);
            return current.idempotencyKey === key ? resultFor(current) : alreadyProcessed(current);
          }

          const attempt = await attemptBooking(
            deps.tms,
            { loadId: claimed.loadId, mcNumber: hold.mcNumber, agreedRate: claimed.agreedRate },
            request.log,
          );
          const resolution = resolveBooking(attempt);
          // Going back to 'held' clears the key so the operator can retry with any key.
          const [resolved] = await deps.twin.query(
            sql`UPDATE holds SET status = ${resolution.status}, booking_ref = ${resolution.bookingRef},
                  release_reason = ${resolution.reason}, idempotency_key = ${resolution.status === "held" ? null : key},
                  updated_at = now()
                WHERE hold_id = ${holdId} AND status = 'confirming' RETURNING *`,
            holdRowSchema,
          );
          if (!resolved) throw new Error("hold left 'confirming' before the booking outcome was stored");
          return resultFor(resolved);
        } catch (error) {
          // A hold left in 'confirming' is never booked twice; an operator checks it by hand.
          request.log.warn({ err: error, holdId }, "hold confirm unavailable");
          return noResult("service_unavailable", confirmMessages.serviceUnavailable, holdId);
        }
      },
    );
  };
}

const releaseMessages = {
  invalid: "Send a hold id and, optionally, a reason of 1 to 200 characters.",
  notFound: "No hold with that id.",
  serviceUnavailable: "The hold service is unavailable right now. Retry the release.",
} as const;

const notReleased = (
  status: Exclude<ReleaseHoldResponse["status"], "released" | "not_releasable">,
  message: string,
  holdId: string | null = null,
): ReleaseHoldResponse => ({ status, message, holdId, holdStatus: null, bookingRef: null, reason: null });

// Only a hold still in 'held' is released; one being booked or already booked is left alone.
export function releaseHoldRoutes(deps: ReleaseHoldRouteDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler(invalidRequestHandler(() => notReleased("invalid_request", releaseMessages.invalid)));

    app.post(
      "/holds/:holdId/release",
      { schema: { params: confirmHoldParams, body: releaseHoldBody, response: { 200: releaseHoldResponse } } },
      async (request) => {
        const { holdId } = request.params;
        const { reason } = request.body;
        try {
          const [released] = await deps.twin.query(
            sql`UPDATE holds SET status = 'released', release_reason = ${reason}, updated_at = now()
                WHERE hold_id = ${holdId} AND status = 'held' RETURNING *`,
            holdRowSchema,
          );
          if (released) {
            return {
              ...holdFields(released),
              status: "released" as const,
              message: `Hold released (${reason}). The load is free for other calls.`,
            };
          }
          const [current] = await deps.twin.query(sql`SELECT * FROM holds WHERE hold_id = ${holdId}`, holdRowSchema);
          if (!current) return notReleased("not_found", releaseMessages.notFound, holdId);
          return {
            ...holdFields(current),
            status: "not_releasable" as const,
            message: `This hold is ${current.status} and cannot be released.`,
          };
        } catch (error) {
          request.log.warn({ err: error, holdId }, "hold release unavailable");
          return notReleased("service_unavailable", releaseMessages.serviceUnavailable, holdId);
        }
      },
    );
  };
}
