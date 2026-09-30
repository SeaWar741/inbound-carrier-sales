"use client";

import { Tooltip } from "antd";
import type { IconType } from "react-icons";
import { LuActivity, LuClockAlert, LuSparkles, LuTrendingUp, LuTrophy } from "react-icons/lu";
import type { NetworkCarrier } from "@/lib/contracts";

export type ChipStyle = { label: string; tip: string; icon: IconType; iconTone: string };

// The statuses the page filters by, in the order a call is most worth making. Red is a carrier going
// quiet, emerald an open lane, amber a top carrier, blue a new one. Top and Lane open are tags, so a
// carrier can wear several.
export const statusStyle = {
  at_risk: { label: "At risk", tip: "At risk: booked before, now quiet or calling less", icon: LuClockAlert, iconTone: "text-tone-red" },
  growth: { label: "Lane open", tip: "Lane open: one of their lanes has a load now", icon: LuTrendingUp, iconTone: "text-tone-emerald" },
  top: { label: "Top", tip: "Top: books most of their offers", icon: LuTrophy, iconTone: "text-tone-amber" },
  new: { label: "New", tip: "New: fewer than 3 calls", icon: LuSparkles, iconTone: "text-tone-blue" },
} satisfies Record<string, ChipStyle>;
export type NetworkStatus = keyof typeof statusStyle;

const activeStyle: ChipStyle = { label: "Active", tip: "Active, nothing to flag", icon: LuActivity, iconTone: "text-tone-gray" };

function carrierStatuses(carrier: NetworkCarrier): NetworkStatus[] {
  const statuses: NetworkStatus[] = [];
  if (carrier.relationship === "at_risk") statuses.push("at_risk");
  if (carrier.growth) statuses.push("growth");
  if (carrier.top) statuses.push("top");
  if (carrier.relationship === "new") statuses.push("new");
  return statuses;
}

// A bare icon in its tone, named for screen readers and explained on hover and focus.
export function StyleIcon({ style, size = 15 }: { style: ChipStyle; size?: number }) {
  const Icon = style.icon;
  return (
    <Tooltip title={style.tip}>
      <span role="img" aria-label={style.tip} tabIndex={0} className={`flex shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${style.iconTone}`}>
        <Icon size={size} aria-hidden />
      </span>
    </Tooltip>
  );
}

// Every status the carrier carries, or the neutral mark when there is nothing to flag.
export function StatusIcons({ carrier }: { carrier: NetworkCarrier }) {
  const statuses = carrierStatuses(carrier);
  return (
    <span className="flex items-center gap-1.5">
      {statuses.length === 0 ? <StyleIcon style={activeStyle} /> : statuses.map((status) => <StyleIcon key={status} style={statusStyle[status]} />)}
    </span>
  );
}
