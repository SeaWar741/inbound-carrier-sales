import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  operatorDemandCarriersQuery,
  operatorDemandCarriersResponse,
  operatorDemandQuery,
  operatorDemandResponse,
  operatorNetworkQuery,
  operatorNetworkResponse,
} from "../src/contract.ts";
import type { LoadQueryFilters, LoadSummary } from "../src/infra/tms/codec.ts";
import { TmsUnavailableError } from "../src/infra/tms/errors.ts";
import { TwinError, type SqlStatement } from "../src/infra/twin-client.ts";
import { demandCarriersQuery, demandQuery, networkQuery, operatorNetworkRoutes } from "../src/routes/operator-network.ts";
import { buildServer } from "../src/server.ts";
import { testConfig } from "./test-config.ts";

// Carrier rows as Twin nests them in json. The first booked before and has been silent for weeks
// (at risk) while still booking most of its negotiated calls in the window (top); dates sit far
// from the 14 day boundary so the fixture reads the same on any day.
const atRiskTopRow = {
  ord: 1,
  carrier_key: "mc:123456",
  mc_number: "123456",
  dot_number: "7654321",
  carrier_name: "ACME TRUCKING LLC",
  eligible: true,
  relationship: "at_risk",
  top: true,
  growth: true,
  lifetime_calls: 12,
  lifetime_bookings: 5,
  last_call_at: "2026-08-10T15:00:00+00:00",
  calls_recent: 0,
  calls_prior: 0,
  calls: 4,
  negotiable_calls: 3,
  bookings: 2,
  searches: 6,
  loads_negotiated: 3,
  lanes: [
    { origin_state: "GA", destination_state: "KS", equipment: "DRY_VAN", n: 4, open: true },
    { origin_state: "TX", destination_state: null, equipment: null, n: 1, open: false },
  ],
};

const newRow = {
  ...atRiskTopRow,
  ord: 2,
  carrier_key: "call:call-x",
  mc_number: null,
  dot_number: null,
  carrier_name: null,
  eligible: false,
  relationship: "new",
  top: false,
  growth: false,
  lifetime_calls: 1,
  lifetime_bookings: 0,
  last_call_at: "2026-08-01T15:00:00+00:00",
  calls: 1,
  negotiable_calls: 0,
  bookings: 0,
  searches: 1,
  loads_negotiated: 0,
  lanes: [],
};

// One row: counts as strings (count(*) is int8), the page as parsed json.
const networkRow = {
  total: "2",
  all_count: "2",
  new_count: "1",
  at_risk_count: "1",
  top_count: "1",
  growth_count: "1",
  called_kpi: "2",
  booked_kpi: "2",
  negotiated_kpi: "3",
  open_lanes: [
    { origin_state: "GA", equipment: "DRY_VAN", carriers: "1" },
    { origin_state: "TX", equipment: "REEFER", carriers: "1" },
  ],
  open_origins: [
    { origin_state: "GA", carriers: "1" },
    { origin_state: "TX", carriers: "1" },
  ],
  rows: [atRiskTopRow, newRow],
};

const statements: string[] = [];
let failTwin = false;
// The one row Twin answers; the demand tests swap in their own.
let twinRow: unknown = networkRow;
const twin = {
  query: async <T>(statement: SqlStatement, rowSchema: z.ZodType<T>): Promise<T[]> => {
    statements.push(statement.text);
    if (failTwin) throw new TwinError("connection reset");
    return [rowSchema.parse(twinRow)];
  },
};

const summary = (loadId: string, origState: string, equipmentType: LoadSummary["equipmentType"], status = "OPEN"): LoadSummary => ({
  loadId,
  origCity: "City",
  origState,
  origZip: "00000",
  destCity: "City",
  destState: "KS",
  destZip: "00000",
  pickupDateTime: "20261003141300",
  equipmentType,
  rate: 2000,
  miles: 900,
  status,
});

const board: Partial<Record<LoadSummary["equipmentType"], LoadSummary[]>> = {
  DRY_VAN: [summary("LD1", "GA", "DRY_VAN"), summary("LD2", "OH", "DRY_VAN", "BOOKED")],
  REEFER: [summary("LD3", "TX", "REEFER")],
};
const tms = { queryLoads: vi.fn(async (filters: LoadQueryFilters) => board[filters.equipmentType as LoadSummary["equipmentType"]] ?? []) };

