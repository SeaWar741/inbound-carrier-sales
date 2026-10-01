import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import { hasZodFastifySchemaValidationErrors, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  notifyCapacityBody,
  notifyCapacityParams,
  notifyCapacityResponse,
  operatorCapacityResponse,
  operatorWallUnavailableResponse,
  saveCapacityBody,
  saveCapacityResponse,
  type NotifyCapacityResponse,
  type OperatorCapacityResponse,
  type SaveCapacityResponse,
} from "../contract.ts";
import { capacityTrucksShown, capacityWindowDays, openLanesCacheMs, operatorTimeZone } from "../constants.ts";
import { dollars } from "../domain/negotiation.ts";
import { tmsWallClockToDate } from "../domain/trip.ts";
import type { CarrierMessage, OtpDeliveryClient } from "../infra/otp-delivery-client.ts";
import type { LoadSummary } from "../infra/tms/codec.ts";
import { TmsBusinessError } from "../infra/tms/errors.ts";
import type { TmsClient } from "../infra/tms/tms-client.ts";
import { sql, type TwinClient } from "../infra/twin-client.ts";
import { invalidRequestHandler } from "../plugins/invalid-request.ts";
import { openBoard } from "./operator-network.ts";

export type CapacityRouteDeps = { twin: Pick<TwinClient, "query"> };

// Carrier-facing and never a promise: a saved truck only means we may send a load later.
const saveMessages = {
  saved: "Got it, your truck is on file. If a load opens up near there we'll send you the details.",
  notVerified: "I need to verify your carrier before I can keep your truck on file.",
  noConsent: "No problem, I won't keep your truck on file.",
  pastDate: "That date has already passed. When does the truck free up?",
  invalid: "I need the city, the state and the day your truck frees up to keep it on file.",
  serviceUnavailable: "I'm having trouble on my end right now. Please give me a moment and try again.",
} as const;

const reply = (status: SaveCapacityResponse["status"], message: string): SaveCapacityResponse => ({ status, message });

// The desk's calendar day as YYYY-MM-DD; en-CA formats dates in that order.
export const deskToday = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: operatorTimeZone }).format(now);

const callRow = z.object({ verified: z.boolean(), mc_number: z.string().nullable() });

export function capacityRoutes(deps: CapacityRouteDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler(invalidRequestHandler(() => reply("invalid_request", saveMessages.invalid)));

    app.post("/capacity", { schema: { body: saveCapacityBody, response: { 200: saveCapacityResponse } } }, async (request) => {
      const { callId, city, state, freeDate, equipmentType, preferredDestinationState, consent } = request.body;
      try {
        const [call] = await deps.twin.query(sql`SELECT verified, mc_number FROM calls WHERE call_id = ${callId}`, callRow);
        if (call?.verified !== true || call.mc_number === null) return reply("not_verified", saveMessages.notVerified);
        if (!consent) return reply("no_consent", saveMessages.noConsent);
        // ISO dates compare as strings.
        if (freeDate < deskToday(new Date())) return reply("invalid_request", saveMessages.pastDate);

        // A second save on the same call corrects the truck; a load already sent for it stays recorded.
        await deps.twin.query(
          sql`INSERT INTO truck_capacity (call_id, mc_number, city, state, equipment, free_date, preferred_destination_state)
              VALUES (${callId}, ${call.mc_number}, ${city}, ${state}, ${equipmentType ?? null}, ${freeDate}, ${preferredDestinationState ?? null})
              ON CONFLICT (call_id) DO UPDATE SET city = EXCLUDED.city, state = EXCLUDED.state, equipment = EXCLUDED.equipment,
                free_date = EXCLUDED.free_date, preferred_destination_state = EXCLUDED.preferred_destination_state`,
          z.unknown(),
        );
        return reply("ok", saveMessages.saved);
      } catch (error) {
        request.log.warn({ err: error }, "capacity not saved");
        return reply("service_unavailable", saveMessages.serviceUnavailable);
      }
    });
  };
}

