"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { IconType } from "react-icons";
import type { TowerLoad, TowerWall, TripStatus } from "@/lib/contracts";
import { formatUsd } from "@/lib/format";
import { emptyLoadFilters, statusCounts } from "@/lib/load-filters";

// A number that rolls up when it changes, so a new booking is noticed without reading every cell.
function Rolling({ value, className }: { value: string; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <span className={`relative inline-flex overflow-hidden ${className ?? ""}`}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={value}
          initial={reduce ? { opacity: 0 } : { y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { y: "-100%", opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.28, ease: [0.2, 0.8, 0.2, 1] }}
          className="tabular inline-block"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

// The icon, when given, sits before the label in its own tone.
export function Tile({
  label,
  value,
  hint,
  icon: Icon,
  iconTone = "text-fg-muted",
}: {
  label: string;
  value: string;
  hint: string;
  icon?: IconType;
  iconTone?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-panel)] border border-line bg-panel px-4 py-3">
      <dt className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
        {Icon && <Icon size={14} className={`shrink-0 ${iconTone}`} aria-hidden />}
        <span className="truncate">{label}</span>
      </dt>
      <dd className="text-2xl font-medium leading-tight text-fg">
        <Rolling value={value} />
      </dd>
      <dd className="truncate text-xs text-fg-faint">{hint}</dd>
    </div>
  );
}

export const tripLabels: Record<TripStatus, string> = {
  upcoming: "Upcoming",
  in_transit: "In transit",
  arrived: "Arrived (est.)",
};

export const tripTones: Record<TripStatus, { dot: string; pill: string }> = {
  upcoming: { dot: "bg-fg-faint", pill: "bg-panel-raised text-fg-muted" },
  in_transit: { dot: "bg-accent", pill: "bg-accent-soft text-accent" },
  arrived: { dot: "bg-ok", pill: "bg-ok-soft text-ok" },
};

const barOrder: TripStatus[] = ["upcoming", "in_transit", "arrived"];

// How the booked loads split across their trip, as one proportion bar.
function TripSplit({ counts }: { counts: Record<TripStatus | "all", number> | null }) {
  const total = counts?.all ?? 0;
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-[var(--radius-panel)] border border-line bg-panel px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-fg-muted">Booked loads</span>
        <span className="tabular text-xs text-fg-faint">{counts === null ? "-" : total}</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-panel-raised" aria-hidden>
        {total > 0 &&
          barOrder.map((status) =>
            counts !== null && counts[status] > 0 ? (
              <div key={status} className={`${tripTones[status].dot} border-r-2 border-panel last:border-r-0`} style={{ flexGrow: counts[status] }} />
            ) : null,
          )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {barOrder.map((status) => (
          <li key={status} className="flex items-center gap-1.5 text-xs text-fg-muted">
            <span className={`size-2 rounded-full ${tripTones[status].dot}`} aria-hidden />
            {tripLabels[status]}
            <span className="tabular text-fg">{counts === null ? "-" : counts[status]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function KpiTiles({ loads, counters }: { loads: TowerLoad[] | null; counters: TowerWall["counters"] | null }) {
  const counts = loads && statusCounts(loads, emptyLoadFilters);
  const dollarsInMotion = (loads ?? []).reduce((sum, load) => sum + (load.status === "in_transit" ? load.agreedRate : 0), 0);
  const winRate = counters && counters.offered > 0 ? `${Math.round((counters.booked / counters.offered) * 100)}%` : "-";

  return (
    <section aria-label="Key numbers" aria-live="polite">
      <dl className="grid grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,1.6fr)] gap-3">
        <Tile label="Dollars in motion" value={loads === null ? "-" : formatUsd(dollarsInMotion)} hint="Agreed rate of loads in transit" />
        <Tile label="Loads in motion" value={counts === null ? "-" : String(counts.in_transit)} hint={`${counts?.upcoming ?? 0} more picking up soon`} />
        <Tile
          label="Booked today"
          value={counters === null ? "-" : String(counters.booked)}
          hint={counters === null ? "" : `${formatUsd(counters.bookedValue)} booked load value`}
        />
        <Tile
          label="Win rate today"
          value={winRate}
          hint={counters === null ? "" : `${counters.booked} booked of ${counters.offered} offered · ${counters.calls} calls`}
        />
        <Tile
          label="Trucks captured · 7d"
          value={counters === null ? "-" : String(counters.capacity.captured)}
          hint={
            counters === null ? "" : `${counters.capacity.notified} notified · ${counters.capacity.bookedAfterNotice} booked after notice`
          }
        />
        <TripSplit counts={counts} />
      </dl>
    </section>
  );
}