const app = buildServer(testConfig, { agentRoutes: [], operatorRoutes: [operatorNetworkRoutes({ twin, tms })] });
const downTms = { queryLoads: vi.fn(async () => Promise.reject(new TmsUnavailableError("LOAD_QUERY", 3, false, "timeout"))) };
const boardDownApp = buildServer(testConfig, { agentRoutes: [], operatorRoutes: [operatorNetworkRoutes({ twin, tms: downTms })] });
afterAll(() => Promise.all([app.close(), boardDownApp.close()]));

const getNetwork = (query = "", key: string = testConfig.OPERATOR_API_KEY, target = app) =>
  target.inject({ method: "GET", url: `/v1/operator/network${query}`, headers: { "x-api-key": key } });

describe("GET /v1/operator/network", () => {
  it("rejects the agent key", async () => {
    expect((await getNetwork("", testConfig.AGENT_API_KEY)).statusCode).toBe(401);
  });

  it.each([
    ["an unknown view", "?view=lost"],
    ["an unknown since", "?since=1y"],
    ["from without to", "?from=2026-09-01"],
    ["page 0", "?page=0"],
    ["an unknown sort", "?sort=name"],
    ["an unknown dir", "?dir=up"],
    ["a page size off the list", "?pageSize=30"],
    ["a fractional page size", "?pageSize=10.5"],
  ])("rejects %s", async (_, query) => {
    statements.length = 0;
    expect((await getNetwork(query)).statusCode).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it("returns the page, counts and a carrier that is at risk and top at once, from one Twin row", async () => {
    statements.length = 0;
    const res = await getNetwork("?page=1");
    expect(res.statusCode).toBe(200);
    expect(statements).toHaveLength(1);
    const body = operatorNetworkResponse.parse(res.json());
    expect(body).toMatchObject({ status: "ok", total: 2, page: 1, pageSize: 25, boardAvailable: true });
    expect(body.counts).toEqual({ all: 2, new: 1, atRisk: 1, top: 1, growth: 1 });
    expect(body.kpis).toEqual({ called: 2, booked: 2, negotiated: 3 });
    expect(body.openLanes).toEqual([
      { originState: "GA", equipment: "DRY_VAN", carriers: 1 },
      { originState: "TX", equipment: "REEFER", carriers: 1 },
    ]);
    expect(body.openOrigins).toEqual([
      { originState: "GA", carriers: 1 },
      { originState: "TX", carriers: 1 },
    ]);
    expect(body.rows[0]).toEqual({
      key: "mc:123456",
      mcNumber: "123456",
      dotNumber: "7654321",
      carrierName: "ACME TRUCKING LLC",
      eligible: true,
      relationship: "at_risk",
      top: true,
      growth: true,
      facts: {
        lifetimeCalls: 12,
        lifetimeBookings: 5,
        lastCallAt: "2026-08-10T15:00:00.000Z",
        callsRecent: 0,
        callsPrior: 0,
        calls: 4,
        negotiableCalls: 3,
        bookings: 2,
        searches: 6,
        loadsNegotiated: 3,
      },
      lanes: [
        { originState: "GA", destinationState: "KS", equipment: "DRY_VAN", count: 4, open: true },
        { originState: "TX", destinationState: null, equipment: null, count: 1, open: false },
      ],
    });
    expect(body.rows[1]).toMatchObject({ key: "call:call-x", relationship: "new", top: false, lanes: [] });
  });

  it("decides the relationship in SQL, first match new then at_risk then active, and top apart from it", () => {
    const text = networkQuery(operatorNetworkQuery.parse({}), new Set()).text;
    const relationship = text.slice(text.indexOf("CASE"), text.indexOf("END AS relationship"));
    const newAt = relationship.indexOf("THEN 'new'");
    const atRiskAt = relationship.indexOf("THEN 'at_risk'");
    const activeAt = relationship.indexOf("ELSE 'active'");
    expect(newAt).toBeGreaterThan(-1);
    expect(atRiskAt).toBeGreaterThan(newAt);
    expect(activeAt).toBeGreaterThan(atRiskAt);
    expect(relationship).toContain("WHEN f.lifetime_calls < 3 THEN 'new'");
    expect(relationship).toContain(
      "WHEN f.lifetime_bookings >= 1 AND (f.last_call_at < (now() - 14 * interval '1 day')::timestamp OR f.calls_recent * 2 < f.calls_prior) THEN 'at_risk'",
    );
    // Top is its own column, so an at_risk carrier can be top, and its rate is over negotiable calls only.
    expect(relationship).not.toContain("bookings >= 2");
    expect(text).toContain("(f.bookings >= 2 AND f.bookings >= 0.5 * f.negotiable_calls) AS top");
    expect(text).toContain("count(*) FILTER (WHERE k.in_window AND k.negotiable) AS negotiable_calls");
    // A booking whose TMS confirmation is pending is still a booking, as in the inbox and the dashboard.
    expect(text).toContain("h.status IN ('booked', 'booked_unconfirmed')) AS booked");
    expect(text).toContain("EXISTS (SELECT 1 FROM offers o WHERE o.call_id = c.call_id) AS negotiable");
    expect(text).toContain("c.created_at >= (now() - interval '30 days')::timestamp AS in_window");
  });

  it("puts the view in the total and page, not in the counts", () => {
    const text = networkQuery(operatorNetworkQuery.parse({ view: "at_risk", page: "2" }), new Set()).text;
    const filtered = text.slice(text.indexOf("filtered AS ("), text.indexOf("ordered AS ("));
    expect(filtered).not.toContain("f.relationship = 'at_risk'");
    expect(text).toContain("FROM filtered f WHERE f.relationship = 'at_risk'");
    expect(text).toContain("(SELECT count(*) FROM ordered) AS total");
    expect(text).toContain("(SELECT count(*) FROM filtered WHERE relationship = 'at_risk') AS at_risk_count");
    expect(text).toContain("(SELECT count(*) FROM filtered WHERE top) AS top_count");
    expect(text).toContain("row_number() OVER (ORDER BY f.last_call_at DESC, f.carrier_key)");
    expect(text).toContain("p.ord > 25 AND p.ord <= 50");
    expect(text).toContain("LEFT JOIN LATERAL");
    expect(text).toContain("LIMIT 5");
  });

  it.each([
    ["mc", "asc", "ORDER BY lpad(f.mc_number, 12, '0') ASC NULLS LAST, f.last_call_at DESC, f.carrier_key)"],
    ["carrier", "desc", "ORDER BY f.carrier_name DESC NULLS LAST, f.last_call_at DESC, f.carrier_key)"],
    ["lastCall", "asc", "ORDER BY f.last_call_at ASC, f.carrier_key)"],
    ["calls", "desc", "ORDER BY f.calls DESC, f.last_call_at DESC, f.carrier_key)"],
    ["bookings", "asc", "ORDER BY f.bookings ASC, f.last_call_at DESC, f.carrier_key)"],
  ])("orders by %s %s from the whitelist, then the stable tie breakers", (sort, dir, order) => {
    expect(networkQuery(operatorNetworkQuery.parse({ sort, dir }), new Set()).text).toContain(order);
  });

  it("pages by the chosen page size and echoes it", async () => {
    expect(networkQuery(operatorNetworkQuery.parse({ page: "3", pageSize: "10" }), new Set()).text).toContain("p.ord > 20 AND p.ord <= 30");
    expect(networkQuery(operatorNetworkQuery.parse({ page: "2", pageSize: "50" }), new Set()).text).toContain("p.ord > 50 AND p.ord <= 100");
    const res = await getNetwork("?pageSize=10");
    expect(operatorNetworkResponse.parse(res.json()).pageSize).toBe(10);
  });

  it("reads KPIs over the filtered carriers and the open lane panel over the listed ones, before the filters", () => {
    const text = networkQuery(operatorNetworkQuery.parse({ origin: "GA", view: "top" }), new Set()).text;
    expect(text).toContain("(SELECT count(*) FROM filtered WHERE calls > 0) AS called_kpi");
    expect(text).toContain("(SELECT COALESCE(sum(bookings), 0) FROM filtered) AS booked_kpi");
    expect(text).toContain("(SELECT COALESCE(sum(loads_negotiated), 0) FROM filtered) AS negotiated_kpi");
    expect(text).toContain("listed AS (\n      SELECT c.* FROM classified c WHERE c.calls > 0 OR c.relationship = 'at_risk'");
    expect(text).toContain("FROM lanes l JOIN listed c ON c.carrier_key = l.carrier_key\n        WHERE l.open AND l.equipment IS NOT NULL GROUP BY l.origin_state, l.equipment");
    expect(text).toContain("WHERE l.open GROUP BY l.origin_state\n");
  });

  it("renders the bar filters as escaped SQL in filtered", () => {
    const text = networkQuery(operatorNetworkQuery.parse({ equipment: ["reefer"], origin: "ga", q: "50%_o'k", since: "7d" }), new Set()).text;
    const filtered = text.slice(text.indexOf("filtered AS ("), text.indexOf("ordered AS ("));
    expect(filtered).toContain("EXISTS (SELECT 1 FROM lanes l WHERE l.carrier_key = c.carrier_key AND l.equipment IN (E'REEFER') AND l.origin_state = E'GA')");
    expect(filtered).toContain("c.carrier_name ILIKE E'%50\\\\%\\\\_o''k%'");
    expect(text).toContain("c.created_at >= (now() - interval '7 days')::timestamp AS in_window");
    expect(filtered).not.toContain("l.open");
  });

  it("narrows the lane filter to open lanes on the growth view, so a panel click keeps the panel's count", () => {
    const text = networkQuery(operatorNetworkQuery.parse({ view: "growth", equipment: ["reefer"], origin: "ga" }), new Set()).text;
    const filtered = text.slice(text.indexOf("filtered AS ("), text.indexOf("ordered AS ("));
    expect(filtered).toContain("l.equipment IN (E'REEFER') AND l.origin_state = E'GA' AND l.open)");
  });

  it("accepts only the listed page sizes", () => {
    expect(operatorNetworkQuery.parse({ pageSize: "10" }).pageSize).toBe(10);
    expect(operatorNetworkQuery.safeParse({ pageSize: "30" }).success).toBe(false);
  });

  it("matches growth against the open board lanes, reading them once per cache period", async () => {
    tms.queryLoads.mockClear();
    const cachedApp = buildServer(testConfig, { agentRoutes: [], operatorRoutes: [operatorNetworkRoutes({ twin, tms })] });
    try {
      statements.length = 0;
      expect((await getNetwork("", undefined, cachedApp)).statusCode).toBe(200);
      expect(tms.queryLoads).toHaveBeenCalledTimes(5);
      expect(tms.queryLoads.mock.calls.map(([filters]) => filters)).toContainEqual({ equipmentType: "FLATBED", maxResults: 50 });
      expect((await getNetwork("?view=growth", undefined, cachedApp)).statusCode).toBe(200);
      expect(tms.queryLoads).toHaveBeenCalledTimes(5);
      // Booked loads are not open lanes. Exact lanes match the triples; a search's Any matches only its own part.
      for (const text of statements) {
        expect(text).toContain("(r.origin_state || '|' || r.destination_state || '|' || r.equipment) IN (E'GA|KS|DRY_VAN', E'TX|KS|REEFER')");
        expect(text).toContain("OR (r.search AND r.destination_state IS NULL AND (r.origin_state || '|' || r.equipment) IN (E'GA|DRY_VAN', E'TX|REEFER'))");
        expect(text).toContain("OR (r.search AND r.equipment IS NULL AND (r.origin_state || '|' || r.destination_state) IN (E'GA|KS', E'TX|KS'))");
        expect(text).toContain("OR (r.search AND r.destination_state IS NULL AND r.equipment IS NULL AND r.origin_state IN (E'GA', E'TX'))");
        expect(text).not.toContain("OH|");
      }
    } finally {
      await cachedApp.close();
    }
  });

  it("tags growth on an open origin and equipment only for a lane the carrier booked at least twice", () => {
    const text = networkQuery(operatorNetworkQuery.parse({}), new Set(["GA|KS|DRY_VAN"])).text;
    expect(text).toContain("OR ((r.origin_state || '|' || r.equipment) IN (E'GA|DRY_VAN') AND EXISTS (");
    expect(text).toContain("AND b.destination_state = r.destination_state AND b.equipment = r.equipment\n            AND b.bookings >= 2))");
    expect(text).toContain("count(DISTINCT h.hold_id) AS bookings");
    expect(text).toContain("JOIN holds h ON h.call_id = k.call_id AND h.status IN ('booked', 'booked_unconfirmed')");
    expect(text).toContain("JOIN offers o ON o.call_id = h.call_id AND o.load_id = h.load_id");
    // A carrier is growth when any of its lanes is open.
    expect(text).toContain("EXISTS (SELECT 1 FROM lanes l WHERE l.carrier_key = f.carrier_key AND l.open) AS growth");
  });

  it("answers without growth when the board cannot be read", async () => {
    statements.length = 0;
    const res = await getNetwork("", undefined, boardDownApp);
    expect(res.statusCode).toBe(200);
    expect(operatorNetworkResponse.parse(res.json()).boardAvailable).toBe(false);
    const [text] = statements;
    expect(text).toContain("(r.origin_state || '|' || r.destination_state || '|' || r.equipment) IN (NULL)");
    expect(text).toContain("(r.origin_state || '|' || r.equipment) IN (NULL)");
    expect(text).toContain("r.origin_state IN (NULL)");
    expect(text).not.toContain("|DRY_VAN'");
    // A failed read is not cached: the next request asks the board again.
    const calls = downTms.queryLoads.mock.calls.length;
    await getNetwork("", undefined, boardDownApp);
    expect(downTms.queryLoads.mock.calls.length).toBeGreaterThan(calls);
  });

  it("answers 503 when Twin fails", async () => {
    failTwin = true;
    try {
      const res = await getNetwork();
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: "service_unavailable" });
    } finally {
      failTwin = false;
    }
  });
});

