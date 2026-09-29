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
const dayLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

export function formatUsd(amount: number): string {
  return usdWhole.format(amount);
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
