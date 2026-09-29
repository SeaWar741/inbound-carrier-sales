import type { CallStage, CarrierStage, TowerCall } from "@/lib/contracts";
import { callStageLabel, carrierStageLabels } from "@/lib/format";

// Accent means the AI is still working the carrier, amber waits on a human, green is freight moving,
// neutral is settled.
const carrierStageTone: Record<CarrierStage, { pill: string; dot: string }> = {
  live: { pill: "bg-accent-soft text-accent", dot: "bg-accent" },
  negotiating: { pill: "bg-accent-soft text-accent", dot: "bg-accent" },
  needs_approval: { pill: "bg-warn-soft text-warn", dot: "bg-warn" },
  booked: { pill: "bg-ok-soft text-ok", dot: "bg-ok" },
  in_transit: { pill: "bg-ok-soft text-ok", dot: "bg-ok" },
  arrived: { pill: "bg-panel-raised text-fg-muted", dot: "bg-line-strong" },
  lost: { pill: "bg-panel-raised text-fg-muted", dot: "bg-line-strong" },
};

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
export const badgeClass = "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-md font-medium leading-none";

export function Badge({ tone, size = "sm", children }: { tone: string; size?: keyof typeof badgeSize; children: React.ReactNode }) {
  return <span className={`${badgeClass} ${badgeSize[size]} ${tone}`}>{children}</span>;
}

export function CarrierStagePill({ stage, size = "sm" }: { stage: CarrierStage; size?: keyof typeof badgeSize }) {
  return (
    <Badge tone={carrierStageTone[stage].pill} size={size}>
      {carrierStageLabels[stage]}
    </Badge>
  );
}

export function CarrierStageDot({ stage }: { stage: CarrierStage }) {
  return (
    <span
      role="img"
      aria-label={carrierStageLabels[stage]}
      className={`size-2.5 shrink-0 rounded-full ${carrierStageTone[stage].dot}`}
    />
  );
}

export function CallStagePill({ call }: { call: Pick<TowerCall, "stage" | "round"> }) {
  return <Badge tone={callStageTone[call.stage]}>{callStageLabel(call)}</Badge>;
}
