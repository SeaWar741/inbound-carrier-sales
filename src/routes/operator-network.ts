import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  carrierRelationships,
  operatorDemandCarriersQuery,
  operatorDemandCarriersResponse,
  operatorDemandQuery,
  operatorDemandResponse,
  operatorNetworkQuery,
  operatorNetworkResponse,
  operatorWallUnavailableResponse,
  type DemandCarrier,
  type DemandLane,
  type NetworkCarrier,
  type OperatorDemandCarriersQuery,
  type OperatorDemandQuery,
  type OperatorNetworkQuery,
} from "../contract.ts";
import {
  inboxPageSize,
  openLanesCacheMs,
  openLanesPerEquipment,
  operatorTimeZone,
  segmentNewMaxCalls,
  segmentRecentDays,
  segmentTopMinBookings,
  segmentTopMinRate,
} from "../constants.ts";
import { equipmentTypes } from "../infra/tms/codec.ts";
import type { TmsClient } from "../infra/tms/tms-client.ts";
import { sql, type SqlStatement, type TwinClient } from "../infra/twin-client.ts";
import { carrierKey, containsPattern, windowCondition } from "./operator-inbox.ts";

export type OperatorNetworkDeps = { twin: Pick<TwinClient, "query">; tms: Pick<TmsClient, "queryLoads"> };

// The board's open lanes as `STATE|EQUIPMENT`, one LOAD_QUERY per equipment type. Null when any
// query fails: a partial board would tag growth on some lanes and silently not on others.
export async function openLanes(tms: Pick<TmsClient, "queryLoads">, log: Pick<FastifyBaseLogger, "warn">): Promise<Set<string> | null> {
  try {
    const boards = await Promise.all(
      equipmentTypes.map((equipmentType) => tms.queryLoads({ equipmentType, maxResults: openLanesPerEquipment })),
    );
    // LOAD_QUERY has no status filter, so a full answer may have left open loads out.
    if (boards.some((board) => board.length === openLanesPerEquipment)) log.warn("open lanes may be partial: an equipment type filled the TMS cap");
    return new Set(boards.flat().filter((load) => load.status === "OPEN").map((load) => `${load.origState}|${load.equipmentType}`));
  } catch {
    return null;
  }
}

const views: Record<OperatorNetworkQuery["view"], string> = {
  all: "TRUE",
  new: "f.relationship = 'new'",
  at_risk: "f.relationship = 'at_risk'",
  top: "f.top",
  growth: "f.growth",
};

