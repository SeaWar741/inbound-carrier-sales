"use client";

import { useEffect, useRef } from "react";
import { LuArrowRight, LuTriangleAlert, LuTruck } from "react-icons/lu";
import { tripLabels, tripTones } from "@/components/dashboard/kpi-tiles";
import { EmptyState } from "@/components/empty-state";
import type { TowerLoad } from "@/lib/contracts";
import { formatUsd } from "@/lib/format";

// ETAs are instants; the desk reads them on Chicago time.
const etaFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function carrierLabel(load: TowerLoad): string {
  if (load.carrierName) return load.carrierName;
  return load.mcNumber ? `MC ${load.mcNumber}` : "Unidentified carrier";
}

function LoadRow({ load, selected, onSelect }: { load: TowerLoad; selected: boolean; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  // A pick on the map brings its row into view.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const { lane } = load;

  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(load.holdId)}
      className={`flex w-full min-w-0 flex-col gap-2 border-b border-line px-4 py-3 text-left transition focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
        selected ? "bg-accent-soft" : "hover:bg-panel-raised"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="tabular shrink-0 text-xs text-fg-muted">{load.loadId}</span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${tripTones[load.status].pill}`}>
          {tripLabels[load.status]}
        </span>
        <span className="tabular ml-auto shrink-0 text-xs text-fg">{formatUsd(load.agreedRate)}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1 text-sm text-fg">
        <span className="truncate">
          {lane.origin.city}, {lane.origin.state}
        </span>
        <LuArrowRight size={12} className="shrink-0 text-fg-faint" aria-label="to" />
        <span className="truncate">
          {lane.destination.city}, {lane.destination.state}
        </span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-fg-muted">
        <span className="truncate">{carrierLabel(load)}</span>
        <span className="tabular shrink-0">ETA {etaFormat.format(new Date(load.etaAt))}</span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-panel-raised"
        role="progressbar"
        aria-label="Trip progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(load.progress * 100)}
      >
        <div className={`h-full rounded-full ${tripTones[load.status].dot}`} style={{ width: `${load.progress * 100}%` }} />
      </div>
    </button>
  );
}

export function ActiveLoads({
  loads,
  error,
  selectedId,
  onSelect,
}: {
  loads: TowerLoad[] | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section aria-label="Active loads" className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-panel">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-medium text-fg">Active loads</h2>
        {error !== null ? (
          <span className="flex items-center gap-1 text-xs text-warn">
            <LuTriangleAlert size={12} aria-hidden />
            {loads === null ? error : "Stale"}
          </span>
        ) : (
          <span className="tabular text-xs text-fg-faint">{loads?.length ?? "-"}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loads === null ? (
          <EmptyState className="h-full py-16" icon={<LuTruck size={20} />} title="Loading loads" />
        ) : loads.length === 0 ? (
          <EmptyState
            className="h-full py-16"
            icon={<LuTruck size={20} />}
            title="No booked loads right now"
            hint="Loads show here once a carrier books one"
          />
        ) : (
          loads.map((load) => <LoadRow key={load.holdId} load={load} selected={load.holdId === selectedId} onSelect={onSelect} />)
        )}
      </div>
    </section>
  );
}
