import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demandSorts, type DemandLane } from "./contracts.ts";
import {
  defaultDemandSort,
  asksLabel,
  carrierListHref,
  demandCarriersQuery,
  demandEquipmentLabel,
  demandInboxHref,
  demandKey,
  demandQuery,
  demandSaid,
  demandTrend,
  demandUnmet,
  laneLabel,
  nextOf,
  nextStepHref,
  unmetBarPercent,
  weekChange,
} from "./demand.ts";
import { paging, sortChange } from "./list-query.ts";

function lane(overrides: Partial<DemandLane> = {}): DemandLane {
  return {
    originState: "TX",
    destinationState: "GA",
    equipment: "DRY_VAN",
    noMatch: 7,
    offeredNoBooking: 2,
    thisWeek: 3,
    previousWeek: 1,
    carriers: 4,
    ...overrides,
  };
}

const demandPaging = (search: URLSearchParams) => paging(search, demandSorts, defaultDemandSort);

describe("demandQuery and paging", () => {
  it("sends nothing for the defaults", () => {
    assert.equal(demandQuery(new URLSearchParams("")), "");
    assert.deepEqual(demandPaging(new URLSearchParams("")), { sort: "unmet", dir: "desc", page: 1, pageSize: 25 });
  });

  it("sends the filters, a next step, the sort and the paging", () => {
    const search = new URLSearchParams("q=+acme+&next=rate&equipment=REEFER&origin=TX&sort=lane&dir=asc&page=3&pageSize=50");
    assert.equal(demandQuery(search), "q=acme&equipment=REEFER&origin=TX&next=rate&sort=lane&dir=asc&page=3&pageSize=50");
  });

  it("drops values the adapter would refuse", () => {
    const search = new URLSearchParams("next=both&sort=mc&dir=up&page=0&pageSize=30&lane=TX||&carrier=mc:1");
    assert.equal(demandQuery(search), "");
    assert.deepEqual(demandPaging(search), { sort: "unmet", dir: "desc", page: 1, pageSize: 25 });
  });
});

describe("sortChange on the demand sorts", () => {
  it("leaves the default sort and direction out of the URL and goes back to page 1", () => {
    assert.deepEqual(sortChange("unmet", "desc", defaultDemandSort), { sort: null, dir: null, page: null });
    assert.deepEqual(sortChange("lane", "asc", defaultDemandSort), { sort: "lane", dir: "asc", page: null });
    assert.deepEqual(sortChange("thisWeek", "desc", defaultDemandSort), { sort: "thisWeek", dir: null, page: null });
  });
});

describe("demandSaid", () => {
  it("says what the board missed, both parts when both happened", () => {
    assert.equal(demandSaid(lane()), "7 searches found nothing · 2 offers not booked");
    assert.equal(demandSaid(lane({ offeredNoBooking: 0 })), "7 searches found nothing");
    assert.equal(demandSaid(lane({ noMatch: 1, offeredNoBooking: 1 })), "1 search found nothing · 1 offer not booked");
  });

  it("still reads when nothing went unmet, and never says rejected", () => {
    assert.equal(demandSaid(lane({ noMatch: 0, offeredNoBooking: 0 })), "No unmet asks");
    for (const row of [lane(), lane({ noMatch: 0 }), lane({ offeredNoBooking: 0 })]) assert.doesNotMatch(demandSaid(row), /reject/i);
  });
});

describe("demandTrend and weekChange", () => {
  it("reads last week then this week", () => {
    assert.deepEqual(demandTrend(lane()), { trend: "up", text: "1 → 3", tip: "Unmet: 1 last week, 3 this week" });
    assert.equal(demandTrend(lane({ thisWeek: 2, previousWeek: 5 })).trend, "down");
    assert.equal(demandTrend(lane({ thisWeek: 1, previousWeek: 1 })).trend, "flat");
  });

  it("words the week against the one before", () => {
    assert.equal(weekChange({ thisWeek: 9, previousWeek: 4 }), "Up from 4 last week");
    assert.equal(weekChange({ thisWeek: 2, previousWeek: 4 }), "Down from 4 last week");
    assert.equal(weekChange({ thisWeek: 4, previousWeek: 4 }), "Same as last week");
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

describe("nextOf and nextStepHref", () => {
  it("finds a load when only searches went unmet, checks the rate when only offers did", () => {
    assert.equal(nextOf({ noMatch: 9, offeredNoBooking: 0 }), "source");
    assert.equal(nextOf({ noMatch: 0, offeredNoBooking: 7 }), "rate");
    assert.equal(nextOf({ noMatch: 2, offeredNoBooking: 1 }), "both");
  });

  it("opens the dashboard on the lane's pickup state, and its equipment when it has one", () => {
    assert.equal(nextStepHref(lane({ equipment: "REEFER" })), "/?origin=TX&equipment=REEFER");
    assert.equal(nextStepHref(lane({ equipment: null })), "/?origin=TX");
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

describe("demandEquipmentLabel", () => {
  it("names the equipment, Any when the carriers did not say", () => {
    assert.equal(demandEquipmentLabel("REEFER"), "Reefer");
    assert.equal(demandEquipmentLabel(null), "Any equipment");
  });
});

describe("demandCarriersQuery", () => {
  it("sends destination and equipment only when the row has them", () => {
    assert.equal(demandCarriersQuery(lane(), 1), "origin=TX&destination=GA&equipment=DRY_VAN");
    assert.equal(demandCarriersQuery(lane({ destinationState: null, equipment: null }), 1), "origin=TX");
    assert.equal(demandCarriersQuery(lane({ equipment: null }), 2), "origin=TX&destination=GA&page=2");
  });
});

describe("carrierListHref and demandInboxHref", () => {
  const carrier = { key: "mc:9000002", mcNumber: "9000002", carrierName: "Acme Freight" };

  it("searches the Carriers page by MC, else by name", () => {
    assert.equal(carrierListHref(carrier), "/carriers?q=9000002");
    assert.equal(carrierListHref({ mcNumber: null, carrierName: "Acme Freight" }), "/carriers?q=Acme+Freight");
    assert.equal(carrierListHref({ mcNumber: null, carrierName: null }), null);
  });

  it("selects the carrier in the inbox's last 30 days", () => {
    assert.equal(demandInboxHref(carrier), "/inbox?carrier=mc%3A9000002&q=9000002&since=30d");
    assert.equal(demandInboxHref({ key: "name:x", mcNumber: null, carrierName: null }), "/inbox?carrier=name%3Ax&since=30d");
  });
});

describe("asksLabel", () => {
  it("counts asks, singular and plural", () => {
    assert.equal(asksLabel(1), "1 ask");
    assert.equal(asksLabel(3), "3 asks");
  });
});
