import type { IconType } from "react-icons";
import { LuActivity, LuArrowDownRight, LuArrowRight, LuArrowUpRight, LuClockAlert, LuSparkles, LuTrendingUp, LuTrophy } from "react-icons/lu";
import { Badge } from "@/components/inbox/stage-pill";
import type { CarrierRelationship, NetworkCarrier } from "@/lib/contracts";
import { callsTrend, recentDays, type CallsTrend, type NetworkReason } from "@/lib/network";

export type ChipStyle = { label: string; icon: IconType; iconTone: string; pill: string };

// One look per relationship and tag, shared by the view chips, the rows and the panel. Red is a
// carrier going quiet, blue a new one, green an active one; amber and emerald are the tags.
export const relationshipStyle: Record<CarrierRelationship, ChipStyle> = {
  new: { label: "New", icon: LuSparkles, iconTone: "text-tone-blue", pill: "bg-tone-blue-soft text-tone-blue" },
  at_risk: { label: "At risk", icon: LuClockAlert, iconTone: "text-tone-red", pill: "bg-tone-red-soft text-tone-red" },
  active: { label: "Active", icon: LuActivity, iconTone: "text-tone-green", pill: "bg-tone-green-soft text-tone-green" },
};
export const topStyle: ChipStyle = { label: "Top", icon: LuTrophy, iconTone: "text-tone-amber", pill: "bg-tone-amber-soft text-tone-amber" };
export const growthStyle: ChipStyle = { label: "Growth", icon: LuTrendingUp, iconTone: "text-tone-emerald", pill: "bg-tone-emerald-soft text-tone-emerald" };

// Each panel reason line wears the icon of the relationship or tag it explains.
export const reasonStyle: Record<NetworkReason["kind"], ChipStyle> = { ...relationshipStyle, top: topStyle, growth: growthStyle };

// A bare icon in its tone, named for screen readers and on hover: the row's status and tag marks.
export function StyleIcon({ style, size = 14 }: { style: ChipStyle; size?: number }) {
  const Icon = style.icon;
  return (
    <span role="img" aria-label={style.label} title={style.label} className={`flex shrink-0 ${style.iconTone}`}>
      <Icon size={size} aria-hidden />
    </span>
  );
}

function Chip({ style, size = "sm" }: { style: ChipStyle; size?: "sm" | "md" }) {
  const Icon = style.icon;
  return (
    <Badge tone={style.pill} size={size}>
      <Icon size={size === "sm" ? 11 : 13} aria-hidden />
      {style.label}
    </Badge>
  );
}

// The relationship chip, then a chip per tag the carrier carries.
export function NetworkChips({ carrier, size = "sm" }: { carrier: NetworkCarrier; size?: "sm" | "md" }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      <Chip style={relationshipStyle[carrier.relationship]} size={size} />
      {carrier.top && <Chip style={topStyle} size={size} />}
      {carrier.growth && <Chip style={growthStyle} size={size} />}
    </span>
  );
}

const trendStyle: Record<CallsTrend, { icon: IconType; tone: string; word: string }> = {
  up: { icon: LuArrowUpRight, tone: "text-tone-green", word: "Calling more" },
  down: { icon: LuArrowDownRight, tone: "text-tone-red", word: "Calling less" },
  flat: { icon: LuArrowRight, tone: "text-fg-faint", word: "Calling the same" },
};

// The last 14 days of calls against the 14 before, as an arrow; `withText` spells it out.
export function TrendArrow({ carrier, withText = false }: { carrier: NetworkCarrier; withText?: boolean }) {
  const { icon: Icon, tone, word } = trendStyle[callsTrend(carrier)];
  const { callsRecent, callsPrior } = carrier.facts;
  const detail = `${callsRecent} in the last ${recentDays} d vs ${callsPrior} in the ${recentDays} d before`;
  return (
    <span role="img" aria-label={`${word}: ${detail}`} title={`${word}: ${detail}`} className={`flex shrink-0 items-center gap-1.5 ${tone}`}>
      <Icon size={16} aria-hidden />
      {withText && (
        <span className="text-sm text-fg">
          {word} <span className="text-fg-muted">({detail})</span>
        </span>
      )}
    </span>
  );
}
