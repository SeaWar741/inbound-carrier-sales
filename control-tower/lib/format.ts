import type { CarrierStage, TowerCall } from "./contracts";
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

// The newest summary the agent wrote on a call.
export function lastSummary(call: Pick<TowerCall, "events">): string | null {
  return call.events.findLast((event) => event.summary)?.summary ?? null;
}

export type LoadSection<T> = { loadId: string | null; calls: T[] };

// A carrier's calls sectioned by load: a call belongs to the load of its latest offer, calls with no
// offer share one "no load" section. Sections keep the order of their first call, and calls keep the
// order they came in (newest first from the adapter).
export function groupCallsByLoad<T extends { offers: { loadId: string }[] }>(calls: T[]): LoadSection<T>[] {
  const sections = new Map<string | null, LoadSection<T>>();
  for (const call of calls) {
    const loadId = call.offers.at(-1)?.loadId ?? null;
    let section = sections.get(loadId);
    if (!section) {
      section = { loadId, calls: [] };
      sections.set(loadId, section);
    }
    section.calls.push(call);
  }
  return [...sections.values()];
}

export type TimelineRow<T> =
  | { kind: "call"; call: T; day: string | null }
  | { kind: "no_load"; count: number; open: boolean };

// The rows one timeline section renders. `day` is the desk date (YYYY-MM-DD) on the first call of a
// new day, so today's calls carry none. The no-load section folds into one "N calls without a load"
// row that opens when the operator expands it or when the selected call is inside it.
export function timelineRows<T extends { callId: string; createdAt: string }>(
  section: LoadSection<T>,
  { today, selectedCallId, expanded }: { today: string; selectedCallId: string | null; expanded: boolean },
): TimelineRow<T>[] {
  const rows: TimelineRow<T>[] = [];
  if (section.loadId === null) {
    const open = expanded || section.calls.some((call) => call.callId === selectedCallId);
    rows.push({ kind: "no_load", count: section.calls.length, open });
    if (!open) return rows;
  }
  let previousDay = today;
  for (const call of section.calls) {
    const day = deskDayKey(call.createdAt);
    rows.push({ kind: "call", call, day: day === previousDay ? null : day });
    previousDay = day;
  }
  return rows;
}
