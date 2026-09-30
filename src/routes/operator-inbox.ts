import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  carrierStages,
  type CarrierStage,
  operatorCarrierCallsParams,
  operatorCarrierCallsQuery,
  operatorCarrierCallsResponse,
  operatorCarriersQuery,
  operatorCarriersResponse,
  operatorLoadsResponse,
  operatorWallUnavailableResponse,
  type OperatorCarrier,
  type OperatorCarrierCallsQuery,
  type OperatorCarriersQuery,
  type OperatorLoad,
} from "../contract.ts";
import { carrierCallsLimit, dashboardLoadsLimit, inboxPageSize, operatorTimeZone } from "../constants.ts";
import { tripProgress, tripSql, tripStatuses } from "../domain/trip.ts";
import { sql, type SqlStatement, type TwinClient } from "../infra/twin-client.ts";
import { callRow, laneOf, toWallCall, wallCallColumns } from "./operator.ts";

export type OperatorInboxDeps = { twin: Pick<TwinClient, "query"> };

// Booked holds with the lane of their load's latest offer that has one; holds whose load never had
// a lane stored are skipped, which also keeps tripSql away from null pickups. The window keeps
// trips that arrived in the last day and pickups up to a week out, capped at dashboardLoadsLimit.
export function loadsQuery(): SqlStatement {
  const text = sql`WITH lane AS (
      SELECT DISTINCT ON (h.hold_id) h.hold_id, h.load_id, h.call_id, h.agreed_rate,
        COALESCE(h.mc_number, c.mc_number) AS mc_number, c.carrier_name,
        o.origin_city, o.origin_state, o.origin_zip, o.destination_city, o.destination_state, o.destination_zip,
        o.equipment, o.miles, o.pickup_at
      FROM holds h
      JOIN offers o ON o.load_id = h.load_id
      LEFT JOIN calls c ON c.call_id = h.call_id
      WHERE h.status IN ('booked', 'booked_unconfirmed')
        AND o.origin_city IS NOT NULL AND o.origin_state IS NOT NULL AND o.origin_zip IS NOT NULL
        AND o.destination_city IS NOT NULL AND o.destination_state IS NOT NULL AND o.destination_zip IS NOT NULL
        AND o.equipment IS NOT NULL AND o.miles IS NOT NULL AND o.pickup_at IS NOT NULL
      ORDER BY h.hold_id, o.created_at DESC
    )
    SELECT lane.*, trip.pickup_ts, trip.eta_ts, trip.trip_status
    FROM lane `.text + tripSql.text + sql`
    WHERE trip.eta_ts >= now() - interval '24 hours' AND trip.pickup_ts <= now() + interval '7 days'
    ORDER BY trip.pickup_ts
    LIMIT ${dashboardLoadsLimit}`.text;
  return { text };
}

// Twin returns int8 as strings and timestamptz as ISO strings with an offset.
export const loadRow = z.object({
  hold_id: z.string(),
  load_id: z.string(),
  call_id: z.string(),
  agreed_rate: z.coerce.number(),
  mc_number: z.string().nullable(),
  carrier_name: z.string().nullable(),
  origin_city: z.string(),
  origin_state: z.string(),
  origin_zip: z.string(),
  destination_city: z.string(),
  destination_state: z.string(),
  destination_zip: z.string(),
  equipment: z.string(),
  miles: z.coerce.number().int(),
  pickup_at: z.string(),
  pickup_ts: z.coerce.date(),
  eta_ts: z.coerce.date(),
  trip_status: z.enum(tripStatuses),
});
type LoadRow = z.output<typeof loadRow>;

function toOperatorLoad(row: LoadRow, now: Date): OperatorLoad | null {
  const lane = laneOf(row);
  if (!lane) return null;
  return {
    holdId: row.hold_id,
    loadId: row.load_id,
    callId: row.call_id,
    mcNumber: row.mc_number,
    carrierName: row.carrier_name,
    agreedRate: row.agreed_rate,
    lane,
    pickupAt: row.pickup_ts.toISOString(),
    etaAt: row.eta_ts.toISOString(),
    status: row.trip_status,
    progress: tripProgress(row.pickup_ts, row.eta_ts, now),
  };
}

