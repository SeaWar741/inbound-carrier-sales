import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TowerCall } from "./contracts.ts";
import {
  callSummary,
  carrierName,
  feasibilityBadge,
  formatDeskWhen,
  formatPerMile,
  formatSignedUsd,
  formatTimeAgo,
  loadCards,
  toolLabel,
} from "./format.ts";

describe("formatTimeAgo", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  it("rounds down to minutes, hours and days", () => {
    assert.equal(formatTimeAgo("2026-09-29T11:59:30Z", now), "now");
    assert.equal(formatTimeAgo("2026-09-29T11:55:00Z", now), "5m");
    assert.equal(formatTimeAgo("2026-09-29T09:00:00Z", now), "3h");
    assert.equal(formatTimeAgo("2026-09-27T11:00:00Z", now), "2d");
  });
});

describe("toolLabel", () => {
  it("words known tools, drops the built-in underscore, and spells out unknown ones", () => {
    assert.equal(toolLabel("evaluate_offer"), "Evaluated offer");
    assert.equal(toolLabel("create_hold"), "Placed hold");
    assert.equal(toolLabel("_hangup"), "Call ended by agent");
    assert.equal(toolLabel("transfer_call"), "Transfer call");
    assert.equal(toolLabel("_"), "_");
  });

  it("words the trip estimate and the carrier's hold notice, and a failed notice as failed", () => {
    assert.equal(toolLabel("get_trip_estimate"), "Estimated trip");
    assert.equal(toolLabel("hold_notice", "sent"), "Notified carrier");
    assert.equal(toolLabel("hold_notice", "failed"), "Carrier not notified");
    assert.equal(toolLabel("create_hold", "failed"), "Placed hold failed");
  });
});

describe("feasibilityBadge", () => {
  it("badges team and impossible trips, never solo", () => {
    assert.equal(feasibilityBadge("solo"), null);
    assert.equal(feasibilityBadge("team")?.text, "Team");
    assert.equal(feasibilityBadge("impossible")?.text, "Can't make it");
  });
});

describe("carrierName", () => {
  it("prefers the stored name, then MC, then DOT", () => {
    assert.equal(carrierName({ carrierName: "Acme", mcNumber: "1", dotNumber: "2" }), "Acme");
    assert.equal(carrierName({ carrierName: null, mcNumber: "1", dotNumber: "2" }), "MC 1");
    assert.equal(carrierName({ carrierName: null, mcNumber: null, dotNumber: "2" }), "DOT 2");
    assert.equal(carrierName({ carrierName: null, mcNumber: null, dotNumber: null }), "Unidentified carrier");
  });
});

describe("loadCards", () => {
  const c = (callId: string, createdAt: string, ...offers: [string, number][]) => ({
    callId,
    createdAt,
    offers: offers.map(([loadId, round]) => ({ loadId, round })),
  });
  const shape = (cards: ReturnType<typeof loadCards>) =>
    cards.map((card) => `${card.loadId ?? "none"}:${card.calls.map((call) => call.callId).join(",")}:r${card.rounds}:${card.lastAt}`);

  it("makes one card per load, newest activity first, with the calls newest first", () => {
    const cards = loadCards([
      c("c4", "2026-09-29T15:00:00Z", ["LD2", 1]),
      c("c3", "2026-09-29T14:00:00Z", ["LD1", 3]),
      c("c2", "2026-09-29T13:00:00Z", ["LD2", 2]),
      c("c1", "2026-09-29T12:00:00Z", ["LD1", 1]),
    ]);
    assert.deepEqual(shape(cards), ["LD2:c4,c2:r2:2026-09-29T15:00:00Z", "LD1:c3,c1:r3:2026-09-29T14:00:00Z"]);
  });

  it("files a call under the load of its latest offer and counts rounds on that load only", () => {
    const cards = loadCards([c("c1", "2026-09-29T12:00:00Z", ["LD9", 3], ["LD1", 1])]);
    assert.deepEqual(shape(cards), ["LD1:c1:r1:2026-09-29T12:00:00Z"]);
  });

  it("folds calls without a load into one card at the end, even when they are newer", () => {
    const cards = loadCards([
      c("c3", "2026-09-29T15:00:00Z"),
      c("c2", "2026-09-29T14:00:00Z", ["LD1", 2]),
      c("c1", "2026-09-29T13:00:00Z"),
    ]);
    assert.deepEqual(shape(cards), ["LD1:c2:r2:2026-09-29T14:00:00Z", "none:c3,c1:r0:2026-09-29T15:00:00Z"]);
  });

  it("orders by start time even when the calls arrive out of order", () => {
    const cards = loadCards([c("c1", "2026-09-29T12:00:00Z", ["LD1", 1]), c("c2", "2026-09-29T13:00:00Z", ["LD2", 1])]);
    assert.deepEqual(
      cards.map((card) => card.loadId),
      ["LD2", "LD1"],
    );
  });

  it("answers no cards for no calls", () => {
    assert.deepEqual(loadCards([]), []);
  });
});

describe("formatDeskWhen", () => {
  // Desk time is Chicago: 2026-09-29T19:30Z is 2:30 PM on Sep 29, 2026-09-29T03:00Z is still Sep 28.
  it("shows the clock today and the date on other days", () => {
    assert.equal(formatDeskWhen("2026-09-29T19:30:00Z", "2026-09-29"), "2:30 PM");
    assert.equal(formatDeskWhen("2026-09-29T03:00:00Z", "2026-09-29"), "Sep 28, 10:00 PM");
  });
});

describe("callSummary", () => {
  type Hold = NonNullable<TowerCall["hold"]>;
  const events = [{ tool: "create_hold", summary: "Holding load LD1 at $7,600", status: "ok", createdAt: "2026-09-29T12:00:00.000Z" }];
  const hold = (status: Hold["status"]): Hold => ({
    holdId: "h1",
    loadId: "LD1",
    status,
    agreedRate: 7600,
    postedRate: 7000,
    maxBuy: 7900,
    bookingRef: null,
    lane: null,
    trip: null,
    createdAt: "2026-09-29T12:00:00.000Z",
  });

  it("words a call with a hold by the hold's current status, not the agent's last event", () => {
    assert.equal(callSummary({ events, hold: hold("booked") }), "Booked LD1 at $7,600");
    assert.equal(callSummary({ events, hold: hold("booked_unconfirmed") }), "Booked LD1 at $7,600, unconfirmed");
    assert.equal(callSummary({ events, hold: hold("held") }), "Holding LD1 at $7,600, waiting for a rep");
    assert.equal(callSummary({ events, hold: hold("released") }), "Released LD1");
  });

  it("falls back to the newest summary without a hold", () => {
    assert.equal(callSummary({ events, hold: null }), "Holding load LD1 at $7,600");
    assert.equal(callSummary({ events: [], hold: null }), null);
  });
});

describe("formatSignedUsd and formatPerMile", () => {
  it("signs spreads and leaves zero bare", () => {
    assert.equal(formatSignedUsd(134), "+$134");
    assert.equal(formatSignedUsd(-50), "-$50");
    assert.equal(formatSignedUsd(0.2), "$0");
  });

  it("prints dollars per mile with cents", () => {
    assert.equal(formatPerMile(2150 / 742), "$2.90/mi");
  });
});
