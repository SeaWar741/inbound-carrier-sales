import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { testConfig } from "./test-config.ts";
import type { TripSnapshot } from "../src/domain/trip-estimate.ts";
import type { LoadDetail, LoadSummary } from "../src/infra/tms/codec.ts";
import { TmsBusinessError, TmsUnavailableError } from "../src/infra/tms/errors.ts";
import { TmsClient } from "../src/infra/tms/tms-client.ts";
import type { TripEstimates } from "../src/infra/trip-estimator.ts";
import { TwinClient } from "../src/infra/twin-client.ts";
import { loadRoutes, type LoadRouteDeps } from "../src/routes/loads.ts";
import { offerRoutes } from "../src/routes/offers.ts";
import { buildServer } from "../src/server.ts";
import { startFakeTms, type FakeBehavior, type FakeTms } from "./fake-tms-server.ts";

const config: Config = { ...testConfig };

// Max buys of the fake board's loads (LD00881, LD00848): no response may ever carry them.
const secretMaxBuys = ["2538", "7684"];
const expectNoMaxBuy = (body: string) => {
  expect(body).not.toMatch(/max_?buy/i);
  for (const value of secretMaxBuys) expect(body).not.toContain(value);
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// In-memory stand-in for the Twin tables, answering the statements the routes send.
const verifiedCalls = new Map<string, boolean>();
// Active holds: load id -> the call holding it.
const activeHolds = new Map<string, string>();
// Summed operator authorizations, keyed "callId|loadId".
const authorized = new Map<string, number>();
type OfferRow = { callId: string; loadId: string; round: number; carrierAsk: number; decision: string; rateToSay: number | null };
let offers: (OfferRow & { postedRate?: number; maxBuy?: number; lane?: string[] })[] = [];
const sqlLog: string[] = [];
// Recorded searches, as their INSERT text; a flag makes the insert fail.
const searchInserts: string[] = [];
let failSearchInsert = false;

const twinFetch = vi.fn<typeof fetch>(async (_input, init) => {
  const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  const text = typeof body === "object" && body !== null && "sql" in body && typeof body.sql === "string" ? body.sql : "";
  sqlLog.push(text);
  const rows = (list: object[]) => jsonResponse({ command: "SELECT", rowCount: list.length, rows: list, truncated: false });

  const insert =
    /INSERT INTO offers[\s\S]*VALUES \(E'([^']*)', E'([^']*)', (\d+), (\d+), E'(\w+)', (NULL|\d+),\s+(\d+), (\d+),\s+([^)]*)\)/.exec(text);
  if (insert) {
    const [, callId = "", loadId = "", round, carrierAsk, decision = "", rate, postedRate, maxBuy, laneValues = ""] = insert;
    const row = {
      callId,
      loadId,
      round: Number(round),
      carrierAsk: Number(carrierAsk),
      decision,
      rateToSay: rate === "NULL" ? null : Number(rate),
      postedRate: Number(postedRate),
      maxBuy: Number(maxBuy),
      lane: laneValues.split(/,\s+/),
    };
    if (offers.some((o) => o.callId === callId && o.loadId === loadId && o.round === row.round)) {
      return jsonResponse({ message: 'duplicate key value violates unique constraint "offers_call_id_load_id_round_key"' }, 400);
    }
    offers.push(row);
    return jsonResponse({ command: "INSERT", rowCount: 1, rows: [], truncated: false });
  }
  if (text.startsWith("INSERT INTO load_searches")) {
    if (failSearchInsert) return jsonResponse({ message: 'relation "load_searches" does not exist' }, 400);
    searchInserts.push(text);
    return jsonResponse({ command: "INSERT", rowCount: 1, rows: [], truncated: false });
  }
  const callState = /FROM offers o WHERE o\.call_id = c\.call_id AND o\.load_id = E'([^']*)'[\s\S]*WHERE c\.call_id = E'([^']*)'/.exec(text);
  if (callState) {
    const [, loadId, callId = ""] = callState;
    const verified = verifiedCalls.get(callId);
    if (verified === undefined) return rows([]);
    const prior = offers.filter((o) => o.callId === callId && o.loadId === loadId).length;
    const holder = activeHolds.get(loadId ?? "");
    return rows([
      {
        verified,
        prior_rounds: String(prior),
        held_elsewhere: holder !== undefined && holder !== callId,
        authorized_usd: String(authorized.get(`${callId}|${loadId}`) ?? 0),
      },
    ]);
  }
  const verifiedQuery = /SELECT verified FROM calls WHERE call_id = E'([^']*)'/.exec(text);
  if (verifiedQuery) {
    const verified = verifiedCalls.get(verifiedQuery[1] ?? "");
    return rows(verified === undefined ? [] : [{ verified }]);
  }
  const holdsQuery = /SELECT load_id FROM holds WHERE load_id IN \(([^)]*)\) AND status <> 'released' AND call_id <> E'([^']*)'$/.exec(text);
  if (holdsQuery) {
    const [, list = "", callId] = holdsQuery;
    const ids = [...list.matchAll(/E'([^']*)'/g)].map((m) => m[1] ?? "");
    const heldElsewhere = ids.filter((id) => {
      const holder = activeHolds.get(id);
      return holder !== undefined && holder !== callId;
    });
    return rows(heldElsewhere.map((id) => ({ load_id: id })));
  }
  return jsonResponse({ message: `unexpected SQL: ${text}` }, 400);
});