// Radar rows as Twin nests them: sums and counts as strings, like int8.
const demandRow = {
  total: "2",
  no_match_total: "4",
  offered_no_booking_total: "3",
  carriers_total: "3",
  this_week_total: "3",
  previous_week_total: "3",
  origins: [
    { origin_state: "TX", unmet: "5" },
    { origin_state: "GA", unmet: "2" },
  ],
  rows: [
    {
      ord: 1,
      origin_state: "TX",
      destination_state: null,
      equipment: null,
      searches: "5",
      no_match: "4",
      offered_no_booking: "1",
      this_week: "3",
      previous_week: "1",
      carriers: "2",
    },
    {
      ord: 2,
      origin_state: "GA",
      destination_state: "KS",
      equipment: "DRY_VAN",
      searches: "0",
      no_match: "0",
      offered_no_booking: "2",
      this_week: "0",
      previous_week: "2",
      carriers: "1",
    },
  ],
};

const demandCarriersRow = {
  total: "1",
  rows: [{ ord: 1, carrier_key: "mc:123456", mc_number: "123456", carrier_name: "ACME TRUCKING LLC", asks: "4" }],
};

const getDemand = (path: string, key: string = testConfig.OPERATOR_API_KEY) =>
  app.inject({ method: "GET", url: `/v1/operator/demand${path}`, headers: { "x-api-key": key } });