export type OperatorCapacityRouteDeps = {
  twin: Pick<TwinClient, "query">;
  tms: Pick<TmsClient, "queryLoads" | "getLoad">;
  delivery: Pick<OtpDeliveryClient, "send">;
};

type TruckFit = { state: string; equipment: string | null; freeDate: string };
type LoadFit = Pick<LoadSummary, "origState" | "equipmentType" | "pickupDateTime">;

// YYYY-MM-DD plus whole days, on the calendar alone.
const addDays = (isoDate: string, days: number) => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// A load fits a truck that frees up in its origin state with its equipment (or any), picking up from
// the free date through capacityWindowDays after. The preferred destination only ranks, never filters.
export function fitsTruck(truck: TruckFit, load: LoadFit): boolean {
  if (truck.equipment !== null && truck.equipment !== load.equipmentType) return false;
  if (load.origState !== truck.state) return false;
  const pickupDay = load.pickupDateTime.slice(0, 8);
  const first = truck.freeDate.replaceAll("-", "");
  const last = addDays(truck.freeDate, capacityWindowDays).replaceAll("-", "");
  return pickupDay >= first && pickupDay <= last;
}

// The TMS wall clock is desk time, so it is shown in the desk's zone: "Oct 3, 8:00 AM".
const deskPickup = (wire: string) =>
  tmsWallClockToDate(wire).toLocaleString("en-US", {
    timeZone: operatorTimeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const deskDay = (at: Date) => at.toLocaleDateString("en-US", { timeZone: operatorTimeZone, month: "short", day: "numeric" });

type NoticeLoad = Pick<
  LoadSummary,
  "loadId" | "origCity" | "origState" | "destCity" | "destState" | "equipmentType" | "pickupDateTime" | "rate"
>;

// The carrier asked for this on the call, so it reminds them when. Only the posted rate is quoted:
// the fields are picked one by one so the max buy can never reach the message.
export function capacityNotice(load: NoticeLoad, capturedOn: Date): CarrierMessage {
  const { loadId, origCity, origState, destCity, destState, equipmentType, pickupDateTime, rate } = load;
  const origin = `${origCity}, ${origState}`;
  const equipment = equipmentType.toLowerCase().replaceAll("_", " ");
  return {
    subject: `Load ${loadId} near ${origin}`,
    body:
      `HappyRobot Logistics: on ${deskDay(capturedOn)} you asked us to keep your truck on file. ` +
      `Load ${loadId}, ${origin} to ${destCity}, ${destState}, ${equipment}, pickup ${deskPickup(pickupDateTime)}, ` +
      `posted ${dollars(rate)}. Call us back and mention load ${loadId}.`,
  };
}

const noticeChannel = z.enum(["email", "sms"]).nullable();

const activeTruckRow = z.object({
  id: z.string(),
  mc_number: z.string(),
  carrier_name: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  equipment: z.string().nullable(),
  free_date: z.string(),
  preferred_destination_state: z.string().nullable(),
  notice_channel: noticeChannel,
  notified_load_id: z.string().nullable(),
  notified_at: z.coerce.date().nullable(),
});

const notifyTruckRow = z.object({
  state: z.string(),
  equipment: z.string().nullable(),
  free_date: z.string(),
  notified_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
  otp_channel: noticeChannel,
  otp_destination: z.string().nullable(),
});

const notifyMessages = {
  invalid: "Send a truck id and a load id.",
  notFound: "No saved truck with that id.",
  sent: "The carrier was sent the load.",
  alreadyNotified: "This carrier was already sent a load for this truck.",
  loadUnavailable: "That load is no longer open or does not fit this truck.",
  noContact: "This carrier has no verified email or phone to send the load to.",
  failed: "The load was not sent. Retry shortly.",
  sendUncertain: "The notice may not have gone out. Check with the carrier before contacting them again.",
} as const;

const notified = (status: NotifyCapacityResponse["status"], message: string): NotifyCapacityResponse => ({ status, message });

type CapacityTruck = OperatorCapacityResponse["trucks"][number];

const toCapacityLoad = (load: LoadSummary, preferredState: string | null): NonNullable<CapacityTruck["loads"]>[number] => ({
  loadId: load.loadId,
  origin: `${load.origCity}, ${load.origState}`,
  destination: `${load.destCity}, ${load.destState}`,
  pickupDateTime: deskPickup(load.pickupDateTime),
  equipmentType: load.equipmentType,
  loadboardRate: load.rate,
  miles: load.miles,
  preferred: preferredState !== null && load.destState === preferredState,
});

export function operatorCapacityRoutes(deps: OperatorCapacityRouteDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();
    // The same board read as the Demand page's open lanes: one LOAD_QUERY per equipment type, shared by
    // every truck. Only a read that answered is kept; after a TMS failure the next request tries again.
    let board: { loads: LoadSummary[]; readAt: number } | undefined;

    async function currentBoard(log: FastifyBaseLogger): Promise<LoadSummary[] | null> {
      if (board && Date.now() - board.readAt < openLanesCacheMs) return board.loads;
      try {
        const loads = await openBoard(deps.tms, log);
        board = { loads, readAt: Date.now() };
        return loads;
      } catch (error) {
        log.warn({ err: error }, "capacity board unavailable");
        return null;
      }
    }

    // The operator's screen, not the voice agent, reads these, so a bad request is a plain 400.
    app.setErrorHandler((error, _request, reply) => {
      if (hasZodFastifySchemaValidationErrors(error)) return reply.code(400).send({ status: "invalid_request", message: notifyMessages.invalid });
      throw error;
    });

    app.get(
      "/operator/capacity",
      { schema: { response: { 200: operatorCapacityResponse, 503: operatorWallUnavailableResponse } } },
      async (request, reply) => {
        try {
          const trucks = await deps.twin.query(
            sql`SELECT tc.id, tc.mc_number, c.carrier_name, tc.city, tc.state, tc.equipment,
                  to_char(tc.free_date, 'YYYY-MM-DD') AS free_date, tc.preferred_destination_state,
                  CASE WHEN c.otp_destination IS NOT NULL THEN c.otp_channel END AS notice_channel,
                  tc.notified_load_id, tc.notified_at::timestamptz AS notified_at
                FROM truck_capacity tc LEFT JOIN calls c ON c.call_id = tc.call_id
                WHERE tc.free_date + ${capacityWindowDays} >= (now() AT TIME ZONE ${operatorTimeZone})::date
                ORDER BY tc.created_at DESC LIMIT ${capacityTrucksShown}`,
            activeTruckRow,
          );
          const loadsOnBoard = trucks.length === 0 ? [] : await currentBoard(request.log);

          // Without a board every truck shows no loads at all rather than an empty list. Pickups on days
          // already past in the desk's zone are skipped.
          const today = deskToday(new Date()).replaceAll("-", "");
          const fits = trucks.map((truck) => {
            if (loadsOnBoard === null) return null;
            const truckFit = { state: truck.state, equipment: truck.equipment, freeDate: truck.free_date };
            return loadsOnBoard.filter((load) => load.pickupDateTime.slice(0, 8) >= today && fitsTruck(truckFit, load));
          });

          const loadIds = [...new Set(fits.flatMap((loads) => (loads ?? []).map((load) => load.loadId)))];
          const held =
            loadIds.length === 0
              ? new Set<string>()
              : new Set(
                  (
                    await deps.twin.query(
                      sql`SELECT load_id FROM holds WHERE load_id IN (${loadIds}) AND status <> 'released'`,
                      z.object({ load_id: z.string() }),
                    )
                  ).map((row) => row.load_id),
                );

          const response: OperatorCapacityResponse = {
            status: "ok",
            trucks: trucks.map((truck, i) => {
              return {
                id: truck.id,
                mcNumber: truck.mc_number,
                carrierName: truck.carrier_name,
                city: truck.city,
                state: truck.state,
                equipment: truck.equipment,
                freeDate: truck.free_date,
                preferredDestinationState: truck.preferred_destination_state,
                noticeChannel: truck.notice_channel,
                notifiedLoadId: truck.notified_load_id,
                notifiedAt: truck.notified_at?.toISOString() ?? null,
                loads:
                  fits[i]
                    ?.filter((load) => !held.has(load.loadId))
                    .map((load) => toCapacityLoad(load, truck.preferred_destination_state))
                    .sort((a, b) => Number(b.preferred) - Number(a.preferred)) ?? null,
              };
            }),
          };
          return response;
        } catch (error) {
          request.log.warn({ err: error }, "operator capacity unavailable");
          return reply.code(503).send({ status: "service_unavailable", message: "The capacity data is unavailable right now. Retry shortly." });
        }
      },
    );

    // Sends one open load to a saved truck's carrier, once: only the request whose UPDATE claims the
    // truck sends. A send that throws keeps the claim, since the notice may already be on its way.
    app.post(
      "/operator/capacity/:id/notify",
      {
        schema: {
          params: notifyCapacityParams,
          body: notifyCapacityBody,
          response: {
            200: notifyCapacityResponse,
            400: z.object({ status: z.literal("invalid_request"), message: z.string() }),
            404: z.object({ status: z.literal("not_found"), message: z.string() }),
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params;
        const { loadId } = request.body;
        try {
          const [truck] = await deps.twin.query(
            sql`SELECT tc.state, tc.equipment, to_char(tc.free_date, 'YYYY-MM-DD') AS free_date,
                  tc.notified_at::timestamptz AS notified_at, tc.created_at::timestamptz AS created_at,
                  c.otp_channel, c.otp_destination
                FROM truck_capacity tc LEFT JOIN calls c ON c.call_id = tc.call_id
                WHERE tc.id = ${id}`,
            notifyTruckRow,
          );
          if (!truck) return reply.code(404).send({ status: "not_found", message: notifyMessages.notFound });
          if (!truck.otp_channel || !truck.otp_destination) return notified("no_contact", notifyMessages.noContact);
          if (truck.notified_at !== null) return notified("already_notified", notifyMessages.alreadyNotified);

          let load;
          try {
            load = await deps.tms.getLoad(loadId);
          } catch (error) {
            request.log.warn({ err: error, loadId }, "capacity load unavailable");
            if (error instanceof TmsBusinessError) return notified("load_unavailable", notifyMessages.loadUnavailable);
            return notified("failed", notifyMessages.failed);
          }
          const truckFit = { state: truck.state, equipment: truck.equipment, freeDate: truck.free_date };
          if (load.status !== "OPEN" || !fitsTruck(truckFit, load)) return notified("load_unavailable", notifyMessages.loadUnavailable);

          const [claimed] = await deps.twin.query(
            sql`UPDATE truck_capacity SET notified_load_id = ${load.loadId}, notified_at = now()
                WHERE id = ${id} AND notified_at IS NULL RETURNING id`,
            z.object({ id: z.string() }),
          );
          if (!claimed) return notified("already_notified", notifyMessages.alreadyNotified);

          try {
            await deps.delivery.send(truck.otp_channel, truck.otp_destination, capacityNotice(load, truck.created_at));
          } catch (error) {
            request.log.warn({ err: error, id, loadId }, "capacity notice failed");
            // The send may have started before it threw, so the claim stays: a retry could reach the carrier twice.
            return notified("failed", notifyMessages.sendUncertain);
          }
          return notified("sent", notifyMessages.sent);
        } catch (error) {
          request.log.warn({ err: error, id }, "capacity notice unavailable");
          return notified("failed", notifyMessages.failed);
        }
      },
    );
  };
}
