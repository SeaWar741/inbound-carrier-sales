import { afterAll, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { operatorLoadsResponse } from "../src/contract.ts";
import { TwinError, type SqlStatement } from "../src/infra/twin-client.ts";
import { operatorInboxRoutes } from "../src/routes/operator-inbox.ts";
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

const statements: string[] = [];
let failTwin = false;
const twin = {
  query: async <T>(statement: SqlStatement, rowSchema: z.ZodType<T>): Promise<T[]> => {
    statements.push(statement.text);
    if (failTwin) throw new TwinError("connection reset");
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
