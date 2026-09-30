"use client";

import { useCallback, useEffect, useRef } from "react";
import { LuArrowDownUp, LuArrowRight, LuList, LuTriangleAlert, LuTruck, LuX } from "react-icons/lu";
import { tripLabels, tripTones } from "@/components/dashboard/kpi-tiles";
import { EmptyState } from "@/components/empty-state";
import { FilterSelect, SearchInput, TabStrip } from "@/components/inbox/filter-bar";
import type { TowerLoad, TripStatus } from "@/lib/contracts";
import { carrierName, equipmentLabel, formatDateTime, formatUsd } from "@/lib/format";
import type { LoadFilters, LoadSort } from "@/lib/load-filters";

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
        <span className="truncate">{carrierName({ ...load, dotNumber: null })}</span>
        <span className="tabular shrink-0">ETA {formatDateTime(load.etaAt)}</span>
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
        <SearchInput q={filters.q} onSearch={onSearch} placeholder="Search load, city, carrier, MC" label="Search loads" />
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
      <TabStrip
        label="Load status"
        tabs={statusTabs.map(({ status, label }) => ({ value: status, label, count: counts ? counts[status || "all"] : null }))}
        active={filters.status}
        onTab={(status) => onFilter("status", status)}
      />
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