// A carrier's key from a calls row: tagged so an MC, a DOT and a call id with equal digits never merge.
const carrierKey = (alias: "c" | "t") =>
  `COALESCE('mc:' || ${alias}.mc_number, 'dot:' || ${alias}.dot_number, 'call:' || ${alias}.call_id)`;

const sinceBounds: Record<OperatorCarriersQuery["since"], SqlStatement> = {
  // The desk's calendar day, converted back to the stored session-zone clock like wallQuery.
  today: sql`(date_trunc('day', now() AT TIME ZONE ${operatorTimeZone}) AT TIME ZONE ${operatorTimeZone})::timestamp`,
  "7d": sql`(now() - interval '7 days')::timestamp`,
  "30d": sql`(now() - interval '30 days')::timestamp`,
};

// The window the carrier queries read, from the query's day range or else its `since` preset.
export type InboxWindow = Pick<OperatorCarriersQuery, "since" | "from" | "to">;

// Midnight at the start of a desk calendar day, on the stored session-zone clock like `today`.
const deskDayStart = (day: string, plusDays: number) =>
  sql`((${day}::date + ${plusDays})::timestamp AT TIME ZONE ${operatorTimeZone})::timestamp`.text;

// The `created_at` condition of the window: a picked range runs from the start of `from` to the
// start of the day after `to`, so both days are whole.
function windowCondition(inboxWindow: InboxWindow): string {
  if (inboxWindow.from !== undefined && inboxWindow.to !== undefined) {
    return `c.created_at >= ` + deskDayStart(inboxWindow.from, 0) + ` AND c.created_at < ` + deskDayStart(inboxWindow.to, 1);
  }
  return `c.created_at >= ` + sinceBounds[inboxWindow.since].text;
}

// Every key ends with the carrier key so equal values page in a stable order.
const sortOrders: Record<OperatorCarriersQuery["sort"], string> = {
  priority: "f.tab_rank, f.last_activity_at DESC, f.carrier_key",
  recent: "f.last_activity_at DESC, f.carrier_key",
  rate: "COALESCE(f.agreed_rate, f.latest_ask) DESC NULLS LAST, f.carrier_key",
  pickup: "CASE f.trip_status WHEN 'upcoming' THEN f.pickup_ts WHEN 'in_transit' THEN f.eta_ts END ASC NULLS LAST, f.carrier_key",
};