describe("GET /v1/operator/demand", () => {
  beforeEach(() => {
    twinRow = demandRow;
  });
  afterEach(() => {
    twinRow = networkRow;
  });

  it("rejects the agent key", async () => {
    expect((await getDemand("", testConfig.AGENT_API_KEY)).statusCode).toBe(401);
    expect((await getDemand("/carriers?origin=TX", testConfig.AGENT_API_KEY)).statusCode).toBe(401);
  });

  it("returns the page of lanes from one Twin row, with no booked or money field", async () => {
    statements.length = 0;
    const res = await getDemand("?page=1");
    expect(res.statusCode).toBe(200);
    expect(statements).toHaveLength(1);
    const body = operatorDemandResponse.parse(res.json());
    expect(body).toMatchObject({
      status: "ok",
      total: 2,
      page: 1,
      pageSize: 25,
      totals: { noMatch: 4, offeredNoBooking: 3, carriers: 3, thisWeek: 3, previousWeek: 3 },
    });
    expect(body.origins).toEqual([
      { originState: "TX", unmet: 5 },
      { originState: "GA", unmet: 2 },
    ]);
    expect(body.rows[0]).toEqual({
      originState: "TX",
      destinationState: null,
      equipment: null,
      searches: 5,
      noMatch: 4,
      offeredNoBooking: 1,
      thisWeek: 3,
      previousWeek: 1,
      carriers: 2,
    });
    for (const row of res.json().rows) {
      expect(Object.keys(row).filter((field) => /book(ed)?$|rate|usd|buy/i.test(field))).toEqual([]);
    }
    expect(statements[0]).not.toMatch(/AS booked\b|agreed_rate|max_buy|carrier_ask/);
  });

  it("buckets weeks on the desk calendar, converted back to the stored clock", () => {
    const text = demandQuery(operatorDemandQuery.parse({})).text;
    expect(text).toContain("date_trunc('week', now() AT TIME ZONE E'America/Chicago') AS week_start");
    expect(text).toContain("((b.week_start - interval '21 days') AT TIME ZONE E'America/Chicago')::timestamp AS window_start");
    expect(text).toContain("((b.week_start - interval '7 days') AT TIME ZONE E'America/Chicago')::timestamp AS previous_start");
    expect(text).toContain("(b.week_start AT TIME ZONE E'America/Chicago')::timestamp AS this_start");
    expect(text).toContain("sum(a.unmet) FILTER (WHERE a.created_at >= w.this_start)");
    expect(text).toContain("FILTER (WHERE a.created_at >= w.previous_start AND a.created_at < w.this_start)");
    expect(text).toContain("ls.created_at >= w.window_start");
    expect(text).toContain("o.created_at >= w.window_start");
  });

  it("counts an offered load only when its call got no live hold on it, and skips offers without a stored lane", () => {
    const text = demandQuery(operatorDemandQuery.parse({})).text;
    expect(text).toContain(
      "NOT EXISTS (SELECT 1 FROM holds h WHERE h.call_id = o.call_id AND h.load_id = o.load_id AND h.status IN ('held', 'confirming', 'booked', 'booked_unconfirmed'))",
    );
    expect(text).toContain("DISTINCT ON (o.call_id, o.load_id)");
    expect(text).toContain("o.equipment IS NOT NULL");
    expect(text).toContain("CASE WHEN ls.results = 0 THEN 1 ELSE 0 END AS no_match");
    expect(text).toContain("count(DISTINCT a.carrier_key) AS carriers");
  });

  it.each([
    ["an unknown sort", "?sort=searches"],
    ["an unknown dir", "?dir=up"],
    ["a page size off the list", "?pageSize=100"],
    ["an unknown next move", "?next=call"],
  ])("rejects %s", async (_, query) => {
    statements.length = 0;
    expect((await getDemand(query)).statusCode).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it("keeps a lane by its states or by an MC or name among its asks, escaped, without touching its counts", () => {
    const text = demandQuery(operatorDemandQuery.parse({ q: " tx'%" })).text;
    expect(text).toContain("(g.origin_state = E'TX''%' OR g.destination_state = E'TX''%' OR EXISTS (");
    expect(text).toContain("AND q.destination_state IS NOT DISTINCT FROM g.destination_state AND q.equipment IS NOT DISTINCT FROM g.equipment");
    expect(text).toContain("(q.mc_number ILIKE E'%tx''\\\\%%' OR q.carrier_name ILIKE E'%tx''\\\\%%')");
    // q filters the grouped rows, so it never reaches the asks that are summed.
    const grouped = text.slice(text.indexOf("grouped AS ("), text.indexOf("ordered AS ("));
    expect(grouped).not.toContain("ILIKE");
  });

  it("keeps the rows of the next move: source needs no-match searches, rate needs offers without a booking", () => {
    expect(demandQuery(operatorDemandQuery.parse({ next: "source" })).text).toContain("WHERE g.no_match > 0\n");
    expect(demandQuery(operatorDemandQuery.parse({ next: "rate", origin: "ga" })).text).toContain(
      "WHERE g.origin_state = E'GA'\n        AND g.offered_no_booking > 0\n",
    );
  });

  it("sums the week totals over the kept rows and the origins over every row", () => {
    const text = demandQuery(operatorDemandQuery.parse({ origin: "ga" })).text;
    expect(text).toContain("(SELECT COALESCE(sum(this_week), 0) FROM ordered) AS this_week_total");
    expect(text).toContain("(SELECT COALESCE(sum(previous_week), 0) FROM ordered) AS previous_week_total");
    expect(text).toContain("SELECT g.origin_state, sum(g.unmet) AS unmet FROM grouped g GROUP BY g.origin_state");
  });

  it.each([
    ["lane", "asc", "ORDER BY g.origin_state ASC, g.destination_state ASC NULLS LAST, g.unmet DESC, g.searches DESC, g.equipment NULLS LAST"],
    ["equipment", "desc", "ORDER BY g.equipment DESC NULLS LAST, g.unmet DESC, g.searches DESC, g.origin_state, g.destination_state NULLS LAST"],
    ["unmet", "asc", "ORDER BY g.unmet ASC, g.searches DESC, g.origin_state, g.destination_state NULLS LAST, g.equipment NULLS LAST"],
    ["thisWeek", "desc", "ORDER BY g.this_week DESC, g.unmet DESC, g.searches DESC, g.origin_state"],
    ["carriers", "asc", "ORDER BY g.carriers ASC, g.unmet DESC, g.searches DESC, g.origin_state"],
  ])("orders by %s %s from the whitelist, then the stable tie breakers", (sort, dir, order) => {
    expect(demandQuery(operatorDemandQuery.parse({ sort, dir })).text).toContain(order);
  });

  it("pages by the chosen page size and echoes it", async () => {
    expect(demandQuery(operatorDemandQuery.parse({ page: "2", pageSize: "10" })).text).toContain("p.ord > 10 AND p.ord <= 20");
    const res = await getDemand("?pageSize=50");
    expect(operatorDemandResponse.parse(res.json()).pageSize).toBe(50);
  });

  it("orders by unmet then searches then lane, and pages", () => {
    const text = demandQuery(operatorDemandQuery.parse({ page: "3" })).text;
    expect(text).toContain(
      "ORDER BY g.unmet DESC, g.searches DESC, g.origin_state, g.destination_state NULLS LAST, g.equipment NULLS LAST",
    );
    expect(text).toContain("GROUP BY a.origin_state, a.destination_state, a.equipment");
    expect(text).toContain("p.ord > 50 AND p.ord <= 75");
  });

  it("renders the equipment and origin filters as escaped SQL", () => {
    const text = demandQuery(operatorDemandQuery.parse({ equipment: ["reefer", "dry van"], origin: "tx" })).text;
    expect(text).toContain("WHERE g.equipment IN (E'REEFER', E'DRY_VAN')");
    expect(text).toContain("AND g.origin_state = E'TX'");
    // The carriers total counts the asks of every kept row, not the page.
    expect(text).toContain("(SELECT count(DISTINCT a.carrier_key) FROM asks a JOIN ordered g ON g.origin_state = a.origin_state");
  });

  it("answers 503 when Twin fails", async () => {
    failTwin = true;
    try {
      for (const path of ["", "/carriers?origin=TX"]) {
        const res = await getDemand(path);
        expect(res.statusCode).toBe(503);
        expect(res.json()).toMatchObject({ status: "service_unavailable" });
      }
    } finally {
      failTwin = false;
    }
  });
});

describe("GET /v1/operator/demand/carriers", () => {
  beforeEach(() => {
    twinRow = demandCarriersRow;
  });
  afterEach(() => {
    twinRow = networkRow;
  });

  it.each([
    ["no origin", ""],
    ["an unknown equipment", "?origin=TX&equipment=boat"],
    ["page 0", "?origin=TX&page=0"],
  ])("rejects %s", async (_, query) => {
    statements.length = 0;
    expect((await getDemand(`/carriers${query}`)).statusCode).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it("returns the carriers behind the row, paged", async () => {
    statements.length = 0;
    const res = await getDemand("/carriers?origin=tx&page=2");
    expect(res.statusCode).toBe(200);
    const body = operatorDemandCarriersResponse.parse(res.json());
    expect(body).toEqual({
      status: "ok",
      rows: [{ key: "mc:123456", mcNumber: "123456", carrierName: "ACME TRUCKING LLC", asks: 4 }],
      total: 1,
      page: 2,
      pageSize: 25,
    });
    expect(statements[0]).toContain("p.ord > 25 AND p.ord <= 50");
  });

  it("matches the Any row with IS NULL, not as a wildcard", () => {
    const text = demandCarriersQuery(operatorDemandCarriersQuery.parse({ origin: "TX" })).text;
    expect(text).toContain("a.origin_state = E'TX' AND a.destination_state IS NULL AND a.equipment IS NULL");
    const exact = demandCarriersQuery(operatorDemandCarriersQuery.parse({ origin: "GA", destination: "ks", equipment: "dry van" })).text;
    expect(exact).toContain("a.origin_state = E'GA' AND a.destination_state = E'KS' AND a.equipment = E'DRY_VAN'");
    expect(exact).not.toContain("IS NULL AND a.equipment");
  });

  it("counts asks as searches plus offered loads without a booking, ordered by asks then key", () => {
    const text = demandCarriersQuery(operatorDemandCarriersQuery.parse({ origin: "TX" })).text;
    expect(text).toContain("sum(a.searches + a.offered_no_booking) AS asks");
    expect(text).toContain("row_number() OVER (ORDER BY g.asks DESC, g.carrier_key)");
    expect(text).toContain("date_trunc('week', now() AT TIME ZONE E'America/Chicago')");
  });
});
