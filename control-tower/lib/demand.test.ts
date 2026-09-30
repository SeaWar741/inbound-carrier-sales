import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DemandLane } from "./contracts.ts";
import { asksLabel, carrierSearchHref, demandCarriersQuery, demandKey, demandSignal, demandTrend, laneLabel } from "./demand.ts";

function lane(overrides: Partial<DemandLane> = {}): DemandLane {
  return {
    originState: "TX",
    destinationState: "GA",
    equipment: "DRY_VAN",
    searches: 7,
    noMatch: 7,
    offeredNoBooking: 2,
    unmet: 9,
    thisWeek: 3,
    previousWeek: 1,
    carriers: 4,
    ...overrides,
  };
}

describe("demandSignal", () => {
  it("counts searches, carriers, matches and offers without a booking", () => {
    assert.equal(demandSignal(lane()), "7 searches by 4 carriers, 0 matched; 2 offered, no booking");
    assert.equal(demandSignal(lane({ noMatch: 2 })), "7 searches by 4 carriers, 5 matched; 2 offered, no booking");
  });

  it("uses the singular for one search and one carrier", () => {
    assert.equal(demandSignal(lane({ searches: 1, noMatch: 1, carriers: 1, offeredNoBooking: 1 })), "1 search by 1 carrier, 0 matched; 1 offered, no booking");
  });

  it("leaves the offer clause out when nothing was offered", () => {
    assert.equal(demandSignal(lane({ offeredNoBooking: 0 })), "7 searches by 4 carriers, 0 matched");
  });

  it("words a lane with offers but no searches", () => {
    assert.equal(demandSignal(lane({ searches: 0, noMatch: 0, offeredNoBooking: 3, carriers: 1 })), "3 offered to 1 carrier, no booking");
  });

  it("never says rejected", () => {
    for (const row of [lane(), lane({ offeredNoBooking: 0 }), lane({ searches: 0, noMatch: 0 })]) {
      assert.doesNotMatch(demandSignal(row), /reject/i);
    }
  });
});

describe("demandTrend", () => {
  it("compares this desk week with the previous one", () => {
    assert.deepEqual(demandTrend(lane()), { trend: "up", text: "3 this week vs 1 last" });
    assert.deepEqual(demandTrend(lane({ thisWeek: 0, previousWeek: 2 })), { trend: "down", text: "0 this week vs 2 last" });
    assert.deepEqual(demandTrend(lane({ thisWeek: 2, previousWeek: 2 })), { trend: "flat", text: "2 this week vs 2 last" });
  });
});

describe("laneLabel and demandKey", () => {
  it("names an any-destination lane Any", () => {
    assert.equal(laneLabel(lane()), "TX → GA");
    assert.equal(laneLabel(lane({ destinationState: null })), "TX → Any");
  });

  it("keeps the Any rows apart from the named ones", () => {
    assert.notEqual(demandKey(lane()), demandKey(lane({ destinationState: null })));
    assert.notEqual(demandKey(lane()), demandKey(lane({ equipment: null })));
  });
});

describe("demandCarriersQuery", () => {
  it("sends destination and equipment only when the row has them", () => {
    assert.equal(demandCarriersQuery(lane(), 1), "origin=TX&destination=GA&equipment=DRY_VAN");
    assert.equal(demandCarriersQuery(lane({ destinationState: null, equipment: null }), 1), "origin=TX");
    assert.equal(demandCarriersQuery(lane({ equipment: null }), 2), "origin=TX&destination=GA&page=2");
  });
});

describe("carrierSearchHref", () => {
  it("searches the Carriers page by MC, else by name", () => {
    assert.equal(carrierSearchHref({ mcNumber: "123456", carrierName: "Acme Freight" }), "/carriers?q=123456");
    assert.equal(carrierSearchHref({ mcNumber: null, carrierName: "Acme Freight" }), "/carriers?q=Acme+Freight");
    assert.equal(carrierSearchHref({ mcNumber: null, carrierName: null }), null);
  });
});

describe("asksLabel", () => {
  it("counts asks, singular and plural", () => {
    assert.equal(asksLabel(1), "1 ask");
    assert.equal(asksLabel(3), "3 asks");
  });
});
