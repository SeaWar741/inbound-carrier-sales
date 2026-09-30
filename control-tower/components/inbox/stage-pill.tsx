import type { IconType } from "react-icons";
import { LuCircleCheck, LuCircleX, LuFlag, LuHand, LuHandshake, LuPhoneCall, LuTruck } from "react-icons/lu";
import { PulseDot } from "@/components/pulse-dot";
import type { CallStage, CarrierStage, TowerCall } from "@/lib/contracts";
import { callStageLabel, carrierStageLabels } from "@/lib/format";

// A stage's color: `icon` for a bare icon or text, `pill` for a soft badge.
export type StageTone = { icon: string; pill: string };

const tones = {
  red: { icon: "text-tone-red", pill: "bg-tone-red-soft text-tone-red" },
  green: { icon: "text-tone-green", pill: "bg-tone-green-soft text-tone-green" },
  amber: { icon: "text-tone-amber", pill: "bg-tone-amber-soft text-tone-amber" },
  emerald: { icon: "text-tone-emerald", pill: "bg-tone-emerald-soft text-tone-emerald" },
  blue: { icon: "text-tone-blue", pill: "bg-tone-blue-soft text-tone-blue" },
  teal: { icon: "text-tone-teal", pill: "bg-tone-teal-soft text-tone-teal" },
  gray: { icon: "text-tone-gray", pill: "bg-tone-gray-soft text-tone-gray" },
} satisfies Record<string, StageTone>;

// The one stage language of the inbox: the rail, the list rows and the detail badge all read it.
// Red waits on a human, green is on the phone, amber is haggling, emerald is booked, blue is
// rolling, teal has arrived, gray is lost.
export const carrierStageStyle: Record<CarrierStage, { label: string; icon: IconType; tone: StageTone }> = {
  needs_approval: { label: carrierStageLabels.needs_approval, icon: LuHand, tone: tones.red },
  live: { label: carrierStageLabels.live, icon: LuPhoneCall, tone: tones.green },
  negotiating: { label: carrierStageLabels.negotiating, icon: LuHandshake, tone: tones.amber },
  booked: { label: carrierStageLabels.booked, icon: LuCircleCheck, tone: tones.emerald },
  in_transit: { label: carrierStageLabels.in_transit, icon: LuTruck, tone: tones.blue },
  arrived: { label: carrierStageLabels.arrived, icon: LuFlag, tone: tones.teal },
  lost: { label: carrierStageLabels.lost, icon: LuCircleX, tone: tones.gray },
};

// Rail rows that are not a stage: "All carriers" is neutral.
export const neutralTone: StageTone = tones.gray;

// Same tones the call wall used for a single call's stage.
const callStageTone: Record<CallStage, string> = {
  connecting: "bg-accent-soft text-accent",
  verifying: "bg-accent-soft text-accent",
  otp: "bg-accent-soft text-accent",
  searching: "bg-accent-soft text-accent",
  negotiating: "bg-accent-soft text-accent",
  holding: "bg-warn-soft text-warn",
  booked: "bg-ok-soft text-ok",
  released: "bg-panel-raised text-fg-muted",
  ended: "bg-panel-raised text-fg-muted",
};

// The cortex badge: a small rounded label; "sm" is the list row size, "md" the detail header size.
const badgeSize = {
  sm: "h-[18px] px-1.5 text-[10px]",
  md: "px-3 py-1.5 text-xs",
};
const badgeClass = "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-md font-medium leading-none";

export function Badge({ tone, size = "sm", children }: { tone: string; size?: keyof typeof badgeSize; children: React.ReactNode }) {
  return <span className={`${badgeClass} ${badgeSize[size]} ${tone}`}>{children}</span>;
}

// The detail header's stage: icon and label in the stage's tone; a live call pulses.
export function CarrierStagePill({ stage, size = "sm" }: { stage: CarrierStage; size?: keyof typeof badgeSize }) {
  const { label, icon: Icon, tone } = carrierStageStyle[stage];
  return (
    <Badge tone={tone.pill} size={size}>
      {stage === "live" && <PulseDot tone="live" />}
      <Icon size={size === "sm" ? 11 : 13} aria-hidden />
      {label}
    </Badge>
  );
}

// A list row's stage: the bare icon in the stage's tone, named for screen readers and on hover.
export function CarrierStageIcon({ stage, size = 18 }: { stage: CarrierStage; size?: number }) {
  const { label, icon: Icon, tone } = carrierStageStyle[stage];
  return (
    <span role="img" aria-label={label} title={label} className={`flex shrink-0 items-center gap-1.5 ${tone.icon}`}>
      {stage === "live" && <PulseDot tone="live" />}
      <Icon size={size} aria-hidden />
    </span>
  );
}

export function CallStagePill({ call }: { call: Pick<TowerCall, "stage" | "round"> }) {
  return <Badge tone={callStageTone[call.stage]}>{callStageLabel(call)}</Badge>;
}
