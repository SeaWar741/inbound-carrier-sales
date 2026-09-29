"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LuArrowDownUp, LuArrowRight, LuList, LuSearch, LuTriangleAlert, LuTruck, LuX } from "react-icons/lu";
import { tripLabels, tripTones } from "@/components/dashboard/kpi-tiles";
import { EmptyState } from "@/components/empty-state";
import { equipmentLabel } from "@/components/hold-card";
import { FilterSelect } from "@/components/inbox/filter-bar";
import type { TowerLoad, TripStatus } from "@/lib/contracts";
import { formatUsd } from "@/lib/format";
import type { LoadFilters, LoadSort } from "@/lib/load-filters";

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

const searchDebounceMs = 200;

const statusTabs: { status: TripStatus | ""; label: string }[] = [
  { status: "", label: "All" },
  { status: "in_transit", label: tripLabels.in_transit },
  { status: "upcoming", label: tripLabels.upcoming },
  { status: "arrived", label: tripLabels.arrived },
];

const sortOptions: { value: LoadSort; label: string }[] = [
  { value: "", label: "Status" },
  { value: "pickup", label: "Pickup" },
  { value: "eta", label: "ETA" },
  { value: "rate", label: "Rate high to low" },
  { value: "progress", label: "Progress" },
];

// The box follows the typing; the filter follows the box once typing pauses.
function SearchBox({ q, onSearch }: { q: string; onSearch: (q: string) => void }) {
  const [search, setSearch] = useState(q);
  const lastSent = useRef(q);

  // The Clear button resets q from outside the box.
  useEffect(() => {
    if (q !== lastSent.current) {
      lastSent.current = q;
      setSearch(q);
    }
  }, [q]);

  useEffect(() => {
    const next = search.trim();
    if (next === lastSent.current) return;
    const timer = setTimeout(() => {
      lastSent.current = next;
      onSearch(next);
    }, searchDebounceMs);
    return () => clearTimeout(timer);
  }, [search, onSearch]);

  return (
    <div className="relative">
      <LuSearch size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-faint" aria-hidden />
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        maxLength={64}
        placeholder="Search load, city, carrier, MC"
        aria-label="Search loads"
        className="h-9 w-full min-w-0 rounded-md border border-line bg-transparent py-1 pr-3 pl-9 text-sm text-fg shadow-xs outline-none transition-[color,box-shadow] placeholder:text-fg-faint focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent/30"
      />
    </div>
  );
}

// The inbox tab strip: an underlined tab with a count pill.
function StatusTabs({
  active,
  counts,
  onTab,
}: {
  active: TripStatus | "";
  counts: Record<TripStatus | "all", number> | null;
  onTab: (status: TripStatus | "") => void;
}) {
  return (
    <div role="tablist" aria-label="Load status" className="flex shrink-0 border-b border-line">
      {statusTabs.map(({ status, label }) => {
        const selected = status === active;
        const n = counts ? counts[status || "all"] : null;
        return (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onTab(status)}
            className={`-mb-px flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1 border-b-2 px-1 py-2 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
              selected ? "border-accent text-accent" : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {label}
            <span
              className={`tabular min-w-4 rounded-full px-1 py-0.5 text-center text-[10px] leading-none font-semibold ${
                selected ? "bg-accent-soft text-accent" : "bg-panel-raised text-fg-muted"
              }`}
            >
              {n ?? "-"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ActiveLoads({
  loads,
  total,
  error,
  selectedId,
  onSelect,
  filters,
  sort,
  counts,
  equipments,
  onFilter,
  onSort,
  onClear,
}: {
  // The filtered, sorted loads; null until the first poll lands.
  loads: TowerLoad[] | null;
  // Every booked load in the window, before filters.
  total: number | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  filters: LoadFilters;
  sort: LoadSort;
  counts: Record<TripStatus | "all", number> | null;
  equipments: string[];
  onFilter: <K extends keyof LoadFilters>(key: K, value: LoadFilters[K]) => void;
  onSort: (sort: LoadSort) => void;
  onClear: () => void;
}) {
  const narrowed = filters.q !== "" || filters.status !== "" || filters.equipment !== "" || sort !== "";
  const onSearch = useCallback((q: string) => onFilter("q", q), [onFilter]);

  return (
    <section aria-label="Active loads" className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-panel">
      <div className="flex shrink-0 flex-col gap-2 px-4 pt-2.5 pb-1">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-fg">Active loads</h2>
          {error !== null ? (
            <span className="flex items-center gap-1 text-xs text-warn">
              <LuTriangleAlert size={12} aria-hidden />
              {loads === null ? error : "Stale"}
            </span>
          ) : (
            <span className="tabular text-xs text-fg-faint">
              {loads === null ? "-" : loads.length === total ? total : `${loads.length} of ${total}`}
            </span>
          )}
        </div>
        <SearchBox q={filters.q} onSearch={onSearch} />
        <div className="flex min-w-0 items-center gap-1.5">
          <FilterSelect
            label="Equipment"
            icon={LuTruck}
            value={filters.equipment}
            onChange={(v) => onFilter("equipment", v)}
            options={[{ value: "", label: "Equipment" }, ...equipments.map((c) => ({ value: c, label: equipmentLabel(c) }))]}
          />
          {narrowed && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear filters"
              title="Clear filters"
              className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-panel-raised hover:text-risk"
            >
              <LuX size={14} aria-hidden />
            </button>
          )}
          <span className="ml-auto shrink-0">
            <FilterSelect label="Sort" icon={LuArrowDownUp} value={sort} onChange={(v) => onSort(v as LoadSort)} options={sortOptions} />
          </span>
        </div>
      </div>
      <StatusTabs active={filters.status} counts={counts} onTab={(status) => onFilter("status", status)} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loads === null ? (
          <EmptyState className="h-full py-16" icon={<LuTruck size={20} />} title="Loading loads" />
        ) : total === 0 ? (
          <EmptyState
            className="h-full py-16"
            icon={<LuTruck size={20} />}
            title="No booked loads right now"
            hint="Loads show here once a carrier books one"
          />
        ) : loads.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-16">
            <EmptyState icon={<LuList size={20} />} title="No loads match these filters" />
            <button
              type="button"
              onClick={onClear}
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-line px-2.5 text-xs font-medium text-fg transition-colors hover:bg-panel-raised"
            >
              <LuX size={12} aria-hidden />
              Clear filters
            </button>
          </div>
        ) : (
          loads.map((load) => <LoadRow key={load.holdId} load={load} selected={load.holdId === selectedId} onSelect={onSelect} />)
        )}
      </div>
    </section>
  );
}
