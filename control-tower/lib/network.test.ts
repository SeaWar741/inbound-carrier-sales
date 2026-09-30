import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NetworkCarrier } from "./contracts.ts";
import { callsTrend, fromInboxWindow, inboxHref, networkReasons, shortReason, toInboxWindow, windowPhrase, type NetworkWindow } from "./network.ts";

const now = Date.parse("2026-09-30T17:00:00Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
const thirtyDays = { since: "", from: "", to: "" };
// The panel's lines joined, so each case reads as one string.
const networkReason = (c: NetworkCarrier, at: number, dateWindow: NetworkWindow) =>
  networkReasons(c, at, dateWindow)
    .map((reason) => reason.text)
    .join(". ");

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

describe("networkReasons", () => {
  it("counts a new carrier's calls, singular and plural", () => {
    assert.equal(networkReason(carrier({ relationship: "new", facts: { lifetimeCalls: 2 } }), now, thirtyDays), "2 calls so far");
    assert.equal(networkReason(carrier({ relationship: "new", facts: { lifetimeCalls: 1 } }), now, thirtyDays), "1 call so far");
  });

  it("says a silent at-risk carrier's last call and past bookings", () => {
    const quiet = carrier({ relationship: "at_risk", facts: { lastCallAt: daysAgo(19.5), callsRecent: 0, lifetimeBookings: 3 } });
    assert.equal(networkReason(quiet, now, thirtyDays), "Last call 19 d ago; 3 bookings before");
    const once = carrier({ relationship: "at_risk", facts: { lastCallAt: daysAgo(20), callsRecent: 0, lifetimeBookings: 1 } });
    assert.equal(networkReason(once, now, thirtyDays), "Last call 20 d ago; 1 booking before");
  });

  it("says an at-risk carrier that still calls is calling less", () => {
    const fading = carrier({ relationship: "at_risk", facts: { lastCallAt: daysAgo(3), callsRecent: 1, callsPrior: 4 } });
    assert.equal(networkReason(fading, now, thirtyDays), "Calls down: 1 in 14 d vs 4 before");
  });

  it("reads which rule fired from the recent calls, not from the last call's date", () => {
    // The database clock and the browser's differ, so the browser's day count can land on either side of 14.
    const edge = carrier({ relationship: "at_risk", facts: { lastCallAt: daysAgo(13.9), callsRecent: 0, lifetimeBookings: 2 } });
    assert.equal(networkReason(edge, now, thirtyDays), "Last call 13 d ago; 2 bookings before");
    const counted = carrier({ relationship: "at_risk", facts: { lastCallAt: daysAgo(14.1), callsRecent: 1, callsPrior: 5 } });
    assert.equal(networkReason(counted, now, thirtyDays), "Calls down: 1 in 14 d vs 5 before");
  });

  it("words a top carrier's booking rate with the window", () => {
    const top = carrier({ top: true, facts: { bookings: 4, negotiableCalls: 5 } });
    assert.equal(networkReason(top, now, thirtyDays), "4 of 5 negotiated calls booked in 30 d");
    assert.equal(networkReason(top, now, { since: "7d", from: "", to: "" }), "4 of 5 negotiated calls booked in 7 d");
    assert.equal(networkReason(top, now, { since: "today", from: "", to: "" }), "4 of 5 negotiated calls booked today");
    assert.equal(
      networkReason(top, now, { since: "", from: "2026-09-01", to: "2026-09-20" }),
      "4 of 5 negotiated calls booked from Sep 1 to Sep 20",
    );
  });

  it("does not claim more booked calls than negotiated ones", () => {
    const top = carrier({ top: true, facts: { bookings: 2, negotiableCalls: 1 } });
    assert.equal(networkReason(top, now, thirtyDays), "2 bookings on 1 negotiated call in 30 d");
  });

  it("names the lane the board matched for growth, never the most run one", () => {
    const growth = carrier({
      growth: true,
      lanes: [
        { originState: "CA", destinationState: "AZ", equipment: "DRY_VAN", count: 4, open: false },
        { originState: "TX", destinationState: "IL", equipment: "REEFER", count: 3, open: true },
      ],
    });
    assert.equal(networkReason(growth, now, thirtyDays), "Has run TX · Reefer, open on the board now");
    const anyEquipment = carrier({ growth: true, lanes: [{ originState: "GA", destinationState: null, equipment: null, count: 1, open: true }] });
    assert.equal(networkReason(anyEquipment, now, thirtyDays), "Asked for GA · any equipment, open on the board now");
    assert.equal(networkReason(carrier({ growth: true }), now, thirtyDays), "A lane it runs is open on the board now");
  });

  it("joins the relationship sentence and every tag sentence", () => {
    const all = carrier({
      relationship: "at_risk",
      top: true,
      growth: true,
      lanes: [{ originState: "TX", destinationState: "IL", equipment: "DRY_VAN", count: 2, open: true }],
      facts: { lastCallAt: daysAgo(19), callsRecent: 0, lifetimeBookings: 3, bookings: 4, negotiableCalls: 5 },
    });
    assert.equal(
      networkReason(all, now, thirtyDays),
      "Last call 19 d ago; 3 bookings before. 4 of 5 negotiated calls booked in 30 d. Has run TX · Dry van, open on the board now",
    );
  });

  it("gives one line per reason, each with its kind", () => {
    const both = carrier({ relationship: "new", growth: true, facts: { lifetimeCalls: 2 } });
    assert.deepEqual(
      networkReasons(both, now, thirtyDays).map((reason) => reason.kind),
      ["new", "growth"],
    );
  });

  it("calls an untagged active carrier active with nothing to flag, and leaves it out when tagged", () => {
    assert.deepEqual(networkReasons(carrier(), now, thirtyDays), [{ kind: "active", text: "Active, nothing to flag" }]);
    assert.equal(networkReason(carrier({ top: true, facts: { bookings: 3, negotiableCalls: 3 } }), now, thirtyDays), "3 of 3 negotiated calls booked in 30 d");
    assert.equal(networkReason(carrier({ top: true, facts: { bookings: 1, negotiableCalls: 1 } }), now, thirtyDays), "1 of 1 negotiated call booked in 30 d");
  });
});

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

describe("callsTrend", () => {
  it("compares the last 14 days with the 14 before", () => {
    assert.equal(callsTrend(carrier({ facts: { callsRecent: 4, callsPrior: 1 } })), "up");
    assert.equal(callsTrend(carrier({ facts: { callsRecent: 1, callsPrior: 4 } })), "down");
    assert.equal(callsTrend(carrier({ facts: { callsRecent: 2, callsPrior: 2 } })), "flat");
  });
});

describe("windows", () => {
  it("words each window", () => {
    assert.equal(windowPhrase(thirtyDays), "in 30 d");
    assert.equal(windowPhrase({ since: "30d", from: "", to: "" }), "in 30 d");
  });

  it("translates to and from the inbox picker, whose default is 7 days", () => {
    assert.deepEqual(toInboxWindow(thirtyDays), { since: "30d", from: "", to: "" });
    assert.deepEqual(toInboxWindow({ since: "7d", from: "", to: "" }), { since: "", from: "", to: "" });
    assert.deepEqual(fromInboxWindow({ since: "30d", from: "", to: "" }), thirtyDays);
    assert.deepEqual(fromInboxWindow({ since: "", from: "", to: "" }), { since: "7d", from: "", to: "" });
    assert.deepEqual(fromInboxWindow({ since: "today", from: "", to: "" }), { since: "today", from: "", to: "" });
    const range = { since: "", from: "2026-09-01", to: "2026-09-20" };
    assert.deepEqual(toInboxWindow(range), range);
    assert.deepEqual(fromInboxWindow(range), range);
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
