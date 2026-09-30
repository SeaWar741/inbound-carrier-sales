"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IconType } from "react-icons";
import { LuArrowRight, LuArrowUpDown, LuChevronDown, LuContainer, LuRoute, LuSearch } from "react-icons/lu";
import { equipmentLabel } from "@/components/hold-card";
import { inboxSorts } from "@/lib/contracts";

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
export const sinceOptions = [
  { value: "today", label: "Today" },
  { value: "", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];
const sortLabels: Record<(typeof inboxSorts)[number], string> = {
  priority: "Priority",
  recent: "Recent",
  rate: "Rate",
  pickup: "Pickup",
};
const searchDebounceMs = 300;

// The box follows the typing; onSearch follows the box once typing pauses. A q changed from
// outside the box ("Clear filters", a pasted URL) resets it.
export function SearchInput({
  q,
  onSearch,
  placeholder,
  label,
  className = "",
}: {
  q: string;
  onSearch: (q: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}) {
  const [search, setSearch] = useState(q);
  const lastSent = useRef(q);

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
    <div className={`relative ${className}`}>
      <LuSearch size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-faint" aria-hidden />
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        maxLength={64}
        placeholder={placeholder}
        aria-label={label}
        className="h-9 w-full min-w-0 rounded-md border border-line bg-transparent py-1 pr-3 pl-9 text-sm text-fg shadow-xs outline-none transition-[color,box-shadow] placeholder:text-fg-faint focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent/30"
      />
    </div>
  );
}

export type Tab<T extends string> = {
  value: T;
  label: React.ReactNode;
  // Names a tab whose label is only an icon.
  ariaLabel?: string;
  // Null shows "-" while loading; a tab without a count leaves the pill out.
  count?: number | null;
  // Keeps a red pill while its count is not zero.
  urgent?: boolean;
};

// The cortex tab strip: an underlined tab with an optional count pill.
export function TabStrip<T extends string>({
  label,
  tabs,
  active,
  onTab,
}: {
  label: string;
  tabs: Tab<T>[];
  active: T;
  onTab: (value: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex shrink-0 border-b border-line">
      {tabs.map((tab) => {
        const selected = tab.value === active;
        const pill = selected ? "bg-accent-soft text-accent" : tab.urgent && tab.count ? "bg-risk-soft text-risk" : "bg-panel-raised text-fg-muted";
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={tab.ariaLabel}
            onClick={() => onTab(tab.value)}
            className={`-mb-px flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1 border-b-2 px-1.5 py-2 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
              selected ? "border-accent text-accent" : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={`tabular min-w-4 rounded-full px-1 py-0.5 text-center text-[10px] leading-none font-semibold ${pill}`}>
                {tab.count ?? "-"}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

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

const chipSelect =
  "field-sizing-content h-full min-w-0 cursor-pointer appearance-none bg-transparent text-xs font-medium outline-none";

// The cortex h-8 filter chip: a colored leading icon, the value, and a chevron, on a native select.
// It shrinks and clips instead of wrapping, so the chips stay on one row.
function ChipSelect({
  label,
  icon: Icon,
  tone,
  value,
  onChange,
  options,
}: {
  label: string;
  icon: IconType;
  tone: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const set = value !== "";
  return (
    <label
      title={label}
      className={`relative flex h-8 min-w-0 shrink items-center rounded-lg border bg-panel transition-colors focus-within:ring-2 focus-within:ring-accent/40 hover:bg-panel-raised ${
        set ? "border-accent/40 text-accent" : "border-line text-fg"
      }`}
    >
      <Icon size={14} className={`pointer-events-none absolute left-2 ${tone}`} aria-hidden />
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className={`${chipSelect} pr-5 pl-7`}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <LuChevronDown size={12} className="pointer-events-none absolute right-1.5 opacity-50" aria-hidden />
    </label>
  );
}

// Origin and destination states in one chip: route icon, origin, arrow, destination.
function LaneChip({ origin, destination, onChange }: { origin: string; destination: string; onChange: (key: "origin" | "destination", value: string) => void }) {
  const set = origin !== "" || destination !== "";
  const side = (key: "origin" | "destination", value: string, any: string) => (
    <select
      aria-label={key === "origin" ? "Origin state" : "Destination state"}
      value={value}
      onChange={(event) => onChange(key, event.target.value)}
      className={`${chipSelect} px-0.5 ${value ? "text-accent" : "text-fg"}`}
    >
      <option value="">{any}</option>
      {states.map((state) => (
        <option key={state} value={state}>
          {state}
        </option>
      ))}
    </select>
  );
  return (
    <div
      role="group"
      aria-label="Lane"
      title="Lane"
      className={`flex h-8 min-w-0 shrink items-center gap-0.5 rounded-lg border bg-panel pr-1.5 pl-2 transition-colors focus-within:ring-2 focus-within:ring-accent/40 hover:bg-panel-raised ${
        set ? "border-accent/40" : "border-line"
      }`}
    >
      <LuRoute size={14} className="shrink-0 text-ok" aria-hidden />
      {side("origin", origin, "From")}
      <LuArrowRight size={11} className="shrink-0 text-fg-faint" aria-hidden />
      {side("destination", destination, "To")}
    </div>
  );
}

const equipmentOptions = [{ value: "", label: "Equipment" }, ...equipmentCodes.map((c) => ({ value: c, label: equipmentLabel(c) }))];
const sortOptions = inboxSorts.map((s) => ({ value: s === "priority" ? "" : s, label: sortLabels[s] }));

// The list header's filters, all on screen: one row of chips (equipment, lane, sort) over the
// search box. Stage and date live in the stage rail. Every change goes to the URL.
export function FilterBar({
  filters,
  onChange,
}: {
  filters: InboxFilters;
  onChange: (key: keyof InboxFilters, value: string) => void;
}) {
  const onSearch = useCallback((q: string) => onChange("q", q), [onChange]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <ChipSelect
          label="Equipment"
          icon={LuContainer}
          tone="text-accent"
          value={filters.equipment}
          onChange={(v) => onChange("equipment", v)}
          options={equipmentOptions}
        />
        <LaneChip origin={filters.origin} destination={filters.destination} onChange={onChange} />
        <span className="min-w-0 flex-1" />
        <ChipSelect label="Sort" icon={LuArrowUpDown} tone="text-warn" value={filters.sort} onChange={(v) => onChange("sort", v)} options={sortOptions} />
      </div>
      <SearchInput q={filters.q} onSearch={onSearch} placeholder="Search MC, DOT, carrier, load..." label="Search carriers" />
    </div>
  );
}