// One round trip: the page of carriers, the total, and the count per view. Relationship and tags
// read lifetime facts or window facts as the contract says, every threshold interpolated here so
// the TypeScript side never re-decides them. A carrier is listed when it called inside the window, or
// is at risk: going quiet is what puts it there, so the window must not hide it;
// its observed lanes are the lanes of its searches and negotiated loads inside the window. `filtered`
// applies the bar filters, the counts group it by view, and the total and page add the chosen view.
export function networkQuery(params: OperatorNetworkQuery, lanes: ReadonlySet<string> | null): SqlStatement {
  const pairs = [...(lanes ?? [])];
  const pairStates = [...new Set(pairs.map((pair) => pair.slice(0, pair.indexOf("|"))))];
  const recentBound = sql`(now() - ${segmentRecentDays} * interval '1 day')::timestamp`.text;
  const priorBound = sql`(now() - 2 * ${segmentRecentDays} * interval '1 day')::timestamp`.text;

  const filters: string[] = [];
  const laneFilters: string[] = [];
  if (params.equipment.length > 0) laneFilters.push(sql`l.equipment IN (${params.equipment})`.text);
  if (params.origin) laneFilters.push(sql`l.origin_state = ${params.origin}`.text);
  if (laneFilters.length > 0) {
    filters.push(`EXISTS (SELECT 1 FROM lanes l WHERE l.carrier_key = c.carrier_key AND ${laneFilters.join(" AND ")})`);
  }
  if (params.q) {
    const pattern = containsPattern(params.q);
    filters.push(sql`(c.mc_number ILIKE ${pattern} OR c.dot_number ILIKE ${pattern} OR c.carrier_name ILIKE ${pattern})`.text);
  }
  const offset = (params.page - 1) * inboxPageSize;

  const text =
    `WITH keyed AS (
      SELECT c.call_id, c.created_at, c.eligible, c.mc_number, c.dot_number, c.carrier_name,
        ` + carrierKey("c") + ` AS carrier_key,
        ` + windowCondition(params) + ` AS in_window,
        EXISTS (SELECT 1 FROM offers o WHERE o.call_id = c.call_id) AS negotiable,
        (SELECT count(*) FROM holds h WHERE h.call_id = c.call_id AND h.status IN ('booked', 'booked_unconfirmed')) AS booked,
        (SELECT count(*) FROM load_searches ls WHERE ls.call_id = c.call_id) AS searched
      FROM calls c
    ), facts AS (
      SELECT k.carrier_key,
        count(*) AS lifetime_calls,
        sum(k.booked) AS lifetime_bookings,
        max(k.created_at) AS last_call_at,
        count(*) FILTER (WHERE k.created_at >= ` + recentBound + `) AS calls_recent,
        count(*) FILTER (WHERE k.created_at >= ` + priorBound + ` AND k.created_at < ` + recentBound + `) AS calls_prior,
        count(*) FILTER (WHERE k.in_window) AS calls,
        count(*) FILTER (WHERE k.in_window AND k.negotiable) AS negotiable_calls,
        COALESCE(sum(k.booked) FILTER (WHERE k.in_window), 0) AS bookings,
        COALESCE(sum(k.searched) FILTER (WHERE k.in_window), 0) AS searches,
        (array_agg(k.eligible ORDER BY k.created_at DESC, k.call_id DESC))[1] AS eligible,
        (array_agg(k.mc_number ORDER BY k.created_at DESC) FILTER (WHERE k.mc_number IS NOT NULL))[1] AS mc_number,
        (array_agg(k.dot_number ORDER BY k.created_at DESC) FILTER (WHERE k.dot_number IS NOT NULL))[1] AS dot_number,
        (array_agg(k.carrier_name ORDER BY k.created_at DESC) FILTER (WHERE k.carrier_name IS NOT NULL))[1] AS carrier_name
      FROM keyed k GROUP BY k.carrier_key
    ), negotiated AS (
      SELECT k.carrier_key, count(DISTINCT o.load_id) AS loads_negotiated
      FROM keyed k JOIN offers o ON o.call_id = k.call_id WHERE k.in_window GROUP BY k.carrier_key
    ), lanes AS (
      -- A lane is open when the board has an open load from its origin state on its equipment; a search
      -- without equipment asked for any, so it matches the state on every open equipment.
      SELECT r.*, COALESCE((r.origin_state || '|' || r.equipment) IN (` + sql`${pairs}`.text + `)
        OR (r.equipment IS NULL AND r.origin_state IN (` + sql`${pairStates}`.text + `)), FALSE) AS open
      FROM (
        SELECT k.carrier_key, k.call_id, ls.origin_state, ls.destination_state, ls.equipment
        FROM keyed k JOIN load_searches ls ON ls.call_id = k.call_id WHERE k.in_window
        UNION ALL
        -- One lane per negotiated load on a call, however many rounds it took. Offers made before the
        -- lane was stored have none; unlike a search, their NULL equipment does not mean any.
        SELECT DISTINCT ON (o.call_id, o.load_id) k.carrier_key, k.call_id, o.origin_state, o.destination_state, o.equipment
        FROM keyed k JOIN offers o ON o.call_id = k.call_id WHERE k.in_window AND o.equipment IS NOT NULL
      ) r
    ), classified AS (
      SELECT f.*, COALESCE(n.loads_negotiated, 0) AS loads_negotiated,
        CASE
          WHEN f.lifetime_calls < ` + sql`${segmentNewMaxCalls}`.text + ` THEN 'new'
          WHEN f.lifetime_bookings >= 1 AND (f.last_call_at < ` + recentBound + ` OR f.calls_recent * 2 < f.calls_prior) THEN 'at_risk'
          ELSE 'active'
        END AS relationship,
        (f.bookings >= ` + sql`${segmentTopMinBookings}`.text + ` AND f.bookings >= ` + sql`${segmentTopMinRate}`.text + ` * f.negotiable_calls) AS top,
        EXISTS (SELECT 1 FROM lanes l WHERE l.carrier_key = f.carrier_key AND l.open) AS growth
      FROM facts f LEFT JOIN negotiated n ON n.carrier_key = f.carrier_key
    ), filtered AS (
      SELECT c.* FROM classified c
      WHERE (c.calls > 0 OR c.relationship = 'at_risk')
        AND ` + (filters.length > 0 ? filters.join("\n        AND ") : "TRUE") + `
    ), ordered AS (
      SELECT f.*, row_number() OVER (ORDER BY f.last_call_at DESC, f.carrier_key) AS ord
      FROM filtered f WHERE ` + views[params.view] + `
    )
    SELECT (SELECT count(*) FROM ordered) AS total,
      (SELECT count(*) FROM filtered) AS all_count,
      (SELECT count(*) FROM filtered WHERE relationship = 'new') AS new_count,
      (SELECT count(*) FROM filtered WHERE relationship = 'at_risk') AS at_risk_count,
      (SELECT count(*) FROM filtered WHERE top) AS top_count,
      (SELECT count(*) FROM filtered WHERE growth) AS growth_count,
      COALESCE((SELECT json_agg(r ORDER BY r.ord) FROM (
        SELECT p.ord, p.carrier_key, p.mc_number, p.dot_number, p.carrier_name, p.eligible, p.relationship, p.top, p.growth,
          p.lifetime_calls, p.lifetime_bookings, p.last_call_at::timestamptz AS last_call_at, p.calls_recent, p.calls_prior,
          p.calls, p.negotiable_calls, p.bookings, p.searches, p.loads_negotiated, pl.lanes
        FROM ordered p
        LEFT JOIN LATERAL (
          SELECT COALESCE(json_agg(t ORDER BY t.open DESC, t.n DESC, t.origin_state, t.destination_state, t.equipment), '[]'::json) AS lanes
          FROM (
            -- Calls, not rows: a call that searched a lane and negotiated a load on it ran it once.
            -- Open lanes first, so the one behind the growth tag is always among the five.
            SELECT l.origin_state, l.destination_state, l.equipment, count(DISTINCT l.call_id) AS n, bool_or(l.open) AS open
            FROM lanes l WHERE l.carrier_key = p.carrier_key
            GROUP BY l.origin_state, l.destination_state, l.equipment
            ORDER BY open DESC, n DESC, l.origin_state, l.destination_state, l.equipment
            LIMIT 5
          ) t
        ) pl ON TRUE
        WHERE p.ord > ` + sql`${offset}`.text + ` AND p.ord <= ` + sql`${offset + inboxPageSize}`.text + `
      ) r), '[]'::json) AS rows`;
  return { text };
}

