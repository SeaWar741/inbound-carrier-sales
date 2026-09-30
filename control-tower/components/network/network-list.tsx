"use client";

import { useRef } from "react";
import { LuCircleCheck, LuLoaderCircle, LuPhone, LuTriangleAlert } from "react-icons/lu";
import { growthStyle, relationshipStyle, StyleIcon, topStyle } from "@/components/network/network-chips";
import { SkeletonRows, useLoadMore } from "@/components/paged-list";
import type { NetworkCarrier, TowerNetwork } from "@/lib/contracts";
import { carrierName, formatTimeAgo } from "@/lib/format";
import { shortReason } from "@/lib/network";

// Two lines, like the inbox row: status, name, MC and tag icons over the one-line reason, with the
// last call and lifetime bookings on the right.
function NetworkRow({
  carrier,
  now,
  selected,
  onSelect,
  buttonRef,
}: {
  carrier: NetworkCarrier;
  now: number;
  selected: boolean;
  onSelect: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
}) {
  const { facts } = carrier;
  // The name falls back to the MC, which then is not repeated beside it.
  const mc = carrier.carrierName && carrier.mcNumber ? `MC ${carrier.mcNumber}` : null;
  const reason = shortReason(carrier, now);
  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`w-full cursor-pointer px-4 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
          selected ? "bg-accent-soft" : "hover:bg-panel-raised"
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <StyleIcon style={relationshipStyle[carrier.relationship]} size={16} />
          <span className="min-w-0 truncate text-sm font-semibold text-fg">{carrierName(carrier)}</span>
          {mc && <span className="shrink-0 font-mono text-xs text-fg-muted">{mc}</span>}
          {carrier.top && <StyleIcon style={topStyle} />}
          {carrier.growth && <StyleIcon style={growthStyle} />}
          <span className="min-w-0 flex-1" />
          <span className="flex shrink-0 items-center gap-1 text-xs text-fg-muted" title={`Last call ${facts.lastCallAt}`}>
            <LuPhone size={12} className="text-fg-faint" aria-hidden />
            <span className="tabular-nums">{formatTimeAgo(facts.lastCallAt, now)}</span>
          </span>
          <span className="flex w-20 shrink-0 items-center justify-end gap-1 text-xs text-fg-muted" title={`${facts.lifetimeBookings} bookings all time`}>
            <LuCircleCheck size={12} className="text-tone-green" aria-hidden />
            <span className="tabular-nums">{facts.lifetimeBookings} booked</span>
          </span>
        </span>
        <span className="mt-0.5 block truncate pl-6 text-xs text-fg-muted" title={reason}>
          {reason}
        </span>
      </button>
    </li>
  );
}

// The carriers of the chosen view, newest call first, with the next page loading as the list nears its end.
export function NetworkList({
  data,
  loading,
  error,
  now,
  title,
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
  // The selected view's label.
  title: string;
  // The search and filters.
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
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const { scroller, sentinel } = useLoadMore(hasMore, rows.length, onLoadMore);

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
  } else if (data.counts.all === 0) {
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
        {header}
        <p className="tabular mt-2 truncate text-xs text-fg-muted">
          {data ? `${total} ${total === 1 ? "carrier" : "carriers"}` : "-"} · {title}
        </p>
        {error && data && (
          <p role="status" className="mt-1 flex items-center gap-1 text-xs text-risk">
            <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
            <span className="truncate">{error}</span>
          </p>
        )}
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
