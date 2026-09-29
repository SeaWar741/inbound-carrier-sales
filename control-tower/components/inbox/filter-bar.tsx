"use client";

import { useEffect, useRef, useState } from "react";
import type { IconType } from "react-icons";
import { LuArrowDownUp, LuArrowRight, LuCalendarDays, LuChevronDown, LuCircleDot, LuRoute, LuSearch, LuTruck, LuX } from "react-icons/lu";
import { equipmentLabel } from "@/components/hold-card";
import { carrierStages, inboxSorts } from "@/lib/contracts";
import { carrierStageLabels } from "@/lib/format";

// The filters the inbox keeps in the URL; an empty string is "no filter" (or the adapter default).
export type InboxFilters = {
  stage: string;
  equipment: string;
  origin: string;
  destination: string;
  since: string;
  q: string;
  sort: string;
};

const equipmentCodes = ["DRY_VAN", "REEFER", "FLATBED", "STEP_DECK", "POWER_ONLY"];
const states = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];
// The adapter's `since` windows and sorts; the URL omits their defaults (7d, priority).
const sinceOptions = [
  { value: "", label: "7 days" },
  { value: "today", label: "Today" },
  { value: "30d", label: "30 days" },
];
const sortLabels: Record<(typeof inboxSorts)[number], string> = {
  priority: "Priority",
  recent: "Recent",
  rate: "Rate",
  pickup: "Pickup",
};
const searchDebounceMs = 300;

// The cortex filter chip (an h-8 select trigger with a leading icon), on a native select.
export function FilterSelect({
  label,
  icon: Icon,
  value,
  onChange,
  options,
}: {
  label: string;
  icon: IconType;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const set = value !== "";
  return (
    <label className="relative inline-flex h-7 shrink-0 items-center">
      <Icon size={13} className={`pointer-events-none absolute left-2 ${set ? "text-accent" : "text-fg-faint"}`} aria-hidden />
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`field-sizing-content h-7 cursor-pointer appearance-none rounded-lg border bg-panel pr-5 pl-6 text-xs font-medium outline-none transition-colors hover:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40 ${
          set ? "border-accent/40 text-accent" : "border-line text-fg"
        }`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <LuChevronDown size={12} className="pointer-events-none absolute right-1.5 text-fg-faint opacity-70" aria-hidden />
    </label>
  );
}

// Origin and destination states as one chip: "TX -> Any".
function LaneSelect({
  origin,
  destination,
  onChange,
}: {
  origin: string;
  destination: string;
  onChange: (key: "origin" | "destination", value: string) => void;
}) {
  const set = origin !== "" || destination !== "";
  const select = (key: "origin" | "destination", value: string, label: string) => (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(key, event.target.value)}
      className="field-sizing-content h-full cursor-pointer appearance-none bg-transparent px-0.5 outline-none focus-visible:underline"
    >
      <option value="">Any</option>
      {states.map((state) => (
        <option key={state} value={state}>
          {state}
        </option>
      ))}
    </select>
  );
  return (
    <span
      className={`inline-flex h-7 shrink-0 items-center gap-0.5 rounded-lg border bg-panel pr-1.5 pl-2 text-xs font-medium transition-colors focus-within:ring-2 focus-within:ring-accent/40 hover:bg-panel-raised ${
        set ? "border-accent/40 text-accent" : "border-line text-fg"
      }`}
    >
      <LuRoute size={13} className={`mr-0.5 ${set ? "text-accent" : "text-fg-faint"}`} aria-hidden />
      {select("origin", origin, "Origin state")}
      <LuArrowRight size={12} className="text-fg-faint" aria-hidden />
      {select("destination", destination, "Destination state")}
    </span>
  );
}

// Filter chips and the search box of the carrier list header. Every change goes to the URL.
export function FilterBar({
  filters,
  onChange,
  onClear,
}: {
  filters: InboxFilters;
  onChange: (key: keyof InboxFilters, value: string) => void;
  onClear: () => void;
}) {
  // The box follows the typing; the URL (and the poll) follows the box once typing pauses.
  const [search, setSearch] = useState(filters.q);
  const lastSent = useRef(filters.q);

  // "Clear filters" or a pasted URL changes q from outside the box.
  useEffect(() => {
    if (filters.q !== lastSent.current) {
      lastSent.current = filters.q;
      setSearch(filters.q);
    }
  }, [filters.q]);

  useEffect(() => {
    const next = search.trim();
    if (next === lastSent.current) return;
    const timer = setTimeout(() => {
      lastSent.current = next;
      onChange("q", next);
    }, searchDebounceMs);
    return () => clearTimeout(timer);
  }, [search, onChange]);

  const narrowed = [filters.stage, filters.equipment, filters.origin, filters.destination, filters.since, filters.q].some((v) => v !== "");

  return (
    <>
      <div className="relative mb-2">
        <LuSearch size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-faint" aria-hidden />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          maxLength={64}
          placeholder="Search MC, DOT, carrier, load..."
          aria-label="Search carriers"
          className="h-9 w-full min-w-0 rounded-md border border-line bg-transparent py-1 pr-3 pl-9 text-sm text-fg shadow-xs outline-none transition-[color,box-shadow] placeholder:text-fg-faint focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent/30"
        />
      </div>

      {/* One row; when it outgrows the pane it scrolls sideways with the scrollbar hidden. */}
      <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <FilterSelect
          label="Stage"
          icon={LuCircleDot}
          value={filters.stage}
          onChange={(v) => onChange("stage", v)}
          options={[{ value: "", label: "Stage" }, ...carrierStages.map((s) => ({ value: s, label: carrierStageLabels[s] }))]}
        />
        <FilterSelect
          label="Equipment"
          icon={LuTruck}
          value={filters.equipment}
          onChange={(v) => onChange("equipment", v)}
          options={[{ value: "", label: "Equipment" }, ...equipmentCodes.map((c) => ({ value: c, label: equipmentLabel(c) }))]}
        />
        <LaneSelect origin={filters.origin} destination={filters.destination} onChange={onChange} />
        <FilterSelect label="Since" icon={LuCalendarDays} value={filters.since} onChange={(v) => onChange("since", v)} options={sinceOptions} />
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
          <FilterSelect
            label="Sort"
            icon={LuArrowDownUp}
            value={filters.sort}
            onChange={(v) => onChange("sort", v)}
            options={inboxSorts.map((s) => ({ value: s === "priority" ? "" : s, label: sortLabels[s] }))}
          />
        </span>
      </div>
    </>
  );
}
