import type { DemandLane, TowerDemand } from "./contracts";
import { equipmentLabel } from "./format.ts";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type LaneId = Pick<DemandLane, "originState" | "destinationState" | "equipment">;

// A row's identity: the adapter groups by origin, destination and equipment, null being "Any". It is
// also the `lane` URL value, so "TX||" is the TX row that asked for any destination and equipment.
export function demandKey(lane: LaneId): string {
  return `${lane.originState}|${lane.destinationState ?? ""}|${lane.equipment ?? ""}`;
}

const state = /^[A-Z]{2}$/;
const equipmentCode = /^[A-Z_]+$/;

// The lane a `lane` URL value names, or null when it is not one; a hand-edited link must not reach
// the adapter as a query it refuses.
export function parseDemandKey(key: string): LaneId | null {
  const parts = key.split("|");
  if (parts.length !== 3) return null;
  const [origin, destination, equipment] = parts as [string, string, string];
  if (!state.test(origin) || (destination !== "" && !state.test(destination)) || (equipment !== "" && !equipmentCode.test(equipment))) return null;
  return { originState: origin, destinationState: destination || null, equipment: equipment || null };
}

// The lane's own page: the key, encoded so the "|" separators survive the path.
export function demandLaneHref(lane: LaneId): string {
  return `/demand/${encodeURIComponent(demandKey(lane))}`;
}

// The lane a /demand/[lane] path segment names, or null. The segment may reach the page encoded or
// already decoded, and a key has no "%" of its own, so decoding a decoded one changes nothing.
export function parseDemandLaneParam(segment: string): LaneId | null {
  let key: string;
  try {
    key = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return parseDemandKey(key);
}

// "TX → GA", or "TX → Any" when the carriers asked for any destination.
export function laneLabel(lane: Pick<DemandLane, "originState" | "destinationState">): string {
  return `${lane.originState} → ${lane.destinationState ?? "Any"}`;
}

// The lane page's title: "TX → GA · Reefer", "Any equipment" when the carriers did not say.
export function laneTitle(lane: LaneId): string {
  return `${laneLabel(lane)} · ${lane.equipment ? equipmentLabel(lane.equipment) : "Any equipment"}`;
}

// What the lane is short of: searches that found no load plus loads offered that were never booked.
export function demandUnmet(lane: Pick<DemandLane, "noMatch" | "offeredNoBooking">): number {
  return lane.noMatch + lane.offeredNoBooking;
}

// The unmet bar's width, as a percent of the largest unmet on the loaded rows. A lane with any unmet
// keeps a sliver so it never reads as empty next to a much larger one.
export function unmetBarPercent(unmet: number, largest: number): number {
  if (unmet <= 0 || largest <= 0) return 0;
  return Math.max(4, Math.round((unmet / largest) * 100));
}

// What the board missed on the lane, in words: "9 searches, none matched · 4 carriers" or
// "3 searches, 1 matched · 2 offered, no booking · 3 carriers". Matched is every search that
// returned a load. A clause with nothing to say is left out; `asked` words the carriers for the panel,
// where the sentence stands alone.
export function demandSignal(lane: Pick<DemandLane, "searches" | "noMatch" | "offeredNoBooking" | "carriers">, { asked = false } = {}): string {
  const matched = lane.searches - lane.noMatch;
  const clauses = [
    lane.searches > 0 ? `${plural(lane.searches, "search", "searches")}, ${matched === 0 ? "none" : matched} matched` : null,
    lane.offeredNoBooking > 0 ? `${lane.offeredNoBooking} offered, no booking` : null,
  ].filter((clause) => clause !== null);
  if (clauses.length === 0) clauses.push("No unmet asks");
  return [...clauses, `${plural(lane.carriers, "carrier")}${asked ? " asked" : ""}`].join(" · ");
}

export type DemandTrend = "up" | "down" | "flat";

// Unmet asks this desk week against the week before: "2 vs 5".
export function demandTrend(lane: Pick<DemandLane, "thisWeek" | "previousWeek">): { trend: DemandTrend; text: string } {
  const trend = lane.thisWeek > lane.previousWeek ? "up" : lane.thisWeek < lane.previousWeek ? "down" : "flat";
  return { trend, text: `${lane.thisWeek} vs ${lane.previousWeek}` };
}

export type DemandNextStep = { kind: "source" | "rate" | "both"; title: string; body: string };

// The one thing the desk can do about a lane, from what went unmet on it: nothing on the board means
// sourcing a load, offers that did not book mean the rate. Null when nothing went unmet.
export function demandNextStep(lane: Pick<DemandLane, "noMatch" | "offeredNoBooking">): DemandNextStep | null {
  if (lane.noMatch > 0 && lane.offeredNoBooking > 0) {
    return { kind: "both", title: "Source and check the rate", body: "Some searches found nothing and some offers did not book." };
  }
  if (lane.noMatch > 0) return { kind: "source", title: "Source a load", body: "The board had nothing for these carriers." };
  if (lane.offeredNoBooking > 0) return { kind: "rate", title: "Check the rate", body: "Loads were offered and none booked." };
  return null;
}

// The header strip: the whole filtered board, not only the loaded rows.
export function demandTotalsLabels(totals: TowerDemand["totals"]): { noMatch: string; offeredNoBooking: string; carriers: string } {
  return {
    noMatch: `${plural(totals.noMatch, "search", "searches")} found nothing`,
    offeredNoBooking: `${plural(totals.offeredNoBooking, "offer")} not booked`,
    carriers: `${plural(totals.carriers, "carrier")} asked`,
  };
}

// The query for one row's carriers. Leaving destination or equipment out selects the row the
// carriers asked "Any" for, so they go only when the row has them.
export function demandCarriersQuery(lane: LaneId, page: number): string {
  const params = new URLSearchParams({ origin: lane.originState });
  if (lane.destinationState) params.set("destination", lane.destinationState);
  if (lane.equipment) params.set("equipment", lane.equipment);
  if (page > 1) params.set("page", String(page));
  return params.toString();
}

// A carrier's own page on the Carriers tab, by the carrier key the adapter sends ("mc:9000002").
export function carrierHref(key: string): string {
  return `/carriers/${encodeURIComponent(key)}`;
}

export function asksLabel(asks: number): string {
  return plural(asks, "ask");
}
