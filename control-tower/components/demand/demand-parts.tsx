import type { IconType } from "react-icons";
import { LuBadgeDollarSign, LuContainer, LuEqual, LuSearchX, LuSnowflake, LuTrendingDown, LuTrendingUp, LuTruck } from "react-icons/lu";
import { demandEquipmentLabel, type DemandNext, type DemandTrend } from "@/lib/demand";

// The equipment as a row shows it: an icon and the words; a truck when the carriers asked for any.
export function EquipmentTag({ equipment, className = "" }: { equipment: string | null; className?: string }) {
  const Icon = equipment === "REEFER" ? LuSnowflake : equipment ? LuContainer : LuTruck;
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-fg-muted ${className}`}>
      <Icon size={13} className="shrink-0 text-fg-faint" aria-hidden />
      <span className="truncate">{demandEquipmentLabel(equipment)}</span>
    </span>
  );
}

// More unmet asks this week is a gap growing, so it reads amber; fewer reads green.
export const trendStyle: Record<DemandTrend, { icon: IconType; tone: string }> = {
  up: { icon: LuTrendingUp, tone: "text-warn" },
  down: { icon: LuTrendingDown, tone: "text-ok" },
  flat: { icon: LuEqual, tone: "text-fg-faint" },
};

// Blue for a load to find, amber for a rate to check, as on the key numbers above the table.
export const nextStyle: Record<DemandNext, { label: string; icon: IconType; tone: string }> = {
  source: { label: "Find a load", icon: LuSearchX, tone: "text-tone-blue" },
  rate: { label: "Check the rate", icon: LuBadgeDollarSign, tone: "text-tone-amber" },
  both: { label: "Find a load, check rate", icon: LuSearchX, tone: "text-tone-blue" },
};
