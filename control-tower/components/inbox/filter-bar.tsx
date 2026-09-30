"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { IconType } from "react-icons";
import { LuArrowDownUp, LuArrowRight, LuChevronDown, LuListFilter, LuSearch, LuX } from "react-icons/lu";
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

const panelSelect =
  "h-8 w-full min-w-0 cursor-pointer appearance-none rounded-md border border-line bg-panel pr-7 pl-2.5 text-sm text-fg outline-none transition-colors hover:bg-panel-raised focus-visible:border-accent focus-visible:ring-[3px] focus-visible:ring-accent/30";

// A labelled full-width native select for the filters panel.
function PanelSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="relative flex min-w-0 flex-1 items-center">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className={panelSelect}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <LuChevronDown size={14} className="pointer-events-none absolute right-2 text-fg-faint" aria-hidden />
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

// An active filter after the Filters button; the x drops just that filter.
function FilterPill({ label, onRemove, children }: { label: string; onRemove: () => void; children: React.ReactNode }) {
  return (
    <span className="inline-flex h-6 min-w-0 shrink items-center gap-0.5 rounded-full bg-accent-soft pr-0.5 pl-2 text-[11px] font-medium text-accent">
      <span className="inline-flex min-w-0 items-center gap-0.5 truncate">{children}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} filter`}
        title={`Remove ${label} filter`}
        className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors hover:bg-accent/15 focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <LuX size={11} aria-hidden />
      </button>
    </span>
  );
}

const stageOptions = [{ value: "", label: "Any stage" }, ...carrierStages.map((s) => ({ value: s, label: carrierStageLabels[s] }))];
const equipmentOptions = [{ value: "", label: "Any equipment" }, ...equipmentCodes.map((c) => ({ value: c, label: equipmentLabel(c) }))];
const stateOptions = (any: string) => [{ value: "", label: any }, ...states.map((state) => ({ value: state, label: state }))];
const sinceLabel = (since: string) => sinceOptions.find((option) => option.value === since)?.label ?? since;

// The search box over one row: a Filters button with its panel, the active filters as pills, and
// the sort. Every change goes to the URL.
export function FilterBar({
  filters,
  onChange,
}: {
  filters: InboxFilters;
  onChange: (key: keyof InboxFilters, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const onSearch = useCallback((q: string) => onChange("q", q), [onChange]);

  const lane = filters.origin !== "" || filters.destination !== "";
  const active = [filters.stage !== "", filters.equipment !== "", lane, filters.since !== ""].filter(Boolean).length;
  const clearLane = () => {
    if (filters.origin) onChange("origin", "");
    if (filters.destination) onChange("destination", "");
  };
  // Clears what the panel sets; the search box keeps its text.
  const clearPanel = () => {
    if (filters.stage) onChange("stage", "");
    if (filters.equipment) onChange("equipment", "");
    clearLane();
    if (filters.since) onChange("since", "");
  };

  // A click outside the bar or Esc closes the panel; Esc hands focus back to the button.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <SearchInput q={filters.q} onSearch={onSearch} placeholder="Search MC, DOT, carrier, load..." label="Search carriers" className="mb-2" />

      {/* One row at any pane width: the pills shrink and truncate instead of wrapping. */}
      <div ref={root} className="relative flex min-w-0 items-center gap-1.5">
        <button
          ref={trigger}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="inbox-filters"
          className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border bg-panel px-2 text-xs font-medium outline-none transition-colors hover:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40 ${
            active > 0 ? "border-accent/40 text-accent" : "border-line text-fg"
          }`}
        >
          <LuListFilter size={13} className={active > 0 ? "text-accent" : "text-fg-faint"} aria-hidden />
          Filters
          {active > 0 && (
            <span className="tabular min-w-4 rounded-full bg-accent px-1 py-0.5 text-center text-[10px] leading-none font-semibold text-white">{active}</span>
          )}
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {filters.stage && (
            <FilterPill label="stage" onRemove={() => onChange("stage", "")}>
              {carrierStageLabels[filters.stage as keyof typeof carrierStageLabels] ?? filters.stage}
            </FilterPill>
          )}
          {filters.equipment && (
            <FilterPill label="equipment" onRemove={() => onChange("equipment", "")}>
              {equipmentLabel(filters.equipment)}
            </FilterPill>
          )}
          {lane && (
            <FilterPill label="lane" onRemove={clearLane}>
              {filters.origin || "Any"}
              <LuArrowRight size={10} className="shrink-0" aria-label="to" />
              {filters.destination || "Any"}
            </FilterPill>
          )}
          {filters.since && (
            <FilterPill label="date" onRemove={() => onChange("since", "")}>
              {sinceLabel(filters.since)}
            </FilterPill>
          )}
        </div>

        <span className="shrink-0">
          <FilterSelect
            label="Sort"
            icon={LuArrowDownUp}
            value={filters.sort}
            onChange={(v) => onChange("sort", v)}
            options={inboxSorts.map((s) => ({ value: s === "priority" ? "" : s, label: sortLabels[s] }))}
          />
        </span>

        {open && (
          <div
            id="inbox-filters"
            role="dialog"
            aria-label="Filters"
            className="absolute top-full left-0 z-20 mt-1.5 flex w-72 flex-col gap-3 rounded-[var(--radius-panel)] border border-line bg-panel p-3 shadow-lg"
          >
            <Field label="Stage">
              <PanelSelect label="Stage" value={filters.stage} onChange={(v) => onChange("stage", v)} options={stageOptions} />
            </Field>
            <Field label="Equipment">
              <PanelSelect label="Equipment" value={filters.equipment} onChange={(v) => onChange("equipment", v)} options={equipmentOptions} />
            </Field>
            <Field label="Lane">
              <PanelSelect label="Origin state" value={filters.origin} onChange={(v) => onChange("origin", v)} options={stateOptions("Any")} />
              <LuArrowRight size={14} className="shrink-0 text-fg-faint" aria-hidden />
              <PanelSelect
                label="Destination state"
                value={filters.destination}
                onChange={(v) => onChange("destination", v)}
                options={stateOptions("Any")}
              />
            </Field>
            <Field label="Date">
              <PanelSelect label="Since" value={filters.since} onChange={(v) => onChange("since", v)} options={sinceOptions} />
            </Field>
            <div className="flex items-center justify-between border-t border-line pt-3">
              <button
                type="button"
                onClick={clearPanel}
                disabled={active === 0}
                className="cursor-pointer rounded-md px-1 text-xs font-medium text-fg-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-7 cursor-pointer items-center rounded-md border border-line bg-panel px-3 text-xs font-medium text-fg shadow-xs outline-none transition-colors hover:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