const twin = new TwinClient({ apiKey: "k", fetch: twinFetch });

const tmsClient = (fake: FakeTms) =>
  new TmsClient({ host: "127.0.0.1", port: fake.port, token: config.TMS_TOKEN, maxAttempts: 1, attemptDeadlineMs: 500 });

// No vendor keys in tests: the default estimator answers null, like a deployment without EIA and ORS.
const noTrips: TripEstimates = { estimate: async () => null };

function serverWith(tms: LoadRouteDeps["tms"], trips: TripEstimates = noTrips) {
  return buildServer(config, { agentRoutes: [loadRoutes({ tms, twin, trips }), offerRoutes({ tms, twin })], operatorRoutes: [] });
}

let fake: FakeTms;
let app: ReturnType<typeof serverWith>;
beforeAll(async () => {
  fake = await startFakeTms({ token: config.TMS_TOKEN });
  app = serverWith(tmsClient(fake));
});
afterAll(async () => {
  await app.close();
  await fake.close();
});

beforeEach(() => {
  verifiedCalls.clear();
  verifiedCalls.set("call-ok", true);
  verifiedCalls.set("call-unverified", false);
  activeHolds.clear();
  authorized.clear();
  offers = [];
  sqlLog.length = 0;
  searchInserts.length = 0;
  failSearchInsert = false;
  twinFetch.mockClear();
});

const post = (url: string, payload: object, target = app, key = config.AGENT_API_KEY) =>
  target.inject({ method: "POST", url, headers: { "x-api-key": key }, payload });
const search = (payload: object, target = app) => post("/v1/loads/search", payload, target);
const evaluate = (payload: object, target = app) => post("/v1/offers/evaluate", payload, target);

async function withFake<T>(script: FakeBehavior[], run: (target: typeof app, tms: FakeTms) => Promise<T>): Promise<T> {
  const scripted = await startFakeTms({ token: config.TMS_TOKEN, script });
  const target = serverWith(tmsClient(scripted));
  try {
    return await run(target, scripted);
  } finally {
    await target.close();
    await scripted.close();
  }
}

