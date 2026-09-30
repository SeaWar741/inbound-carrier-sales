import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { testConfig } from "./test-config.ts";
import { dieselCacheMs } from "../src/constants.ts";
import { estimateTrip, laneDieselPerGal, soloLegalHours, teamLegalHours } from "../src/domain/trip-estimate.ts";
import { EiaClient } from "../src/infra/eia-client.ts";
import { OrsClient } from "../src/infra/ors-client.ts";
import { TripEstimator, zip3Centroids, type TripRequest } from "../src/infra/trip-estimator.ts";

const fixture = (path: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${path}.json`, import.meta.url), "utf8"));
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("soloLegalHours", () => {
  it("adds no break up to 8 h of driving", () => {
    expect(soloLegalHours(0)).toBe(0);
    expect(soloLegalHours(8)).toBe(8);
  });

  it("adds a 30 min break once a shift drives past 8 h", () => {
    expect(soloLegalHours(9)).toBe(9.5);
    expect(soloLegalHours(11)).toBe(11.5);
  });

  it("adds 10 h off duty between 11 h shifts, and a break only where the last shift passes 8 h", () => {
    expect(soloLegalHours(19)).toBe(19 + 0.5 + 10);
    expect(soloLegalHours(20)).toBe(20 + 0.5 * 2 + 10);
    expect(soloLegalHours(22)).toBe(22 + 0.5 * 2 + 10);
    expect(soloLegalHours(23)).toBe(23 + 0.5 * 2 + 10 * 2);
  });
});

describe("teamLegalHours", () => {
  it("drives 22 of every 24 hours", () => {
    expect(teamLegalHours(22)).toBe(24);
    expect(teamLegalHours(11)).toBe(12);
  });
});

describe("laneDieselPerGal", () => {
  const prices = new Map([
    ["NUS", 6.4],
    ["R50", 7.4],
    ["R1Y", 6.5],
    ["SCA", 8.2],
  ]);

  it("averages the origin and destination area prices", () => {
    expect(laneDieselPerGal(prices, "WA", "MD")).toBeCloseTo(6.95);
  });

  it("prices California on its own series", () => {
    expect(laneDieselPerGal(prices, "CA", "CA")).toBe(8.2);
  });

  it("falls back to the national price for an unknown state or a missing area", () => {
    expect(laneDieselPerGal(prices, "PR", "WA")).toBeCloseTo(6.9);
    expect(laneDieselPerGal(prices, "TX", "TX")).toBe(6.4);
    expect(laneDieselPerGal(new Map([["R50", 7]]), "PR", "WA")).toBeUndefined();
  });
});

describe("estimateTrip", () => {
  // 1,000 mi at 50 mph = 20 h of driving: 31 h solo (2 breaks + 10 h off), 21.8 h as a team.
  const base = {
    miles: 1000,
    rate: 3000,
    pickupAt: new Date("2026-10-01T12:00:00Z"),
    avgMph: 50,
    tollShare: 0.2,
    dieselPerGal: 6.3,
  };

  it("prices diesel and tolls in whole dollars and nets them off the rate", () => {
    const estimate = estimateTrip({ ...base, deliveryAt: new Date("2026-10-03T12:00:00Z") });
    // 1,000 / 6.3 mpg x $6.30 = $1,000; 1,000 x 0.2 x $0.226 = $45.2.
    expect(estimate.dieselUsd).toBe(1000);
    expect(estimate.tollsUsd).toBe(45);
    expect(estimate.rate).toBe(3000);
    expect(estimate.carrierNetUsd).toBe(1955);
    expect(estimate.dieselPerGal).toBe(6.3);
    expect(estimate.tollShare).toBe(0.2);
  });

  it("is solo when a single driver fits the window", () => {
    const estimate = estimateTrip({ ...base, deliveryAt: new Date("2026-10-02T19:00:00Z") });
    expect(estimate).toMatchObject({ legalHours: 31, feasibility: "solo" });
    expect(estimate.legalEtaAt).toBe("2026-10-02T19:00:00.000Z");
    expect(estimate.netPerHour).toBe(Math.round(1955 / 31));
  });

  it("is team when only a team fits the window", () => {
    const estimate = estimateTrip({ ...base, deliveryAt: new Date("2026-10-02T10:00:00Z") });
    expect(estimate).toMatchObject({ legalHours: 21.8, feasibility: "team" });
    expect(estimate.legalEtaAt).toBe("2026-10-02T09:49:05.454Z");
    expect(estimate.netPerHour).toBe(Math.round(1955 / ((20 * 24) / 22)));
  });

  it("is impossible when not even a team lands within 2 h of the appointment, and gives the team ETA and lateness", () => {
    const deliveryAt = new Date("2026-10-02T06:00:00Z");
    const estimate = estimateTrip({ ...base, deliveryAt });
    expect(estimate.feasibility).toBe("impossible");
    expect(estimate.legalEtaAt).toBe("2026-10-02T09:49:05.454Z");
    expect(estimate.deliveryAt).toBe(deliveryAt.toISOString());
    // Team ETA 09:49 against a 06:00 appointment.
    expect(estimate.lateHours).toBe(3.8);
  });

  it("is on time with no lateness when the crew lands before the appointment", () => {
    expect(estimateTrip({ ...base, deliveryAt: new Date("2026-10-03T12:00:00Z") }).lateHours).toBe(0);
  });

  it("keeps the crew exactly 2 h late, and not 2.1 h late", () => {
    // Solo needs 31 h, landing 2026-10-02T19:00Z; team needs 21.8 h, landing 09:49Z.
    const soloTwoLate = estimateTrip({ ...base, deliveryAt: new Date("2026-10-02T17:00:00Z") });
    expect(soloTwoLate).toMatchObject({ feasibility: "solo", lateHours: 2 });
    const soloTooLate = estimateTrip({ ...base, deliveryAt: new Date("2026-10-02T16:54:00Z") });
    expect(soloTooLate).toMatchObject({ feasibility: "team", lateHours: 0 });

    // 1,100 mi = 22 h of driving: a team needs exactly 24 h, landing 2026-10-02T12:00Z.
    const long = { ...base, miles: 1100 };
    const teamTwoLate = estimateTrip({ ...long, deliveryAt: new Date("2026-10-02T10:00:00Z") });
    expect(teamTwoLate).toMatchObject({ feasibility: "team", lateHours: 2 });
    const teamTooLate = estimateTrip({ ...long, deliveryAt: new Date("2026-10-02T09:54:00Z") });
    expect(teamTooLate).toMatchObject({ feasibility: "impossible", lateHours: 2.1 });
  });
});

describe("TripEstimator", () => {
  const centroids = new Map([
    ["984", [-122.44, 47.25] as const],
    ["212", [-76.61, 39.29] as const],
  ]);
  // LD00879 from the 2026-09-28 board snapshot, pickup and delivery read as Chicago wall clock.
  const ld00879: TripRequest = {
    origin: { zip: "98402", state: "WA" },
    destination: { zip: "21202", state: "MD" },
    miles: 2335,
    pickupAt: new Date("2026-10-01T14:32:00-05:00"),
    deliveryAt: new Date("2026-10-02T20:32:00-05:00"),
    rate: 7600,
  };

  function vendorFetch(overrides: { eia?: () => Response; ors?: () => Response } = {}) {
    return vi.fn<typeof fetch>(async (input) => {
      const host = new URL(String(input)).hostname;
      if (host === "api.eia.gov") return overrides.eia?.() ?? jsonResponse(fixture("eia/diesel-weekly"));
      if (host === "api.openrouteservice.org") return overrides.ors?.() ?? jsonResponse(fixture("ors/tacoma-baltimore"));
      return jsonResponse({ error: "not mocked" }, 500);
    });
  }

  function estimatorWith(fetchImpl: typeof fetch, now = () => 0) {
    return new TripEstimator({
      eia: new EiaClient({ apiKey: "eia-key", fetch: fetchImpl }),
      ors: new OrsClient({ apiKey: "ors-key", fetch: fetchImpl }),
      centroids,
      now,
    });
  }

  const log = () => ({ warn: vi.fn() });
  const calls = (fetchMock: ReturnType<typeof vendorFetch>, host: string) =>
    fetchMock.mock.calls.filter(([input]) => new URL(String(input)).hostname === host).length;

  it("estimates a lane from the routed speed, toll share and area diesel prices", async () => {
    const estimate = await estimatorWith(vendorFetch()).estimate(ld00879, log());
    // 2,784.065 mi in 220,630.2 s = 45.43 mph; diesel = mean of R50 7.357 and R1Y 6.531.
    const avgMph = 2784.065 / (220630.2 / 3600);
    const dieselPerGal = (7.357 + 6.531) / 2;
    expect(estimate).toEqual(
      estimateTrip({ miles: 2335, rate: 7600, pickupAt: ld00879.pickupAt, deliveryAt: ld00879.deliveryAt, avgMph, tollShare: 20.74 / 100, dieselPerGal }),
    );
    expect(estimate?.feasibility).toBe("impossible");
  });

  it("routes a lane once and shares parallel lookups", async () => {
    const fetchMock = vendorFetch();
    const estimator = estimatorWith(fetchMock);
    await Promise.all([estimator.estimate(ld00879, log()), estimator.estimate(ld00879, log())]);
    await estimator.estimate({ ...ld00879, origin: { zip: "98499", state: "WA" } }, log());
    expect(calls(fetchMock, "api.openrouteservice.org")).toBe(1);
    expect(calls(fetchMock, "api.eia.gov")).toBe(1);
  });

  it("refreshes diesel once the cache is a week old", async () => {
    const fetchMock = vendorFetch();
    let now = 0;
    const estimator = estimatorWith(fetchMock, () => now);
    await estimator.estimate(ld00879, log());
    now = dieselCacheMs - 1;
    await estimator.estimate(ld00879, log());
    expect(calls(fetchMock, "api.eia.gov")).toBe(1);
    now = dieselCacheMs;
    await estimator.estimate(ld00879, log());
    expect(calls(fetchMock, "api.eia.gov")).toBe(2);
  });

  it("answers null and warns on a vendor error, then retries on the next call", async () => {
    let orsStatus = 429;
    const fetchMock = vendorFetch({ ors: () => (orsStatus === 200 ? jsonResponse(fixture("ors/tacoma-baltimore")) : jsonResponse({}, orsStatus)) });
    const estimator = estimatorWith(fetchMock);
    const warnLog = log();
    expect(await estimator.estimate(ld00879, warnLog)).toBeNull();
    expect(warnLog.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), "trip estimate unavailable");
    orsStatus = 200;
    expect(await estimator.estimate(ld00879, log())).not.toBeNull();
    expect(calls(fetchMock, "api.openrouteservice.org")).toBe(2);
  });

  it("answers null and warns on a diesel outage", async () => {
    const warnLog = log();
    const estimate = await estimatorWith(vendorFetch({ eia: () => jsonResponse({}, 503) })).estimate(ld00879, warnLog);
    expect(estimate).toBeNull();
    expect(warnLog.warn).toHaveBeenCalledOnce();
  });

  it("answers null without a vendor call for a ZIP3 it cannot place", async () => {
    const fetchMock = vendorFetch();
    const warnLog = log();
    const estimate = await estimatorWith(fetchMock).estimate({ ...ld00879, destination: { zip: "00000", state: "MD" } }, warnLog);
    expect(estimate).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnLog.warn).toHaveBeenCalledWith({ originZip3: "984", destinationZip3: "000" }, "trip estimate skipped: unknown ZIP3");
  });

  it("is off without both vendor keys", async () => {
    const warnLog = log();
    expect(testConfig.EIA_API_KEY).toBeUndefined();
    expect(await TripEstimator.fromConfig(testConfig, centroids).estimate(ld00879, warnLog)).toBeNull();
    expect(await TripEstimator.fromConfig({ EIA_API_KEY: "k" }, centroids).estimate(ld00879, warnLog)).toBeNull();
    expect(warnLog.warn).not.toHaveBeenCalled();
  });

  it("reads the control tower's ZIP3 centroids as [lng, lat]", () => {
    const [lng, lat] = zip3Centroids.get("984") ?? [];
    expect(lng).toBeCloseTo(-122.4, 0);
    expect(lat).toBeCloseTo(47.2, 0);
  });
});
