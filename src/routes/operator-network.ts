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

// A lane the board has open only by origin and equipment is growth when the carrier booked that exact
// lane this many times: a repeat lane, not a one-off.
const growthMinLaneBookings = 2;

// The board's open lanes as `ORIGIN|DESTINATION|EQUIPMENT`, one LOAD_QUERY per equipment type. Null when any
// query fails: a partial board would tag growth on some lanes and silently not on others.
export async function openLanes(tms: Pick<TmsClient, "queryLoads">, log: Pick<FastifyBaseLogger, "warn">): Promise<Set<string> | null> {
  try {
    const boards = await Promise.all(
      equipmentTypes.map((equipmentType) => tms.queryLoads({ equipmentType, maxResults: openLanesPerEquipment })),
    );
    // LOAD_QUERY has no status filter, so a full answer may have left open loads out.
    if (boards.some((board) => board.length === openLanesPerEquipment)) log.warn("open lanes may be partial: an equipment type filled the TMS cap");
    return new Set(boards.flat().filter((load) => load.status === "OPEN").map((load) => `${load.origState}|${load.destState}|${load.equipmentType}`));
  } catch (error) {
    log.warn({ err: error }, "open lanes unavailable, growth tags skipped");
    return null;
  }
}

type SortKey = { column: string; nullable?: boolean };

// The chosen keys in the chosen direction, then the stable tie breakers not already chosen. Columns
// come from the whitelist maps below, never from the request.
function orderBy(keys: readonly SortKey[], dir: "asc" | "desc", ties: readonly string[]): string {
  const direction = dir === "asc" ? "ASC" : "DESC";
  const chosen = keys.map((key) => `${key.column} ${direction}${key.nullable ? " NULLS LAST" : ""}`);
  const rest = ties.filter((tie) => !keys.some((key) => tie.split(" ")[0] === key.column));
  return [...chosen, ...rest].join(", ");
}