const count = z.coerce.number().int();

const networkRow = z.object({
  carrier_key: z.string(),
  mc_number: z.string().nullable(),
  dot_number: z.string().nullable(),
  carrier_name: z.string().nullable(),
  eligible: z.boolean(),
  relationship: z.enum(carrierRelationships),
  top: z.boolean(),
  growth: z.boolean(),
  lifetime_calls: count,
  lifetime_bookings: count,
  last_call_at: z.coerce.date(),
  calls_recent: count,
  calls_prior: count,
  calls: count,
  negotiable_calls: count,
  bookings: count,
  searches: count,
  loads_negotiated: count,
  lanes: z.array(
    z.object({
      origin_state: z.string().nullable(),
      destination_state: z.string().nullable(),
      equipment: z.string().nullable(),
      n: count,
      open: z.boolean(),
    }),
  ),
});
type NetworkRow = z.output<typeof networkRow>;

// Twin returns count(*) as strings and the json column already parsed.
export const networkResult = z.object({
  total: count,
  all_count: count,
  new_count: count,
  at_risk_count: count,
  top_count: count,
  growth_count: count,
  rows: z.array(networkRow),
});

function toNetworkCarrier(row: NetworkRow): NetworkCarrier {
  return {
    key: row.carrier_key,
    mcNumber: row.mc_number,
    dotNumber: row.dot_number,
    carrierName: row.carrier_name,
    eligible: row.eligible,
    relationship: row.relationship,
    top: row.top,
    growth: row.growth,
    facts: {
      lifetimeCalls: row.lifetime_calls,
      lifetimeBookings: row.lifetime_bookings,
      lastCallAt: row.last_call_at.toISOString(),
      callsRecent: row.calls_recent,
      callsPrior: row.calls_prior,
      calls: row.calls,
      negotiableCalls: row.negotiable_calls,
      bookings: row.bookings,
      searches: row.searches,
      loadsNegotiated: row.loads_negotiated,
    },
    lanes: row.lanes.map((lane) => ({
      originState: lane.origin_state,
      destinationState: lane.destination_state,
      equipment: lane.equipment,
      count: lane.n,
      open: lane.open,
    })),
  };
}

