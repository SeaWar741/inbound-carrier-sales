"use client";

import { useRef } from "react";
import { LuArrowUpRight, LuChevronLeft, LuInbox, LuChevronRight, LuHand, LuPackage, LuPhone, LuTriangleAlert } from "react-icons/lu";
import { Badge, CarrierStageDot, CarrierStagePill } from "@/components/inbox/stage-pill";
import { PulseDot } from "@/components/pulse-dot";
import type { inboxTabs, TowerCarrier, TowerCarriers } from "@/lib/contracts";
import { callSummary, carrierName, formatTimeAgo } from "@/lib/format";

export type InboxTab = (typeof inboxTabs)[number];

// Mirrors the adapter's inbox page size.
export const inboxPageSize = 25;

type Counts = TowerCarriers["counts"];
const tabs: { tab: InboxTab; label: string; title: string; count: (counts: Counts) => number; urgent?: boolean }[] = [
  // The four tabs split every carrier, so their sum is the whole list.
  { tab: "all", label: "", title: "All carriers", count: (c) => c.needsYou + c.live + c.active + c.closed },
  { tab: "needs_you", label: "Needs you", title: "Needs you", count: (c) => c.needsYou, urgent: true },
  { tab: "live", label: "Live", title: "Live", count: (c) => c.live },
  { tab: "active", label: "Active", title: "Active", count: (c) => c.active },
  { tab: "closed", label: "Closed", title: "Closed", count: (c) => c.closed },
];

