import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TowerCall, WallOffer } from "./contracts.ts";
import { arrivalText, dealEnd, dealRounds, dealStatus, labelGap, priceBar } from "./deal.ts";

const offer = (loadId: string, round: number, carrierAsk: number, rateToSay: number | null, decision: WallOffer["decision"] = "counter"): WallOffer => ({
  loadId,
  round,
  carrierAsk,
  decision,
  rateToSay,
  postedRate: 725,
  maxBuy: 800,
  lane: null,
  createdAt: `2026-09-29T10:0${round}:00.000Z`,
});

type HoldStatus = NonNullable<TowerCall["hold"]>["status"];
const call = (opts: { live?: boolean; hold?: { loadId: string; status: HoldStatus } | null; offers?: WallOffer[]; events?: TowerCall["events"] }) => ({
  live: opts.live ?? false,
  offers: opts.offers ?? [offer("LD1", 1, 820, 760)],
  events: opts.events ?? [],
  hold: opts.hold
    ? {
        holdId: "h1",
        agreedRate: 750,
        postedRate: 725,
        maxBuy: 800,
        bookingRef: null,
        lane: null,
        trip: null,
        createdAt: "2026-09-29T10:10:00.000Z",
        ...opts.hold,
      }
    : null,
});

describe("dealStatus", () => {
  it("follows this call's hold on the load", () => {
    assert.equal(dealStatus(call({ hold: { loadId: "LD1", status: "booked" } }), "LD1"), "booked");
    assert.equal(dealStatus(call({ hold: { loadId: "LD1", status: "held" } }), "LD1"), "held");
    assert.equal(dealStatus(call({ hold: { loadId: "LD1", status: "released" } }), "LD1"), "released");
  });
  it("without a hold on the load: live is negotiating, ended is no deal", () => {
    assert.equal(dealStatus(call({ live: true }), "LD1"), "negotiating");
    assert.equal(dealStatus(call({}), "LD1"), "no_deal");
    assert.equal(dealStatus(call({ hold: { loadId: "LD2", status: "booked" } }), "LD1"), "no_deal");
  });
});

describe("dealRounds", () => {
  it("keeps the load's rounds in round order", () => {
    const offers = [offer("LD1", 3, 750, 750, "accept"), offer("LD2", 1, 900, 850), offer("LD1", 1, 820, 760), offer("LD1", 2, 800, 775)];
    assert.deepEqual(dealRounds(offers, "LD1"), [
      { round: 1, carrierAsk: 820, ourOffer: 760, decision: "counter" },
      { round: 2, carrierAsk: 800, ourOffer: 775, decision: "counter" },
      { round: 3, carrierAsk: 750, ourOffer: 750, decision: "accept" },
    ]);
    assert.deepEqual(dealRounds(offers, "LD9"), []);
  });
});

describe("dealEnd", () => {
  it("names the deal, a release, a handoff, a pass, or an open negotiation", () => {
    assert.deepEqual(dealEnd(call({ hold: { loadId: "LD1", status: "booked_unconfirmed" } }), "LD1"), { kind: "deal", amount: 750 });
    assert.deepEqual(dealEnd(call({ hold: { loadId: "LD1", status: "held" } }), "LD1"), { kind: "deal", amount: 750 });
    assert.deepEqual(dealEnd(call({ hold: { loadId: "LD1", status: "released" } }), "LD1"), { kind: "released", amount: 750 });
    assert.deepEqual(dealEnd(call({ live: true }), "LD1"), { kind: "open" });
    assert.deepEqual(dealEnd(call({}), "LD1"), { kind: "passed" });
    const asked = [{ tool: "request_human", summary: null, status: null, createdAt: "2026-09-29T10:05:00.000Z" }];
    assert.deepEqual(dealEnd(call({ events: asked }), "LD1"), { kind: "handed_to_rep" });
  });
});

describe("arrivalText", () => {
  it("words one driver, a team, and late", () => {
    assert.deepEqual(arrivalText({ feasibility: "solo", lateHours: 0 }), { text: "Arrives on time, one driver", tone: "ok" });
    assert.deepEqual(arrivalText({ feasibility: "team", lateHours: 0 }), { text: "Needs a team to arrive on time", tone: "warn" });
    assert.deepEqual(arrivalText({ feasibility: "impossible", lateHours: 7.6 }), { text: "Arrives ~8h late", tone: "risk" });
  });
});

describe("priceBar", () => {
  const row = (bar: ReturnType<typeof priceBar>, kind: string) => bar.labels.find((label) => label.kind === kind);

  it("runs posted to our max and fills up to our number", () => {
    const bar = priceBar({ posted: 700, max: 800, ours: 750, ask: 790 });
    assert.equal(bar.maxAt, 100);
    assert.deepEqual(bar.fill, { from: 0, to: 50 });
    assert.equal(row(bar, "posted")?.at, 0);
    assert.equal(row(bar, "ours")?.at, 50);
    assert.equal(row(bar, "ask")?.row, "below");
    assert.deepEqual(
      bar.labels.map((label) => label.row),
      ["above", "above", "below", "above"],
    );
  });

  it("stretches to an ask over our max", () => {
    const bar = priceBar({ posted: 700, max: 800, ours: 760, ask: 900 });
    assert.equal(bar.maxAt, 50);
    assert.equal(row(bar, "ask")?.at, 100);
  });

  it("drops the ask when it is our number, and has no fill before we offer", () => {
    assert.equal(row(priceBar({ posted: 700, max: 800, ours: 750, ask: 750 }), "ask"), undefined);
    assert.equal(priceBar({ posted: 700, max: 800, ours: null, ask: 820 }).fill, null);
  });

  it("moves a crowded label to the other row", () => {
    // Agreed $790 sits 10% from our $800 max: the max label goes below.
    const bar = priceBar({ posted: 700, max: 800, ours: 790, ask: null });
    assert.ok(100 - 90 < labelGap);
    assert.equal(row(bar, "ours")?.row, "above");
    assert.equal(row(bar, "max")?.row, "below");
  });

  it("keeps the preferred row when both rows are crowded", () => {
    const bar = priceBar({ posted: 700, max: 800, ours: 795, ask: 798 });
    assert.equal(row(bar, "ask")?.row, "below");
    assert.equal(row(bar, "max")?.row, "above");
  });

  it("does not divide by a flat track", () => {
    const bar = priceBar({ posted: 800, max: 800, ours: 800, ask: null });
    assert.equal(bar.maxAt, 0);
    assert.deepEqual(bar.fill, { from: 0, to: 0 });
  });
});
