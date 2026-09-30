import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { TripEstimate } from "../src/domain/trip-estimate.ts";
import type { LoadDetail } from "../src/infra/tms/codec.ts";
import { TmsBusinessError, TmsUnavailableError } from "../src/infra/tms/errors.ts";
import type { SqlStatement } from "../src/infra/twin-client.ts";
import { tmsWallClockToDate } from "../src/domain/trip.ts";
import type { TripEstimates } from "../src/infra/trip-estimator.ts";
import { tripRoutes, type TripRouteDeps } from "../src/routes/trips.ts";
import { buildServer } from "../src/server.ts";
import { testConfig } from "./test-config.ts";

type Offer = { callId: string; loadId: string; round: number; decision: string; rateToSay: number | null };

const verifiedCalls = new Map<string, boolean>();
let offers: Offer[] = [];
let twinDown = false;

// Answers the one statement the route sends: the call's verification and our latest rate on the load.
async function query<T>(statement: SqlStatement, rowSchema: z.ZodType<T>): Promise<T[]> {
  if (twinDown) throw new Error("twin down");
  const callId = /c\.call_id = E'([^']*)'\s*$/.exec(statement.text)?.[1] ?? "";
  const loadId = /o\.load_id = E'([^']*)'/.exec(statement.text)?.[1] ?? "";
  const verified = verifiedCalls.get(callId);
  if (verified === undefined) return [];
  const latest = offers
    .filter((o) => o.callId === callId && o.loadId === loadId)
    .toSorted((a, b) => b.round - a.round)[0];
  return [rowSchema.parse({ verified, rate_to_say: latest?.rateToSay == null ? null : String(latest.rateToSay) })];
}

const load: LoadDetail = {
  loadId: "LD00879",
  origCity: "Tacoma",
  origState: "WA",
  origZip: "98499",
  destCity: "Baltimore",
  destState: "MD",
  destZip: "21201",
  pickupDateTime: "20261003141300",
  deliveryDateTime: "20261006111300",
  equipmentType: "DRY_VAN",
  rate: 7600,
  miles: 2335,
  status: "OPEN",
  weight: 40000,
  commodity: "Paper",
  pieces: 20,
  dims: "53ft",
  notes: "",
  maxBuy: 8123,
};

const estimateAt = (rate: number, feasibility: TripEstimate["feasibility"] = "solo"): TripEstimate => ({
  dieselUsd: 2573,
  tollsUsd: 109,
  carrierNetUsd: rate - 2573 - 109,
  legalHours: 97.4,
  feasibility,
  legalEtaAt: new Date("2026-10-07T20:37:00.000Z"),
  netPerHour: 50,
  dieselPerGal: 6.944,
  tollShare: 0.2074,
});

let tms: { getLoad: ReturnType<typeof vi.fn<TripRouteDeps["tms"]["getLoad"]>> };
let estimate: ReturnType<typeof vi.fn<TripEstimates["estimate"]>>;

const app = () => buildServer(testConfig, { agentRoutes: [tripRoutes({ tms, twin: { query }, trips: { estimate } })], operatorRoutes: [] });

async function post(payload: object, key = testConfig.AGENT_API_KEY) {
  const server = app();
  try {
    return await server.inject({ method: "POST", url: "/v1/trips/estimate", headers: { "x-api-key": key }, payload });
  } finally {
    await server.close();
  }
}

beforeEach(() => {
  verifiedCalls.clear();
  verifiedCalls.set("call-ok", true);
  verifiedCalls.set("call-unverified", false);
  offers = [];
  twinDown = false;
  tms = { getLoad: vi.fn(async () => load) };
  estimate = vi.fn(async (trip) => estimateAt(trip.rate));
});

describe("tmsWallClockToDate", () => {
  it("reads the TMS wall clock as Chicago time, daylight and standard", () => {
    expect(tmsWallClockToDate("20261003141300").toISOString()).toBe("2026-10-03T19:13:00.000Z");
    expect(tmsWallClockToDate("20261215080000").toISOString()).toBe("2026-12-15T14:00:00.000Z");
  });
});

