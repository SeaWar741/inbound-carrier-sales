import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DemandLane } from "./contracts.ts";
import {
  asksLabel,
  carrierSearchHref,
  demandCarriersQuery,
  demandKey,
  demandSignal,
  demandTotalsLabels,
  demandTrend,
  demandUnmet,
  laneLabel,
  parseDemandKey,
  unmetBarPercent,
} from "./demand.ts";

function lane(overrides: Partial<DemandLane> = {}): DemandLane {
  return {
    originState: "TX",
    destinationState: "GA",
    equipment: "DRY_VAN",
    searches: 7,
    noMatch: 7,
    offeredNoBooking: 2,
    thisWeek: 3,
    previousWeek: 1,
    carriers: 4,
    ...overrides,
  };
}

describe("demandSignal", () => {
  it("counts searches and matches, then offers without a booking, then the carriers", () => {
    assert.equal(demandSignal(lane({ offeredNoBooking: 0 })), "7 searches, none matched · 4 carriers");
    assert.equal(demandSignal(lane({ searches: 3, noMatch: 2, offeredNoBooking: 2, carriers: 3 })), "3 searches, 1 matched · 2 offered, no booking · 3 carriers");
  });

  it("words a lane with offers but no searches", () => {
    assert.equal(demandSignal(lane({ searches: 0, noMatch: 0, offeredNoBooking: 7, carriers: 5 })), "7 offered, no booking · 5 carriers");
  });

  it("uses the singular for one search and one carrier", () => {
    assert.equal(demandSignal(lane({ searches: 1, noMatch: 1, carriers: 1, offeredNoBooking: 1 })), "1 search, none matched · 1 offered, no booking · 1 carrier");
  });

  it("says who asked when the panel asks for it", () => {
    assert.equal(demandSignal(lane({ searches: 9, noMatch: 9, offeredNoBooking: 0 }), { asked: true }), "9 searches, none matched · 4 carriers asked");
  });

  it("still reads when there is nothing unmet", () => {
    assert.equal(demandSignal(lane({ searches: 0, noMatch: 0, offeredNoBooking: 0, carriers: 1 })), "No unmet asks · 1 carrier");
  });

  it("never says rejected", () => {
    for (const row of [lane(), lane({ offeredNoBooking: 0 }), lane({ searches: 0, noMatch: 0 })]) {
      assert.doesNotMatch(demandSignal(row), /reject/i);
      assert.doesNotMatch(demandSignal(row, { asked: true }), /reject/i);
    }
  });
});

describe("demandTrend", () => {
  it("compares this desk week with the previous one", () => {
    assert.deepEqual(demandTrend(lane()), { trend: "up", text: "3 vs 1" });
    assert.deepEqual(demandTrend(lane({ thisWeek: 2, previousWeek: 5 })), { trend: "down", text: "2 vs 5" });
    assert.deepEqual(demandTrend(lane({ thisWeek: 1, previousWeek: 1 })), { trend: "flat", text: "1 vs 1" });
  });
});

describe("demandUnmet and unmetBarPercent", () => {
  it("adds searches with no match and offers with no booking", () => {
    assert.equal(demandUnmet(lane()), 9);
  });

  it("sizes the bar against the largest unmet and keeps a sliver for small ones", () => {
    assert.equal(unmetBarPercent(9, 9), 100);
    assert.equal(unmetBarPercent(6, 9), 67);
    assert.equal(unmetBarPercent(1, 100), 4);
    assert.equal(unmetBarPercent(0, 9), 0);
    assert.equal(unmetBarPercent(0, 0), 0);
  });
});

describe("demandTotalsLabels", () => {
  it("words the header totals, singular and plural", () => {
    assert.deepEqual(demandTotalsLabels({ noMatch: 42, offeredNoBooking: 27, carriers: 19 }), {
      noMatch: "42 searches found nothing",
      offeredNoBooking: "27 offers not booked",
      carriers: "19 carriers asked",
    });
    assert.deepEqual(demandTotalsLabels({ noMatch: 1, offeredNoBooking: 1, carriers: 1 }), {
      noMatch: "1 search found nothing",
      offeredNoBooking: "1 offer not booked",
      carriers: "1 carrier asked",
    });
  });
});

describe("parseDemandKey", () => {
  it("reads back what demandKey writes, Any parts included", () => {
    for (const row of [lane(), lane({ destinationState: null }), lane({ equipment: null }), lane({ destinationState: null, equipment: null })]) {
      assert.deepEqual(parseDemandKey(demandKey(row)), { originState: row.originState, destinationState: row.destinationState, equipment: row.equipment });
    }
  });

  it("refuses a value that is not a lane", () => {
    for (const key of ["", "TX", "TX|GA", "tx|GA|REEFER", "TX|Georgia|", "|GA|REEFER", "TX|GA|reefer", "TX|GA|REEFER|x"]) {
      assert.equal(parseDemandKey(key), null, key);
    }
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
