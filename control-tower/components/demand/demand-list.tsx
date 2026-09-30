"use client";

import type { IconType } from "react-icons";
import { LuArrowDownRight, LuArrowRight, LuArrowUpRight, LuChevronDown, LuChevronRight, LuContainer, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import { DemandCarriers } from "@/components/demand/demand-carriers";
import { equipmentLabel } from "@/components/hold-card";
import { Count, SkeletonRows, useLoadMore } from "@/components/paged-list";
import type { DemandLane, TowerDemand } from "@/lib/contracts";
import { demandKey, demandSignal, demandTrend, laneLabel, type DemandTrend } from "@/lib/demand";

// Lane and sentence take the room left; every count column is the same narrow width.
const columns = "grid grid-cols-[minmax(0,1fr)_repeat(4,5.5rem)_12rem] items-center gap-3";

// More unmet asks this week is a gap growing, so it reads amber; fewer reads green.
const trendStyle: Record<DemandTrend, { icon: IconType; tone: string; word: string }> = {
  up: { icon: LuArrowUpRight, tone: "text-warn", word: "More this week" },
  down: { icon: LuArrowDownRight, tone: "text-ok", word: "Fewer this week" },
  flat: { icon: LuArrowRight, tone: "text-fg-faint", word: "Same as last week" },
};

function Trend({ lane }: { lane: DemandLane }) {
  const { trend, text } = demandTrend(lane);
  const { icon: Icon, tone, word } = trendStyle[trend];
  return (
    <span title={`${word}: ${text} (searches with no match and offers with no booking)`} className="flex items-center justify-end gap-1.5">
      <Icon size={16} className={`shrink-0 ${tone}`} aria-label={word} />
      <span className="tabular truncate text-xs text-fg-muted">{text}</span>
    </span>
  );
}

function DemandRow({ lane, expanded, onToggle }: { lane: DemandLane; expanded: boolean; onToggle: () => void }) {
  const Chevron = expanded ? LuChevronDown : LuChevronRight;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={`${columns} w-full cursor-pointer px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
          expanded ? "bg-accent-soft" : "hover:bg-panel-raised"
        }`}
      >
        <span className="flex min-w-0 items-start gap-2">
          <Chevron size={14} className="mt-1 shrink-0 text-fg-faint" aria-hidden />
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-medium text-fg">{laneLabel(lane)}</span>
              <span className="flex min-w-0 items-center gap-1 text-sm text-fg-muted">
                <LuContainer size={13} className="shrink-0 text-accent" aria-hidden />
                <span className="truncate">{lane.equipment ? equipmentLabel(lane.equipment) : "Any"}</span>
              </span>
            </span>
            <span className="mt-1 block truncate text-sm text-fg-muted">{demandSignal(lane)}</span>
          </span>
        </span>
        <Count value={lane.searches} label="searches" />
        <Count value={lane.noMatch} label="searches with no match" />
        <Count value={lane.offeredNoBooking} label="offered, no booking" />
        <Count value={lane.carriers} label="carriers" />
        <Trend lane={lane} />
      </button>
      {expanded && <DemandCarriers lane={lane} />}
    </li>
  );
}

// The lanes carriers asked for and the board did not cover, most unmet first as the adapter sends
// them, with the next page loading as the list nears its end.
export function DemandList({
  data,
  loading,
  error,
  header,
  filtered,
  expandedKey,
  loadingMore,
  hasMore,
  onLoadMore,
  onToggle,
  onClearFilters,
}: {
  data: TowerDemand | null;
  loading: boolean;
  error: string | null;
  // The title and the filter bar.
  header: React.ReactNode;
  filtered: boolean;
  expandedKey: string | null;
  loadingMore: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onToggle: (key: string) => void;
  onClearFilters: () => void;
}) {
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const { scroller, sentinel } = useLoadMore(hasMore, rows.length, onLoadMore);

  let body: React.ReactNode;
  if (data === null) {
    body = loading ? (
      <SkeletonRows />
    ) : (
      <div className="p-8 text-center text-fg-muted">
        <p>The demand data is unavailable</p>
        <p className="mt-1 text-xs text-fg-faint">It retries every few seconds</p>
      </div>
    );
  } else if (rows.length > 0) {
    body = (
      <ul aria-label="Lanes" className="divide-y divide-line">
        {rows.map((lane) => {
          const key = demandKey(lane);
          return <DemandRow key={key} lane={lane} expanded={key === expandedKey} onToggle={() => onToggle(key)} />;
        })}
      </ul>
    );
  } else if (filtered) {
    body = (
      <div className="p-8 text-center text-fg-muted">
        <p>No lanes match these filters</p>
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
        <p>No unmet demand in the last 4 weeks</p>
        <p className="mt-1 text-xs text-fg-faint">Lanes show up here when a search finds no load or an offer ends without a booking</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-panel">
      <div className="shrink-0 border-b border-line">
        {header}
        {error && data && (
          <p role="status" className="flex items-center gap-1 px-4 pb-2 text-xs text-risk">
            <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
            <span className="truncate">{error}</span>
          </p>
        )}
        <div className={`${columns} border-t border-line px-4 py-1.5 text-[11px] font-semibold tracking-wide text-fg-faint uppercase`}>
          <span>{data ? `${total} ${total === 1 ? "lane" : "lanes"}` : "Lane"}</span>
          <span className="text-right">Searches</span>
          <span className="text-right" title="Searches that found no load">No match</span>
          <span className="text-right" title="Loads offered that ended without a booking">Offered, no booking</span>
          <span className="text-right">Carriers</span>
          <span className="text-right" title="Searches with no match plus offers with no booking, this week vs last">This week</span>
        </div>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {body}
        {hasMore && rows.length > 0 && (
          <div ref={sentinel} role="status" className="flex items-center justify-center gap-2 border-t border-line px-4 py-3 text-xs text-fg-faint">
            {loadingMore && <LuLoaderCircle size={14} className="animate-spin" aria-hidden />}
            {loadingMore ? "Loading more lanes..." : `${rows.length} of ${total}`}
          </div>
        )}
      </div>
    </div>
  );
}
