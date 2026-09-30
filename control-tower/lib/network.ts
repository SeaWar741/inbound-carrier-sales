import type { CarrierRelationship, DemandLane, NetworkCarrier, TowerCall } from "./contracts";
import { deskDayKey, equipmentLabel, formatUsd } from "./format.ts";

// Mirrors the adapter's segmentRecentDays, only to word the span the at-risk sentence compares.
export const recentDays = 14;
const dayMs = 86_400_000;
// The inbox's longest `since` preset; an older last call needs an explicit day range there.
const inboxLongestDays = 30;

// The carriers page window as the URL keeps it: `since` is "" for the default (30 days), "7d" or
// "today"; a whole from/to day range replaces it.
export type NetworkWindow = { since: string; from: string; to: string };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The inbox's date picker reads "" as its own default (7 days), so the two windows translate both ways.
export function toInboxWindow(dateWindow: NetworkWindow): NetworkWindow {
  if (dateWindow.from && dateWindow.to) return { since: "", from: dateWindow.from, to: dateWindow.to };
  return { since: dateWindow.since === "7d" ? "" : dateWindow.since === "today" ? "today" : "30d", from: "", to: "" };
}

export function fromInboxWindow(dateWindow: NetworkWindow): NetworkWindow {
  if (dateWindow.from && dateWindow.to) return { since: "", from: dateWindow.from, to: dateWindow.to };
  return { since: dateWindow.since === "" ? "7d" : dateWindow.since === "30d" ? "" : dateWindow.since, from: "", to: "" };
}

// Desk days are plain dates, so they are formatted in UTC ("Sep 1").
const shortDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

// How a sentence names the window: "in 30 d", "in 7 d", "today", "from Sep 1 to Sep 20".
export function windowPhrase(dateWindow: NetworkWindow): string {
  if (dateWindow.from && dateWindow.to) {
    return `from ${shortDay.format(new Date(`${dateWindow.from}T00:00:00Z`))} to ${shortDay.format(new Date(`${dateWindow.to}T00:00:00Z`))}`;
  }
  if (dateWindow.since === "today") return "today";
  if (dateWindow.since === "7d") return "in 7 d";
  return "in 30 d";
}

// Whole days since the carrier's last call.
export function daysSinceLastCall(carrier: Pick<NetworkCarrier, "facts">, now: number): number {
  return Math.floor((now - Date.parse(carrier.facts.lastCallAt)) / dayMs);
}

function relationshipSentence(carrier: NetworkCarrier, now: number): string | null {
  const { facts } = carrier;
  if (carrier.relationship === "new") return `${plural(facts.lifetimeCalls, "call")} so far`;
  if (carrier.relationship === "at_risk") {
    // The adapter marks a carrier at risk for no calls in the recent span or for calling less than half
    // as often; no recent calls is the first, so the sentence reads the facts rather than the dates.
    if (facts.callsRecent === 0) return `Last call ${daysSinceLastCall(carrier, now)} d ago; ${plural(facts.lifetimeBookings, "booking")} before`;
    return `Calls down: ${facts.callsRecent} in ${recentDays} d vs ${facts.callsPrior} before`;
  }
  return null;
}

function topSentence(carrier: NetworkCarrier, dateWindow: NetworkWindow): string {
  const { bookings, negotiableCalls } = carrier.facts;
  const when = windowPhrase(dateWindow);
  // A call can book more than one load, so bookings may outnumber the negotiated calls.
  if (bookings > negotiableCalls) return `${plural(bookings, "booking")} on ${plural(negotiableCalls, "negotiated call")} ${when}`;
  return `${bookings} of ${plural(negotiableCalls, "negotiated call")} booked ${when}`;
}

// Names the lane the board matched; the adapter lists open lanes first, so it is among the five.
// A search without equipment asked for any, so it is phrased as asked, not as run.
function growthSentence(carrier: NetworkCarrier): string {
  const lane = carrier.lanes.find((l) => l.open);
  if (!lane?.originState) return "A lane it runs is open on the board now";
  if (!lane.equipment) return `Asked for ${lane.originState} · any equipment, open on the board now`;
  return `Has run ${lane.originState} · ${equipmentLabel(lane.equipment)}, open on the board now`;
}

// A plain active carrier with no tag has nothing to explain, in the row or the panel.
const nothingToFlag = "Active, nothing to flag";

export type NetworkReason = { kind: CarrierRelationship | "top" | "growth"; text: string };

// Why the carrier sits where it does, one full sentence per line for the panel: the relationship
// sentence, then one per tag.
export function networkReasons(carrier: NetworkCarrier, now: number, dateWindow: NetworkWindow): NetworkReason[] {
  const reasons: NetworkReason[] = [];
  const relationship = relationshipSentence(carrier, now);
  if (relationship !== null) reasons.push({ kind: carrier.relationship, text: relationship });
  if (carrier.top) reasons.push({ kind: "top", text: topSentence(carrier, dateWindow) });
  if (carrier.growth) reasons.push({ kind: "growth", text: growthSentence(carrier) });
  return reasons.length > 0 ? reasons : [{ kind: "active", text: nothingToFlag }];
}

function shortRelationship(carrier: NetworkCarrier, now: number): string | null {
  const { facts } = carrier;
  if (carrier.relationship === "new") return `${plural(facts.lifetimeCalls, "call")} so far`;
  if (carrier.relationship === "at_risk") {
    if (facts.callsRecent === 0) return `No call in ${daysSinceLastCall(carrier, now)} d · ${plural(facts.lifetimeBookings, "booking")} before`;
    return `Calls down ${facts.callsRecent} vs ${facts.callsPrior}`;
  }
  return null;
}

