"use client";

import type { IconType } from "react-icons";
import { LuCalendarDays, LuHistory, LuInfo, LuLightbulb } from "react-icons/lu";
import { DemandCarriers } from "@/components/demand/demand-carriers";
import { EquipmentTag, trendStyle } from "@/components/demand/demand-list";
import type { DemandLane } from "@/lib/contracts";
import { demandSignal, demandTrend, laneLabel } from "@/lib/demand";

function WeekBox({ icon: Icon, label, value, tone = "text-fg" }: { icon: IconType; label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-bg px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-fg-muted">
        <Icon size={13} className="shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <div className={`tabular mt-0.5 text-lg font-semibold ${tone}`}>
        {value} <span className="text-xs font-normal text-fg-muted">unmet</span>
      </div>
    </div>
  );
}

// The selected lane: what it is short of, how this week compares, and the carriers who asked. `lane`
// is only the lane's identity when a link names one the loaded rows do not hold; its counts are
// then unknown and only the carriers show.
// What the desk can do about the lane, from what went unmet on it.
function nextStep(row: DemandLane): string {
  if (row.offeredNoBooking === 0) return "The board had nothing for these carriers. Source a load on this lane, or call them when one opens.";
  if (row.noMatch === 0) return "Loads were offered here and none booked. Check the rate against what these carriers asked.";
  return "Some searches found nothing and some offers did not book. Source more loads here and check the rate.";
}

export function DemandDetail({
  lane,
  row,
  listLoaded,
}: {
  lane: Pick<DemandLane, "originState" | "destinationState" | "equipment">;
  row: DemandLane | null;
  // Until the list answers, a linked lane's counts are still on their way, not missing.
  listLoaded: boolean;
}) {
  const trend = row ? trendStyle[demandTrend(row).trend] : null;
  return (
    <div className="h-full min-h-0 overflow-y-auto bg-panel">
      <div className="p-4">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="shrink-0 text-lg font-semibold text-fg">{laneLabel(lane)}</h2>
          <EquipmentTag equipment={lane.equipment} />
        </div>
        {row && <p className="mt-1 text-sm text-fg-muted">{demandSignal(row, { asked: true })}</p>}
        {!row && listLoaded && (
          <p className="mt-1 flex items-center gap-1 text-sm text-fg-faint">
            <LuInfo size={13} className="shrink-0" aria-hidden />
            Not among the lanes loaded for these filters
          </p>
        )}
        {row && trend && (
          <div className="mt-3 grid grid-cols-2 gap-2" title="Unmet this week vs last week">
            <WeekBox icon={LuCalendarDays} label="This week" value={row.thisWeek} tone={trend.tone === "text-fg-faint" ? "text-fg" : trend.tone} />
            <WeekBox icon={LuHistory} label="Last week" value={row.previousWeek} />
          </div>
        )}
        {row && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-accent-soft px-3 py-2 text-sm text-fg">
            <LuLightbulb size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden />
            {nextStep(row)}
          </p>
        )}
      </div>
      <DemandCarriers lane={lane} />
    </div>
  );
}
