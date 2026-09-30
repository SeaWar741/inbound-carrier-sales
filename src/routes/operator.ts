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
  setAutonomyBody,
  setAutonomyResponse,
  tripSnapshot,
  type OperatorWallResponse,
  type WallCall,
  type WallLane,
} from "../contract.ts";
import { otpMaxAttempts, operatorTimeZone, wallEventsPerCall } from "../constants.ts";
import { assessCall, otpLocked } from "../domain/call-stage.ts";
import type { TmsHealthRecorder } from "../infra/tms/tms-health.ts";
import { sql, type SqlStatement, type TwinClient } from "../infra/twin-client.ts";
import { autonomyModes, holdStatuses } from "../infra/twin-schemas.ts";

export type OperatorRouteDeps = { twin: Pick<TwinClient, "query">; tmsHealth: Pick<TmsHealthRecorder, "snapshot"> };

// What a WallCall needs beyond the calls row, read per call from a row aliased `t`: the latest
// round of each load, the live hold, the last events and every intervention. Nested timestamps
// are cast to timestamptz so the JSON carries an offset. The sql tag cannot nest statements,
// so queries splice this fragment's text between their own tagged parts.
const callColumns = sql`EXISTS (SELECT 1 FROM call_events e WHERE e.call_id = t.call_id AND e.tool = 'request_human') AS human_requested,
        COALESCE((SELECT json_agg(o ORDER BY o.created_at) FROM (
          SELECT DISTINCT ON (load_id) load_id, round, carrier_ask, decision, rate_to_say, posted_rate, max_buy,
            origin_city, origin_state, origin_zip, destination_city, destination_state, destination_zip, equipment, miles, pickup_at,
            created_at::timestamptz AS created_at
          FROM offers WHERE call_id = t.call_id ORDER BY load_id, round DESC
        ) o), '[]'::json) AS offers,
        COALESCE((SELECT json_agg(r ORDER BY r.created_at) FROM (
          SELECT load_id, round, carrier_ask, decision, rate_to_say, created_at::timestamptz AS created_at
          FROM offers WHERE call_id = t.call_id
        ) r), '[]'::json) AS rounds,
        (SELECT row_to_json(h) FROM (
          SELECT hold_id, load_id, status, agreed_rate, posted_rate, max_buy, booking_ref, trip, created_at::timestamptz AS created_at
          FROM holds WHERE call_id = t.call_id ORDER BY (status <> 'released') DESC, created_at DESC LIMIT 1
        ) h) AS hold,
        COALESCE((SELECT json_agg(e ORDER BY e.created_at) FROM (
          SELECT tool, summary, status, created_at::timestamptz AS created_at
          FROM call_events WHERE call_id = t.call_id ORDER BY created_at DESC LIMIT ${wallEventsPerCall}
        ) e), '[]'::json) AS events,
        COALESCE((SELECT json_agg(i ORDER BY i.created_at) FROM (
          SELECT kind, load_id, amount_usd, message, created_at::timestamptz AS created_at
          FROM interventions WHERE call_id = t.call_id
        ) i), '[]'::json) AS interventions`;

// The select list of a WallCall row from a calls row aliased `t`: its own columns, then callColumns.
export const wallCallColumns: SqlStatement = {
  text: sql`t.call_id, t.mc_number, t.dot_number, t.eligible, t.verified, t.otp_attempts,
        t.otp_expires_at::timestamptz AS otp_expires_at, t.created_at::timestamptz AS created_at,
        `.text + callColumns.text,
};

// Stored timestamps are session-zone wall clock; bounds are converted back to that clock so the
// created_at comparison stays index-friendly. The day's counters come back in a single row.
export function wallQuery(): SqlStatement {
  const text = sql`WITH bounds AS (
      SELECT date_trunc('day', now() AT TIME ZONE ${operatorTimeZone}) AS local_start
    ), today AS (
      SELECT c.* FROM calls c, bounds b
      WHERE c.created_at >= (b.local_start AT TIME ZONE ${operatorTimeZone})::timestamp
        AND c.created_at < ((b.local_start + interval '1 day') AT TIME ZONE ${operatorTimeZone})::timestamp
    ), today_holds AS (
      SELECT h.* FROM holds h JOIN today t ON t.call_id = h.call_id
      WHERE h.status IN ('booked', 'booked_unconfirmed')
    )
    SELECT to_char((SELECT local_start FROM bounds), 'YYYY-MM-DD') AS day,
      (SELECT count(*) FROM today) AS calls_count,
      (SELECT count(*) FROM today_holds) AS booked_count,
      (SELECT count(*) FROM today WHERE NOT eligible OR (NOT verified AND otp_attempts >= ${otpMaxAttempts})) AS blocked,
      (SELECT COALESCE(sum(agreed_rate), 0) FROM today_holds) AS dollars_generated,
      (SELECT COALESCE(sum(max_buy - agreed_rate), 0) FROM today_holds) AS margin_saved,
      COALESCE((SELECT value FROM settings WHERE key = 'autonomy'), 'human') AS autonomy`.text;
  return { text };
}

