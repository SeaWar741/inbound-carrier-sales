import { networkSorts, networkViews, type NetworkCarrier, type TowerCall } from "./contracts.ts";
import { deskDayKey, equipmentLabel, formatUsd, plural } from "./format.ts";
import { paging, setPaging } from "./list-query.ts";

const dayMs = 86_400_000;
// The inbox's longest `since` preset; an older last call needs an explicit day range there.
const inboxLongestDays = 30;

// The adapter's default sort, which the URL never repeats.
export const defaultSort: NetworkSort = "lastCall";
export type NetworkSort = (typeof networkSorts)[number];

// The filters the carriers page keeps in the URL besides the status view, sort and paging.
export const networkFilterKeys = ["q", "equipment", "origin"] as const;

// The adapter query for the carriers page URL. Only valid values go out, so a hand-edited URL shows
// the default instead of an error; the window is the adapter's fixed 30 days.
export function networkQuery(search: Pick<URLSearchParams, "get">): string {
  const query = new URLSearchParams();
  const view = search.get("view");
  if (view !== "all" && networkViews.some((v) => v === view)) query.set("view", view!);
  for (const key of networkFilterKeys) {
    const value = search.get(key)?.trim();
    if (value) query.set(key, value);
  }
  setPaging(query, paging(search, networkSorts, defaultSort), defaultSort);
  return query.toString();
}

// Whole days since the carrier's last call.
function daysSinceLastCall(carrier: Pick<NetworkCarrier, "facts">, now: number): number {
  return Math.floor((now - Date.parse(carrier.facts.lastCallAt)) / dayMs);
}

// A plain active carrier with no tag has nothing to explain.
const nothingToFlag = "Active, nothing to flag";

function shortRelationship(carrier: NetworkCarrier, now: number): string | null {
  const { facts } = carrier;
  if (carrier.relationship === "new") return `${plural(facts.lifetimeCalls, "call")} so far`;
  if (carrier.relationship === "at_risk") {
    if (facts.callsRecent === 0) return `No call in ${daysSinceLastCall(carrier, now)} d · ${plural(facts.lifetimeBookings, "booking")} before`;
    return `Calls down ${facts.callsRecent} vs ${facts.callsPrior}`;
  }
  return null;
}

// Top counts offers as the calls that had one: "3 of 4 offers booked".
function shortTop(carrier: NetworkCarrier): string {
  const { bookings, negotiableCalls } = carrier.facts;
  if (bookings > negotiableCalls) return `${plural(bookings, "booking")} on ${plural(negotiableCalls, "offer")}`;
  return `${bookings} of ${plural(negotiableCalls, "offer")} booked`;
}

function shortGrowth(carrier: NetworkCarrier): string {
  const lane = carrier.lanes.find((l) => l.open);
  if (!lane?.originState) return "A lane it runs is open now";
  if (!lane.equipment) return `${lane.originState} open now`;
  return `${lane.originState} ${equipmentLabel(lane.equipment)} open now`;
}

// The list row's one-line reason: signal and number, joined with " · ", short enough for one line.
export function shortReason(carrier: NetworkCarrier, now: number): string {
  const parts = [shortRelationship(carrier, now)];
  if (carrier.top) parts.push(shortTop(carrier));
  if (carrier.growth) parts.push(shortGrowth(carrier));
  const phrases = parts.filter((part): part is string => part !== null);
  return phrases.length > 0 ? phrases.join(" · ") : nothingToFlag;
}

// A window that holds the carrier's last call: the rolling 30 days, else a day range reaching back to
// it, since an at-risk carrier's last call may be older. A day of slack keeps a call near the edge of
// the 30 days from falling out of it.
export function callsWindow(carrier: Pick<NetworkCarrier, "facts">, now: number): Record<string, string> {
  if (now - Date.parse(carrier.facts.lastCallAt) < (inboxLongestDays - 1) * dayMs) return { since: "30d" };
  return { from: deskDayKey(carrier.facts.lastCallAt), to: deskDayKey(now) };
}

// The inbox link for one carrier. `carrier` selects it; `q` (its MC, else DOT, else name) and the
// calls window make sure the inbox list holds it.
export function inboxHref(carrier: Pick<NetworkCarrier, "key" | "mcNumber" | "dotNumber" | "carrierName" | "facts">, now: number): string {
  const params = new URLSearchParams({ carrier: carrier.key });
  const q = carrier.mcNumber ?? carrier.dotNumber ?? carrier.carrierName;
  if (q) params.set("q", q);
  for (const [key, value] of Object.entries(callsWindow(carrier, now))) params.set(key, value);
  return `/inbox?${params.toString()}`;
}

export type CallOutcome = { kind: "live" | "booked" | "holding" | "lost" | "no_offer"; text: string };

// How one of the carrier's calls ended, for its timeline: the hold decides when there is one, then
// whether any load was offered.
export function callOutcome(call: Pick<TowerCall, "live" | "hold" | "offers">): CallOutcome {
  if (call.live) return { kind: "live", text: "On the call now" };
  const hold = call.hold;
  if (hold) {
    if (hold.status === "booked" || hold.status === "booked_unconfirmed") return { kind: "booked", text: `Booked at ${formatUsd(hold.agreedRate)}` };
    if (hold.status === "released") return { kind: "lost", text: "Hold released" };
    return { kind: "holding", text: `Holding at ${formatUsd(hold.agreedRate)}` };
  }
  const last = call.offers.at(-1);
  if (last && last.rateToSay !== null) return { kind: "lost", text: `No deal: asked ${formatUsd(last.carrierAsk)}, our best ${formatUsd(last.rateToSay)}` };
  if (last) return { kind: "lost", text: `No deal, last ask ${formatUsd(last.carrierAsk)}` };
  return { kind: "no_offer", text: "No load offered" };
}
