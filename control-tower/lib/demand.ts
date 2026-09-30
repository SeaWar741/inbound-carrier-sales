import type { DemandCarrier, DemandLane } from "./contracts";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A row's identity: the adapter groups by origin, destination and equipment, null being "Any".
export function demandKey(lane: Pick<DemandLane, "originState" | "destinationState" | "equipment">): string {
  return `${lane.originState}|${lane.destinationState ?? ""}|${lane.equipment ?? ""}`;
}

// "TX → GA", or "TX → Any" when the carriers asked for any destination.
export function laneLabel(lane: Pick<DemandLane, "originState" | "destinationState">): string {
  return `${lane.originState} → ${lane.destinationState ?? "Any"}`;
}

// What the board missed on the lane, in words: "7 searches by 4 carriers, 5 matched; 2 offered, no
// booking". Matched is every search that returned a load. A clause with nothing to say is left out.
export function demandSignal(lane: Pick<DemandLane, "searches" | "noMatch" | "offeredNoBooking" | "carriers">): string {
  const by = plural(lane.carriers, "carrier");
  const offered = lane.offeredNoBooking > 0 ? `${lane.offeredNoBooking} offered, no booking` : null;
  if (lane.searches === 0) return offered ? `${lane.offeredNoBooking} offered to ${by}, no booking` : `No asks from ${by}`;
  const searched = `${plural(lane.searches, "search", "searches")} by ${by}, ${lane.searches - lane.noMatch} matched`;
  return offered ? `${searched}; ${offered}` : searched;
}

export type DemandTrend = "up" | "down" | "flat";

// Unmet asks this desk week against the week before.
export function demandTrend(lane: Pick<DemandLane, "thisWeek" | "previousWeek">): { trend: DemandTrend; text: string } {
  const trend = lane.thisWeek > lane.previousWeek ? "up" : lane.thisWeek < lane.previousWeek ? "down" : "flat";
  return { trend, text: `${lane.thisWeek} this week vs ${lane.previousWeek} last` };
}

// The query for one row's carriers. Leaving destination or equipment out selects the row the
// carriers asked "Any" for, so they go only when the row has them.
export function demandCarriersQuery(lane: Pick<DemandLane, "originState" | "destinationState" | "equipment">, page: number): string {
  const params = new URLSearchParams({ origin: lane.originState });
  if (lane.destinationState) params.set("destination", lane.destinationState);
  if (lane.equipment) params.set("equipment", lane.equipment);
  if (page > 1) params.set("page", String(page));
  return params.toString();
}

// The Carriers page searched for this carrier: by MC, else by name; null when there is neither.
export function carrierSearchHref(carrier: Pick<DemandCarrier, "mcNumber" | "carrierName">): string | null {
  const q = carrier.mcNumber ?? carrier.carrierName;
  return q ? `/carriers?${new URLSearchParams({ q }).toString()}` : null;
}

export function asksLabel(asks: number): string {
  return plural(asks, "ask");
}
