import type { IconType } from "react-icons";
import { LuArrowDown, LuArrowUp, LuContainer, LuEqual, LuSnowflake } from "react-icons/lu";
import type { DemandTrend } from "@/lib/demand";
import { equipmentLabel } from "@/lib/format";

// The equipment as a row shows it: an icon and the words, "Any equipment" when the carriers did not say.
export function EquipmentTag({ equipment, className = "" }: { equipment: string | null; className?: string }) {
  const Icon = equipment === "REEFER" ? LuSnowflake : LuContainer;
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-sm text-fg-muted ${className}`}>
      <Icon size={13} className="shrink-0 text-fg-faint" aria-hidden />
      <span className="truncate">{equipment ? equipmentLabel(equipment) : "Any equipment"}</span>
    </span>
  );
}

// More unmet asks this week is a gap growing, so it reads amber; fewer reads green.
export const trendStyle: Record<DemandTrend, { icon: IconType; tone: string; pill: string; word: string }> = {
  up: { icon: LuArrowUp, tone: "text-warn", pill: "bg-tone-amber-soft text-tone-amber", word: "More than last week" },
  down: { icon: LuArrowDown, tone: "text-ok", pill: "bg-tone-green-soft text-tone-green", word: "Fewer than last week" },
  flat: { icon: LuEqual, tone: "text-fg-faint", pill: "bg-tone-gray-soft text-tone-gray", word: "Same as last week" },
};

// A status pill: a tinted background is the only color on the page that means state.
export function Pill({ icon: Icon, tone, children }: { icon?: IconType; tone: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap ${tone}`}>
      {Icon && <Icon size={12} className="shrink-0" aria-hidden />}
      {children}
    </span>
  );
}