// The CTEs up to `asks`: one row per unmet or searched ask in the last 4 desk weeks, this one
// included. Stored timestamps are session-zone wall clock, so the desk week starts are converted
// back to that clock like wallQuery and created_at is compared against them. A search counts once
// on the lane it asked for (NULL destination or equipment means any); an offered load counts once
// per call on its load's lane when that call got no hold on it. Offers made before the lane was
// stored have NULL equipment that means unknown, not any, so they are left out. Asks without an
// origin state (a zip-only search) have no row to land in.
function demandCtes(): string {
  const liveHold = `h.status IN ('held', 'confirming', 'booked', 'booked_unconfirmed')`;
  return (
    sql`WITH bounds AS (
      SELECT date_trunc('week', now() AT TIME ZONE ${operatorTimeZone}) AS week_start
    ), weeks AS (
      SELECT ((b.week_start - interval '21 days') AT TIME ZONE ${operatorTimeZone})::timestamp AS window_start,
        ((b.week_start - interval '7 days') AT TIME ZONE ${operatorTimeZone})::timestamp AS previous_start,
        (b.week_start AT TIME ZONE ${operatorTimeZone})::timestamp AS this_start
      FROM bounds b
    ), offered AS (
      SELECT DISTINCT ON (o.call_id, o.load_id) o.call_id, o.load_id, o.origin_state, o.destination_state, o.equipment, o.created_at
      FROM offers o, weeks w
      WHERE o.created_at >= w.window_start AND o.equipment IS NOT NULL AND o.origin_state IS NOT NULL
      ORDER BY o.call_id, o.load_id, o.created_at DESC
    ), raw_asks AS (
      SELECT ls.call_id, ls.origin_state, ls.destination_state, ls.equipment, ls.created_at,
        1 AS searches, CASE WHEN ls.results = 0 THEN 1 ELSE 0 END AS no_match, 0 AS offered_no_booking
      FROM load_searches ls, weeks w
      WHERE ls.created_at >= w.window_start AND ls.origin_state IS NOT NULL
      UNION ALL
      SELECT o.call_id, o.origin_state, o.destination_state, o.equipment, o.created_at, 0, 0, 1
      FROM offered o
      WHERE NOT EXISTS (SELECT 1 FROM holds h WHERE h.call_id = o.call_id AND h.load_id = o.load_id AND `.text +
    liveHold +
    `)
    ), asks AS (
      SELECT a.*, a.no_match + a.offered_no_booking AS unmet, c.mc_number, c.carrier_name,
        CASE WHEN c.call_id IS NOT NULL THEN ` +
    carrierKey("c") +
    ` END AS carrier_key
      FROM raw_asks a LEFT JOIN calls c ON c.call_id = a.call_id
    )`
  );
}

