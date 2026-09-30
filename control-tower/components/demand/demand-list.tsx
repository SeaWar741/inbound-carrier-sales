"use client";

import Link from "next/link";
import { LuChevronRight } from "react-icons/lu";
import { SkeletonRows } from "@/components/paged-list";
import { EquipmentTag, trendStyle } from "@/components/demand/demand-parts";
import type { DemandLane, TowerDemand } from "@/lib/contracts";
import { demandKey, demandLaneHref, demandSignal, demandTrend, demandUnmet, laneLabel, unmetBarPercent } from "@/lib/demand";

function Trend({ lane }: { lane: DemandLane }) {
  const { trend, text } = demandTrend(lane);
  const { icon: Icon, tone, word } = trendStyle[trend];
  return (
    <span title="Unmet this week vs last week" className={`flex w-20 shrink-0 items-center justify-end gap-1 text-xs ${tone}`}>
      <Icon size={13} className="shrink-0" aria-label={word} />
      <span className="tabular">{text}</span>
    </span>
  );
}

// One line per lane, the whole row opening the lane's page. The lane, equipment and bar widths are
// fixed so every column starts in one line down the list.
function DemandRow({ lane, rank, largest }: { lane: DemandLane; rank: number; largest: number }) {
  const unmet = demandUnmet(lane);
  return (
    <li>
      <Link
        href={demandLaneHref(lane)}
        className="flex h-11 min-w-0 items-center gap-4 px-4 text-sm outline-none transition-colors hover:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
      >
        <span className="tabular w-5 shrink-0 text-right text-xs text-fg-faint">{rank}</span>
        <span className="w-20 shrink-0 truncate font-medium text-fg">{laneLabel(lane)}</span>
        <EquipmentTag equipment={lane.equipment} className="w-32 shrink-0" />
        <span className="flex shrink-0 items-center gap-2" title={`${unmet} unmet: searches with no match plus offers with no booking`}>
          <span className="h-1.5 w-[120px] overflow-hidden rounded-full bg-panel-raised">
            <span className="block h-full rounded-full bg-tone-amber/70" style={{ width: `${unmetBarPercent(unmet, largest)}%` }} />
          </span>
          <span className="w-16 text-fg-muted">
            <span className="font-medium tabular-nums text-fg">{unmet}</span> unmet
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{demandSignal(lane)}</span>
        <Trend lane={lane} />
        <LuChevronRight size={14} className="shrink-0 text-fg-faint" aria-hidden />
      </Link>
    </li>
  );
}

// The lanes carriers asked for and the board did not cover, most unmet first as the adapter sends
// them. The bar is sized against the largest lane loaded so far.
export function DemandList({
  data,
  loading,
  filtered,
  onClearFilters,
}: {
  data: TowerDemand | null;
  loading: boolean;
  filtered: boolean;
  onClearFilters: () => void;
}) {
  const rows = data?.rows ?? [];
  const largest = rows.reduce((max, lane) => Math.max(max, demandUnmet(lane)), 0);

  if (data === null) {
    return loading ? (
      <SkeletonRows />
    ) : (
      <div className="p-10 text-center text-sm text-fg-muted">
        <p>The demand data is unavailable</p>
        <p className="mt-1 text-xs text-fg-faint">It retries every few seconds</p>
      </div>
    );
  }
  if (rows.length > 0) {
    return (
      <ul aria-label="Lanes, most unmet first" className="divide-y divide-line">
        {rows.map((lane, i) => (
          <DemandRow key={demandKey(lane)} lane={lane} rank={i + 1} largest={largest} />
        ))}
      </ul>
    );
  }
  if (filtered) {
    return (
      <div className="p-10 text-center text-sm text-fg-muted">
        <p>No lanes match these filters</p>
        <button
          type="button"
          onClick={onClearFilters}
          className="mt-3 inline-flex h-8 cursor-pointer items-center rounded-md border border-line bg-panel px-3 text-sm font-medium text-fg hover:bg-panel-raised"
        >
          Clear filters
        </button>
      </div>
    );
  }
  return (
    <div className="p-10 text-center text-sm text-fg-muted">
      <p>No unmet demand in the last 4 weeks</p>
      <p className="mt-1 text-xs text-fg-faint">Lanes show up here when a search finds no load or an offer ends without a booking</p>
    </div>
  );
}
