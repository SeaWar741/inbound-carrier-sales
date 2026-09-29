import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createInterventionBody,
  createInterventionParams,
  createInterventionResponse,
  interventionKinds,
  operatorWallResponse,
  operatorWallUnavailableResponse,
  type OperatorWallResponse,
  type WallCall,
} from "../contract.ts";
import { otpMaxAttempts, operatorTimeZone, wallEventsPerCall } from "../constants.ts";
import { assessCall, otpLocked } from "../domain/call-stage.ts";
import type { TmsHealthRecorder } from "../infra/tms/tms-health.ts";
import { sql, type SqlStatement, type TwinClient } from "../infra/twin-client.ts";
import { holdStatuses } from "../infra/twin-schemas.ts";

export type OperatorRouteDeps = { twin: Pick<TwinClient, "query">; tmsHealth: Pick<TmsHealthRecorder, "snapshot"> };

// Stored timestamps are session-zone wall clock; bounds are converted back to that clock so the
// created_at comparison stays index-friendly. Nested timestamps are cast to timestamptz so the
// JSON carries an offset. The wall and its counters come back in a single row.
export function wallQuery(): SqlStatement {
  return sql`WITH bounds AS (
      SELECT date_trunc('day', now() AT TIME ZONE ${operatorTimeZone}) AS local_start
    ), today AS (
      SELECT c.* FROM calls c, bounds b
      WHERE c.created_at >= (b.local_start AT TIME ZONE ${operatorTimeZone})::timestamp
        AND c.created_at < ((b.local_start + interval '1 day') AT TIME ZONE ${operatorTimeZone})::timestamp
    ), today_holds AS (
      SELECT h.* FROM holds h JOIN today t ON t.call_id = h.call_id
      WHERE h.status IN ('booked', 'booked_unconfirmed')
    ), wall AS (
      SELECT t.call_id, t.mc_number, t.dot_number, t.eligible, t.verified, t.otp_attempts,
        t.otp_expires_at::timestamptz AS otp_expires_at, t.created_at::timestamptz AS created_at,
        EXISTS (SELECT 1 FROM call_events e WHERE e.call_id = t.call_id AND e.tool = 'request_human') AS human_requested,
        COALESCE((SELECT json_agg(o ORDER BY o.created_at) FROM (
          SELECT DISTINCT ON (load_id) load_id, round, carrier_ask, decision, rate_to_say, posted_rate, max_buy,
            created_at::timestamptz AS created_at
          FROM offers WHERE call_id = t.call_id ORDER BY load_id, round DESC
        ) o), '[]'::json) AS offers,
        (SELECT row_to_json(h) FROM (
          SELECT hold_id, load_id, status, agreed_rate, posted_rate, max_buy, booking_ref, created_at::timestamptz AS created_at
          FROM holds WHERE call_id = t.call_id ORDER BY (status <> 'released') DESC, created_at DESC LIMIT 1
        ) h) AS hold,
        COALESCE((SELECT json_agg(e ORDER BY e.created_at) FROM (
          SELECT tool, summary, status, created_at::timestamptz AS created_at
          FROM call_events WHERE call_id = t.call_id ORDER BY created_at DESC LIMIT ${wallEventsPerCall}
        ) e), '[]'::json) AS events,
        COALESCE((SELECT json_agg(i ORDER BY i.created_at) FROM (
          SELECT kind, load_id, amount_usd, message, created_at::timestamptz AS created_at
          FROM interventions WHERE call_id = t.call_id
        ) i), '[]'::json) AS interventions
      FROM today t
    )
    SELECT to_char((SELECT local_start FROM bounds), 'YYYY-MM-DD') AS day,
      (SELECT count(*) FROM today) AS calls_count,
      (SELECT count(*) FROM today_holds) AS booked_count,
      (SELECT count(*) FROM today WHERE NOT eligible OR (NOT verified AND otp_attempts >= ${otpMaxAttempts})) AS fraud_blocked,
      (SELECT COALESCE(sum(agreed_rate), 0) FROM today_holds) AS dollars_generated,
      (SELECT COALESCE(sum(max_buy - agreed_rate), 0) FROM today_holds) AS margin_saved,
      COALESCE((SELECT json_agg(w ORDER BY w.created_at DESC) FROM wall w), '[]'::json) AS calls`;
}

// Twin returns int8 and numeric as strings, and json columns already parsed.
const count = z.coerce.number().int();
const money = z.coerce.number();
const optionalMoney = z.coerce.number().nullable();
const timestamp = z.coerce.date();

const offerRow = z.object({
  load_id: z.string(),
  round: count,
  carrier_ask: money,
  decision: z.enum(["accept", "counter", "reject"]),
  rate_to_say: optionalMoney,
  posted_rate: optionalMoney,
  max_buy: optionalMoney,
  created_at: timestamp,
});

const holdRow = z.object({
  hold_id: z.string(),
  load_id: z.string(),
  status: z.enum(holdStatuses),
  agreed_rate: money,
  posted_rate: optionalMoney,
  max_buy: optionalMoney,
  booking_ref: z.string().nullable(),
  created_at: timestamp,
});

const eventRow = z.object({
  tool: z.string(),
  summary: z.string().nullable(),
  status: z.string().nullable(),
  created_at: timestamp,
});