describe("POST /v1/trips/estimate", () => {
  it("estimates a verified call's trip at the posted rate before any offer", async () => {
    const res = await post({ callId: "call-ok", loadId: "ld00879" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      message: "At $7,600, after about $2,573 in diesel and about $109 in tolls, you'd keep about $4,918.",
      rate: 7600,
      dieselUsd: 2573,
      tollsUsd: 109,
      carrierNetUsd: 4918,
      feasibility: "solo",
      legalEtaAt: "2026-10-07T20:37:00.000Z",
      netPerHour: 50,
    });
    expect(res.body).not.toMatch(/max_?buy|8123/i);
    expect(tms.getLoad).toHaveBeenCalledWith("LD00879");
    expect(estimate.mock.calls[0]?.[0]).toEqual({
      origin: { zip: "98499", state: "WA" },
      destination: { zip: "21201", state: "MD" },
      miles: 2335,
      pickupAt: new Date("2026-10-03T19:13:00.000Z"),
      deliveryAt: new Date("2026-10-06T16:13:00.000Z"),
      rate: 7600,
    });
  });

  it("speaks a few dollars of tolls as next to nothing", async () => {
    estimate.mockImplementationOnce(async (trip) => ({ ...estimateAt(trip.rate), tollsUsd: 3 }));
    const body = (await post({ callId: "call-ok", loadId: "LD00879" })).json();
    expect(body.message).toMatch(/in diesel and next to nothing in tolls, you'd keep/);
    expect(body.tollsUsd).toBe(3);
  });

  it("estimates at our latest round on this load, not an earlier one or another load's", async () => {
    offers = [
      { callId: "call-ok", loadId: "LD00879", round: 1, decision: "counter", rateToSay: 7400 },
      { callId: "call-ok", loadId: "LD00879", round: 2, decision: "counter", rateToSay: 7500 },
      { callId: "call-ok", loadId: "LD00848", round: 1, decision: "accept", rateToSay: 9000 },
    ];
    const res = await post({ callId: "call-ok", loadId: "LD00879" });
    expect(res.json()).toMatchObject({ status: "ok", rate: 7500, carrierNetUsd: 7500 - 2573 - 109 });
    expect(res.json().message).toMatch(/^At \$7,500,/);
    expect(estimate.mock.calls[0]?.[0].rate).toBe(7500);
  });

  it("falls back to the posted rate when the latest round was a reject", async () => {
    offers = [
      { callId: "call-ok", loadId: "LD00879", round: 1, decision: "counter", rateToSay: 7500 },
      { callId: "call-ok", loadId: "LD00879", round: 2, decision: "reject", rateToSay: null },
    ];
    expect((await post({ callId: "call-ok", loadId: "LD00879" })).json()).toMatchObject({ status: "ok", rate: 7600 });
    expect(estimate.mock.calls[0]?.[0].rate).toBe(7600);
  });

  it("names a window that needs a team or cannot be made legally", async () => {
    estimate.mockImplementation(async (trip) => estimateAt(trip.rate, "team"));
    expect((await post({ callId: "call-ok", loadId: "LD00879" })).json().message).toMatch(/you'd keep about \$4,918\. That delivery window needs a team\.$/);
    estimate.mockImplementation(async (trip) => estimateAt(trip.rate, "impossible"));
    const impossible = (await post({ callId: "call-ok", loadId: "LD00879" })).json();
    expect(impossible).toMatchObject({ status: "ok", feasibility: "impossible" });
    expect(impossible.message).toMatch(/ That delivery window is too tight to make legally\.$/);
  });

  it("refuses an unverified or unknown call without touching the TMS or the estimator", async () => {
    for (const callId of ["call-unverified", "call-unknown"]) {
      const res = await post({ callId, loadId: "LD00879" });
      expect(res.json()).toEqual({
        status: "not_verified",
        message: "I need to verify your carrier before I can go over trip costs.",
        rate: null,
        dieselUsd: null,
        tollsUsd: null,
        carrierNetUsd: null,
        feasibility: null,
        legalEtaAt: null,
        netPerHour: null,
      });
    }
    expect(tms.getLoad).not.toHaveBeenCalled();
    expect(estimate).not.toHaveBeenCalled();
  });

  it("answers estimate_unavailable when the estimator has nothing", async () => {
    estimate.mockResolvedValueOnce(null);
    expect((await post({ callId: "call-ok", loadId: "LD00879" })).json()).toMatchObject({ status: "estimate_unavailable", rate: null, feasibility: null });
  });

  it("answers load_unavailable for a load that is not OPEN or not found", async () => {
    tms.getLoad.mockResolvedValueOnce({ ...load, status: "BOOKED" });
    expect((await post({ callId: "call-ok", loadId: "LD00879" })).json()).toMatchObject({ status: "load_unavailable" });
    tms.getLoad.mockRejectedValueOnce(new TmsBusinessError("LOAD_GET", 1, false, "NOT_FOUND", "Load not found"));
    expect((await post({ callId: "call-ok", loadId: "LD00879" })).json()).toMatchObject({ status: "load_unavailable" });
    expect(estimate).not.toHaveBeenCalled();
  });

  it("answers tms_unavailable and service_unavailable on outages", async () => {
    tms.getLoad.mockRejectedValueOnce(new TmsUnavailableError("LOAD_GET", 3, false, "timeout"));
    expect((await post({ callId: "call-ok", loadId: "LD00879" })).json()).toMatchObject({ status: "tms_unavailable" });
    twinDown = true;
    expect((await post({ callId: "call-ok", loadId: "LD00879" })).json()).toMatchObject({ status: "service_unavailable" });
  });

  it("answers invalid_request with HTTP 200 for a malformed body", async () => {
    for (const payload of [{ callId: "call-ok" }, { callId: "call-ok", loadId: "LD-879" }]) {
      const res = await post(payload);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "invalid_request", rate: null });
    }
  });

  it("stays behind the agent key", async () => {
    const res = await post({ callId: "call-ok", loadId: "LD00879" }, testConfig.OPERATOR_API_KEY);
    expect(res.statusCode).toBe(401);
    expect(tms.getLoad).not.toHaveBeenCalled();
  });
});
