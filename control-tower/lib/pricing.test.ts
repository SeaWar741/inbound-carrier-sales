import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TowerCall, WallOffer } from "./contracts.ts";
import { average, carrierPricing, loadOutcome, marginKept, negotiationPath, perMile, pricingBreakdown } from "./pricing.ts";

const lane = (miles: number) => ({
  origin: { city: "Albuquerque", state: "NM", zip: "87102" },
  destination: { city: "Corpus Christi", state: "TX", zip: "78401" },
  equipment: "REEFER",
  miles,
  pickupAt: "20260929193401",
});

const offer = (loadId: string, round: number, carrierAsk: number, rateToSay: number | null, createdAt: string, miles = 1000): WallOffer => ({
  loadId,
  round,
  carrierAsk,
  decision: rateToSay === null ? "reject" : "counter",
  rateToSay,
  postedRate: 2000,
  maxBuy: 2200,
  lane: lane(miles),
  createdAt,
});

type Priced = Pick<TowerCall, "offers" | "hold" | "live" | "createdAt">;
const call = (offers: WallOffer[], hold: { loadId: string; status: "held" | "confirming" | "booked" | "booked_unconfirmed" | "released"; agreedRate: number; createdAt: string } | null = null, live = false): Priced => ({
  offers,
  live,
  createdAt: offers[0]?.createdAt ?? "2026-09-29T10:00:00.000Z",
  hold: hold && {
    holdId: `h-${hold.loadId}-${hold.createdAt}`,
    bookingRef: null,
    postedRate: 2000,
    maxBuy: 2200,
    lane: lane(1000),
    ...hold,
  },
});

describe("marginKept", () => {
  it("answers dollars under the ceiling and the share of it", () => {
    assert.deepEqual(marginKept(2200, 2100), { usd: 100, pct: (100 / 2200) * 100 });
  });
  it("goes negative over the ceiling and null without numbers", () => {
    assert.equal(marginKept(2200, 2300)?.usd, -100);
    assert.equal(marginKept(null, 2100), null);
    assert.equal(marginKept(2200, null), null);
  });
  it("does not divide by a zero ceiling", () => {
    assert.deepEqual(marginKept(0, 0), { usd: 0, pct: 0 });
  });
});

describe("perMile", () => {
  it("divides by known miles only", () => {
    assert.equal(perMile(2000, 1000), 2);
    assert.equal(perMile(2000, 0), null);
    assert.equal(perMile(2000, null), null);
    assert.equal(perMile(2000, undefined), null);
    assert.equal(perMile(null, 1000), null);
  });
});

describe("average", () => {
  it("answers null for an empty set", () => {
    assert.equal(average([]), null);
    assert.equal(average([1, 2, 3]), 2);
  });
});

describe("negotiationPath", () => {
  it("collects the load's offers across calls, oldest first", () => {
    const calls = [
      call([offer("LD1", 3, 2400, 2150, "2026-09-29T12:00:00.000Z")]),
      call([offer("LD2", 1, 3000, 2600, "2026-09-29T11:30:00.000Z")]),
      call([offer("LD1", 1, 2500, 2050, "2026-09-29T11:00:00.000Z")]),
    ];
    assert.deepEqual(
      negotiationPath(calls, "LD1").map((o) => o.round),
      [1, 3],
    );
    assert.deepEqual(negotiationPath([], "LD1"), []);
  });
});

describe("loadOutcome", () => {
  const at = "2026-09-29T12:00:00.000Z";
  it("follows the newest hold on the load", () => {
    const calls = [
      call([offer("LD1", 3, 2400, 2150, at)], { loadId: "LD1", status: "booked", agreedRate: 2150, createdAt: "2026-09-29T12:05:00.000Z" }),
      call([offer("LD1", 2, 2400, 2100, at)], { loadId: "LD1", status: "released", agreedRate: 2100, createdAt: "2026-09-29T11:05:00.000Z" }),
    ];
    assert.deepEqual(loadOutcome(calls, "LD1"), { kind: "booked", amount: 2150 });
    assert.deepEqual(loadOutcome([calls[1]!], "LD1"), { kind: "lost" });
    assert.deepEqual(
      loadOutcome([call([offer("LD1", 1, 2400, 2100, at)], { loadId: "LD1", status: "held", agreedRate: 2100, createdAt: at })], "LD1"),
      { kind: "holding", amount: 2100 },
    );
  });
  it("reads a hold a rep has not acted on as holding, and a confirmed or unconfirmed booking as booked", () => {
    // LD00879 in the dev data: the agent's last event said "Holding" but the hold row is booked.
    const hold = (status: "held" | "confirming" | "booked" | "booked_unconfirmed") =>
      loadOutcome([call([offer("LD1", 3, 7600, 7600, at)], { loadId: "LD1", status, agreedRate: 7600, createdAt: at })], "LD1");
    assert.deepEqual(hold("held"), { kind: "holding", amount: 7600 });
    assert.deepEqual(hold("confirming"), { kind: "holding", amount: 7600 });
    assert.deepEqual(hold("booked"), { kind: "booked", amount: 7600 });
    assert.deepEqual(hold("booked_unconfirmed"), { kind: "booked", amount: 7600 });
  });
  it("without a hold: live is negotiating, countered is lost, never countered is no offer", () => {
    assert.deepEqual(loadOutcome([call([offer("LD1", 1, 2400, 2100, at)], null, true)], "LD1"), { kind: "negotiating" });
    assert.deepEqual(loadOutcome([call([offer("LD1", 1, 2400, 2100, at)])], "LD1"), { kind: "lost" });
    assert.deepEqual(loadOutcome([call([offer("LD1", 1, 2400, null, at)])], "LD1"), { kind: "no_offer" });
  });
});

