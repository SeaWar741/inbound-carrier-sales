import type { TowerLoad, TripStatus } from "./contracts";

// The dashboard narrows the full window of booked loads on the client; "" is "no filter".
// `origin` is a pickup state code, matched on the lane origin.
export type LoadFilters = { q: string; status: TripStatus | ""; equipment: string; origin: string };
// "" keeps the desk order: in transit, then upcoming, then arrived, each by pickup.
export type LoadSort = "" | "pickup" | "eta" | "rate" | "progress";

export const emptyLoadFilters: LoadFilters = { q: "", status: "", equipment: "", origin: "" };

// Trucks on the road first, then the ones about to pick up, then the ones already delivered.
const statusRank: Record<TripStatus, number> = { in_transit: 0, upcoming: 1, arrived: 2 };

function matchesQuery(load: TowerLoad, q: string): boolean {
  const { origin, destination } = load.lane;
  const fields = [
    load.loadId,
    `${origin.city}, ${origin.state}`,
    `${destination.city}, ${destination.state}`,
    load.carrierName ?? "",
    load.mcNumber ? `MC ${load.mcNumber}` : "",
  ];
  return fields.some((field) => field.toLowerCase().includes(q));
}

export function filterLoads(loads: TowerLoad[], filters: LoadFilters): TowerLoad[] {
  const q = filters.q.trim().toLowerCase();
  return loads.filter(
    (load) =>
      (filters.status === "" || load.status === filters.status) &&
      (filters.equipment === "" || load.lane.equipment === filters.equipment) &&
      (filters.origin === "" || load.lane.origin.state === filters.origin) &&
      (q === "" || matchesQuery(load, q)),
  );
}

// Counts per status tab after search, equipment and origin, before the status choice, like the inbox tabs.
export function statusCounts(loads: TowerLoad[], filters: LoadFilters): Record<TripStatus | "all", number> {
  const counts = { all: 0, in_transit: 0, upcoming: 0, arrived: 0 };
  for (const load of filterLoads(loads, { ...filters, status: "" })) {
    counts.all += 1;
    counts[load.status] += 1;
  }
  return counts;
}

const time = (iso: string) => Date.parse(iso);

// A sorted copy; ties keep the incoming order (the adapter's pickup order).
export function sortLoads(loads: TowerLoad[], sort: LoadSort): TowerLoad[] {
  const compare: Record<LoadSort, (a: TowerLoad, b: TowerLoad) => number> = {
    "": (a, b) => statusRank[a.status] - statusRank[b.status],
    pickup: (a, b) => time(a.pickupAt) - time(b.pickupAt),
    eta: (a, b) => time(a.etaAt) - time(b.etaAt),
    rate: (a, b) => b.agreedRate - a.agreedRate,
    progress: (a, b) => b.progress - a.progress,
  };
  return [...loads].sort(compare[sort]);
}

// The equipment codes present in the data, for the Equipment chip.
export function loadEquipments(loads: TowerLoad[]): string[] {
  return [...new Set(loads.map((load) => load.lane.equipment))].sort();
}

// The pickup states present in the data, for the From chip.
export function loadOrigins(loads: TowerLoad[]): string[] {
  return [...new Set(loads.map((load) => load.lane.origin.state))].sort();
}
