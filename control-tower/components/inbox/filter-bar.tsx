"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IconType } from "react-icons";
import { Select } from "antd";
import { LuArrowRight, LuArrowUpDown, LuChevronDown, LuContainer, LuFlag, LuRoute, LuSearch } from "react-icons/lu";
import { inboxSorts } from "@/lib/contracts";
import { equipmentLabel } from "@/lib/format";

// The filters the inbox keeps in the URL; an empty string is "no filter" (or the adapter default).
export type InboxFilters = {
  stage: string;
  equipment: string;
  origin: string;
  destination: string;
  since: string;
  // A picked day range (YYYY-MM-DD, desk days); it replaces `since` while set.
  from: string;
  to: string;
  q: string;
  sort: string;
};

const equipmentCodes = ["DRY_VAN", "REEFER", "FLATBED", "STEP_DECK", "POWER_ONLY"];
const states = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];
// The adapter's sorts; the URL omits its default (priority).
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

// An antd select in the list header: a colored leading icon, search by label, and a clear button.
// An empty value shows the placeholder.
export function HeaderSelect({
  label,
  placeholder = label,
  grow = 1,
  icon: Icon,
  tone,
  value,
  onChange,
  options,
}: {
  label: string;
  placeholder?: string;
  // Its share of the row's width.
  grow?: number;
  icon: IconType;
  tone: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <Select
      size="small"
      aria-label={label}
      title={label}
      placeholder={placeholder}
      value={value === "" ? undefined : value}
      onChange={(next?: string) => onChange(next ?? "")}
      options={options}
      showSearch={{ optionFilterProp: "label" }}
      allowClear
      popupMatchSelectWidth={false}
      prefix={<Icon size={14} className={tone} aria-hidden />}
      // Inline, because antd's own styles outrank Tailwind's utility layer.
      style={{ flex: `${grow} 1 0`, minWidth: 0 }}
    />
  );
}

export const equipmentOptions = equipmentCodes.map((c) => ({ value: c, label: equipmentLabel(c) }));
export const stateOptions = states.map((state) => ({ value: state, label: state }));
// Priority is the default, so picking it clears the sort back to the placeholder.
const sortOptions = inboxSorts.map((s) => ({ value: s, label: sortLabels[s] }));

// The list header's filters, all on screen: the lane and equipment on one row, then the search box
// and the sort. Stage and date live in the stage rail. Every change goes to the URL.
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
        <HeaderSelect label="From" icon={LuRoute} tone="text-ok" value={filters.origin} onChange={(v) => onChange("origin", v)} options={stateOptions} />
        <LuArrowRight size={12} className="shrink-0 text-fg-faint" aria-hidden />
        <HeaderSelect label="To" icon={LuFlag} tone="text-ok" value={filters.destination} onChange={(v) => onChange("destination", v)} options={stateOptions} />
        <HeaderSelect
          label="Equipment"
          grow={1.5}
          icon={LuContainer}
          tone="text-accent"
          value={filters.equipment}
          onChange={(v) => onChange("equipment", v)}
          options={equipmentOptions}
        />
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <SearchInput q={filters.q} onSearch={onSearch} placeholder="MC, carrier or load" label="Search carriers" className="min-w-0 flex-[2]" />
        <HeaderSelect
          label="Sort"
          placeholder="Priority"
          icon={LuArrowUpDown}
          tone="text-warn"
          value={filters.sort}
          onChange={(v) => onChange("sort", v === "priority" ? "" : v)}
          options={sortOptions}
        />
      </div>
    </div>
  );
}
