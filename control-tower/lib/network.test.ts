import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NetworkCarrier } from "./contracts.ts";
import { callOutcome, callsWindow, inboxHref, networkPaging, networkQuery, shortReason, sortChange, topOpenLanes } from "./network.ts";

const now = Date.parse("2026-09-30T17:00:00Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

function carrier(overrides: Partial<Omit<NetworkCarrier, "facts">> & { facts?: Partial<NetworkCarrier["facts"]> } = {}): NetworkCarrier {
  const { facts, ...rest } = overrides;
  return {
    key: "mc:123456",
    mcNumber: "123456",
    dotNumber: "7654321",
    carrierName: "Acme Freight",
    eligible: true,
    relationship: "active",
    top: false,
    growth: false,
    lanes: [],
    ...rest,
    facts: {
      lifetimeCalls: 8,
      lifetimeBookings: 3,
      lastCallAt: daysAgo(1),
      callsRecent: 3,
      callsPrior: 3,
      calls: 5,
      negotiableCalls: 5,
      bookings: 3,
      searches: 4,
      loadsNegotiated: 6,
      ...facts,
    },
  };
}

describe("shortReason", () => {
  it("says how long a silent at-risk carrier has been quiet and what it booked before", () => {
    const quiet = carrier({ relationship: "at_risk", facts: { lastCallAt: daysAgo(37.2), callsRecent: 0, lifetimeBookings: 2 } });
    assert.equal(shortReason(quiet, now), "No call in 37 d · 2 bookings before");
    const once = carrier({ relationship: "at_risk", facts: { lastCallAt: daysAgo(20), callsRecent: 0, lifetimeBookings: 1 } });
    assert.equal(shortReason(once, now), "No call in 20 d · 1 booking before");
  });

  it("compares an at-risk carrier's recent calls with the span before", () => {
    const fading = carrier({ relationship: "at_risk", facts: { lastCallAt: daysAgo(3), callsRecent: 1, callsPrior: 6 } });
    assert.equal(shortReason(fading, now), "Calls down 1 vs 6");
  });

  it("counts a new carrier's calls", () => {
    assert.equal(shortReason(carrier({ relationship: "new", facts: { lifetimeCalls: 2 } }), now), "2 calls so far");
    assert.equal(shortReason(carrier({ relationship: "new", facts: { lifetimeCalls: 1 } }), now), "1 call so far");
  });

  it("words a top carrier's booked offers, never more booked than offered", () => {
    assert.equal(shortReason(carrier({ top: true, facts: { bookings: 3, negotiableCalls: 4 } }), now), "3 of 4 offers booked");
    assert.equal(shortReason(carrier({ top: true, facts: { bookings: 1, negotiableCalls: 1 } }), now), "1 of 1 offer booked");
    assert.equal(shortReason(carrier({ top: true, facts: { bookings: 2, negotiableCalls: 1 } }), now), "2 bookings on 1 offer");
  });

  it("names the open lane's origin and equipment for growth", () => {
    const growth = carrier({
      growth: true,
      lanes: [
        { originState: "CA", destinationState: "AZ", equipment: "DRY_VAN", count: 4, open: false },
        { originState: "PA", destinationState: "PA", equipment: "REEFER", count: 7, open: true },
      ],
    });
    assert.equal(shortReason(growth, now), "PA Reefer open now");
    const anyEquipment = carrier({ growth: true, lanes: [{ originState: "GA", destinationState: null, equipment: null, count: 1, open: true }] });
    assert.equal(shortReason(anyEquipment, now), "GA open now");
    assert.equal(shortReason(carrier({ growth: true }), now), "A lane it runs is open now");
  });

  it("joins the relationship and every tag with a dot", () => {
    const fading = carrier({
      relationship: "at_risk",
      top: true,
      growth: true,
      lanes: [{ originState: "PA", destinationState: "PA", equipment: "REEFER", count: 7, open: true }],
      facts: { lastCallAt: daysAgo(3), callsRecent: 1, callsPrior: 6, bookings: 1, negotiableCalls: 2 },
    });
    assert.equal(shortReason(fading, now), "Calls down 1 vs 6 · 1 of 2 offers booked · PA Reefer open now");
  });

  it("says an untagged active carrier has nothing to flag", () => {
    assert.equal(shortReason(carrier(), now), "Active, nothing to flag");
  });
});

describe("inboxHref", () => {
  it("selects the carrier, searches its MC and keeps a recent last call inside 30 days", () => {
    assert.equal(inboxHref(carrier({ facts: { lastCallAt: daysAgo(19) } }), now), "/inbox?carrier=mc%3A123456&q=123456&since=30d");
  });

  it("falls back to the DOT, then the name", () => {
    assert.equal(inboxHref(carrier({ key: "dot:7654321", mcNumber: null }), now), "/inbox?carrier=dot%3A7654321&q=7654321&since=30d");
    assert.equal(
      inboxHref(carrier({ key: "call:abc", mcNumber: null, dotNumber: null }), now),
      "/inbox?carrier=call%3Aabc&q=Acme+Freight&since=30d",
    );
  });

  it("uses a day range reaching an older last call", () => {
    assert.equal(
      inboxHref(carrier({ facts: { lastCallAt: "2026-08-15T15:00:00Z" } }), now),
      "/inbox?carrier=mc%3A123456&q=123456&from=2026-08-15&to=2026-09-30",
    );
  });
});

describe("callsWindow", () => {
  it("keeps a recent last call inside the rolling 30 days", () => {
    assert.deepEqual(callsWindow(carrier({ facts: { lastCallAt: daysAgo(28) } }), now), { since: "30d" });
  });

  it("reaches back to an older last call with a day range", () => {
    assert.deepEqual(callsWindow(carrier({ facts: { lastCallAt: "2026-08-15T15:00:00Z" } }), now), { from: "2026-08-15", to: "2026-09-30" });
  });
});

describe("networkQuery", () => {
  const query = (search: string) => networkQuery(new URLSearchParams(search));

  it("sends nothing for the defaults", () => {
    assert.equal(query(""), "");
    assert.equal(query("view=all&sort=lastCall&dir=desc&page=1&pageSize=25"), "");
  });

  it("forwards the status, filters, sort and paging", () => {
    assert.equal(
      query("view=growth&q=+123+&equipment=REEFER&origin=TX&sort=mc&dir=asc&page=3&pageSize=50"),
      "view=growth&q=123&equipment=REEFER&origin=TX&sort=mc&dir=asc&page=3&pageSize=50",
    );
  });

  it("drops values the adapter would refuse", () => {
    assert.equal(query("view=bogus&sort=name&dir=up&page=-2&pageSize=30&key=mc%3A1"), "");
    assert.equal(query("page=1.5"), "");
  });
});

describe("networkPaging", () => {
  it("fills in the defaults", () => {
    assert.deepEqual(networkPaging(new URLSearchParams()), { sort: "lastCall", dir: "desc", page: 1, pageSize: 25 });
    assert.deepEqual(networkPaging(new URLSearchParams("sort=bookings&dir=asc&page=2&pageSize=10")), { sort: "bookings", dir: "asc", page: 2, pageSize: 10 });
  });
});

describe("sortChange", () => {
  it("drops the defaults and goes back to page 1", () => {
    assert.deepEqual(sortChange("lastCall", "desc"), { sort: null, dir: null, page: null });
    assert.deepEqual(sortChange("calls", "asc"), { sort: "calls", dir: "asc", page: null });
    assert.deepEqual(sortChange("mc", "desc"), { sort: "mc", dir: null, page: null });
  });
});

describe("topOpenLanes", () => {
  it("keeps the five lanes with the most carriers, most first", () => {
    const lanes = [
      { originState: "TX", equipment: "REEFER", carriers: 2 },
      { originState: "CA", equipment: "REEFER", carriers: 5 },
      { originState: "GA", equipment: "DRY_VAN", carriers: 1 },
      { originState: "AZ", equipment: "FLATBED", carriers: 2 },
      { originState: "IL", equipment: "DRY_VAN", carriers: 3 },
      { originState: "OH", equipment: "DRY_VAN", carriers: 4 },
    ];
    assert.deepEqual(
      topOpenLanes(lanes).map((lane) => lane.originState),
      ["CA", "OH", "IL", "AZ", "TX"],
    );
  });
});

describe("callOutcome", () => {
  const hold = (status: "held" | "confirming" | "booked" | "booked_unconfirmed" | "released") =>
    ({ holdId: "h1", loadId: "DMH290", status, agreedRate: 1850, postedRate: null, maxBuy: null, bookingRef: null, lane: null, trip: null, createdAt: daysAgo(1) });
  const offer = { loadId: "DMH290", round: 2, carrierAsk: 2100, decision: "counter" as const, rateToSay: 1900, postedRate: null, maxBuy: null, lane: null, createdAt: daysAgo(1) };

  it("reads a live call first, then the hold, then the offers", () => {
    assert.equal(callOutcome({ live: true, hold: hold("booked"), offers: [] }).text, "On the call now");
    assert.deepEqual(callOutcome({ live: false, hold: hold("booked"), offers: [] }), { kind: "booked", text: "Booked at $1,850" });
    assert.equal(callOutcome({ live: false, hold: hold("booked_unconfirmed"), offers: [] }).kind, "booked");
    assert.deepEqual(callOutcome({ live: false, hold: hold("confirming"), offers: [] }), { kind: "holding", text: "Holding at $1,850" });
    assert.deepEqual(callOutcome({ live: false, hold: hold("released"), offers: [offer] }), { kind: "lost", text: "Hold released" });
    assert.deepEqual(callOutcome({ live: false, hold: null, offers: [offer] }), { kind: "lost", text: "No deal: asked $2,100, our best $1,900" });
    assert.deepEqual(callOutcome({ live: false, hold: null, offers: [{ ...offer, rateToSay: null }] }), { kind: "lost", text: "No deal, last ask $2,100" });
    assert.deepEqual(callOutcome({ live: false, hold: null, offers: [] }), { kind: "no_offer", text: "No load offered" });
  });
});