// Top counts offers as the calls that had one, so "3 of 4 offers booked" reads the same facts as the panel.
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

export type CallsTrend = "up" | "down" | "flat";

// The last 14 days of calls against the 14 before.
export function callsTrend(carrier: Pick<NetworkCarrier, "facts">): CallsTrend {
  const { callsRecent, callsPrior } = carrier.facts;
  if (callsRecent > callsPrior) return "up";
  if (callsRecent < callsPrior) return "down";
  return "flat";
}

// The inbox link for one carrier. `carrier` selects it; `q` (its MC, else DOT, else name) and a window
// that reaches its last call make sure the inbox list holds it, since an at-risk carrier's last call
// may be older than the inbox's default week.
export function inboxHref(carrier: Pick<NetworkCarrier, "key" | "mcNumber" | "dotNumber" | "carrierName" | "facts">, now: number): string {
  const params = new URLSearchParams({ carrier: carrier.key });
  const q = carrier.mcNumber ?? carrier.dotNumber ?? carrier.carrierName;
  if (q) params.set("q", q);
  // A day of slack keeps a call near the edge of the rolling 30 days from falling out of it.
  if (now - Date.parse(carrier.facts.lastCallAt) < (inboxLongestDays - 1) * dayMs) {
    params.set("since", "30d");
  } else {
    params.set("from", deskDayKey(carrier.facts.lastCallAt));
    params.set("to", deskDayKey(now));
  }
  return `/inbox?${params.toString()}`;
}

// The carrier page's one decision: what to do with this carrier and the sentence that says why.
// The first rule that holds wins, in the order a call is most worth making.
export type CarrierDecision = { kind: NetworkReason["kind"]; title: string; sentence: string };

export function carrierDecision(carrier: NetworkCarrier, now: number): CarrierDecision {
  const { facts } = carrier;
  if (carrier.relationship === "at_risk") {
    if (facts.callsRecent > 0) return { kind: "at_risk", title: "Call back", sentence: "Calling less than usual" };
    const after = facts.lifetimeBookings > 0 ? ` after ${plural(facts.lifetimeBookings, "booking")}` : "";
    return { kind: "at_risk", title: "Call back", sentence: `No call in ${daysSinceLastCall(carrier, now)} d${after}` };
  }
  if (carrier.growth) {
    const lane = carrier.lanes.find((l) => l.open);
    const where = lane?.originState ? [lane.originState, lane.equipment && equipmentLabel(lane.equipment)].filter(Boolean).join(" ") : "A lane it runs";
    return { kind: "growth", title: "Offer the open lane", sentence: `${where} is open on the board now` };
  }
  if (carrier.relationship === "new") return { kind: "new", title: "Get to know them", sentence: `${plural(facts.lifetimeCalls, "call")} so far` };
  if (carrier.top) return { kind: "top", title: "Keep them close", sentence: "Books most of its offers" };
  return { kind: "active", title: "Nothing to act on", sentence: nothingToFlag };
}

// The demand page of one lane: origin, destination and equipment joined with "|", an empty part
// for "Any", encoded as one path segment (/demand/TX%7CGA%7CREEFER).
export function demandHref(lane: Pick<DemandLane, "originState" | "destinationState" | "equipment">): string {
  return `/demand/${encodeURIComponent([lane.originState, lane.destinationState ?? "", lane.equipment ?? ""].join("|"))}`;
}

// One row of the carrier page's lanes: how often it ran the lane in the window, whether the board
// has it open, and the asks on it that found no load or no deal.
export type CarrierLane = {
  key: string;
  originState: string | null;
  destinationState: string | null;
  equipment: string | null;
  // Null when the lane is only in the carrier's demand, not among its observed lanes.
  calls: number | null;
  open: boolean;
  unmet: number;
};

// The observed lanes in the network's order, each with its unmet asks, then the lanes it only asked
// for without getting a load, most unmet first. The two sources name "Any" the same way (null).
export function carrierLanes(observed: NetworkCarrier["lanes"], demand: Pick<DemandLane, "originState" | "destinationState" | "equipment" | "noMatch" | "offeredNoBooking">[]): CarrierLane[] {
  const keyOf = (lane: { originState: string | null; destinationState: string | null; equipment: string | null }) =>
    [lane.originState ?? "", lane.destinationState ?? "", lane.equipment ?? ""].join("|");
  const unmetByKey = new Map(demand.map((lane) => [keyOf(lane), lane.noMatch + lane.offeredNoBooking]));
  const rows: CarrierLane[] = observed.map((lane) => ({
    key: keyOf(lane),
    originState: lane.originState,
    destinationState: lane.destinationState,
    equipment: lane.equipment,
    calls: lane.count,
    open: lane.open,
    unmet: unmetByKey.get(keyOf(lane)) ?? 0,
  }));
  const seen = new Set(rows.map((row) => row.key));
  const askedOnly = demand
    .filter((lane) => !seen.has(keyOf(lane)) && lane.noMatch + lane.offeredNoBooking > 0)
    .map((lane) => ({
      key: keyOf(lane),
      originState: lane.originState,
      destinationState: lane.destinationState,
      equipment: lane.equipment,
      calls: null,
      open: false,
      unmet: lane.noMatch + lane.offeredNoBooking,
    }))
    .sort((a, b) => b.unmet - a.unmet);
  return [...rows, ...askedOnly];
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
  if (last) return { kind: "lost", text: `No deal, last ask ${formatUsd(last.carrierAsk)}` };
  return { kind: "no_offer", text: "No load offered" };
}
