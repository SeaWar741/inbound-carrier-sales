import { demandSorts, type DemandCarrier, type DemandLane, type TowerDemand } from "./contracts.ts";
import { equipmentLabel, plural } from "./format.ts";
import { paging, setPaging } from "./list-query.ts";

type LaneId = Pick<DemandLane, "originState" | "destinationState" | "equipment">;

// The adapter's default sort, which the URL never repeats.
export const defaultDemandSort: DemandSort = "unmet";
export type DemandSort = (typeof demandSorts)[number];
export const demandNextSteps = ["source", "rate"] as const;

// The free filters the demand page keeps in the URL besides the next step, sort and paging.
export const demandFilterKeys = ["q", "equipment", "origin"] as const;

// The adapter query for the demand page URL. Only valid values go out, so a hand-edited URL shows the
// default instead of an error.
export function demandQuery(search: Pick<URLSearchParams, "get">): string {
  const query = new URLSearchParams();
  for (const key of demandFilterKeys) {
    const value = search.get(key)?.trim();
    if (value) query.set(key, value);
  }
  const next = search.get("next");
  if (demandNextSteps.some((step) => step === next)) query.set("next", next!);
  setPaging(query, paging(search, demandSorts, defaultDemandSort), defaultDemandSort);
  return query.toString();
}

// A row's identity: the adapter groups by origin, destination and equipment, null being "Any".
export function demandKey(lane: LaneId): string {
  return `${lane.originState}|${lane.destinationState ?? ""}|${lane.equipment ?? ""}`;
}

// "TX → GA", or "TX → Any" when the carriers asked for any destination.
export function laneLabel(lane: Pick<DemandLane, "originState" | "destinationState">): string {
  return `${lane.originState} → ${lane.destinationState ?? "Any"}`;
}

// What the lane is short of: searches that found no load plus loads offered that were never booked.
export function demandUnmet(lane: Pick<DemandLane, "noMatch" | "offeredNoBooking">): number {
  return lane.noMatch + lane.offeredNoBooking;
}

// The unmet bar's width, as a percent of the largest unmet on the page. A lane with any unmet keeps a
// sliver so it never reads as empty next to a much larger one.
export function unmetBarPercent(unmet: number, largest: number): number {
  if (unmet <= 0 || largest <= 0) return 0;
  return Math.max(4, Math.round((unmet / largest) * 100));
}

// What the board missed on the lane, in words: "9 searches found nothing · 2 offers not booked".
export function demandSaid(lane: Pick<DemandLane, "noMatch" | "offeredNoBooking">): string {
  const clauses: string[] = [];
  if (lane.noMatch > 0) clauses.push(`${plural(lane.noMatch, "search", "searches")} found nothing`);
  if (lane.offeredNoBooking > 0) clauses.push(`${plural(lane.offeredNoBooking, "offer")} not booked`);
  return clauses.length > 0 ? clauses.join(" · ") : "No unmet asks";
}

export type DemandTrend = "up" | "down" | "flat";

// Unmet asks the desk week before against this one, in reading order: "5 → 2".
export function demandTrend(lane: Pick<DemandLane, "thisWeek" | "previousWeek">): { trend: DemandTrend; text: string; tip: string } {
  const trend = lane.thisWeek > lane.previousWeek ? "up" : lane.thisWeek < lane.previousWeek ? "down" : "flat";
  return { trend, text: `${lane.previousWeek} → ${lane.thisWeek}`, tip: `Unmet: ${lane.previousWeek} last week, ${lane.thisWeek} this week` };
}

// The Unmet this week tile's hint: how this week compares with the one before.
export function weekChange(totals: Pick<TowerDemand["totals"], "thisWeek" | "previousWeek">): string {
  if (totals.thisWeek > totals.previousWeek) return `Up from ${totals.previousWeek} last week`;
  if (totals.thisWeek < totals.previousWeek) return `Down from ${totals.previousWeek} last week`;
  return "Same as last week";
}

export type DemandNext = "source" | "rate" | "both";

// The desk's move on a lane: nothing on the board means finding a load, offers that did not book mean
// the rate.
export function nextOf(lane: Pick<DemandLane, "noMatch" | "offeredNoBooking">): DemandNext {
  if (lane.offeredNoBooking === 0) return "source";
  if (lane.noMatch === 0) return "rate";
  return "both";
}

// The dashboard narrowed to the lane's pickup state and equipment, where the desk finds or prices a
// load. An Any equipment row leaves equipment out.
export function nextStepHref(lane: Pick<DemandLane, "originState" | "equipment">): string {
  const params = new URLSearchParams({ origin: lane.originState });
  if (lane.equipment) params.set("equipment", lane.equipment);
  return `/?${params.toString()}`;
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

// How the Carriers page and the inbox search for a carrier: its MC, else its name.
function carrierQuery(carrier: Pick<DemandCarrier, "mcNumber" | "carrierName">): string | null {
  return carrier.mcNumber ?? carrier.carrierName;
}

// The Carriers page searched for this carrier, or null when there is nothing to search by.
export function carrierListHref(carrier: Pick<DemandCarrier, "mcNumber" | "carrierName">): string | null {
  const q = carrierQuery(carrier);
  return q ? `/carriers?${new URLSearchParams({ q }).toString()}` : null;
}

// The inbox link for one carrier. `carrier` selects it and `q` makes sure the list holds it; the
// inbox's 30 days cover the demand page's 4 weeks.
export function demandInboxHref(carrier: Pick<DemandCarrier, "key" | "mcNumber" | "carrierName">): string {
  const params = new URLSearchParams({ carrier: carrier.key });
  const q = carrierQuery(carrier);
  if (q) params.set("q", q);
  params.set("since", "30d");
  return `/inbox?${params.toString()}`;
}

// The equipment as a row shows it, "Any equipment" when the carriers did not say.
export function demandEquipmentLabel(equipment: string | null): string {
  return equipment ? equipmentLabel(equipment) : "Any equipment";
}

export function asksLabel(asks: number): string {
  return plural(asks, "ask");
}
