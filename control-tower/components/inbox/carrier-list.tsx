"use client";

import { useEffect, useRef } from "react";
import { LuArrowUpRight, LuClockAlert, LuHand, LuLoaderCircle, LuPackage, LuPhone, LuTriangleAlert, LuUsers } from "react-icons/lu";
import { Badge, CarrierStageIcon } from "@/components/inbox/stage-pill";
import type { TowerCarrier, TowerCarriers } from "@/lib/contracts";
import { callSummary, carrierName, feasibilityBadge, formatTimeAgo } from "@/lib/format";

// The list's loaded pages merged into one answer, with the query and page count they were read for.
export type CarrierPages = TowerCarriers & { query: string; pages: number };

// The right edge of row 1: the stage icon in its tone. A carrier that asked for a human shows the
// red hand whatever its stage.
function StatusIcon({ carrier }: { carrier: TowerCarrier }) {
  if (carrier.needsHuman && carrier.carrierStage !== "needs_approval") {
    return (
      <span role="img" aria-label="Asked for a human" title="Asked for a human" className="flex shrink-0 text-tone-red">
        <LuHand size={18} aria-hidden />
      </span>
    );
  }
  return <CarrierStageIcon stage={carrier.carrierStage} />;
}

// Next to the status icon: the carrier's standing hold is a trip it cannot drive solo in time.
function FeasibilityBadge({ carrier }: { carrier: TowerCarrier }) {
  const hold = carrier.latestCall.hold;
  if (!hold?.trip || hold.status === "released") return null;
  const badge = feasibilityBadge(hold.trip.feasibility);
  if (badge === null) return null;
  const Icon = hold.trip.feasibility === "team" ? LuUsers : LuClockAlert;
  return (
    <Badge tone={badge.tone}>
      <Icon size={11} aria-hidden />
      {badge.text}
    </Badge>
  );
}

// The cortex lead row: dot, name and status icon; numbers; last event; stage badge; time and counts.
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
          <span className="min-w-0 truncate font-medium text-fg">{carrierName(carrier)}</span>
          <span className="min-w-0 flex-1" />
          <FeasibilityBadge carrier={carrier} />
          <StatusIcon carrier={carrier} />
        </div>

        {carrier.carrierName && numbers && <p className="tabular mt-0.5 truncate text-sm text-fg-muted">{numbers}</p>}

        {summary && (
          <p className="mt-1 flex min-w-0 items-center gap-1 text-sm text-fg-faint">
            <LuArrowUpRight size={14} className="shrink-0 text-line-strong" aria-hidden />
            <span className="truncate">{summary}</span>
          </p>
        )}

        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-fg-faint">
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
        </div>
      </button>
    </li>
  );
}

// The cortex list skeleton: two bars per row.
function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-hidden className="space-y-3 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 w-3/4 animate-pulse rounded-md bg-panel-raised" />
          <div className="h-3 w-1/2 animate-pulse rounded-md bg-panel-raised" />
        </div>
      ))}
    </div>
  );
}

export function CarrierList({
  data,
  loading,
  error,
  now,
  title,
  filters,
  filtered,
  selectedKey,
  loadingMore,
  hasMore,
  onLoadMore,
  onSelect,
  onClearFilters,
}: {
  data: TowerCarriers | null;
  loading: boolean;
  error: string | null;
  now: number;
  // The selected rail row's label.
  title: string;
  // The filter chips and search box, rendered in the header.
  filters: React.ReactNode;
  // Any filter other than the rail row narrows the list.
  filtered: boolean;
  selectedKey: string | null;
  // The next page is on its way.
  loadingMore: boolean;
  // Rows past the loaded pages remain.
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
  const everything = data ? data.counts.needsYou + data.counts.live + data.counts.active + data.counts.closed : 0;

  // The sentinel under the last row asks for the next page as it nears the bottom of the pane. A new
  // observer per page length reports at once, so a page too short to scroll still loads the next one.
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
          <span className="tabular shrink-0 text-sm text-fg-muted">{data ? `${total} ${total === 1 ? "carrier" : "carriers"}` : ""}</span>
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