// One round trip: the page of lanes and the total. Lanes are the asks grouped by
// (origin, destination, equipment); the week columns split the unmet asks by desk week.
export function demandQuery(params: OperatorDemandQuery): SqlStatement {
  const filters: string[] = [];
  if (params.equipment.length > 0) filters.push(sql`g.equipment IN (${params.equipment})`.text);
  if (params.origin) filters.push(sql`g.origin_state = ${params.origin}`.text);
  const offset = (params.page - 1) * inboxPageSize;

  const text =
    demandCtes() +
    `, grouped AS (
      SELECT a.origin_state, a.destination_state, a.equipment,
        sum(a.searches) AS searches, sum(a.no_match) AS no_match, sum(a.offered_no_booking) AS offered_no_booking,
        sum(a.unmet) AS unmet,
        COALESCE(sum(a.unmet) FILTER (WHERE a.created_at >= w.this_start), 0) AS this_week,
        COALESCE(sum(a.unmet) FILTER (WHERE a.created_at >= w.previous_start AND a.created_at < w.this_start), 0) AS previous_week,
        count(DISTINCT a.carrier_key) AS carriers
      FROM asks a, weeks w
      GROUP BY a.origin_state, a.destination_state, a.equipment
    ), ordered AS (
      SELECT g.*, row_number() OVER (
        ORDER BY g.unmet DESC, g.searches DESC, g.origin_state, g.destination_state NULLS LAST, g.equipment NULLS LAST
      ) AS ord
      FROM grouped g
      WHERE ` +
    (filters.length > 0 ? filters.join("\n        AND ") : "TRUE") +
    `
    )
    SELECT (SELECT count(*) FROM ordered) AS total,
      COALESCE((SELECT json_agg(r ORDER BY r.ord) FROM (
        SELECT p.ord, p.origin_state, p.destination_state, p.equipment, p.searches, p.no_match, p.offered_no_booking,
          p.unmet, p.this_week, p.previous_week, p.carriers
        FROM ordered p WHERE p.ord > ` +
    sql`${offset}`.text +
    ` AND p.ord <= ` +
    sql`${offset + inboxPageSize}`.text +
    `
      ) r), '[]'::json) AS rows`;
  return { text };
}

// The carriers behind one radar row, matched exactly: a left out destination or equipment is the
// "Any" row (IS NULL), not a wildcard. Asks without a calls row have no carrier and are skipped.
export function demandCarriersQuery(params: OperatorDemandCarriersQuery): SqlStatement {
  const lane = [
    sql`a.origin_state = ${params.origin}`.text,
    params.destination === undefined ? "a.destination_state IS NULL" : sql`a.destination_state = ${params.destination}`.text,
    params.equipment === undefined ? "a.equipment IS NULL" : sql`a.equipment = ${params.equipment}`.text,
  ];
  const offset = (params.page - 1) * inboxPageSize;

  const text =
    demandCtes() +
    `, grouped AS (
      SELECT a.carrier_key, sum(a.searches + a.offered_no_booking) AS asks,
        (array_agg(a.mc_number ORDER BY a.created_at DESC) FILTER (WHERE a.mc_number IS NOT NULL))[1] AS mc_number,
        (array_agg(a.carrier_name ORDER BY a.created_at DESC) FILTER (WHERE a.carrier_name IS NOT NULL))[1] AS carrier_name
      FROM asks a
      WHERE a.carrier_key IS NOT NULL AND ` +
    lane.join(" AND ") +
    `
      GROUP BY a.carrier_key
    ), ordered AS (
      SELECT g.*, row_number() OVER (ORDER BY g.asks DESC, g.carrier_key) AS ord
      FROM grouped g
    )
    SELECT (SELECT count(*) FROM ordered) AS total,
      COALESCE((SELECT json_agg(r ORDER BY r.ord) FROM (
        SELECT p.ord, p.carrier_key, p.mc_number, p.carrier_name, p.asks
        FROM ordered p WHERE p.ord > ` +
    sql`${offset}`.text +
    ` AND p.ord <= ` +
    sql`${offset + inboxPageSize}`.text +
    `
      ) r), '[]'::json) AS rows`;
  return { text };
}

const demandRow = z.object({
  origin_state: z.string(),
  destination_state: z.string().nullable(),
  equipment: z.string().nullable(),
  searches: count,
  no_match: count,
  offered_no_booking: count,
  unmet: count,
  this_week: count,
  previous_week: count,
  carriers: count,
});

// Twin returns count(*) and sum(int) as strings and the json column already parsed.
export const demandResult = z.object({ total: count, rows: z.array(demandRow) });

