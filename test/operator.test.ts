import { afterAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { operatorWallResponse } from "../src/contract.ts";
import { TmsHealthRecorder } from "../src/infra/tms/tms-health.ts";
import { TwinError, type SqlStatement } from "../src/infra/twin-client.ts";
import { callRow, operatorWallRoutes, toWallCall } from "../src/routes/operator.ts";
import { buildServer } from "../src/server.ts";
import { testConfig } from "./test-config.ts";

// Shaped like Twin's answer: int8 and sums as strings.
const wallRow = {
  day: "2026-09-29",
  calls_count: "2",
  offered_count: "1",
  booked_count: "1",
  blocked: "1",
  booked_value: "2300",
  capacity_captured: "4",
  capacity_notified: "2",
  capacity_booked_after_notice: "1",
  autonomy: "human",
};

// The hold's trip snapshot as stored in holds.trip (jsonb), passed through to the wall as is.
const trip = {
  rate: 2300,
  dieselUsd: 620,
  tollsUsd: 45,
  carrierNetUsd: 1635,
  feasibility: "team",
  legalEtaAt: "2026-10-04T20:00:00.000Z",
  legalHours: 30.5,
  netPerHour: 54,
  dieselPerGal: 3.72,
  tollShare: 0.12,
};

// Call rows as Twin nests them in json: nested timestamps with an offset.
const callRows = [
  {
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
        miles: "997",
        pickup_at: "20261003141300",
        created_at: "2026-09-29T15:08:00+00:00",
      },
      {
        load_id: "LD00848",
        round: 1,
        carrier_ask: 7000,
        decision: "counter",
        rate_to_say: 6886,
        posted_rate: 6886,
        max_buy: 7684,
        origin_city: null,
        origin_state: null,
        origin_zip: null,
        destination_city: null,
        destination_state: null,
        destination_zip: null,
        equipment: null,
        miles: null,
        pickup_at: null,
        created_at: "2026-09-29T15:02:00+00:00",
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
      trip,
      created_at: "2026-09-29T15:09:00+00:00",
    },
    events: [
      { tool: "verify_carrier", summary: "MC 123456 verified", status: "ok", created_at: "2026-09-29T15:00:01+00:00" },
      { tool: "create_hold", summary: null, status: "ok", created_at: "2026-09-29T15:09:00+00:00" },
    ],
    interventions: [
      { kind: "authorization", load_id: "LD00881", amount_usd: "50", message: "Authorize +$50", created_at: "2026-09-29T15:07:00+00:00" },
    ],
  },
  {
    call_id: "call-a",
    mc_number: null,
    dot_number: "111",
    eligible: false,
    verified: false,
    otp_attempts: 0,
    otp_expires_at: null,
    created_at: "2026-09-29T14:00:00+00:00",
    human_requested: false,
    offers: [],
    hold: null,
    events: [{ tool: "verify_carrier", summary: null, status: "not_eligible", created_at: "2026-09-29T14:00:01+00:00" }],
    interventions: [],
  },
];

const statements: string[] = [];
let failTwin = false;
const twin = {
  query: async <T>(statement: SqlStatement, rowSchema: z.ZodType<T>): Promise<T[]> => {
    statements.push(statement.text);
    if (failTwin) throw new TwinError("connection reset");
    if (statement.text.startsWith("INSERT INTO interventions")) {
      return statement.text.includes("WHERE call_id = E'call-b'") ? [rowSchema.parse({ id: "0b0c2a5e-8a39-4b8e-9d7e-0f3f2d1c4b5a" })] : [];
    }
    return [rowSchema.parse(wallRow)];
  },
};

const tmsHealth = new TmsHealthRecorder({ now: new Date("2026-09-29T12:00:00.000Z") });
tmsHealth.record({ attempt: 1, latencyMs: 300, outcome: "timeout" });
tmsHealth.record({ attempt: 2, latencyMs: 250, outcome: "ok" });

const app = buildServer(testConfig, { agentRoutes: [], operatorRoutes: [operatorWallRoutes({ twin, tmsHealth })] });
afterAll(() => app.close());

const getWall = (key?: string) =>
  app.inject({ method: "GET", url: "/v1/operator/wall", headers: key ? { "x-api-key": key } : {} });

describe("GET /v1/operator/wall", () => {
  it("rejects the agent key and a missing key", async () => {
    expect((await getWall(testConfig.AGENT_API_KEY)).statusCode).toBe(401);
    expect((await getWall()).statusCode).toBe(401);
  });

  it("returns the day's counters parsed from one Twin row", async () => {
    statements.length = 0;
    const res = await getWall(testConfig.OPERATOR_API_KEY);
    expect(res.statusCode).toBe(200);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("AT TIME ZONE E'America/Chicago'");

    const wall = operatorWallResponse.parse(res.json());
    expect(wall.day).toBe("2026-09-29");
    expect(wall.autonomy).toBe("human");
    expect(wall.counters).toEqual({
      calls: 2,
      offered: 1,
      booked: 1,
      blocked: 1,
      bookedValue: 2300,
      capacity: { captured: 4, notified: 2, bookedAfterNotice: 1 },
    });
    expect(wall.tmsHealth).toEqual({
      since: "2026-09-29T12:00:00.000Z",
      attempts: 2,
      retries: 1,
      faultsAbsorbed: 1,
      latencySamples: 2,
      latencyP50Ms: 250,
      latencyP95Ms: 300,
    });
    expect(statements[0]).not.toContain("json_agg");
  });

  it("answers 503 when Twin fails", async () => {
    failTwin = true;
    try {
      const res = await getWall(testConfig.OPERATOR_API_KEY);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: "service_unavailable" });
    } finally {
      failTwin = false;
    }
  });
});

