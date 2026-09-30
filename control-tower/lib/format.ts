import type { CarrierStage, TowerCall, TripSnapshot } from "./contracts";
import type { LoadOutcome } from "./pricing";

// Display helpers for money, durations and times. The desk runs on Chicago time.
const deskTimeZone = "America/Chicago";

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const clock = new Intl.DateTimeFormat("en-US", { timeZone: deskTimeZone, hour: "numeric", minute: "2-digit" });
const clockSeconds = new Intl.DateTimeFormat("en-US", {
  timeZone: deskTimeZone,
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
// wall.day is already the Chicago calendar date, so it is formatted as a plain date in UTC.
const dateTime = new Intl.DateTimeFormat("en-US", { timeZone: deskTimeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
// The desk calendar date of an instant as YYYY-MM-DD (en-CA formats dates that way).
const deskDate = new Intl.DateTimeFormat("en-CA", { timeZone: deskTimeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

export function formatUsd(amount: number): string {
  return usdWhole.format(amount);
}

// "+$134" or "-$50"; zero carries no sign.
export function formatSignedUsd(amount: number): string {
  const rounded = Math.round(amount);
  if (rounded === 0) return usdWhole.format(0);
  return `${rounded > 0 ? "+" : "-"}${usdWhole.format(Math.abs(rounded))}`;
}

// "$2.72/mi".
export function formatPerMile(usdPerMile: number): string {
  return `$${usdPerMile.toFixed(2)}/mi`;
}

export function formatPercent(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

// Driving plus required rest, "30.5 h".
export function formatHours(hours: number): string {
  return `${hours.toFixed(1)} h`;
}

// A trip one driver cannot make on time; solo needs no badge. Impossible says how late even a team lands.
export function feasibilityBadge(trip: Pick<TripSnapshot, "feasibility" | "lateHours">): { text: string; tone: string } | null {
  switch (trip.feasibility) {
    case "solo":
      return null;
    case "team":
      return { text: "Needs team", tone: "bg-tone-amber-soft text-tone-amber" };
    case "impossible":
      return { text: `Late ~${Math.round(trip.lateHours)}h`, tone: "bg-tone-red-soft text-tone-red" };
  }
}

export function deskDayKey(iso: string | number): string {
  return deskDate.format(new Date(iso));
}

// mm:ss, rolling into h:mm:ss for calls longer than an hour.
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

export function formatClock(iso: string | number, withSeconds = false): string {
  return (withSeconds ? clockSeconds : clock).format(new Date(iso));
}

export function formatDay(isoDate: string): string {
  return dayLabel.format(new Date(`${isoDate}T00:00:00Z`));
}

export function formatMs(ms: number | null): string {
  return ms === null ? "-" : `${Math.round(ms)}`;
}

// How the carrier on a call is named everywhere in the tower.
export function carrierId(call: TowerCall): string {
  if (call.mcNumber) return `MC ${call.mcNumber}`;
  if (call.dotNumber) return `DOT ${call.dotNumber}`;
  return "Unidentified carrier";
}

export function carrierState(call: TowerCall): { text: string; tone: string } | null {
  if (call.otp.locked) return { text: "OTP locked", tone: "text-risk" };
  if (call.verified) return call.eligible ? { text: "Verified", tone: "text-ok" } : { text: "Not eligible", tone: "text-risk" };
  if (!call.eligible) return { text: "Not eligible", tone: "text-risk" };
  if (call.mcNumber || call.dotNumber) return { text: "Unverified", tone: "text-fg-muted" };
  return null;
}

// Day and time on the desk clock, for instants that may not be today ("Oct 1, 3:05 PM").
export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

// "now", "5m", "3h", "2d": how long ago, for list rows.
export function formatTimeAgo(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const carrierStageLabels: Record<CarrierStage, string> = {
  needs_approval: "Needs approval",
  negotiating: "Negotiating",
  live: "Live",
  booked: "Booked",
  in_transit: "In transit",
  arrived: "Arrived (est.)",
  lost: "Lost",
};

// How a carrier is named in the inbox: its FMCSA name when stored, else its numbers.
export function carrierName(carrier: { carrierName: string | null; mcNumber: string | null; dotNumber: string | null }): string {
  if (carrier.carrierName) return carrier.carrierName;
  if (carrier.mcNumber) return `MC ${carrier.mcNumber}`;
  if (carrier.dotNumber) return `DOT ${carrier.dotNumber}`;
  return "Unidentified carrier";
}

export function callStageLabel(call: Pick<TowerCall, "stage" | "round">): string {
  switch (call.stage) {
    case "otp":
      return "OTP";
    case "negotiating":
      return call.round === null ? "Negotiating" : `Round ${call.round}`;
    default:
      return call.stage.charAt(0).toUpperCase() + call.stage.slice(1);
  }
}

// A load's outcome as the timeline and the pricing card word it, with its text color.
export function outcomeLabel(outcome: LoadOutcome): { text: string; tone: string } {
  switch (outcome.kind) {
    case "booked":
      return { text: `Booked ${formatUsd(outcome.amount)}`, tone: "text-ok" };
    case "holding":
      return { text: `Holding ${formatUsd(outcome.amount)}`, tone: "text-accent" };
    case "negotiating":
      return { text: "Negotiating", tone: "text-accent" };
    case "lost":
      return { text: "Lost", tone: "text-fg-muted" };
    case "no_offer":
      return { text: "No offer", tone: "text-fg-faint" };
  }
}

// A tool name without the leading underscores HappyRobot puts on built-ins ("_hangup").
export function toolKey(name: string): string {
  return name.replace(/^_+/, "");
}

const toolLabels: Record<string, string> = {
  verify_carrier: "Verified carrier",
  send_otp: "Sent verification code",
  check_otp: "Checked verification code",
  search_loads: "Searched loads",
  evaluate_offer: "Evaluated offer",
  create_hold: "Placed hold",
  request_human: "Asked for a human",
  hangup: "Call ended by agent",
  get_trip_estimate: "Estimated trip",
  hold_notice: "Notified carrier",
};

// The same tools when their event is recorded with status "failed".
const failedToolLabels: Record<string, string> = {
  hold_notice: "Carrier not notified",
};

// An agent tool call as the transcript words it; an unknown tool reads as its name in words.
// A failed event of a tool without its own failed wording reads as its label plus "failed".
export function toolLabel(name: string, status?: string | null): string {
  const key = toolKey(name);
  if (status === "failed") return failedToolLabels[key] ?? `${toolLabel(name)} failed`;
  const known = toolLabels[key];
  if (known) return known;
  const words = key.replaceAll("_", " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

// The newest summary the agent wrote on a call.
function lastSummary(call: Pick<TowerCall, "events">): string | null {
  return call.events.findLast((event) => event.summary)?.summary ?? null;
}

// One line for a call in the timeline. A call that placed a hold is worded by the hold's current
// status: the agent's last event says "Holding" even after a rep books or releases the load.
export function callSummary(call: Pick<TowerCall, "events" | "hold">): string | null {
  const hold = call.hold;
  if (!hold) return lastSummary(call);
  const at = `${hold.loadId} at ${formatUsd(hold.agreedRate)}`;
  switch (hold.status) {
    case "held":
      return `Holding ${at}, waiting for a rep`;
    case "confirming":
      return `Confirming ${at}`;
    case "booked":
      return `Booked ${at}`;
    case "booked_unconfirmed":
      return `Booked ${at}, unconfirmed`;
    case "released":
      return `Released ${hold.loadId}`;
  }
}

export type LoadCard<T> = {
  // Null for the one card that collects calls without any offer.
  loadId: string | null;
  // Newest first; the first is the call a click on the card selects.
  calls: T[];
  // The furthest negotiation round any of the calls reached on this load, 0 without offers.
  rounds: number;
  // When the newest call on the card started.
  lastAt: string;
};

type CardCall = { callId: string; createdAt: string; offers: { loadId: string; round: number }[] };

// The timeline's cards: one per load (a call belongs to the load of its latest offer), newest
// activity first, and the calls without a load folded into one card at the end.
export function loadCards<T extends CardCall>(calls: T[]): LoadCard<T>[] {
  const byLoad = new Map<string | null, T[]>();
  for (const call of calls) {
    const loadId = call.offers.at(-1)?.loadId ?? null;
    const group = byLoad.get(loadId);
    if (group) group.push(call);
    else byLoad.set(loadId, [call]);
  }
  const cards = [...byLoad].map(([loadId, group]) => {
    const ordered = [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const rounds = Math.max(
      0,
      ...ordered.flatMap((call) => call.offers.filter((offer) => offer.loadId === loadId).map((offer) => offer.round)),
    );
    return { loadId, calls: ordered, rounds, lastAt: ordered[0]!.createdAt };
  });
  return cards.sort((a, b) => {
    if ((a.loadId === null) !== (b.loadId === null)) return a.loadId === null ? 1 : -1;
    return b.lastAt.localeCompare(a.lastAt);
  });
}

// A time on the desk clock, with the date in front when it is not on `today` ("Sep 28, 2:30 PM").
export function formatDeskWhen(iso: string, today: string): string {
  return deskDayKey(iso) === today ? formatClock(iso) : formatDateTime(iso);
}