const toDemandLane = (row: z.output<typeof demandRow>): DemandLane => ({
  originState: row.origin_state,
  destinationState: row.destination_state,
  equipment: row.equipment,
  searches: row.searches,
  noMatch: row.no_match,
  offeredNoBooking: row.offered_no_booking,
  unmet: row.unmet,
  thisWeek: row.this_week,
  previousWeek: row.previous_week,
  carriers: row.carriers,
});

const demandCarrierRow = z.object({ carrier_key: z.string(), mc_number: z.string().nullable(), carrier_name: z.string().nullable(), asks: count });

export const demandCarriersResult = z.object({ total: count, rows: z.array(demandCarrierRow) });

const toDemandCarrier = (row: z.output<typeof demandCarrierRow>): DemandCarrier => ({
  key: row.carrier_key,
  mcNumber: row.mc_number,
  carrierName: row.carrier_name,
  asks: row.asks,
});

export function operatorNetworkRoutes(deps: OperatorNetworkDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();
    // Only a board that was read is kept; after a TMS failure the next request tries again.
    let board: { lanes: Set<string>; readAt: number } | undefined;

    async function currentLanes(log: FastifyBaseLogger): Promise<Set<string> | null> {
      if (board && Date.now() - board.readAt < openLanesCacheMs) return board.lanes;
      const lanes = await openLanes(deps.tms, log);
      if (lanes) board = { lanes, readAt: Date.now() };
      return lanes;
    }

    app.get(
      "/operator/network",
      { schema: { querystring: operatorNetworkQuery, response: { 200: operatorNetworkResponse, 503: operatorWallUnavailableResponse } } },
      async (request, reply) => {
        const params = request.query;
        const lanes = await currentLanes(request.log);
        if (!lanes) request.log.warn("open lanes unavailable, growth tags skipped");
        try {
          const [row] = await deps.twin.query(networkQuery(params, lanes), networkResult);
          if (!row) throw new Error("network query returned no row");
          return {
            status: "ok" as const,
            rows: row.rows.map(toNetworkCarrier),
            total: row.total,
            page: params.page,
            pageSize: inboxPageSize,
            counts: { all: row.all_count, new: row.new_count, atRisk: row.at_risk_count, top: row.top_count, growth: row.growth_count },
            boardAvailable: lanes !== null,
          };
        } catch (error) {
          request.log.warn({ err: error }, "operator network unavailable");
          return reply.code(503).send({ status: "service_unavailable", message: "The carrier data is unavailable right now. Retry shortly." });
        }
      },
    );

    app.get(
      "/operator/demand",
      { schema: { querystring: operatorDemandQuery, response: { 200: operatorDemandResponse, 503: operatorWallUnavailableResponse } } },
      async (request, reply) => {
        const params = request.query;
        try {
          const [row] = await deps.twin.query(demandQuery(params), demandResult);
          if (!row) throw new Error("demand query returned no row");
          return { status: "ok" as const, rows: row.rows.map(toDemandLane), total: row.total, page: params.page, pageSize: inboxPageSize };
        } catch (error) {
          request.log.warn({ err: error }, "operator demand unavailable");
          return reply.code(503).send({ status: "service_unavailable", message: "The demand data is unavailable right now. Retry shortly." });
        }
      },
    );

    app.get(
      "/operator/demand/carriers",
      {
        schema: {
          querystring: operatorDemandCarriersQuery,
          response: { 200: operatorDemandCarriersResponse, 503: operatorWallUnavailableResponse },
        },
      },
      async (request, reply) => {
        const params = request.query;
        try {
          const [row] = await deps.twin.query(demandCarriersQuery(params), demandCarriersResult);
          if (!row) throw new Error("demand carriers query returned no row");
          return { status: "ok" as const, rows: row.rows.map(toDemandCarrier), total: row.total, page: params.page, pageSize: inboxPageSize };
        } catch (error) {
          request.log.warn({ err: error }, "operator demand carriers unavailable");
          return reply.code(503).send({ status: "service_unavailable", message: "The demand data is unavailable right now. Retry shortly." });
        }
      },
    );
  };
}