describe("toWallCall", () => {
  it("maps call rows to wall calls with their stage, risk, lanes and interventions", () => {
    const calls = callRows.map((row) => toWallCall(callRow.parse(row)));
    expect(calls.map((c) => [c.callId, c.stage, c.risk])).toEqual([
      ["call-b", "booked", "green"],
      ["call-a", "ended", "red"],
    ]);
    const [booked] = calls;
    const lane = {
      origin: { city: "Savannah", state: "GA", zip: "31401" },
      destination: { city: "Wichita", state: "KS", zip: "67202" },
      equipment: "DRY_VAN",
      miles: 997,
      pickupAt: "20261003141300",
    };
    expect(booked).toMatchObject({
      mcNumber: "123456",
      otp: { attempts: 1, locked: false, expiresAt: "2026-09-29T15:05:00.123Z" },
      round: 2,
      riskReason: null,
      offers: [
        { loadId: "LD00881", round: 2, carrierAsk: 2300, decision: "accept", rateToSay: 2300, postedRate: 2100, maxBuy: 2500, lane },
        { loadId: "LD00848", round: 1, lane: null },
      ],
      hold: { status: "booked", agreedRate: 2300, maxBuy: 2500, bookingRef: "BR-1", lane, trip, createdAt: "2026-09-29T15:09:00.000Z" },
    });
    // A snapshot stored before lateness and the appointment were recorded reads as on time with none.
    expect(booked?.hold?.trip).toMatchObject({ lateHours: 0, deliveryAt: null });
    expect(booked?.events.map((e) => e.tool)).toEqual(["verify_carrier", "create_hold"]);
    expect(booked?.interventions).toEqual([
      { kind: "authorization", loadId: "LD00881", amountUsd: 50, message: "Authorize +$50", createdAt: "2026-09-29T15:07:00.000Z" },
    ]);
  });
});

const intervene = (callId: string, body: object, key: string = testConfig.OPERATOR_API_KEY) =>
  app.inject({ method: "POST", url: `/v1/operator/calls/${callId}/interventions`, headers: { "x-api-key": key }, payload: body });

describe("POST /v1/operator/calls/:callId/interventions", () => {
  it("rejects the agent key", async () => {
    expect((await intervene("call-b", { kind: "whisper", message: "Offer quick pay" }, testConfig.AGENT_API_KEY)).statusCode).toBe(401);
  });

  it("records an authorization scoped to one load of a known call", async () => {
    statements.length = 0;
    const res = await intervene("call-b", { kind: "authorization", loadId: "ld00881", amountUsd: 50 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "recorded", id: "0b0c2a5e-8a39-4b8e-9d7e-0f3f2d1c4b5a" });
    expect(statements[0]).toContain("E'authorization', E'LD00881', 50");
  });

  it("answers 404 for a call that does not exist", async () => {
    expect((await intervene("call-x", { kind: "whisper", message: "hi" })).statusCode).toBe(404);
  });

  it("refuses an authorization without a load or amount, and money on a whisper", async () => {
    expect((await intervene("call-b", { kind: "authorization", amountUsd: 50 })).statusCode).toBe(400);
    expect((await intervene("call-b", { kind: "authorization", loadId: "LD00881", amountUsd: 0 })).statusCode).toBe(400);
    expect((await intervene("call-b", { kind: "authorization", loadId: "LD00881", amountUsd: 5000 })).statusCode).toBe(400);
    expect((await intervene("call-b", { kind: "whisper", amountUsd: 50 })).statusCode).toBe(400);
  });
});

describe("PUT /v1/operator/settings/autonomy", () => {
  const put = (body: object, key: string = testConfig.OPERATOR_API_KEY) =>
    app.inject({ method: "PUT", url: "/v1/operator/settings/autonomy", headers: { "x-api-key": key }, payload: body });

  it("switches the mode with the operator key only", async () => {
    expect((await put({ mode: "autonomous" }, testConfig.AGENT_API_KEY)).statusCode).toBe(401);
    statements.length = 0;
    const res = await put({ mode: "autonomous" });
    expect(res.json()).toEqual({ status: "ok", mode: "autonomous" });
    expect(statements[0]).toContain("ON CONFLICT (key) DO UPDATE");
    expect((await put({ mode: "yolo" })).statusCode).toBe(400);
  });
});
