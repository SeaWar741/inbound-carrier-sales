import { afterAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { operatorCarrierCallsResponse, operatorCarriersQuery, operatorCarriersResponse, operatorLoadsResponse } from "../src/contract.ts";
import { TwinError, type SqlStatement } from "../src/infra/twin-client.ts";
import { carriersQuery, operatorInboxRoutes } from "../src/routes/operator-inbox.ts";
import { buildServer } from "../src/server.ts";
import { testConfig } from "./test-config.ts";

// Shaped like Twin's answer: int8 as strings, timestamptz as ISO strings with an offset.
const loadRow = {
  hold_id: "7b0c2a5e-8a39-4b8e-9d7e-0f3f2d1c4b5a",
  load_id: "LD00881",
  call_id: "call-b",
  agreed_rate: "2300",
  mc_number: "123456",
  carrier_name: "ACME TRUCKING LLC",
  origin_city: "Savannah",
  origin_state: "GA",
  origin_zip: "31401",
  destination_city: "Wichita",
  destination_state: "KS",
  destination_zip: "67202",
  equipment: "DRY_VAN",
  miles: "1000",
  // 14:00 Chicago (CDT, UTC-5) is 19:00 UTC; 1000 miles at 50 mph is 20 h later.
  pickup_at: "20260929140000",
  pickup_ts: "2026-09-29T19:00:00+00:00",
  eta_ts: "2026-09-30T15:00:00+00:00",
  trip_status: "in_transit",
};

// A latest call as Twin nests it in json: numbers as json numbers, timestamps with an offset.
const callJson = {
  call_id: "call-b",
  mc_number: "123456",
  dot_number: "7654321",
  eligible: true,
  verified: true,
  otp_attempts: 1,
  otp_expires_at: "2026-09-29T15:05:00.12345+00:00",
  created_at: "2026-09-29T15:00:00+00:00",
  human_requested: false,
  offers: [
    {
      load_id: "LD00881",
      round: 2,
      carrier_ask: 2300,
      decision: "accept",
      rate_to_say: 2300,
      posted_rate: 2100,
      max_buy: 2500,
      origin_city: "Savannah",
      origin_state: "GA",
      origin_zip: "31401",
      destination_city: "Wichita",
      destination_state: "KS",
      destination_zip: "67202",
      equipment: "DRY_VAN",
      miles: 1000,
      pickup_at: "20260929140000",
      created_at: "2026-09-29T15:08:00+00:00",
    },
  ],
  hold: {
    hold_id: "7b0c2a5e-8a39-4b8e-9d7e-0f3f2d1c4b5a",
    load_id: "LD00881",
    status: "booked",
    agreed_rate: 2300,
    posted_rate: 2100,
    max_buy: 2500,
    booking_ref: "BR-1",
    trip: null,
    created_at: "2026-09-29T15:09:00+00:00",
  },
  events: [{ tool: "confirm_hold", summary: "booked", status: "ok", created_at: "2026-09-29T15:10:00+00:00" }],
  interventions: [],
};

// One row: counts as strings (count(*) is int8), the page as parsed json.
const carriersRow = {
  total: "2",
  needs_you: "1",
  live: "0",
  active: "1",
  closed: "3",
  // json_object_agg over the stage groups: absent stages have no carrier.
  stage_counts: { needs_approval: 1, in_transit: 1, lost: 3 },
  rows: [
    {
      ord: 1,
      carrier_key: "mc:123456",
      mc_number: "123456",
      dot_number: "7654321",
      carrier_name: "ACME TRUCKING LLC",
      calls_count: 3,
      loads_count: 2,
      last_activity_at: "2026-09-29T15:10:00+00:00",
      carrier_stage: "in_transit",
      needs_human: false,
      has_booking: true,
      pickup_ts: "2026-09-29T19:00:00+00:00",
      eta_ts: "2026-09-30T15:00:00+00:00",
      trip_status: "in_transit",
      latest_call: callJson,
    },
    {
      ord: 2,
      carrier_key: "call:call-x",
      mc_number: null,
      dot_number: null,
      carrier_name: null,
      calls_count: 1,
      loads_count: 0,
      last_activity_at: "2026-09-29T14:00:00+00:00",
      carrier_stage: "needs_approval",
      needs_human: true,
      has_booking: false,
      pickup_ts: null,
      eta_ts: null,
      trip_status: null,
      latest_call: { ...callJson, call_id: "call-x", mc_number: null, dot_number: null, offers: [], hold: null },
    },
  ],
};

// Top-level Twin columns: timestamptz as ISO strings, int8 as strings, json parsed.
const callRow = { ...callJson, otp_attempts: "1" };

const statements: string[] = [];
let failTwin = false;
const twin = {
  query: async <T>(statement: SqlStatement, rowSchema: z.ZodType<T>): Promise<T[]> => {
    statements.push(statement.text);
    if (failTwin) throw new TwinError("connection reset");
    const text = statement.text;
    if (text.includes("FROM call_transcripts")) {
      if (!text.includes("E'demo-1'")) return [];
      return [
        { seq: "1", role: "agent", text: "Thanks for calling, this is Pablo.", at: "2026-09-30T15:00:00.000Z" },
        { seq: "2", role: "tool", text: "verify_carrier", at: "2026-09-30T15:00:09.000Z" },
      ].map((r) => rowSchema.parse(r));
    }
    if (text.endsWith("FROM staged p")) return text.includes("'unknown'") ? [] : [rowSchema.parse(carriersRow.rows[0])];
    if (text.startsWith("WITH scoped")) return [rowSchema.parse(carriersRow)];
    if (text.includes("FROM calls t WHERE COALESCE('mc:' || t.mc_number")) {
      return text.includes("'unknown'") ? [] : [callRow, { ...callRow, call_id: "call-a", hold: null }].map((r) => rowSchema.parse(r));
    }
    return [loadRow, { ...loadRow, hold_id: "hold-2", load_id: "LD00900", carrier_name: null, trip_status: "upcoming" }].map((r) => rowSchema.parse(r));
  },
};

const app = buildServer(testConfig, { agentRoutes: [], operatorRoutes: [operatorInboxRoutes({ twin })] });
afterAll(() => app.close());

const getLoads = (key?: string) =>
  app.inject({ method: "GET", url: "/v1/operator/loads", headers: key ? { "x-api-key": key } : {} });

describe("GET /v1/operator/loads", () => {
  it("rejects the agent key and a missing key", async () => {
    expect((await getLoads(testConfig.AGENT_API_KEY)).statusCode).toBe(401);
    expect((await getLoads()).statusCode).toBe(401);
  });

  it("returns booked loads parsed from Twin rows, with progress at request time", async () => {
    statements.length = 0;
    vi.useFakeTimers({ now: new Date("2026-09-30T05:00:00Z"), toFake: ["Date"] });
    try {
      const res = await getLoads(testConfig.OPERATOR_API_KEY);
      expect(res.statusCode).toBe(200);
      const { loads } = operatorLoadsResponse.parse(res.json());
      expect(loads[0]).toEqual({
        holdId: "7b0c2a5e-8a39-4b8e-9d7e-0f3f2d1c4b5a",
        loadId: "LD00881",
        callId: "call-b",
        mcNumber: "123456",
        carrierName: "ACME TRUCKING LLC",
        agreedRate: 2300,
        lane: {
          origin: { city: "Savannah", state: "GA", zip: "31401" },
          destination: { city: "Wichita", state: "KS", zip: "67202" },
          equipment: "DRY_VAN",
          miles: 1000,
          pickupAt: "20260929140000",
        },
        pickupAt: "2026-09-29T19:00:00.000Z",
        etaAt: "2026-09-30T15:00:00.000Z",
        status: "in_transit",
        progress: 0.5,
      });
      expect(loads[1]).toMatchObject({ loadId: "LD00900", carrierName: null, status: "upcoming" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads booked holds only, in the trip window, capped", async () => {
    statements.length = 0;
    await getLoads(testConfig.OPERATOR_API_KEY);
    expect(statements).toHaveLength(1);
    const [text] = statements;
    expect(text).toContain("h.status IN ('booked', 'booked_unconfirmed')");
    expect(text).toContain("o.pickup_at IS NOT NULL");
    expect(text).toContain("CROSS JOIN LATERAL");
    expect(text).toContain("WHERE trip.eta_ts >= now() - interval '24 hours' AND trip.pickup_ts <= now() + interval '7 days'");
    expect(text).toContain("ORDER BY trip.pickup_ts");
    expect(text).toContain("LIMIT 500");
  });

  it("answers 503 when Twin fails", async () => {
    failTwin = true;
    try {
      const res = await getLoads(testConfig.OPERATOR_API_KEY);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: "service_unavailable" });
    } finally {
      failTwin = false;
    }
  });
});

const getCarriers = (query: string, key: string = testConfig.OPERATOR_API_KEY) =>
  app.inject({ method: "GET", url: `/v1/operator/carriers${query}`, headers: { "x-api-key": key } });

describe("GET /v1/operator/carriers", () => {
  it("rejects the agent key", async () => {
    expect((await getCarriers("", testConfig.AGENT_API_KEY)).statusCode).toBe(401);
  });

  it.each([
    ["an unknown tab", "?tab=everything"],
    ["page 0", "?page=0"],
    ["an unknown stage", "?stage=live&stage=parked"],
    ["an unknown sort", "?sort=name"],
    ["a malformed state", "?origin=Georgia"],
    ["an unknown since", "?since=1y"],
    ["a malformed from", "?from=2026-9-1&to=2026-09-03"],
    ["from without to", "?from=2026-09-01"],
    ["to without from", "?to=2026-09-01"],
    ["from after to", "?from=2026-09-03&to=2026-09-01"],
    ["201 live ids", `?${Array.from({ length: 201 }, (_, i) => `live=run-${i}`).join("&")}`],
  ])("rejects %s", async (_, query) => {
    statements.length = 0;
    expect((await getCarriers(query)).statusCode).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it("accepts 200 live ids, repeated stages, and defaults the rest", () => {
    const live = Array.from({ length: 200 }, (_, i) => `run-${i}`);
    expect(operatorCarriersQuery.parse({ live, stage: ["live", "booked", "lost"], equipment: "dry van" })).toMatchObject({
      tab: "all",
      since: "7d",
      sort: "priority",
      page: 1,
      stage: ["live", "booked", "lost"],
      equipment: ["DRY_VAN"],
    });
    expect(operatorCarriersQuery.parse({ live }).live).toHaveLength(200);
  });

  it("returns the page, total, tab counts and stage counts parsed from one Twin row", async () => {
    statements.length = 0;
    const res = await getCarriers("?tab=all&page=2");
    expect(res.statusCode).toBe(200);
    expect(statements).toHaveLength(1);
    const body = operatorCarriersResponse.parse(res.json());
    expect(body).toMatchObject({ total: 2, page: 2, pageSize: 25, counts: { needsYou: 1, live: 0, active: 1, closed: 3 } });
    expect(body.stageCounts).toEqual({ live: 0, negotiating: 0, needs_approval: 1, booked: 0, in_transit: 1, arrived: 0, lost: 3 });
    expect(body.rows[0]).toMatchObject({
      key: "mc:123456",
      carrierName: "ACME TRUCKING LLC",
      callsCount: 3,
      loadsCount: 2,
      lastActivityAt: "2026-09-29T15:10:00.000Z",
      carrierStage: "in_transit",
      needsHuman: false,
      nextTrip: { pickupAt: "2026-09-29T19:00:00.000Z", etaAt: "2026-09-30T15:00:00.000Z", status: "in_transit" },
      latestCall: { callId: "call-b", stage: "booked", hold: { status: "booked", agreedRate: 2300 } },
    });
    expect(body.rows[1]).toMatchObject({ key: "call:call-x", carrierStage: "needs_approval", needsHuman: true, nextTrip: null });
  });

  it("keys carriers by tagged MC, DOT or call id", () => {
    const text = carriersQuery(operatorCarriersQuery.parse({})).text;
    expect(text).toContain("SELECT c.*, COALESCE('mc:' || c.mc_number, 'dot:' || c.dot_number, 'call:' || c.call_id) AS carrier_key");
  });

  it("takes the trip and the open hold from every call in the window, not only the latest call", () => {
    const text = carriersQuery(operatorCarriersQuery.parse({})).text;
    const booked = text.slice(text.indexOf("booked AS ("), text.indexOf("booked_trip AS ("));
    expect(booked).toContain("FROM scoped s JOIN holds h ON h.call_id = s.call_id");
    expect(booked).toContain("WHERE h.status IN ('booked', 'booked_unconfirmed')");
    expect(booked).toContain("ORDER BY s.carrier_key, h.created_at DESC");
    expect(booked).not.toContain("latest_call_id");
    const approval = text.slice(text.indexOf("CASE\n"), text.indexOf("THEN 'needs_approval'"));
    expect(approval).toContain("FROM scoped s JOIN holds h ON h.call_id = s.call_id");
    expect(approval).toContain("WHERE s.carrier_key = k.carrier_key AND h.status IN ('held', 'confirming')");
    expect(approval).not.toContain("latest_call_id");
  });

  it("omits every absent or empty filter instead of rendering IN ()", () => {
    const text = carriersQuery(operatorCarriersQuery.parse({ stage: "", equipment: [], live: "" })).text;
    expect(text).not.toMatch(/IN \(\s*(NULL)?\s*\)/);
    expect(text).not.toContain("carrier_stage IN (E'");
    expect(text).not.toContain("o.equipment IN");
    expect(text).not.toContain("ILIKE");
    expect(text).toContain("FALSE AS latest_live");
    expect(text).toMatch(/WHERE TRUE\s+\), ordered/);
    expect(text).toContain("FROM filtered f WHERE TRUE");
    expect(text).toContain("c.created_at >= (now() - interval '7 days')::timestamp");
    expect(text).toContain("row_number() OVER (ORDER BY f.tab_rank, f.last_activity_at DESC, f.carrier_key)");
    expect(text).toContain("p.ord > 0 AND p.ord <= 25");
  });

  it("renders each given filter, the tab, the sort and the page as escaped SQL", () => {
    const text = carriersQuery(
      operatorCarriersQuery.parse({
        tab: "needs_you",
        stage: ["needs_approval", "live"],
        equipment: ["reefer"],
        origin: "ga",
        destination: "KS",
        since: "today",
        q: "50%_o'k",
        sort: "pickup",
        page: "3",
        live: ["run-1", "run-2"],
      }),
    ).text;
    expect(text).toContain("k.latest_call_id IN (E'run-1', E'run-2') AS latest_live");
    expect(text).toContain("FROM filtered f WHERE f.tab = E'needs_you' AND f.carrier_stage IN (E'needs_approval', E'live')");
    expect(text).toContain("o.equipment IN (E'REEFER') AND o.origin_state = E'GA' AND o.destination_state = E'KS'");
    expect(text).toContain("s.carrier_name ILIKE E'%50\\\\%\\\\_o''k%'");
    expect(text).toContain("date_trunc('day', now() AT TIME ZONE E'America/Chicago') AT TIME ZONE E'America/Chicago'");
    expect(text).toContain("ORDER BY CASE f.trip_status WHEN 'upcoming' THEN f.pickup_ts WHEN 'in_transit' THEN f.eta_ts END ASC NULLS LAST, f.carrier_key");
    expect(text).toContain("p.ord > 50 AND p.ord <= 75");
    // Counts group the bar-filtered set by tab and by stage; only total and page add the tab and stage.
    expect(text).toContain("(SELECT count(*) FROM filtered WHERE tab = 'needs_you') AS needs_you");
    expect(text).toContain("SELECT carrier_stage, count(*) AS n FROM filtered GROUP BY carrier_stage");
    const filtered = text.slice(text.indexOf("filtered AS ("), text.indexOf("ordered AS ("));
    expect(filtered).not.toContain("carrier_stage IN");
    expect(filtered).not.toContain("f.tab =");
    expect(text).toContain("(SELECT count(*) FROM ordered) AS total");
  });

  it("reads a day range as whole Chicago days, from the start of from to the start of the day after to, over since", () => {
    const text = carriersQuery(operatorCarriersQuery.parse({ since: "today", from: "2026-09-01", to: "2026-09-03" })).text;
    expect(text).toContain(
      "c.created_at >= ((E'2026-09-01'::date + 0)::timestamp AT TIME ZONE E'America/Chicago')::timestamp" +
        " AND c.created_at < ((E'2026-09-03'::date + 1)::timestamp AT TIME ZONE E'America/Chicago')::timestamp",
    );
    expect(text).not.toContain("date_trunc('day', now()");
  });

  it("keeps the since preset when the range is blank", () => {
    const text = carriersQuery(operatorCarriersQuery.parse({ since: "30d", from: "", to: "" })).text;
    expect(text).toContain("c.created_at >= (now() - interval '30 days')::timestamp");
    expect(text).not.toContain("::date");
  });

  it("answers 503 when Twin fails", async () => {
    failTwin = true;
    try {
      const res = await getCarriers("");
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: "service_unavailable" });
    } finally {
      failTwin = false;
    }
  });
});

describe("GET /v1/operator/carriers/:key/calls", () => {
  const getCalls = (key: string, query = "") =>
    app.inject({
      method: "GET",
      url: `/v1/operator/carriers/${encodeURIComponent(key)}/calls${query}`,
      headers: { "x-api-key": testConfig.OPERATOR_API_KEY },
    });

  it("returns the carrier's calls as wall calls, newest first, capped at 50", async () => {
    statements.length = 0;
    const res = await getCalls("mc:123456");
    expect(res.statusCode).toBe(200);
    const { calls } = operatorCarrierCallsResponse.parse(res.json());
    expect(calls.map((c) => c.callId)).toEqual(["call-b", "call-a"]);
    expect(calls[0]).toMatchObject({ otp: { attempts: 1 }, hold: { holdId: "7b0c2a5e-8a39-4b8e-9d7e-0f3f2d1c4b5a" } });
    const text = statements.find((t) => t.startsWith("SELECT")) ?? "";
    expect(text).toContain("COALESCE('mc:' || t.mc_number, 'dot:' || t.dot_number, 'call:' || t.call_id) = E'mc:123456'");
    expect(text).toContain("ORDER BY t.created_at DESC, t.call_id DESC");
    expect(text).toContain("LIMIT 50");
    expect(text).toContain("AS human_requested");
  });

  it("returns the carrier's list row, read from the same stage CTEs narrowed to its key", async () => {
    statements.length = 0;
    const res = await getCalls("mc:123456", "?since=30d&live=run-1");
    expect(res.statusCode).toBe(200);
    const { carrier } = operatorCarrierCallsResponse.parse(res.json());
    expect(carrier).toMatchObject({ key: "mc:123456", callsCount: 3, loadsCount: 2, carrierStage: "in_transit", latestCall: { callId: "call-b" } });
    expect(statements).toHaveLength(2);
    const text = statements.find((t) => t.startsWith("WITH scoped")) ?? "";
    expect(text).toContain(
      "c.created_at >= (now() - interval '30 days')::timestamp AND COALESCE('mc:' || c.mc_number, 'dot:' || c.dot_number, 'call:' || c.call_id) = E'mc:123456'",
    );
    expect(text).toContain("k.latest_call_id IN (E'run-1') AS latest_live");
    expect(text).toContain("THEN 'needs_approval'");
    expect(text).not.toContain("tabbed AS");
  });

  it("rejects an unknown since and a half range", async () => {
    expect((await getCalls("mc:123456", "?since=1y")).statusCode).toBe(400);
    expect((await getCalls("mc:123456", "?from=2026-09-01")).statusCode).toBe(400);
  });

  it("reads the carrier's row over the list's day range", async () => {
    statements.length = 0;
    const res = await getCalls("mc:123456", "?from=2026-09-01&to=2026-09-01");
    expect(res.statusCode).toBe(200);
    const text = statements.find((t) => t.startsWith("WITH scoped")) ?? "";
    expect(text).toContain(
      "c.created_at >= ((E'2026-09-01'::date + 0)::timestamp AT TIME ZONE E'America/Chicago')::timestamp" +
        " AND c.created_at < ((E'2026-09-01'::date + 1)::timestamp AT TIME ZONE E'America/Chicago')::timestamp AND COALESCE(",
    );
  });

  it("answers an empty list and no carrier for an unknown key", async () => {
    const res = await getCalls("unknown");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", calls: [], carrier: null });
  });

  it("answers 503 when Twin fails", async () => {
    failTwin = true;
    try {
      expect((await getCalls("123456")).statusCode).toBe(503);
    } finally {
      failTwin = false;
    }
  });
});

describe("GET /v1/operator/calls/:callId/transcript", () => {
  const getTranscript = (callId: string) =>
    app.inject({ method: "GET", url: `/v1/operator/calls/${callId}/transcript`, headers: { "x-api-key": testConfig.OPERATOR_API_KEY } });

  it("returns the stored conversation in order", async () => {
    statements.length = 0;
    const res = await getTranscript("demo-1");
    expect(res.json()).toEqual({
      status: "ok",
      entries: [
        { seq: 1, role: "agent", text: "Thanks for calling, this is Pablo.", at: "2026-09-30T15:00:00.000Z" },
        { seq: 2, role: "tool", text: "verify_carrier", at: "2026-09-30T15:00:09.000Z" },
      ],
    });
    expect(statements[0]).toContain("ORDER BY seq");
  });

  it("answers an empty list for a call with no stored conversation", async () => {
    expect((await getTranscript("run-1")).json()).toEqual({ status: "ok", entries: [] });
  });

  it("answers 503 when Twin fails and stays behind the operator key", async () => {
    failTwin = true;
    try {
      expect((await getTranscript("demo-1")).statusCode).toBe(503);
    } finally {
      failTwin = false;
    }
    const res = await app.inject({ method: "GET", url: "/v1/operator/calls/demo-1/transcript", headers: { "x-api-key": testConfig.AGENT_API_KEY } });
    expect(res.statusCode).toBe(401);
  });
});