// LIKE wildcards in the search box are literal characters.
const containsPattern = (q: string) => `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;

// The CTEs up to `staged`: one row per carrier with its stage. A carrier is every call sharing
// carrierKey inside the window (`since` or the day range), narrowed to one carrier when `key` is given. needs_approval
// comes from an open hold on any of those calls, negotiating and live from its latest call, and
// booked, in_transit and arrived from its latest booked hold across all those calls.
function stagedCtes(inboxWindow: InboxWindow, live: string[], key?: string): string {
  const latestLive = live.length > 0 ? sql`k.latest_call_id IN (${live})`.text : "FALSE";
  const keyFilter = key === undefined ? "" : ` AND ` + carrierKey("c") + sql` = ${key}`.text;
  return (
    `WITH scoped AS (
      SELECT c.*, ` + carrierKey("c") + ` AS carrier_key
      FROM calls c WHERE ` + windowCondition(inboxWindow) + keyFilter + `
    ), grouped AS (
      SELECT s.carrier_key, count(*) AS calls_count, max(s.created_at) AS last_call_at,
        (array_agg(s.call_id ORDER BY s.created_at DESC, s.call_id DESC))[1] AS latest_call_id,
        (array_agg(s.mc_number ORDER BY s.created_at DESC) FILTER (WHERE s.mc_number IS NOT NULL))[1] AS mc_number,
        (array_agg(s.dot_number ORDER BY s.created_at DESC) FILTER (WHERE s.dot_number IS NOT NULL))[1] AS dot_number,
        (array_agg(s.carrier_name ORDER BY s.created_at DESC) FILTER (WHERE s.carrier_name IS NOT NULL))[1] AS carrier_name
      FROM scoped s GROUP BY s.carrier_key
    ), carriers AS (
      SELECT k.*, ` + latestLive + ` AS latest_live FROM grouped k
    ), offer_stats AS (
      SELECT s.carrier_key, count(DISTINCT o.load_id) AS loads_count, max(o.created_at) AS last_offer_at,
        (array_agg(o.carrier_ask ORDER BY o.created_at DESC))[1] AS latest_ask
      FROM scoped s JOIN offers o ON o.call_id = s.call_id GROUP BY s.carrier_key
    ), event_stats AS (
      SELECT s.carrier_key, max(e.created_at) AS last_event_at
      FROM scoped s JOIN call_events e ON e.call_id = s.call_id GROUP BY s.carrier_key
    ), hold_stats AS (
      SELECT s.carrier_key, max(h.updated_at) AS last_hold_at
      FROM scoped s JOIN holds h ON h.call_id = s.call_id GROUP BY s.carrier_key
    ), booked AS (
      SELECT DISTINCT ON (s.carrier_key) s.carrier_key, h.agreed_rate, lo.pickup_at, lo.miles
      FROM scoped s JOIN holds h ON h.call_id = s.call_id
      LEFT JOIN LATERAL (
        SELECT o.pickup_at, o.miles FROM offers o
        WHERE o.load_id = h.load_id AND o.pickup_at IS NOT NULL AND o.miles IS NOT NULL
        ORDER BY o.created_at DESC LIMIT 1
      ) lo ON TRUE
      WHERE h.status IN ('booked', 'booked_unconfirmed')
      ORDER BY s.carrier_key, h.created_at DESC
    ), booked_trip AS (
      SELECT lane.carrier_key, lane.agreed_rate, trip.pickup_ts, trip.eta_ts, trip.trip_status
      FROM booked lane ` + tripSql.text + `
    ), staged AS (
      SELECT k.*, COALESCE(os.loads_count, 0) AS loads_count, os.latest_ask,
        GREATEST(k.last_call_at, os.last_offer_at, es.last_event_at, hs.last_hold_at) AS last_activity_at,
        bt.carrier_key IS NOT NULL AS has_booking, bt.agreed_rate, bt.pickup_ts, bt.eta_ts, bt.trip_status,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM scoped s JOIN holds h ON h.call_id = s.call_id
            WHERE s.carrier_key = k.carrier_key AND h.status IN ('held', 'confirming')
          ) THEN 'needs_approval'
          WHEN k.latest_live AND EXISTS (SELECT 1 FROM offers o WHERE o.call_id = k.latest_call_id) THEN 'negotiating'
          WHEN k.latest_live THEN 'live'
          WHEN bt.trip_status = 'in_transit' THEN 'in_transit'
          WHEN bt.trip_status = 'arrived' THEN 'arrived'
          WHEN bt.carrier_key IS NOT NULL THEN 'booked'
          ELSE 'lost'
        END AS carrier_stage,
        k.latest_live AND EXISTS (
          SELECT 1 FROM call_events e WHERE e.call_id = k.latest_call_id AND e.tool = 'request_human'
        ) AS needs_human
      FROM carriers k
      LEFT JOIN offer_stats os ON os.carrier_key = k.carrier_key
      LEFT JOIN event_stats es ON es.carrier_key = k.carrier_key
      LEFT JOIN hold_stats hs ON hs.carrier_key = k.carrier_key
      LEFT JOIN booked_trip bt ON bt.carrier_key = k.carrier_key
    )`
  );
}

// A carrier row's columns from a `staged` row aliased `p`, as carrierRow parses them.
const carrierColumns =
  `p.carrier_key, p.mc_number, p.dot_number, p.carrier_name, p.calls_count, p.loads_count,
          p.last_activity_at::timestamptz AS last_activity_at, p.carrier_stage, p.needs_human,
          p.has_booking, p.pickup_ts, p.eta_ts, p.trip_status,
          (SELECT row_to_json(w) FROM (SELECT ` + wallCallColumns.text + `
            FROM calls t WHERE t.call_id = p.latest_call_id) w) AS latest_call`;

// One round trip: the page of carriers, the total, and the counts per tab and per stage. `filtered`
// applies the bar filters (equipment, lane, search; the window is in the CTEs); the counts group it
// by tab and by stage, and the total and page add the rail's tab and stage, so a count never
// shrinks because another rail row is selected.
export function carriersQuery(params: OperatorCarriersQuery): SqlStatement {
  const filters: string[] = [];
  const laneFilters: string[] = [];
  if (params.equipment.length > 0) laneFilters.push(sql`o.equipment IN (${params.equipment})`.text);
  if (params.origin) laneFilters.push(sql`o.origin_state = ${params.origin}`.text);
  if (params.destination) laneFilters.push(sql`o.destination_state = ${params.destination}`.text);
  if (laneFilters.length > 0) {
    filters.push(`EXISTS (SELECT 1 FROM scoped s JOIN offers o ON o.call_id = s.call_id
        WHERE s.carrier_key = st.carrier_key AND ${laneFilters.join(" AND ")})`);
  }
  if (params.q) {
    const pattern = containsPattern(params.q);
    filters.push(sql`EXISTS (SELECT 1 FROM scoped s WHERE s.carrier_key = st.carrier_key AND (
        s.mc_number ILIKE ${pattern} OR s.dot_number ILIKE ${pattern} OR s.carrier_name ILIKE ${pattern}
        OR EXISTS (SELECT 1 FROM offers o WHERE o.call_id = s.call_id AND o.load_id ILIKE ${pattern})))`.text);
  }
  const railFilters: string[] = [];
  if (params.tab !== "all") railFilters.push(sql`f.tab = ${params.tab}`.text);
  if (params.stage.length > 0) railFilters.push(sql`f.carrier_stage IN (${params.stage})`.text);
  const railFilter = railFilters.length > 0 ? railFilters.join(" AND ") : "TRUE";
  const offset = (params.page - 1) * inboxPageSize;

  const text =
    stagedCtes(params, params.live) + `, tabbed AS (
      SELECT st.*, CASE
          WHEN st.carrier_stage = 'needs_approval' OR st.needs_human THEN 'needs_you'
          WHEN st.carrier_stage IN ('live', 'negotiating') THEN 'live'
          WHEN st.carrier_stage IN ('booked', 'in_transit') THEN 'active'
          ELSE 'closed'
        END AS tab
      FROM staged st
    ), filtered AS (
      SELECT st.*, CASE st.tab WHEN 'needs_you' THEN 1 WHEN 'live' THEN 2 WHEN 'active' THEN 3 ELSE 4 END AS tab_rank
      FROM tabbed st
      WHERE ` + (filters.length > 0 ? filters.join("\n        AND ") : "TRUE") + `
    ), ordered AS (
      SELECT f.*, row_number() OVER (ORDER BY ` + sortOrders[params.sort] + `) AS ord
      FROM filtered f WHERE ` + railFilter + `
    )
    SELECT (SELECT count(*) FROM ordered) AS total,
      (SELECT count(*) FROM filtered WHERE tab = 'needs_you') AS needs_you,
      (SELECT count(*) FROM filtered WHERE tab = 'live') AS live,
      (SELECT count(*) FROM filtered WHERE tab = 'active') AS active,
      (SELECT count(*) FROM filtered WHERE tab = 'closed') AS closed,
      COALESCE((SELECT json_object_agg(g.carrier_stage, g.n) FROM (
        SELECT carrier_stage, count(*) AS n FROM filtered GROUP BY carrier_stage
      ) g), '{}'::json) AS stage_counts,
      COALESCE((SELECT json_agg(r ORDER BY r.ord) FROM (
        SELECT p.ord, ` + carrierColumns + `
        FROM ordered p WHERE p.ord > ` + sql`${offset}`.text + ` AND p.ord <= ` + sql`${offset + inboxPageSize}`.text + `
      ) r), '[]'::json) AS rows`;
  return { text };
}

const count = z.coerce.number().int();

const carrierRow = z.object({
  carrier_key: z.string(),
  mc_number: z.string().nullable(),
  dot_number: z.string().nullable(),
  carrier_name: z.string().nullable(),
  calls_count: count,
  loads_count: count,
  last_activity_at: z.coerce.date(),
  carrier_stage: z.enum(carrierStages),
  needs_human: z.boolean(),
  has_booking: z.boolean(),
  pickup_ts: z.coerce.date().nullable(),
  eta_ts: z.coerce.date().nullable(),
  trip_status: z.enum(tripStatuses).nullable(),
  latest_call: callRow,
});
type CarrierRow = z.output<typeof carrierRow>;

// Twin returns count(*) as strings and the json column already parsed.
export const carriersRow = z.object({
  total: count,
  needs_you: count,
  live: count,
  active: count,
  closed: count,
  // Only stages with a carrier appear; the rest are zero.
  stage_counts: z.partialRecord(z.enum(carrierStages), count),
  rows: z.array(carrierRow),
});

function toOperatorCarrier(row: CarrierRow): OperatorCarrier {
  return {
    key: row.carrier_key,
    mcNumber: row.mc_number,
    dotNumber: row.dot_number,
    carrierName: row.carrier_name,
    callsCount: row.calls_count,
    loadsCount: row.loads_count,
    lastActivityAt: row.last_activity_at.toISOString(),
    carrierStage: row.carrier_stage,
    needsHuman: row.needs_human,
    nextTrip: row.has_booking
      ? { pickupAt: row.pickup_ts?.toISOString() ?? null, etaAt: row.eta_ts?.toISOString() ?? null, status: row.trip_status }
      : null,
    latestCall: toWallCall(row.latest_call),
  };
}

// One carrier's list row, the same columns and stage the list computes, for the detail header.
export function carrierSummaryQuery(key: string, params: OperatorCarrierCallsQuery): SqlStatement {
  return { text: stagedCtes(params, params.live, key) + `
    SELECT ` + carrierColumns + `
    FROM staged p` };
}

// The carrier's latest calls, newest first, with the same columns the wall reads.
export function carrierCallsQuery(key: string): SqlStatement {
  const text =
    `SELECT ` + wallCallColumns.text + `
    FROM calls t WHERE ` + carrierKey("t") + sql` = ${key}
    ORDER BY t.created_at DESC, t.call_id DESC
    LIMIT ${carrierCallsLimit}`.text;
  return { text };
}

export function operatorInboxRoutes(deps: OperatorInboxDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.get(
      "/operator/loads",
      { schema: { response: { 200: operatorLoadsResponse, 503: operatorWallUnavailableResponse } } },
      async (request, reply) => {
        try {
          const rows = await deps.twin.query(loadsQuery(), loadRow);
          const now = new Date();
          return { status: "ok" as const, loads: rows.flatMap((row) => toOperatorLoad(row, now) ?? []) };
        } catch (error) {
          request.log.warn({ err: error }, "operator loads unavailable");
          return reply.code(503).send({ status: "service_unavailable", message: "The load data is unavailable right now. Retry shortly." });
        }
      },
    );

    app.get(
      "/operator/carriers",
      { schema: { querystring: operatorCarriersQuery, response: { 200: operatorCarriersResponse, 503: operatorWallUnavailableResponse } } },
      async (request, reply) => {
        const params = request.query;
        try {
          const [row] = await deps.twin.query(carriersQuery(params), carriersRow);
          if (!row) throw new Error("carriers query returned no row");
          return {
            status: "ok" as const,
            rows: row.rows.map(toOperatorCarrier),
            total: row.total,
            page: params.page,
            pageSize: inboxPageSize,
            counts: { needsYou: row.needs_you, live: row.live, active: row.active, closed: row.closed },
            stageCounts: Object.fromEntries(carrierStages.map((stage) => [stage, row.stage_counts[stage] ?? 0])) as Record<CarrierStage, number>,
          };
        } catch (error) {
          request.log.warn({ err: error }, "operator carriers unavailable");
          return reply.code(503).send({ status: "service_unavailable", message: "The carrier data is unavailable right now. Retry shortly." });
        }
      },
    );

    app.get(
      "/operator/carriers/:key/calls",
      {
        schema: {
          params: operatorCarrierCallsParams,
          querystring: operatorCarrierCallsQuery,
          response: { 200: operatorCarrierCallsResponse, 503: operatorWallUnavailableResponse },
        },
      },
      async (request, reply) => {
        const { key } = request.params;
        try {
          const [rows, [summary]] = await Promise.all([
            deps.twin.query(carrierCallsQuery(key), callRow),
            deps.twin.query(carrierSummaryQuery(key, request.query), carrierRow),
          ]);
          return { status: "ok" as const, calls: rows.map(toWallCall), carrier: summary ? toOperatorCarrier(summary) : null };
        } catch (error) {
          request.log.warn({ err: error }, "operator carrier calls unavailable");
          return reply.code(503).send({ status: "service_unavailable", message: "The call data is unavailable right now. Retry shortly." });
        }
      },
    );
  };
}
