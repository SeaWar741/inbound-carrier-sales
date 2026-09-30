"use client";

import { useRef } from "react";
import type { IconType } from "react-icons";
import { LuArrowDown, LuArrowUp, LuContainer, LuEqual, LuLoaderCircle, LuSnowflake } from "react-icons/lu";
import { SkeletonRows, useLoadMore } from "@/components/paged-list";
import type { DemandLane, TowerDemand } from "@/lib/contracts";
import { demandKey, demandSignal, demandTrend, demandUnmet, laneLabel, unmetBarPercent, type DemandTrend } from "@/lib/demand";
import { equipmentLabel } from "@/lib/format";

// The equipment as the row and the panel show it: an icon and the words, "Any equipment" when the
// carriers did not say.
export function EquipmentTag({ equipment, className = "" }: { equipment: string | null; className?: string }) {
  const Icon = equipment === "REEFER" ? LuSnowflake : LuContainer;
  return (
    <span className={`flex min-w-0 items-center gap-1 text-sm text-fg-muted ${className}`}>
      <Icon size={13} className={`shrink-0 ${equipment ? "text-accent" : "text-fg-faint"}`} aria-hidden />
      <span className="truncate">{equipment ? equipmentLabel(equipment) : "Any equipment"}</span>
    </span>
  );
}

// More unmet asks this week is a gap growing, so it reads amber; fewer reads green.
export const trendStyle: Record<DemandTrend, { icon: IconType; tone: string; word: string }> = {
  up: { icon: LuArrowUp, tone: "text-warn", word: "More this week" },
  down: { icon: LuArrowDown, tone: "text-ok", word: "Fewer this week" },
  flat: { icon: LuEqual, tone: "text-fg-faint", word: "Same as last week" },
};

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

// Two lines: rank, lane, equipment, the unmet bar and the week trend; then the signal in words.
// The lane and equipment widths are fixed so the bars start in one column down the list.
function DemandRow({
  lane,
  rank,
  largest,
  selected,
  onSelect,
  buttonRef,
}: {
  lane: DemandLane;
  rank: number;
  largest: number;
  selected: boolean;
  onSelect: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
}) {
  const unmet = demandUnmet(lane);
  return (
    <li>
      <button
        ref={buttonRef}
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`w-full cursor-pointer px-4 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
          selected ? "bg-accent-soft" : "hover:bg-panel-raised"
        }`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="tabular w-6 shrink-0 text-right text-sm text-fg-faint">{rank}</span>
          <span className="w-20 shrink-0 truncate font-semibold text-fg">{laneLabel(lane)}</span>
          <EquipmentTag equipment={lane.equipment} className="w-32 shrink-0" />
          <span className="flex min-w-0 flex-1 items-center gap-2" title={`${unmet} unmet: searches with no match plus offers with no booking`}>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-panel-raised">
              <span className="block h-full rounded-full bg-tone-amber/70" style={{ width: `${unmetBarPercent(unmet, largest)}%` }} />
            </span>
            <span className="w-20 shrink-0 text-sm text-fg-muted"><span className="font-semibold tabular-nums text-fg">{unmet}</span> unmet</span>
          </span>
          <Trend lane={lane} />
        </div>
        <p className="mt-0.5 truncate pl-9 text-sm text-fg-muted">{demandSignal(lane)}</p>
      </button>
    </li>
  );
}

// The lanes carriers asked for and the board did not cover, most unmet first as the adapter sends
// them, with the next page loading as the list nears its end. Arrow keys move the selection.
export function DemandList({
  data,
  loading,
  filtered,
  selectedKey,
  loadingMore,
  hasMore,
  onLoadMore,
  onSelect,
  onClearFilters,
}: {
  data: TowerDemand | null;
  loading: boolean;
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
  const largest = rows.reduce((max, lane) => Math.max(max, demandUnmet(lane)), 0);
  const { scroller, sentinel } = useLoadMore(hasMore, rows.length, onLoadMore);

  function onKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = rows.findIndex((lane) => demandKey(lane) === selectedKey);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = rows[index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + step))];
    if (next === undefined) return;
    const key = demandKey(next);
    onSelect(key);
    buttons.current.get(key)?.focus();
  }

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
      <ul aria-label="Lanes, most unmet first" onKeyDown={onKeyDown} className="divide-y divide-line">
        {rows.map((lane, i) => {
          const key = demandKey(lane);
          return (
            <DemandRow
              key={key}
              lane={lane}
              rank={i + 1}
              largest={largest}
              selected={key === selectedKey}
              onSelect={() => onSelect(key)}
              buttonRef={(node) => {
                if (node) buttons.current.set(key, node);
                else buttons.current.delete(key);
              }}
            />
          );
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
    <div ref={scroller} className="h-full min-h-0 overflow-y-auto bg-panel">
      {body}
      {hasMore && rows.length > 0 && (
        <div ref={sentinel} role="status" className="flex items-center justify-center gap-2 border-t border-line px-4 py-3 text-xs text-fg-faint">
          {loadingMore && <LuLoaderCircle size={14} className="animate-spin" aria-hidden />}
          {loadingMore ? "Loading more lanes..." : `${rows.length} of ${total}`}
        </div>
      )}
    </div>
  );
}