describe("carrierPricing", () => {
  it("answers counts and no averages for a carrier with no calls", () => {
    assert.deepEqual(carrierPricing([]), {
      loadsOffered: 0,
      booked: 0,
      bookingRate: null,
      avgAgreedPerMile: null,
      avgMarginKept: null,
      avgRoundsToAgree: null,
    });
  });

  it("averages booked loads once each and leaves open ones out", () => {
    const calls = [
      call([offer("LD1", 3, 2400, 2150, "2026-09-29T12:00:00.000Z")], { loadId: "LD1", status: "booked", agreedRate: 2150, createdAt: "2026-09-29T12:05:00.000Z" }),
      // An older booking of the same load: the newest hold wins.
      call([offer("LD1", 1, 2400, 2000, "2026-09-29T11:00:00.000Z")], { loadId: "LD1", status: "booked", agreedRate: 2000, createdAt: "2026-09-29T11:05:00.000Z" }),
      call([offer("LD2", 1, 2100, 2050, "2026-09-29T10:00:00.000Z")], { loadId: "LD2", status: "booked", agreedRate: 2050, createdAt: "2026-09-29T10:05:00.000Z" }),
      call([offer("LD3", 2, 2600, 2200, "2026-09-29T09:00:00.000Z")], { loadId: "LD3", status: "held", agreedRate: 2200, createdAt: "2026-09-29T09:05:00.000Z" }),
      call([]),
    ];
    const pricing = carrierPricing(calls);
    assert.equal(pricing.loadsOffered, 3);
    assert.equal(pricing.booked, 2);
    assert.equal(pricing.bookingRate, (2 / 3) * 100);
    assert.equal(pricing.avgAgreedPerMile, (2.15 + 2.05) / 2);
    assert.equal(pricing.avgMarginKept, (50 + 150) / 2);
    assert.equal(pricing.avgRoundsToAgree, 2);
  });
});

describe("pricingBreakdown", () => {
  const path = [
    { round: 1, carrierAsk: 8200, rateToSay: 7300, createdAt: "2026-09-29T10:00:00.000Z" },
    { round: 2, carrierAsk: 7800, rateToSay: null, createdAt: "2026-09-29T10:05:00.000Z" },
    { round: 3, carrierAsk: 7600, rateToSay: 7600, createdAt: "2026-09-29T10:10:00.000Z" },
  ];

  it("reads an agreed load top to bottom", () => {
    const b = pricingBreakdown({ postedRate: 7052, maxBuy: 7937, miles: 2335, path, agreedRate: 7600, latestAsk: 7600 });
    assert.equal(b.headroom, 885);
    assert.deepEqual(b.openingAsk, { round: 1, usd: 8200 });
    assert.deepEqual(b.counters.map((c) => [c.round, c.usd]), [[1, 7300], [3, 7600]]);
    assert.equal(b.final.kind, "agreed");
    assert.equal(b.final.usd, 7600);
    assert.equal(b.final.perMile, 7600 / 2335);
    assert.equal(b.posted.perMile, 7052 / 2335);
    assert.equal(b.overPosted, 548);
    assert.equal(b.margin.usd, 337);
    assert.equal(b.margin.pct, (337 / 7937) * 100);
    assert.equal(b.headroomSharePct, (337 / 885) * 100);
  });

  it("reads against the latest ask when nothing is agreed, negative over the ceiling", () => {
    const b = pricingBreakdown({ postedRate: 2000, maxBuy: 2200, miles: 1000, path, agreedRate: null, latestAsk: 2400 });
    assert.equal(b.final.kind, "ask");
    assert.equal(b.final.usd, 2400);
    assert.equal(b.overPosted, 400);
    assert.equal(b.margin.usd, -200);
    assert.equal(b.headroomSharePct, -100);
  });

  it("answers no headroom share when posted equals the ceiling", () => {
    const b = pricingBreakdown({ postedRate: 2000, maxBuy: 2000, miles: 1000, path: [], agreedRate: 2000, latestAsk: 2000 });
    assert.equal(b.headroom, 0);
    assert.equal(b.headroomSharePct, null);
    assert.equal(b.openingAsk, null);
    assert.deepEqual(b.counters, []);
  });

  it("leaves $/mi out when the lane distance is missing", () => {
    const b = pricingBreakdown({ postedRate: 2000, maxBuy: 2200, miles: null, path, agreedRate: 2100, latestAsk: 2100 });
    assert.equal(b.posted.perMile, null);
    assert.equal(b.ceiling.perMile, null);
    assert.equal(b.final.perMile, null);
    assert.equal(b.margin.usd, 100);
  });
});