const interventionRow = z.object({
  kind: z.enum(interventionKinds),
  load_id: z.string().nullable(),
  amount_usd: count.nullable(),
  message: z.string().nullable(),
  created_at: timestamp,
});

const callRow = z.object({
  call_id: z.string(),
  mc_number: z.string().nullable(),
  dot_number: z.string().nullable(),
  eligible: z.boolean(),
  verified: z.boolean(),
  otp_attempts: count,
  otp_expires_at: timestamp.nullable(),
  created_at: timestamp,
  human_requested: z.boolean(),
  offers: z.array(offerRow),
  hold: holdRow.nullable(),
  events: z.array(eventRow),
  interventions: z.array(interventionRow),
});
type CallRow = z.output<typeof callRow>;

export const wallRow = z.object({
  day: z.string(),
  calls_count: count,
  booked_count: count,
  fraud_blocked: count,
  dollars_generated: money,
  margin_saved: money,
  calls: z.array(callRow),
});
export type WallRow = z.output<typeof wallRow>;

export function toWallCall(row: CallRow): WallCall {
  const assessment = assessCall({
    eligible: row.eligible,
    verified: row.verified,
    otpAttempts: row.otp_attempts,
    humanRequested: row.human_requested,
    offers: row.offers.map((o) => ({ round: o.round, createdAt: o.created_at })),
    hold: row.hold && { status: row.hold.status, createdAt: row.hold.created_at },
    events: row.events,
  });
  return {
    callId: row.call_id,
    mcNumber: row.mc_number,
    dotNumber: row.dot_number,
    eligible: row.eligible,
    verified: row.verified,
    otp: {
      attempts: row.otp_attempts,
      locked: otpLocked({ verified: row.verified, otpAttempts: row.otp_attempts }),
      expiresAt: row.otp_expires_at?.toISOString() ?? null,
    },
    ...assessment,
    offers: row.offers.map((o) => ({
      loadId: o.load_id,
      round: o.round,
      carrierAsk: o.carrier_ask,
      decision: o.decision,
      rateToSay: o.rate_to_say,
      postedRate: o.posted_rate,
      maxBuy: o.max_buy,
      createdAt: o.created_at.toISOString(),
    })),
    hold: row.hold && {
      holdId: row.hold.hold_id,
      loadId: row.hold.load_id,
      status: row.hold.status,
      agreedRate: row.hold.agreed_rate,
      postedRate: row.hold.posted_rate,
      maxBuy: row.hold.max_buy,
      bookingRef: row.hold.booking_ref,
      createdAt: row.hold.created_at.toISOString(),
    },
    events: row.events.map((e) => ({ tool: e.tool, summary: e.summary, status: e.status, createdAt: e.created_at.toISOString() })),
    interventions: row.interventions.map((i) => ({
      kind: i.kind,
      loadId: i.load_id,
      amountUsd: i.amount_usd,
      message: i.message,
      createdAt: i.created_at.toISOString(),
    })),
    createdAt: row.created_at.toISOString(),
  };
}

export function operatorWallRoutes(deps: OperatorRouteDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.get(
      "/operator/wall",
      { schema: { response: { 200: operatorWallResponse, 503: operatorWallUnavailableResponse } } },
      async (request, reply) => {
        try {
          const [row] = await deps.twin.query(wallQuery(), wallRow);
          if (!row) throw new Error("wall query returned no row");
          const wall: OperatorWallResponse = {
            status: "ok",
            day: row.day,
            counters: {
              calls: row.calls_count,
              booked: row.booked_count,
              fraudBlocked: row.fraud_blocked,
              dollarsGenerated: row.dollars_generated,
              marginSaved: row.margin_saved,
            },
            tmsHealth: deps.tmsHealth.snapshot(),
            calls: row.calls.map(toWallCall),
          };
          return wall;
        } catch (error) {
          request.log.warn({ err: error }, "operator wall unavailable");
          return reply.code(503).send({ status: "service_unavailable", message: "The call data is unavailable right now. Retry shortly." });
        }
      },
    );

    // The tower writes an authorization before it sends the whisper, so the agent's next
    // evaluate_offer already includes it. Unknown calls are refused, not recorded.
    app.post(
      "/operator/calls/:callId/interventions",
      {
        schema: {
          params: createInterventionParams,
          body: createInterventionBody,
          response: { 200: createInterventionResponse, 404: z.object({ status: z.literal("not_found"), message: z.string() }), 503: operatorWallUnavailableResponse },
        },
      },
      async (request, reply) => {
        const { callId } = request.params;
        const body = request.body;
        const loadId = body.kind === "authorization" ? body.loadId : null;
        const amountUsd = body.kind === "authorization" ? body.amountUsd : null;
        try {
          const [row] = await deps.twin.query(
            sql`INSERT INTO interventions (call_id, kind, load_id, amount_usd, message)
                SELECT call_id, ${body.kind}, ${loadId}, ${amountUsd}, ${body.message ?? null} FROM calls WHERE call_id = ${callId}
                RETURNING id`,
            z.object({ id: z.uuid() }),
          );
          if (!row) return reply.code(404).send({ status: "not_found", message: "No call with that id." });
          return { status: "recorded" as const, id: row.id };
        } catch (error) {
          request.log.warn({ err: error }, "intervention not recorded");
          return reply.code(503).send({ status: "service_unavailable", message: "The intervention was not recorded. Retry shortly." });
        }
      },
    );
  };
}