// Twin returns int8 and numeric as strings, and json columns already parsed.
const count = z.coerce.number().int();
const money = z.coerce.number();
const optionalMoney = z.coerce.number().nullable();
const optionalText = z.string().nullish();
const timestamp = z.coerce.date();

const offerRow = z.object({
  load_id: z.string(),
  round: count,
  carrier_ask: money,
  decision: z.enum(["accept", "counter", "reject"]),
  rate_to_say: optionalMoney,
  posted_rate: optionalMoney,
  max_buy: optionalMoney,
  origin_city: optionalText,
  origin_state: optionalText,
  origin_zip: optionalText,
  destination_city: optionalText,
  destination_state: optionalText,
  destination_zip: optionalText,
  equipment: optionalText,
  miles: count.nullish(),
  pickup_at: optionalText,
  created_at: timestamp,
});
type OfferRow = z.output<typeof offerRow>;

type LaneColumns = Pick<
  OfferRow,
  "origin_city" | "origin_state" | "origin_zip" | "destination_city" | "destination_state" | "destination_zip" | "equipment" | "miles" | "pickup_at"
>;

// Offers stored before lanes were kept have no lane columns set.
export function laneOf(o: LaneColumns): WallLane | null {
  const { origin_city, origin_state, origin_zip, destination_city, destination_state, destination_zip, equipment, miles, pickup_at } = o;
  if (!origin_city || !origin_state || !origin_zip || !destination_city || !destination_state || !destination_zip) return null;
  if (!equipment || miles == null || !pickup_at) return null;
  return {
    origin: { city: origin_city, state: origin_state, zip: origin_zip },
    destination: { city: destination_city, state: destination_state, zip: destination_zip },
    equipment,
    miles,
    pickupAt: pickup_at,
  };
}

// Every round of every load on the call, so the tower can tell how the negotiation went.
const roundRow = offerRow.pick({ load_id: true, round: true, carrier_ask: true, decision: true, rate_to_say: true, created_at: true });

const holdRow = z.object({
  hold_id: z.string(),
  load_id: z.string(),
  status: z.enum(holdStatuses),
  agreed_rate: money,
  posted_rate: optionalMoney,
  max_buy: optionalMoney,
  booking_ref: z.string().nullable(),
  // Holds placed before trip estimates, or without one, store none.
  trip: tripSnapshot.nullable(),
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

export const callRow = z.object({
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
  // Older fixtures and rows without the column read as no rounds.
  rounds: z.array(roundRow).default([]),
  hold: holdRow.nullable(),
  events: z.array(eventRow),
  interventions: z.array(interventionRow),
});
type CallRow = z.output<typeof callRow>;

export const wallRow = z.object({
  day: z.string(),
  calls_count: count,
  booked_count: count,
  blocked: count,
  dollars_generated: money,
  margin_saved: money,
  autonomy: z.enum(autonomyModes),
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
  // The offers are already the latest round per load of this call, so the hold's lane comes from its load's row.
  const holdOffer = row.hold && row.offers.find((o) => o.load_id === row.hold?.load_id);
  const holdLane = holdOffer ? laneOf(holdOffer) : null;
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
      lane: laneOf(o),
      createdAt: o.created_at.toISOString(),
    })),
    rounds: row.rounds.map((r) => ({
      loadId: r.load_id,
      round: r.round,
      carrierAsk: r.carrier_ask,
      decision: r.decision,
      rateToSay: r.rate_to_say,
      createdAt: r.created_at.toISOString(),
    })),
    hold: row.hold && {
      holdId: row.hold.hold_id,
      loadId: row.hold.load_id,
      status: row.hold.status,
      agreedRate: row.hold.agreed_rate,
      postedRate: row.hold.posted_rate,
      maxBuy: row.hold.max_buy,
      bookingRef: row.hold.booking_ref,
      lane: holdLane,
      trip: row.hold.trip,
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
              blocked: row.blocked,
              dollarsGenerated: row.dollars_generated,
              marginSaved: row.margin_saved,
            },
            tmsHealth: deps.tmsHealth.snapshot(),
            autonomy: row.autonomy,
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

    // One switch for every new call: in autonomous mode create_hold books without a rep.
    app.put(
      "/operator/settings/autonomy",
      { schema: { body: setAutonomyBody, response: { 200: setAutonomyResponse, 503: operatorWallUnavailableResponse } } },
      async (request, reply) => {
        const { mode } = request.body;
        try {
          await deps.twin.query(
            sql`INSERT INTO settings (key, value) VALUES ('autonomy', ${mode})
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            z.unknown(),
          );
          request.log.info({ mode }, "autonomy mode changed");
          return { status: "ok" as const, mode };
        } catch (error) {
          request.log.warn({ err: error }, "autonomy mode not saved");
          return reply.code(503).send({ status: "service_unavailable", message: "The mode was not saved. Retry shortly." });
        }
      },
    );
  };
}