// MC numbers are digit strings of different lengths, so they are padded to sort as numbers.
const networkSorts: Record<OperatorNetworkQuery["sort"], readonly SortKey[]> = {
  mc: [{ column: "lpad(f.mc_number, 12, '0')", nullable: true }],
  carrier: [{ column: "f.carrier_name", nullable: true }],
  lastCall: [{ column: "f.last_call_at" }],
  calls: [{ column: "f.calls" }],
  bookings: [{ column: "f.bookings" }],
};
const networkTies = ["f.last_call_at DESC", "f.carrier_key"];

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
// applies the bar filters, the counts and KPIs group it by view, and the total and page add the chosen
// view; the open lane panel reads `listed`, before the filters.
export function networkQuery(params: OperatorNetworkQuery, lanes: ReadonlySet<string> | null): SqlStatement {
  const triples = [...(lanes ?? [])].map((lane) => lane.split("|") as [string, string, string]);
  const unique = (values: string[]) => [...new Set(values)];
  const tripleKeys = triples.map(([origin, destination, equipment]) => `${origin}|${destination}|${equipment}`);
  const pairs = unique(triples.map(([origin, , equipment]) => `${origin}|${equipment}`));
  const routes = unique(triples.map(([origin, destination]) => `${origin}|${destination}`));
  const states = unique(triples.map(([origin]) => origin));
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
  const offset = (params.page - 1) * params.pageSize;

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
    ), booked_lanes AS (
      -- Lifetime bookings per carrier and exact lane; an offer row per round, so holds count once.
      SELECT k.carrier_key, o.origin_state, o.destination_state, o.equipment, count(DISTINCT h.hold_id) AS bookings
      FROM keyed k
      JOIN holds h ON h.call_id = k.call_id AND h.status IN ('booked', 'booked_unconfirmed')
      JOIN offers o ON o.call_id = h.call_id AND o.load_id = h.load_id
      GROUP BY k.carrier_key, o.origin_state, o.destination_state, o.equipment
    ), lanes AS (
      -- A lane is open when the board has an open load on its exact origin, destination and equipment;
      -- a search's NULL destination or equipment asked for any, so only that part matches every value.
      -- It is open too when the board has its origin and equipment and the carrier booked this exact
      -- lane repeatedly: a carrier that keeps running GA to KS on a dry van is worth a call about any GA dry van.
      SELECT r.carrier_key, r.call_id, r.origin_state, r.destination_state, r.equipment, COALESCE(
        (r.origin_state || '|' || r.destination_state || '|' || r.equipment) IN (` + sql`${tripleKeys}`.text + `)
        OR (r.search AND r.destination_state IS NULL AND (r.origin_state || '|' || r.equipment) IN (` + sql`${pairs}`.text + `))
        OR (r.search AND r.equipment IS NULL AND (r.origin_state || '|' || r.destination_state) IN (` + sql`${routes}`.text + `))
        OR (r.search AND r.destination_state IS NULL AND r.equipment IS NULL AND r.origin_state IN (` + sql`${states}`.text + `))
        OR ((r.origin_state || '|' || r.equipment) IN (` + sql`${pairs}`.text + `) AND EXISTS (
          SELECT 1 FROM booked_lanes b WHERE b.carrier_key = r.carrier_key AND b.origin_state = r.origin_state
            AND b.destination_state = r.destination_state AND b.equipment = r.equipment
            AND b.bookings >= ` + sql`${growthMinLaneBookings}`.text + `)), FALSE) AS open
      FROM (
        SELECT k.carrier_key, k.call_id, ls.origin_state, ls.destination_state, ls.equipment, TRUE AS search
        FROM keyed k JOIN load_searches ls ON ls.call_id = k.call_id WHERE k.in_window
        UNION ALL
        -- One lane per negotiated load on a call, however many rounds it took. Offers made before the
        -- lane was stored have none; unlike a search, their NULL equipment does not mean any.
        SELECT DISTINCT ON (o.call_id, o.load_id) k.carrier_key, k.call_id, o.origin_state, o.destination_state, o.equipment, FALSE
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
    ), listed AS (
      SELECT c.* FROM classified c WHERE c.calls > 0 OR c.relationship = 'at_risk'
    ), filtered AS (
      SELECT c.* FROM listed c
      WHERE ` + (filters.length > 0 ? filters.join("\n        AND ") : "TRUE") + `
    ), ordered AS (
      SELECT f.*, row_number() OVER (ORDER BY ` + orderBy(networkSorts[params.sort], params.dir, networkTies) + `) AS ord
      FROM filtered f WHERE ` + views[params.view] + `
    )
    SELECT (SELECT count(*) FROM ordered) AS total,
      (SELECT count(*) FROM filtered) AS all_count,
      (SELECT count(*) FROM filtered WHERE relationship = 'new') AS new_count,
      (SELECT count(*) FROM filtered WHERE relationship = 'at_risk') AS at_risk_count,
      (SELECT count(*) FROM filtered WHERE top) AS top_count,
      (SELECT count(*) FROM filtered WHERE growth) AS growth_count,
      (SELECT count(*) FROM filtered WHERE calls > 0) AS called_kpi,
      (SELECT COALESCE(sum(bookings), 0) FROM filtered) AS booked_kpi,
      (SELECT COALESCE(sum(loads_negotiated), 0) FROM filtered) AS negotiated_kpi,
      COALESCE((SELECT json_agg(o ORDER BY o.carriers DESC, o.origin_state, o.equipment NULLS LAST) FROM (
        SELECT l.origin_state, l.equipment, count(DISTINCT l.carrier_key) AS carriers
        FROM lanes l JOIN listed c ON c.carrier_key = l.carrier_key
        WHERE l.open GROUP BY l.origin_state, l.equipment
      ) o), '[]'::json) AS open_lanes,
      COALESCE((SELECT json_agg(o ORDER BY o.carriers DESC, o.origin_state) FROM (
        SELECT l.origin_state, count(DISTINCT l.carrier_key) AS carriers
        FROM lanes l JOIN listed c ON c.carrier_key = l.carrier_key
        WHERE l.open GROUP BY l.origin_state
      ) o), '[]'::json) AS open_origins,
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
        WHERE p.ord > ` + sql`${offset}`.text + ` AND p.ord <= ` + sql`${offset + params.pageSize}`.text + `
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
  called_kpi: count,
  booked_kpi: count,
  negotiated_kpi: count,
  open_lanes: z.array(z.object({ origin_state: z.string(), equipment: z.string().nullable(), carriers: count })),
  open_origins: z.array(z.object({ origin_state: z.string(), carriers: count })),
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

const demandSorts: Record<OperatorDemandQuery["sort"], readonly SortKey[]> = {
  lane: [{ column: "g.origin_state" }, { column: "g.destination_state", nullable: true }],
  equipment: [{ column: "g.equipment", nullable: true }],
  unmet: [{ column: "g.unmet" }],
  thisWeek: [{ column: "g.this_week" }],
  carriers: [{ column: "g.carriers" }],
};
const demandTies = ["g.unmet DESC", "g.searches DESC", "g.origin_state", "g.destination_state NULLS LAST", "g.equipment NULLS LAST"];

// One round trip: the page of lanes, the total, the totals and the unmet asks per origin. Lanes are
// the asks grouped by (origin, destination, equipment); the week columns split the unmet asks by desk
// week. The bar filters keep or drop whole rows, so a row's counts are always all of its asks.
export function demandQuery(params: OperatorDemandQuery): SqlStatement {
  const filters: string[] = [];
  if (params.equipment.length > 0) filters.push(sql`g.equipment IN (${params.equipment})`.text);
  if (params.origin) filters.push(sql`g.origin_state = ${params.origin}`.text);
  if (params.q) {
    const pattern = containsPattern(params.q);
    const state = params.q.toUpperCase();
    filters.push(
      sql`(g.origin_state = ${state} OR g.destination_state = ${state} OR EXISTS (
        SELECT 1 FROM asks q WHERE q.origin_state = g.origin_state
          AND q.destination_state IS NOT DISTINCT FROM g.destination_state AND q.equipment IS NOT DISTINCT FROM g.equipment
          AND (q.mc_number ILIKE ${pattern} OR q.carrier_name ILIKE ${pattern})))`.text,
    );
  }
  if (params.next === "source") filters.push("g.no_match > 0");
  if (params.next === "rate") filters.push("g.offered_no_booking > 0");
  const offset = (params.page - 1) * params.pageSize;

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
        ORDER BY ` +
    orderBy(demandSorts[params.sort], params.dir, demandTies) +
    `
      ) AS ord
      FROM grouped g
      WHERE ` +
    (filters.length > 0 ? filters.join("\n        AND ") : "TRUE") +
    `
    )
    SELECT (SELECT count(*) FROM ordered) AS total,
      (SELECT COALESCE(sum(no_match), 0) FROM ordered) AS no_match_total,
      (SELECT COALESCE(sum(offered_no_booking), 0) FROM ordered) AS offered_no_booking_total,
      (SELECT COALESCE(sum(this_week), 0) FROM ordered) AS this_week_total,
      (SELECT COALESCE(sum(previous_week), 0) FROM ordered) AS previous_week_total,
      -- Distinct carriers across the kept rows, not the sum of each row's carriers.
      (SELECT count(DISTINCT a.carrier_key) FROM asks a JOIN ordered g ON g.origin_state = a.origin_state
        AND g.destination_state IS NOT DISTINCT FROM a.destination_state AND g.equipment IS NOT DISTINCT FROM a.equipment) AS carriers_total,
      COALESCE((SELECT json_agg(o ORDER BY o.unmet DESC, o.origin_state) FROM (
        SELECT g.origin_state, sum(g.unmet) AS unmet FROM grouped g GROUP BY g.origin_state
      ) o), '[]'::json) AS origins,
      COALESCE((SELECT json_agg(r ORDER BY r.ord) FROM (
        SELECT p.ord, p.origin_state, p.destination_state, p.equipment, p.searches, p.no_match, p.offered_no_booking,
          p.this_week, p.previous_week, p.carriers
        FROM ordered p WHERE p.ord > ` +
    sql`${offset}`.text +
    ` AND p.ord <= ` +
    sql`${offset + params.pageSize}`.text +
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
  this_week: count,
  previous_week: count,
  carriers: count,
});

// Twin returns count(*) and sum(int) as strings and the json column already parsed.
export const demandResult = z.object({
  total: count,
  no_match_total: count,
  offered_no_booking_total: count,
  carriers_total: count,
  this_week_total: count,
  previous_week_total: count,
  origins: z.array(z.object({ origin_state: z.string(), unmet: count })),
  rows: z.array(demandRow),
});

const toDemandLane = (row: z.output<typeof demandRow>): DemandLane => ({
  originState: row.origin_state,
  destinationState: row.destination_state,
  equipment: row.equipment,
  searches: row.searches,
  noMatch: row.no_match,
  offeredNoBooking: row.offered_no_booking,
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
        try {
          const [row] = await deps.twin.query(networkQuery(params, lanes), networkResult);
          if (!row) throw new Error("network query returned no row");
          return {
            status: "ok" as const,
            rows: row.rows.map(toNetworkCarrier),
            total: row.total,
            page: params.page,
            pageSize: params.pageSize,
            counts: { all: row.all_count, new: row.new_count, atRisk: row.at_risk_count, top: row.top_count, growth: row.growth_count },
            kpis: { called: row.called_kpi, booked: row.booked_kpi, negotiated: row.negotiated_kpi },
            openLanes: row.open_lanes.map((lane) => ({ originState: lane.origin_state, equipment: lane.equipment, carriers: lane.carriers })),
            openOrigins: row.open_origins.map((origin) => ({ originState: origin.origin_state, carriers: origin.carriers })),
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
          return {
            status: "ok" as const,
            rows: row.rows.map(toDemandLane),
            total: row.total,
            page: params.page,
            pageSize: params.pageSize,
            totals: {
              noMatch: row.no_match_total,
              offeredNoBooking: row.offered_no_booking_total,
              carriers: row.carriers_total,
              thisWeek: row.this_week_total,
              previousWeek: row.previous_week_total,
            },
            origins: row.origins.map((origin) => ({ originState: origin.origin_state, unmet: origin.unmet })),
          };
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
