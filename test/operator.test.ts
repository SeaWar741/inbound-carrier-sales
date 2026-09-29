import { afterAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { operatorWallResponse } from "../src/contract.ts";
import { TmsHealthRecorder } from "../src/infra/tms/tms-health.ts";
import { TwinError, type SqlStatement } from "../src/infra/twin-client.ts";
import { operatorWallRoutes } from "../src/routes/operator.ts";
import { buildServer } from "../src/server.ts";
import { testConfig } from "./test-config.ts";

// Shaped like Twin's answer: int8 and sums as strings, json columns parsed, nested timestamps with an offset.
const wallRow = {
  day: "2026-09-29",
  calls_count: "2",
  booked_count: "1",
  fraud_blocked: "1",
  dollars_generated: "2300",
  margin_saved: "200",
  calls: [
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
        created_at: "2026-09-29T15:09:00+00:00",
      },
      events: [
        { tool: "verify_carrier", summary: "MC 123456 verified", status: "ok", created_at: "2026-09-29T15:00:01+00:00" },
        { tool: "create_hold", summary: null, status: "ok", created_at: "2026-09-29T15:09:00+00:00" },
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
    },
  ],
};

const statements: string[] = [];
let failTwin = false;
const twin = {
  query: async <T>(statement: SqlStatement, rowSchema: z.ZodType<T>): Promise<T[]> => {
    statements.push(statement.text);
    if (failTwin) throw new TwinError("connection reset");
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

  it("returns the wall parsed from one Twin row", async () => {
    statements.length = 0;
    const res = await getWall(testConfig.OPERATOR_API_KEY);
    expect(res.statusCode).toBe(200);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("AT TIME ZONE E'America/Chicago'");

    const wall = operatorWallResponse.parse(res.json());
    expect(wall.day).toBe("2026-09-29");
    expect(wall.counters).toEqual({ calls: 2, booked: 1, fraudBlocked: 1, dollarsGenerated: 2300, marginSaved: 200 });
    expect(wall.tmsHealth).toEqual({
      since: "2026-09-29T12:00:00.000Z",
      attempts: 2,
      retries: 1,
      faultsAbsorbed: 1,
      latencySamples: 2,
      latencyP50Ms: 250,
      latencyP95Ms: 300,
    });
    expect(wall.calls.map((c) => [c.callId, c.stage, c.risk])).toEqual([
      ["call-b", "booked", "green"],
      ["call-a", "ended", "red"],
    ]);
    const [booked] = wall.calls;
    expect(booked).toMatchObject({
      mcNumber: "123456",
      otp: { attempts: 1, locked: false, expiresAt: "2026-09-29T15:05:00.123Z" },
      round: 2,
      riskReason: null,
      offers: [{ loadId: "LD00881", round: 2, carrierAsk: 2300, decision: "accept", rateToSay: 2300, postedRate: 2100, maxBuy: 2500 }],
      hold: { status: "booked", agreedRate: 2300, maxBuy: 2500, bookingRef: "BR-1", createdAt: "2026-09-29T15:09:00.000Z" },
    });
    expect(booked?.events.map((e) => e.tool)).toEqual(["verify_carrier", "create_hold"]);
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
