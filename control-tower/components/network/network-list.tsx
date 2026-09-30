"use client";

import Link from "next/link";
import { LuChevronRight, LuCircleCheck, LuLoaderCircle, LuPhone } from "react-icons/lu";
import { Chip, growthStyle, relationshipStyle, StyleIcon, topStyle } from "@/components/network/network-chips";
import { SkeletonRows } from "@/components/paged-list";
import type { NetworkCarrier, TowerNetwork } from "@/lib/contracts";
import { carrierName, formatTimeAgo } from "@/lib/format";
import { shortReason } from "@/lib/network";

// One line per carrier, the whole row a link to its page: status, name, MC, tags and the short
// reason, with the last call and lifetime bookings on the right.
function NetworkRow({ carrier, now }: { carrier: NetworkCarrier; now: number }) {
  const { facts } = carrier;
  // The name falls back to the MC, which then is not repeated beside it.
  const mc = carrier.carrierName && carrier.mcNumber ? `MC ${carrier.mcNumber}` : null;
  const reason = shortReason(carrier, now);
  return (
    <li>
      <Link
        href={`/carriers/${encodeURIComponent(carrier.key)}`}
        className="flex h-11 min-w-0 items-center gap-3 px-4 text-sm outline-none transition-colors hover:bg-panel-raised focus-visible:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
      >
        <StyleIcon style={relationshipStyle[carrier.relationship]} size={16} />
        <span className="w-52 shrink-0 truncate font-medium text-fg">{carrierName(carrier)}</span>
        <span className="w-24 shrink-0 truncate font-mono text-xs text-fg-muted">{mc}</span>
        {(carrier.top || carrier.growth) && (
          <span className="flex shrink-0 items-center gap-1">
            {carrier.top && <Chip style={topStyle} />}
            {carrier.growth && <Chip style={growthStyle} />}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-fg-muted" title={reason}>
          {reason}
        </span>
        <span className="flex w-14 shrink-0 items-center justify-end gap-1 text-xs text-fg-muted" title={`Last call ${facts.lastCallAt}`}>
          <LuPhone size={12} className="text-fg-faint" aria-hidden />
          <span className="tabular">{formatTimeAgo(facts.lastCallAt, now)}</span>
        </span>
        <span className="flex w-12 shrink-0 items-center justify-end gap-1 text-xs text-fg-muted" title={`${facts.lifetimeBookings} bookings all time`}>
          <LuCircleCheck size={12} className="text-fg-faint" aria-hidden />
          <span className="tabular">{facts.lifetimeBookings}</span>
        </span>
        <LuChevronRight size={16} className="shrink-0 text-fg-faint" aria-hidden />
      </Link>
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-fg-muted">{children}</div>;
}

// The carriers of the chosen view, newest call first; the sentinel loads the next page as the page
// scroll nears it.
export function NetworkList({
  data,
  loading,
  now,
  viewName,
  filtered,
  loadingMore,
  hasMore,
  sentinel,
  onClearFilters,
}: {
  data: TowerNetwork | null;
  loading: boolean;
  now: number;
  // The selected view's label, for the empty state.
  viewName: string;
  // Any filter other than the view narrows the list.
  filtered: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  sentinel: React.Ref<HTMLDivElement>;
  onClearFilters: () => void;
}) {
  const rows = data?.rows ?? [];

  if (data === null) {
    return loading ? <SkeletonRows /> : <Empty>The carrier network is unavailable. It retries every few seconds.</Empty>;
  }
  if (rows.length === 0) {
    if (filtered) {
      return (
        <Empty>
          No carriers match these filters.{" "}
          <button type="button" onClick={onClearFilters} className="cursor-pointer font-medium text-accent hover:underline">
            Clear filters
          </button>
        </Empty>
      );
    }
    if (data.counts.all === 0) return <Empty>No carriers yet. Carriers show up here after their first call.</Empty>;
    return <Empty>No carriers in {viewName}.</Empty>;
  }

  return (
    <>
      <ul aria-label="Carriers" className="divide-y divide-line">
        {rows.map((carrier) => (
          <NetworkRow key={carrier.key} carrier={carrier} now={now} />
        ))}
      </ul>
      {hasMore && (
        <div ref={sentinel} role="status" className="flex items-center justify-center gap-2 border-t border-line px-4 py-3 text-xs text-fg-faint">
          {loadingMore && <LuLoaderCircle size={14} className="animate-spin" aria-hidden />}
          {loadingMore ? "Loading more carriers..." : `${rows.length} of ${data.total}`}
        </div>
      )}
    </>
  );
}
