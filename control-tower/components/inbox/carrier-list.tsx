"use client";

import { useRef } from "react";
import { LuArrowUpRight, LuChevronLeft, LuChevronRight, LuHand, LuPackage, LuPhone, LuPhoneCall, LuTriangleAlert, LuTruck } from "react-icons/lu";
import { CarrierStageDot, CarrierStagePill } from "@/components/inbox/stage-pill";
import { PulseDot } from "@/components/pulse-dot";
import type { TowerCarrier, TowerCarriers } from "@/lib/contracts";
import { callSummary, carrierName, formatTimeAgo } from "@/lib/format";

// What the right edge of a row flags: a human is needed, a call is live, or freight is moving.
function StatusIcon({ carrier }: { carrier: TowerCarrier }) {
  if (carrier.needsHuman || carrier.carrierStage === "needs_approval") {
    return (
      <span role="img" aria-label="Needs you" title="Needs you" className="flex shrink-0 text-risk">
        <LuHand size={18} aria-hidden />
      </span>
    );
  }
  if (carrier.latestCall.live) {
    return (
      <span role="img" aria-label="Live call" title="Live call" className="flex shrink-0 items-center gap-1.5 text-ok">
        <PulseDot tone="ok" />
        <LuPhoneCall size={18} aria-hidden />
      </span>
    );
  }
  if (carrier.carrierStage === "in_transit") {
    return (
      <span role="img" aria-label="In transit" title="In transit" className="flex shrink-0 text-accent">
        <LuTruck size={18} aria-hidden />
      </span>
    );
  }
  return null;
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
          <CarrierStageDot stage={carrier.carrierStage} />
          <span className="min-w-0 truncate font-medium text-fg">{carrierName(carrier)}</span>
          <span className="min-w-0 flex-1" />
          <StatusIcon carrier={carrier} />
        </div>

        {carrier.carrierName && numbers && <p className="tabular mt-0.5 truncate pl-[18px] text-sm text-fg-muted">{numbers}</p>}

        {summary && (
          <p className="mt-1 flex min-w-0 items-center gap-1 text-sm text-fg-faint">
            <LuArrowUpRight size={14} className="shrink-0 text-line-strong" aria-hidden />
            <span className="truncate">{summary}</span>
          </p>
        )}

        <div className="mt-1.5 flex min-w-0 items-center gap-2 pl-[18px]">
          <CarrierStagePill stage={carrier.carrierStage} />
          {carrier.needsHuman && <span className="truncate text-[11px] font-medium text-risk">Asked for a human</span>}
        </div>

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

const pageButton =
  "inline-flex size-8 cursor-pointer items-center justify-center rounded-md border border-line bg-panel text-fg shadow-xs transition-colors hover:bg-panel-raised disabled:pointer-events-none disabled:opacity-50";

export function CarrierList({
  data,
  loading,
  error,
  now,
  title,
  page,
  filters,
  filtered,
  selectedKey,
  onPage,
  onSelect,
  onClearFilters,
}: {
  data: TowerCarriers | null;
  loading: boolean;
  error: string | null;
  now: number;
  // The selected rail row's label.
  title: string;
  page: number;
  // The filter chips and search box, rendered in the header.
  filters: React.ReactNode;
  // Any filter other than the rail row narrows the list.
  filtered: boolean;
  selectedKey: string | null;
  onPage: (page: number) => void;
  onSelect: (key: string) => void;
  onClearFilters: () => void;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 0;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const everything = data ? data.counts.needsYou + data.counts.live + data.counts.active + data.counts.closed : 0;

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
