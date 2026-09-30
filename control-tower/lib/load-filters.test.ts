import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TowerLoad } from "./contracts";
import { emptyLoadFilters, filterLoads, loadEquipments, loadOrigins, sortLoads, statusCounts } from "./load-filters.ts";

function load(over: Partial<TowerLoad> & { holdId: string }): TowerLoad {
  return {
    loadId: `L-${over.holdId}`,
    callId: "call",
    mcNumber: null,
    carrierName: null,
    agreedRate: 1000,
    lane: {
      origin: { city: "Chicago", state: "IL", zip: "60601" },
      destination: { city: "Dallas", state: "TX", zip: "75201" },
      equipment: "DRY_VAN",
      miles: 900,
      pickupAt: "20260929080000",
    },
    pickupAt: "2026-09-29T13:00:00Z",
    etaAt: "2026-09-30T13:00:00Z",
    status: "upcoming",
    progress: 0,
    ...over,
  };
}

const loads: TowerLoad[] = [
  load({ holdId: "a", loadId: "LD-100", status: "arrived", progress: 1, agreedRate: 2000, etaAt: "2026-09-28T10:00:00Z" }),
  load({ holdId: "b", status: "in_transit", progress: 0.4, carrierName: "Swift Freight", mcNumber: "123456", agreedRate: 3000 }),
  load({
    holdId: "c",
    status: "upcoming",
    agreedRate: 1500,
    etaAt: "2026-10-02T10:00:00Z",
    pickupAt: "2026-10-01T10:00:00Z",
    lane: {
      origin: { city: "Denver", state: "CO", zip: "80202" },
      destination: { city: "Phoenix", state: "AZ", zip: "85001" },
      equipment: "REEFER",
      miles: 800,
      pickupAt: "20261001050000",
    },
  }),
  load({ holdId: "d", status: "in_transit", progress: 0.8, mcNumber: "777", pickupAt: "2026-09-28T13:00:00Z" }),
];
const ids = (list: TowerLoad[]) => list.map((l) => l.holdId);

describe("filterLoads", () => {
  it("keeps everything with no filters", () => {
    assert.deepEqual(ids(filterLoads(loads, emptyLoadFilters)), ["a", "b", "c", "d"]);
  });

  it("searches load id, cities, states, carrier and MC, case-insensitively", () => {
    const search = (q: string) => ids(filterLoads(loads, { ...emptyLoadFilters, q }));
    assert.deepEqual(search("ld-100"), ["a"]);
    assert.deepEqual(search("phoenix"), ["c"]);
    assert.deepEqual(search("Denver, CO"), ["c"]);
    assert.deepEqual(search(" az "), ["c"]);
    assert.deepEqual(search("swift"), ["b"]);
    assert.deepEqual(search("MC 777"), ["d"]);
    assert.deepEqual(search("123456"), ["b"]);
    assert.deepEqual(search("nowhere"), []);
  });

  it("narrows by status and equipment together", () => {
    assert.deepEqual(ids(filterLoads(loads, { ...emptyLoadFilters, status: "in_transit" })), ["b", "d"]);
    assert.deepEqual(ids(filterLoads(loads, { ...emptyLoadFilters, equipment: "REEFER" })), ["c"]);
    assert.deepEqual(ids(filterLoads(loads, { ...emptyLoadFilters, status: "arrived", equipment: "REEFER" })), []);
  });

  it("narrows by origin state", () => {
    assert.deepEqual(ids(filterLoads(loads, { ...emptyLoadFilters, origin: "CO" })), ["c"]);
    assert.deepEqual(ids(filterLoads(loads, { ...emptyLoadFilters, origin: "IL", status: "in_transit" })), ["b", "d"]);
    assert.deepEqual(ids(filterLoads(loads, { ...emptyLoadFilters, origin: "IL", equipment: "REEFER" })), []);
  });
});

describe("statusCounts", () => {
  it("counts after search, equipment and origin but ignores the status choice", () => {
    assert.deepEqual(statusCounts(loads, { ...emptyLoadFilters, status: "arrived", equipment: "DRY_VAN" }), {
      all: 3,
      in_transit: 2,
      upcoming: 0,
      arrived: 1,
    });
    assert.deepEqual(statusCounts(loads, { ...emptyLoadFilters, q: "chicago" }).all, 3);
    assert.deepEqual(statusCounts(loads, { ...emptyLoadFilters, status: "arrived", origin: "CO" }), {
      all: 1,
      in_transit: 0,
      upcoming: 1,
      arrived: 0,
    });
  });
});

describe("sortLoads", () => {
  it("defaults to in transit, upcoming, arrived, keeping pickup order inside each", () => {
    assert.deepEqual(ids(sortLoads(loads, "")), ["b", "d", "c", "a"]);
  });

  it("sorts by pickup, ETA, rate high to low and progress", () => {
    assert.deepEqual(ids(sortLoads(loads, "pickup")), ["d", "a", "b", "c"]);
    assert.deepEqual(ids(sortLoads(loads, "eta")), ["a", "b", "d", "c"]);
    assert.deepEqual(ids(sortLoads(loads, "rate")), ["b", "a", "c", "d"]);
    assert.deepEqual(ids(sortLoads(loads, "progress")), ["a", "d", "b", "c"]);
  });

  it("does not mutate its input", () => {
    sortLoads(loads, "rate");
    assert.deepEqual(ids(loads), ["a", "b", "c", "d"]);
  });
});

describe("loadEquipments", () => {
  it("lists the distinct equipment codes present", () => {
    assert.deepEqual(loadEquipments(loads), ["DRY_VAN", "REEFER"]);
  });
});

describe("loadOrigins", () => {
  it("lists the distinct origin states present", () => {
    assert.deepEqual(loadOrigins(loads), ["CO", "IL"]);
  });
});