// The cortex tab strip: an underlined tab with a count pill; "Needs you" keeps a red pill while it has carriers.
function TabStrip({ active, counts, onTab }: { active: InboxTab; counts: Counts | null; onTab: (tab: InboxTab) => void }) {
  return (
    <div role="tablist" aria-label="Carrier tabs" className="flex shrink-0 border-b border-line">
      {tabs.map(({ tab, label, count, urgent }) => {
        const selected = tab === active;
        const n = counts ? count(counts) : null;
        const pill = selected ? "bg-accent-soft text-accent" : urgent && n ? "bg-risk-soft text-risk" : "bg-panel-raised text-fg-muted";
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={label ? undefined : "All"}
            onClick={() => onTab(tab)}
            className={`-mb-px flex flex-1 cursor-pointer items-center justify-center gap-1 border-b-2 px-1.5 py-2 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
              selected ? "border-accent text-accent" : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {label || <LuInbox size={14} aria-hidden />}
            <span className={`tabular min-w-4 rounded-full px-1 py-0.5 text-center text-[10px] leading-none font-semibold ${pill}`}>
              {n ?? "-"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// The cortex lead row: dot and name, numbers, last message, badges, time and counts.
function CarrierRow({
  carrier,
  now,
  selected,
  onSelect,
  buttonRef,
}: {
  carrier: TowerCarrier;
  now: number;
  selected: boolean;
  onSelect: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
}) {
  const summary = callSummary(carrier.latestCall);
  const numbers = [carrier.mcNumber && `MC ${carrier.mcNumber}`, carrier.dotNumber && `DOT ${carrier.dotNumber}`].filter(Boolean).join(" · ");
  const settled = carrier.carrierStage === "lost" || carrier.carrierStage === "arrived";

  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`w-full cursor-pointer p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
          selected ? "bg-accent-soft" : settled ? "bg-panel-raised/60 hover:bg-panel-raised" : "hover:bg-panel-raised"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <CarrierStageDot stage={carrier.carrierStage} />
          <span className="min-w-0 truncate font-medium text-fg">{carrierName(carrier)}</span>
          <span className="min-w-0 flex-1" />
          {carrier.latestCall.live && <PulseDot tone="accent" label="Live call" />}
          <CarrierStagePill stage={carrier.carrierStage} />
        </div>

        {carrier.carrierName && numbers && <p className="tabular mt-0.5 truncate pl-[18px] text-sm text-fg-muted">{numbers}</p>}

        {summary && (
          <p className="mt-1 flex min-w-0 items-center gap-1 text-sm text-fg-faint">
            <LuArrowUpRight size={14} className="shrink-0 text-line-strong" aria-hidden />
            <span className="truncate">{summary}</span>
          </p>
        )}

        <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-[18px] text-xs text-fg-faint">
          <span className="shrink-0" title={carrier.lastActivityAt}>
            {formatTimeAgo(carrier.lastActivityAt, now)}
          </span>
          <span className="text-line-strong">·</span>
          <span className="flex shrink-0 items-center gap-0.5" title={`${carrier.callsCount} calls`}>
            <LuPhone size={12} aria-hidden />
            <span className="tabular">{carrier.callsCount}</span>
            <span className="sr-only">calls</span>
          </span>
          <span className="text-line-strong">·</span>
          <span className="flex shrink-0 items-center gap-0.5" title={`${carrier.loadsCount} loads offered`}>
            <LuPackage size={12} aria-hidden />
            <span className="tabular">{carrier.loadsCount}</span>
            <span className="sr-only">loads</span>
          </span>
          <span className="min-w-0 flex-1" />
          {carrier.needsHuman && (
            <Badge tone="bg-risk-soft text-risk">
              <LuHand size={11} aria-hidden />
              Needs human
            </Badge>
          )}
        </div>
      </button>
    </li>
  );
}

// The cortex list skeleton: two bars per row.
function SkeletonRows() {
  return (
    <div aria-hidden className="space-y-3 p-4">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 w-3/4 animate-pulse rounded-md bg-panel-raised" />
          <div className="h-3 w-1/2 animate-pulse rounded-md bg-panel-raised" />
        </div>
      ))}
    </div>
  );
}

const pageButton =
  "inline-flex size-8 cursor-pointer items-center justify-center rounded-md border border-line bg-panel text-fg shadow-xs transition-colors hover:bg-panel-raised disabled:pointer-events-none disabled:opacity-50";

export function CarrierList({
  data,
  loading,
  error,
  now,
  tab,
  page,
  filters,
  filtered,
  selectedKey,
  onTab,
  onPage,
  onSelect,
  onClearFilters,
}: {
  data: TowerCarriers | null;
  loading: boolean;
  error: string | null;
  now: number;
  tab: InboxTab;
  page: number;
  // The filter chips and search box, rendered in the header.
  filters: React.ReactNode;
  // Any filter other than the tab narrows the list.
  filtered: boolean;
  selectedKey: string | null;
  onTab: (tab: InboxTab) => void;
  onPage: (page: number) => void;
  onSelect: (key: string) => void;
  onClearFilters: () => void;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const first = (page - 1) * inboxPageSize + 1;
  const last = Math.min(page * inboxPageSize, total);
  const everything = data ? tabs[0]!.count(data.counts) : 0;
  const title = tabs.find((t) => t.tab === tab)?.title ?? "Carriers";

  function onKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = rows.findIndex((row) => row.key === selectedKey);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + step));
    const next = rows[nextIndex];
    if (next === undefined) return;
    onSelect(next.key);
    buttons.current.get(next.key)?.focus();
  }

  let body: React.ReactNode;
  if (data === null) {
    body = loading ? (
      <SkeletonRows />
    ) : (
      <div className="p-8 text-center text-fg-muted">
        <p>The carrier list is unavailable</p>
        <p className="mt-1 text-xs text-fg-faint">It retries every few seconds</p>
      </div>
    );
  } else if (rows.length > 0) {
    body = (
      <ul aria-label="Carriers" onKeyDown={onKeyDown} className="divide-y divide-line">
        {rows.map((carrier) => (
          <CarrierRow
            key={carrier.key}
            carrier={carrier}
            now={now}
            selected={carrier.key === selectedKey}
            onSelect={() => onSelect(carrier.key)}
            buttonRef={(node) => {
              if (node) buttons.current.set(carrier.key, node);
              else buttons.current.delete(carrier.key);
            }}
          />
        ))}
      </ul>
    );
  } else if (filtered) {
    body = (
      <div className="p-8 text-center text-fg-muted">
        <p>No carriers match these filters</p>
        <button
          type="button"
          onClick={onClearFilters}
          className="mt-3 inline-flex h-8 cursor-pointer items-center rounded-md border border-line bg-panel px-3 text-sm font-medium text-fg shadow-xs hover:bg-panel-raised"
        >
          Clear filters
        </button>
      </div>
    );
  } else if (everything === 0) {
    body = (
      <div className="p-8 text-center text-fg-muted">
        <p>No carriers yet</p>
        <p className="mt-1 text-xs text-fg-faint">Carriers show up here after their first call</p>
      </div>
    );
  } else {
    body = (
      <div className="p-8 text-center text-fg-muted">
        <p>No carriers in {title}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-r border-line bg-panel">
      <div className="shrink-0 border-b border-line px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="truncate font-semibold text-fg">{title}</h2>
          <span className="tabular shrink-0 text-sm text-fg-muted">{data ? `${total} carriers` : ""}</span>
        </div>
        {filters}
        {data?.liveUnavailable && (
          <p className="mt-2 flex items-center gap-1 text-xs text-warn">
            <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
            <span className="truncate">Live status unavailable</span>
          </p>
        )}
        {error && data && (
          <p role="status" className="mt-2 flex items-center gap-1 text-xs text-risk">
            <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
            <span className="truncate">{error}</span>
          </p>
        )}
      </div>

      <TabStrip active={tab} counts={data?.counts ?? null} onTab={onTab} />

      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>

      {total > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t border-line px-4 py-2 text-sm text-fg-muted">
          <span className="tabular">
            {first}-{last} of {total}
          </span>
          <span className="flex items-center gap-1.5">
            <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)} className={pageButton}>
              <LuChevronLeft size={16} aria-hidden />
            </button>
            <button type="button" aria-label="Next page" disabled={last >= total} onClick={() => onPage(page + 1)} className={pageButton}>
              <LuChevronRight size={16} aria-hidden />
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