const summary = (loadId: string, status: string): LoadSummary => ({
  loadId,
  origCity: "Savannah",
  origState: "GA",
  origZip: "31401",
  destCity: "Wichita",
  destState: "KS",
  destZip: "67202",
  pickupDateTime: "20261003141300",
  equipmentType: "DRY_VAN",
  rate: 2000,
  miles: 997,
  status,
});
const detail = (loadId: string, status: string): LoadDetail => ({
  ...summary(loadId, status),
  deliveryDateTime: "20261006111300",
  weight: 29831,
  commodity: "Frozen Goods",
  pieces: 25,
  dims: "41ft x 8ft x 9ft",
  notes: "",
  maxBuy: 2538,
});

describe("POST /v1/loads/search", () => {
  it("pitches open loads with delivery details and never the max buy", async () => {
    const res = await search({ callId: "call-ok", originCity: " Savannah ", originState: "ga", equipmentType: "dry van", pickupDate: "2026-10-03" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: "ok", message: "I found 2 open loads that fit." });
    expect(body.loads[0]).toEqual({
      loadId: "LD00881",
      origin: "Savannah, GA 31401",
      destination: "Wichita, KS 67202",
      pickupDateTime: "2026-10-03 14:13",
      deliveryDateTime: "2026-10-06 11:13",
      equipmentType: "DRY_VAN",
      loadboardRate: 2093,
      miles: 997,
      weight: 29831,
      commodity: "Frozen Goods",
      pieces: 25,
      dims: "41ft x 8ft x 9ft",
      notes: "",
      feasibility: null,
    });
    expectNoMaxBuy(res.body);
    const [query] = fake.requests.slice(-3);
    expect(query).toContain("CMD:LOAD_QUERY");
    expect(query).toContain("ORIG_CITY:Savannah|ORIG_STATE:GA|EQTYPE:DRY_VAN|PICKUP_DATE:20261003");
  });

  it("accepts the agent's all-string body with blank optional fields", async () => {
    const res = await search({
      callId: "call-ok",
      originCity: "Savannah",
      originState: "GA",
      destinationCity: "",
      destinationState: "",
      equipmentType: "dry van",
      pickupDate: "",
    });
    expect(res.json()).toMatchObject({ status: "ok" });
    expect(fake.requests.at(-3)).not.toContain("DEST_");
  });

  it("searches every equipment type when the caller says any, anything or all", async () => {
    for (const equipmentType of ["any", "Anything", " ALL ", ""]) {
      const res = await search({ callId: "call-ok", originCity: "Savannah", originState: "GA", equipmentType });
      expect(res.json()).toMatchObject({ status: "ok" });
      const query = fake.requests.findLast((line) => line.includes("CMD:LOAD_QUERY"));
      expect(query).toContain("ORIG_CITY:Savannah|ORIG_STATE:GA|MAX_RESULTS:");
      expect(query).not.toContain("EQTYPE");
    }
    const omitted = await search({ callId: "call-ok", originState: "GA" });
    expect(omitted.json()).toMatchObject({ status: "ok" });
  });

  it("adds each pitched load's feasibility at the posted rate, estimated in parallel", async () => {
    const tms = {
      queryLoads: vi.fn(async () => ["LD1", "LD2", "LD3"].map((id) => summary(id, "OPEN"))),
      getLoad: vi.fn(async (loadId: string) => detail(loadId, "OPEN")),
    };
    // Each estimate waits until all three have started, so a sequential search would never finish.
    let started = 0;
    let allStarted: () => void = () => {};
    const together = new Promise<void>((resolve) => (allStarted = resolve));
    const outcomes = [async () => ({ feasibility: "team" }) as TripSnapshot, async () => null, async () => ({ feasibility: "solo" }) as TripSnapshot];
    const estimate = vi.fn<TripEstimates["estimate"]>(async () => {
      const outcome = outcomes[started] ?? (async () => null);
      started += 1;
      if (started === 3) allStarted();
      await together;
      return outcome();
    });
    const target = serverWith(tms, { estimate });
    const res = await search({ callId: "call-ok", originState: "GA" }, target);
    await target.close();
    const body = res.json();
    expect(body.status).toBe("ok");
    // LD2 got no estimate; the search still pitches it, without feasibility.
    expect(body.loads.map((l: { loadId: string; feasibility: string | null }) => [l.loadId, l.feasibility])).toEqual([
      ["LD1", "team"],
      ["LD2", null],
      ["LD3", "solo"],
    ]);
    expect(estimate.mock.calls.map(([trip]) => trip.rate)).toEqual([2000, 2000, 2000]);
    expectNoMaxBuy(res.body);
  });

  it("refuses an unverified or unknown call without touching the TMS", async () => {
    const before = fake.requests.length;
    for (const callId of ["call-unverified", "call-unknown"]) {
      const res = await search({ callId, originState: "GA", equipmentType: "REEFER" });
      expect(res.json()).toMatchObject({ status: "not_verified", loads: [] });
    }
    expect(fake.requests.length).toBe(before);
  });

  it("keeps only OPEN loads, reads up to 6 candidates, and caps the pitch at 3", async () => {
    const statuses = ["BOOKED", "OPEN", "COVERED", "OPEN", "OPEN", "OPEN", "open", "OPEN", "OPEN", "OPEN", "OPEN"];
    const tms = {
      queryLoads: vi.fn(async () => statuses.map((status, i) => summary(`LD${i}`, status))),
      getLoad: vi.fn(async (loadId: string) => detail(loadId, loadId === "LD3" ? "BOOKED" : "OPEN")),
    };
    const target = serverWith(tms);
    const res = await search({ callId: "call-ok", originZip: "31401", equipmentType: "DRY_VAN" }, target);
    await target.close();
    expect(tms.getLoad.mock.calls.map(([id]) => id)).toEqual(["LD1", "LD3", "LD4", "LD5", "LD7", "LD8"]);
    // LD3 changed status between query and detail, so it is dropped rather than pitched.
    expect(res.json().loads.map((l: { loadId: string }) => l.loadId)).toEqual(["LD1", "LD4", "LD5"]);
    expectNoMaxBuy(res.body);
  });

  it("never pitches a load no crew can deliver on time, and keeps one without an estimate", async () => {
    const ids = ["LD1", "LD2", "LD3", "LD4", "LD5", "LD6"];
    const tms = {
      queryLoads: vi.fn(async () => ids.map((id) => summary(id, "OPEN"))),
      getLoad: vi.fn(async (loadId: string) => detail(loadId, "OPEN")),
    };
    const outcomes: Record<string, TripSnapshot["feasibility"] | null> = {
      LD1: "impossible",
      LD2: null,
      LD3: "impossible",
      LD4: "team",
      LD5: "solo",
      LD6: "solo",
    };
    // Estimates start in candidate order, so the nth call is the nth load.
    let started = 0;
    const estimate = vi.fn<TripEstimates["estimate"]>(async () => {
      const feasibility = outcomes[ids[started++] ?? ""] ?? null;
      return feasibility === null ? null : ({ feasibility } as TripSnapshot);
    });
    const target = serverWith(tms, { estimate });
    const res = await search({ callId: "call-ok", originState: "GA" }, target);
    await target.close();
    expect(res.json().status).toBe("ok");
    expect(res.json().loads.map((l: { loadId: string; feasibility: string | null }) => [l.loadId, l.feasibility])).toEqual([
      ["LD2", null],
      ["LD4", "team"],
      ["LD5", "solo"],
    ]);
    expect(estimate).toHaveBeenCalledTimes(6);
  });

  it("answers no_loads when every candidate's delivery window is too tight", async () => {
    const tms = {
      queryLoads: vi.fn(async () => ["LD1", "LD2"].map((id) => summary(id, "OPEN"))),
      getLoad: vi.fn(async (loadId: string) => detail(loadId, "OPEN")),
    };
    const estimate = vi.fn<TripEstimates["estimate"]>(async () => ({ feasibility: "impossible" }) as TripSnapshot);
    const target = serverWith(tms, { estimate });
    const res = await search({ callId: "call-ok", originState: "GA" }, target);
    await target.close();
    expect(res.json()).toEqual({
      status: "no_loads",
      message: "The loads I have on that lane right now have delivery windows too tight to run legally.",
      loads: [],
    });
  });

  it("drops a load the TMS no longer finds and answers no_loads when none are open", async () => {
    const tms = {
      queryLoads: vi.fn(async () => [summary("LD1", "OPEN"), summary("LD2", "BOOKED")]),
      getLoad: vi.fn(async () => {
        throw new TmsBusinessError("LOAD_GET", 1, false, "NOT_FOUND", "Load not found");
      }),
    };
    const target = serverWith(tms);
    const res = await search({ callId: "call-ok", originState: "GA", equipmentType: "DRY_VAN" }, target);
    await target.close();
    expect(res.json()).toEqual({ status: "no_loads", message: "I don't have any open loads on that lane right now.", loads: [] });
  });

  it("skips loads another call is holding, in one Twin query, before capping the pitch", async () => {
    activeHolds.set("LD1", "call-other");
    activeHolds.set("LD2", "call-ok");
    const tms = {
      queryLoads: vi.fn(async () => ["LD1", "LD2", "LD3", "LD4", "LD5"].map((id) => summary(id, "OPEN"))),
      getLoad: vi.fn(async (loadId: string) => detail(loadId, "OPEN")),
    };
    const target = serverWith(tms);
    const res = await search({ callId: "call-ok", originState: "GA", equipmentType: "DRY_VAN" }, target);
    await target.close();
    // The caller's own hold stays visible; only another call's hold hides a load.
    expect(res.json().loads.map((l: { loadId: string }) => l.loadId)).toEqual(["LD2", "LD3", "LD4"]);
    expect(tms.getLoad.mock.calls.map(([id]) => id)).toEqual(["LD2", "LD3", "LD4", "LD5"]);
    const holdQueries = sqlLog.filter((text) => text.includes("FROM holds"));
    expect(holdQueries).toEqual([
      "SELECT load_id FROM holds WHERE load_id IN (E'LD1', E'LD2', E'LD3', E'LD4', E'LD5') AND status <> 'released' AND call_id <> E'call-ok'",
    ]);
  });

  it("drops a load whose detail is unavailable and pitches the rest", async () => {
    const tms = {
      queryLoads: vi.fn(async () => [summary("LD1", "OPEN"), summary("LD2", "OPEN")]),
      getLoad: vi.fn(async (loadId: string) => {
        if (loadId === "LD1") throw new TmsUnavailableError("LOAD_GET", 3, false, "timeout");
        return detail(loadId, "OPEN");
      }),
    };
    const target = serverWith(tms);
    const res = await search({ callId: "call-ok", originState: "GA", equipmentType: "DRY_VAN" }, target);
    await target.close();
    expect(res.json()).toMatchObject({ status: "ok", message: "I found one open load that fits." });
    expect(res.json().loads.map((l: { loadId: string }) => l.loadId)).toEqual(["LD2"]);
  });

  it("records no search when nothing was pitched and some details could not be read", async () => {
    const tms = {
      queryLoads: vi.fn(async () => [summary("LD1", "OPEN"), summary("LD2", "OPEN")]),
      getLoad: vi.fn(async (loadId: string) => {
        if (loadId === "LD1") throw new TmsUnavailableError("LOAD_GET", 3, false, "timeout");
        return detail(loadId, "OPEN");
      }),
    };
    // The one load that was read cannot be delivered on time, so nothing is pitched.
    const target = serverWith(tms, { estimate: async () => ({ feasibility: "impossible" }) as TripSnapshot });
    const res = await search({ callId: "call-ok", originState: "GA" }, target);
    await target.close();
    expect(res.json()).toMatchObject({ status: "no_loads" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(searchInserts).toEqual([]);
  });

  it("answers tms_unavailable when no load detail could be read", async () => {
    const tms = {
      queryLoads: vi.fn(async () => [summary("LD1", "OPEN"), summary("LD2", "OPEN")]),
      getLoad: vi.fn(async (loadId: string) => {
        if (loadId === "LD1") throw new TmsUnavailableError("LOAD_GET", 3, false, "timeout");
        throw new TmsBusinessError("LOAD_GET", 1, false, "NOT_FOUND", "Load not found");
      }),
    };
    const target = serverWith(tms);
    const res = await search({ callId: "call-ok", originState: "GA", equipmentType: "DRY_VAN" }, target);
    await target.close();
    expect(res.json()).toMatchObject({ status: "tms_unavailable", loads: [] });
  });

  it("answers tms_unavailable when the board does not respond", async () => {
    const res = await withFake(["empty-close"], (target) =>
      search({ callId: "call-ok", originState: "GA", equipmentType: "DRY_VAN" }, target),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "tms_unavailable", loads: [] });
    expect(res.body).not.toContain(config.TMS_TOKEN);
  });

  it("answers invalid_request with HTTP 200 for a malformed body", async () => {
    for (const payload of [
      { callId: "call-ok", originState: "", equipmentType: "DRY_VAN" },
      { callId: "call-ok", originState: "Georgia", equipmentType: "DRY_VAN" },
      { callId: "call-ok", originState: "GA", equipmentType: "SPACESHIP" },
      { callId: "call-ok", originState: "GA", equipmentType: "DRY_VAN", pickupDate: "2026-02-30" },
    ]) {
      const res = await search(payload);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "invalid_request", loads: [] });
    }
  });

  it("records a search that reached the board with its pitched and dropped counts", async () => {
    const tms = {
      queryLoads: vi.fn(async () => ["LD1", "LD2"].map((id) => summary(id, "OPEN"))),
      getLoad: vi.fn(async (loadId: string) => detail(loadId, "OPEN")),
    };
    // Estimates start in candidate order: the first load is impossible, the second deliverable.
    let started = 0;
    const estimate = vi.fn<TripEstimates["estimate"]>(async () => ({ feasibility: started++ === 0 ? "impossible" : "solo" }) as TripSnapshot);
    const target = serverWith(tms, { estimate });
    const res = await search({ callId: "call-ok", originState: "TX", destinationState: "GA", equipmentType: "REEFER" }, target);
    await target.close();
    expect(res.json()).toMatchObject({ status: "ok" });
    await vi.waitFor(() => expect(searchInserts).toHaveLength(1));
    expect(searchInserts[0]).toMatch(
      /VALUES \(E'call-ok', NULL, E'TX', NULL, NULL, E'GA', NULL, E'REEFER', NULL, 1, 1\)$/,
    );
  });

  it("records a search with no match as zero results and any equipment as NULL", async () => {
    const tms = { queryLoads: vi.fn(async () => []), getLoad: vi.fn() };
    const target = serverWith(tms);
    const res = await search({ callId: "call-ok", originState: "TX", equipmentType: "any" }, target);
    await target.close();
    expect(res.json()).toMatchObject({ status: "no_loads" });
    await vi.waitFor(() => expect(searchInserts).toHaveLength(1));
    expect(searchInserts[0]).toMatch(/VALUES \(E'call-ok', NULL, E'TX', NULL, NULL, NULL, NULL, NULL, NULL, 0, 0\)$/);
  });

  it("records nothing when the board or the call lookup is unavailable, or the call is not verified", async () => {
    await withFake(["empty-close"], (target) => search({ callId: "call-ok", originState: "GA", equipmentType: "DRY_VAN" }, target));
    await search({ callId: "call-unverified", originState: "GA" });
    // Give a stray fire-and-forget insert the time it would need to land.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(searchInserts).toEqual([]);
  });

  it("still answers the carrier when the search cannot be recorded", async () => {
    failSearchInsert = true;
    const tms = { queryLoads: vi.fn(async () => []), getLoad: vi.fn() };
    const target = serverWith(tms);
    const res = await search({ callId: "call-ok", originState: "TX" }, target);
    await target.close();
    expect(res.json()).toMatchObject({ status: "no_loads" });
  });

  it("stays behind the agent key", async () => {
    const res = await post("/v1/loads/search", { callId: "call-ok", originState: "GA", equipmentType: "DRY_VAN" }, app, config.OPERATOR_API_KEY);
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/offers/evaluate", () => {
  // LD00881: posted 2093, max buy 2538, gap 445 -> scheduled counters 2225 / 2350 / 2425.
  it("counts rounds server-side, follows the schedule, and rejects after round 3", async () => {
    const responses = [];
    for (let i = 0; i < 4; i++) {
      const res = await evaluate({ callId: "call-ok", loadId: "ld00881", carrierAsk: 3000, round: 1 });
      expectNoMaxBuy(res.body);
      responses.push(res.json());
    }
    expect(responses.map((r) => [r.decision, r.rateToSay, r.round, r.isFinalRound])).toEqual([
      ["counter", 2225, 1, false],
      ["counter", 2350, 2, false],
      ["counter", 2425, 3, true],
      ["reject", null, 4, true],
    ]);
    expect(responses[2].message).toBe("$2,425 is the best I can do on this load.");
    expect(offers.map((o) => [o.round, o.decision, o.rateToSay])).toEqual([
      [1, "counter", 2225],
      [2, "counter", 2350],
      [3, "counter", 2425],
      [4, "reject", null],
    ]);
  });

  it("adds an operator authorization to the counter for that load only", async () => {
    authorized.set("call-ok|LD00881", 50);
    const res = await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 3000 });
    expectNoMaxBuy(res.body);
    expect(res.json()).toMatchObject({ decision: "counter", rateToSay: 2275, round: 1 });
    expect(sqlLog.find((text) => text.includes("FROM interventions"))).toMatch(/i\.kind = 'authorization'/);
    expect((await evaluate({ callId: "call-ok", loadId: "LD00848", carrierAsk: 9000 })).json().rateToSay).not.toBe(2275);
  });

  it("never lets an authorization lift the counter past the max buy", async () => {
    authorized.set("call-ok|LD00881", 900);
    for (let i = 0; i < 3; i++) await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 3000 });
    // 2,425 scheduled + 900 authorized is capped at the 2,538 max buy.
    expect(offers.map((o) => o.rateToSay)).toEqual([2538, 2538, 2538]);
    expect((await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 2539 })).json().decision).toBe("reject");
  });

  it("stores the load's posted rate and max buy with the offer, never in the response", async () => {
    const res = await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 3000 });
    expectNoMaxBuy(res.body);
    expect(sqlLog.find((text) => text.startsWith("INSERT INTO offers"))).toMatch(/posted_rate, max_buy,/);
    expect(offers).toEqual([expect.objectContaining({ round: 1, postedRate: 2093, maxBuy: 2538 })]);
  });

  it("stores the load's lane with the offer so the operator map needs no TMS read", async () => {
    const res = await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 2300 });
    expectNoMaxBuy(res.body);
    expect(res.body).not.toMatch(/Savannah|31401|origin/i);
    expect(sqlLog.find((text) => text.startsWith("INSERT INTO offers"))).toMatch(
      /origin_city, origin_state, origin_zip, destination_city, destination_state, destination_zip, equipment, miles, pickup_at\)/,
    );
    expect(offers[0]?.lane).toEqual([
      "E'Savannah'",
      "E'GA'",
      "E'31401'",
      "E'Wichita'",
      "E'KS'",
      "E'67202'",
      "E'DRY_VAN'",
      "997",
      "E'20261003141300'",
    ]);
  });

  it("reads the carrier's ask when the agent sends it as a digit string", async () => {
    const res = (await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: "1950" })).json();
    expect(res).toMatchObject({ status: "ok", decision: "accept", rateToSay: 1950 });
  });

  it("accepts at the carrier's ask and never says more than asked", async () => {
    const low = (await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 1950 })).json();
    expect(low).toEqual({
      status: "ok",
      message: "$1,950 works for us on this load.",
      decision: "accept",
      rateToSay: 1950,
      round: 1,
      isFinalRound: false,
    });
    const between = (await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 2300 })).json();
    expect(between).toMatchObject({ decision: "accept", rateToSay: 2300, round: 2 });
  });

  it("keeps rounds separate per load", async () => {
    await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 3000 });
    const other = (await evaluate({ callId: "call-ok", loadId: "LD00848", carrierAsk: 9000 })).json();
    expect(other).toMatchObject({ decision: "counter", round: 1 });
    expect(other.rateToSay).toBeLessThanOrEqual(7684);
  });

  it("refuses an unverified call without touching the TMS or recording an offer", async () => {
    const before = fake.requests.length;
    for (const callId of ["call-unverified", "call-unknown"]) {
      const res = await evaluate({ callId, loadId: "LD00881", carrierAsk: 2000 });
      expect(res.json()).toMatchObject({ status: "not_verified", decision: null, rateToSay: null });
    }
    expect(fake.requests.length).toBe(before);
    expect(offers).toEqual([]);
  });

  it("answers load_unavailable for a load that is not OPEN or not found", async () => {
    const tms = { queryLoads: vi.fn(async () => []), getLoad: vi.fn(async (id: string) => detail(id, "BOOKED")) };
    const target = serverWith(tms);
    const booked = (await evaluate({ callId: "call-ok", loadId: "LD1", carrierAsk: 2000 }, target)).json();
    await target.close();
    expect(booked).toMatchObject({ status: "load_unavailable", decision: null });
    const missing = (await evaluate({ callId: "call-ok", loadId: "LD99999", carrierAsk: 2000 })).json();
    expect(missing).toMatchObject({ status: "load_unavailable", decision: null });
    expect(offers).toEqual([]);
  });

  it("answers load_unavailable when another call holds the load, without touching the TMS", async () => {
    activeHolds.set("LD00881", "call-other");
    const before = fake.requests.length;
    const res = (await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 2000 })).json();
    expect(res).toMatchObject({ status: "load_unavailable", decision: null });
    expect(fake.requests.length).toBe(before);
    expect(offers).toEqual([]);

    activeHolds.set("LD00881", "call-ok");
    expect((await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 2000 })).json()).toMatchObject({ status: "ok" });
  });

  it("answers tms_unavailable when the board does not respond", async () => {
    const res = await withFake(["silence"], (target) => evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 2000 }, target));
    expect(res.json()).toMatchObject({ status: "tms_unavailable", decision: null });
    expect(offers).toEqual([]);
  });

  it("answers retry when a concurrent request already took the round", async () => {
    twinFetch.mockImplementationOnce(async () =>
      jsonResponse({ command: "SELECT", rowCount: 1, rows: [{ verified: true, prior_rounds: "0", held_elsewhere: false, authorized_usd: "0" }], truncated: false }),
    );
    offers.push({ callId: "call-ok", loadId: "LD00881", round: 1, carrierAsk: 2600, decision: "counter", rateToSay: 2225 });
    const res = (await evaluate({ callId: "call-ok", loadId: "LD00881", carrierAsk: 2600 })).json();
    expect(res).toMatchObject({ status: "retry", decision: null, rateToSay: null });
  });

  it("answers invalid_request with HTTP 200 for a malformed body", async () => {
    for (const payload of [
      { callId: "call-ok", loadId: "LD00881", carrierAsk: 0 },
      { callId: "call-ok", loadId: "LD00881", carrierAsk: 2150.5 },
      { callId: "call-ok", loadId: "LD-0|881", carrierAsk: 2150 },
      { callId: "call-ok", carrierAsk: 2150 },
    ]) {
      const res = await evaluate(payload);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "invalid_request", decision: null });
    }
  });
});
