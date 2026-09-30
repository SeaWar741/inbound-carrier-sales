"use client";

import { useEffect, useRef } from "react";
import { LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import { NetworkChips, TrendArrow } from "@/components/network/network-chips";
import type { NetworkCarrier, TowerNetwork } from "@/lib/contracts";
import { carrierName, formatTimeAgo } from "@/lib/format";
import { networkReason, type NetworkWindow } from "@/lib/network";

// The list's loaded pages merged into one answer, with the query and page count they were read for.
export type NetworkPages = TowerNetwork & { query: string; pages: number };

// Name and reason take the room left; every count column is the same narrow width.
const columns = "grid grid-cols-[minmax(0,1fr)_repeat(4,5rem)_4rem_2.5rem] items-center gap-3";

function Count({ value, label }: { value: number; label: string }) {
  return (
    <span className="tabular text-right text-sm text-fg" title={`${value} ${label}`}>
      {value}
    </span>
  );
}

function NetworkRow({
  carrier,
  now,
  dateWindow,
  selected,
  onSelect,
  buttonRef,
}: {
  carrier: NetworkCarrier;
  now: number;
  dateWindow: NetworkWindow;
  selected: boolean;
  onSelect: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
}) {
  const { facts } = carrier;
  const numbers = [carrier.mcNumber && `MC ${carrier.mcNumber}`, carrier.dotNumber && `DOT ${carrier.dotNumber}`].filter(Boolean).join(" · ");
  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`${columns} w-full cursor-pointer px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
          selected ? "bg-accent-soft" : "hover:bg-panel-raised"
        }`}
      >
        <span className="min-w-0">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate font-medium text-fg">{carrierName(carrier)}</span>
            {carrier.carrierName && numbers && <span className="tabular shrink-0 text-xs text-fg-muted">{numbers}</span>}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-2">
            <NetworkChips carrier={carrier} />
            <span className="min-w-0 truncate text-sm text-fg-muted">{networkReason(carrier, now, dateWindow)}</span>
          </span>
        </span>
        <Count value={facts.calls} label="calls" />
        <Count value={facts.searches} label="searches" />
        <Count value={facts.loadsNegotiated} label="loads negotiated" />
        <Count value={facts.bookings} label="bookings" />
        <span className="tabular text-right text-sm text-fg-muted" title={facts.lastCallAt}>
          {formatTimeAgo(facts.lastCallAt, now)}
        </span>
        <span className="flex justify-end">
          <TrendArrow carrier={carrier} />
        </span>
      </button>
    </li>
  );
}

// The cortex list skeleton: two bars per row.
function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden className="space-y-3 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 w-1/2 animate-pulse rounded-md bg-panel-raised" />
          <div className="h-3 w-3/4 animate-pulse rounded-md bg-panel-raised" />
        </div>
      ))}
    </div>
  );
}

// The carriers of the chosen view, newest call first, with the next page loading as the list nears its end.
export function NetworkList({
  data,
  loading,
  error,
  now,
  dateWindow,
  header,
  filtered,
  selectedKey,
  loadingMore,
  hasMore,
  onLoadMore,
  onSelect,
  onClearFilters,
}: {
  data: TowerNetwork | null;
  loading: boolean;
  error: string | null;
  now: number;
  dateWindow: NetworkWindow;
  // The view chips and the filter bar.
  header: React.ReactNode;
  // Any filter other than the view narrows the list.
  filtered: boolean;
  selectedKey: string | null;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onSelect: (key: string) => void;
  onClearFilters: () => void;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  // Same paging as the inbox list: a new observer per page length reports at once, so a page too
  // short to scroll still loads the next one.
  useEffect(() => {
    const target = sentinel.current;
    if (!hasMore || target === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
    }, { root: scroller.current, rootMargin: "0px 0px 200px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, rows.length, onLoadMore]);

  function onKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = rows.findIndex((row) => row.key === selectedKey);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = rows[index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + step))];
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
        <p>The carrier network is unavailable</p>
        <p className="mt-1 text-xs text-fg-faint">It retries every few seconds</p>
      </div>
    );
  } else if (rows.length > 0) {
    body = (
      <ul aria-label="Carriers" onKeyDown={onKeyDown} className="divide-y divide-line">
        {rows.map((carrier) => (
          <NetworkRow
            key={carrier.key}
            carrier={carrier}
            now={now}
            dateWindow={dateWindow}
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
  } else {
    body = (
      <div className="p-8 text-center text-fg-muted">
        <p>No carriers here</p>
        <p className="mt-1 text-xs text-fg-faint">Carriers show up here after their first call</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-r border-line bg-panel">
      <div className="shrink-0 border-b border-line">
        {header}
        {error && data && (
          <p role="status" className="flex items-center gap-1 px-4 pb-2 text-xs text-risk">
            <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
            <span className="truncate">{error}</span>
          </p>
        )}
        <div className={`${columns} border-t border-line px-4 py-1.5 text-[11px] font-semibold tracking-wide text-fg-faint uppercase`}>
          <span>{data ? `${total} ${total === 1 ? "carrier" : "carriers"}` : "Carrier"}</span>
          <span className="text-right">Calls</span>
          <span className="text-right">Searches</span>
          <span className="text-right" title="Loads negotiated">Negotiated</span>
          <span className="text-right">Booked</span>
          <span className="text-right">Last call</span>
          <span className="text-right">Trend</span>
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {body}
        {hasMore && rows.length > 0 && (
          <div ref={sentinel} role="status" className="flex items-center justify-center gap-2 border-t border-line px-4 py-3 text-xs text-fg-faint">
            {loadingMore && <LuLoaderCircle size={14} className="animate-spin" aria-hidden />}
            {loadingMore ? "Loading more carriers..." : `${rows.length} of ${total}`}
          </div>
        )}
      </div>
    </div>
  );
}
