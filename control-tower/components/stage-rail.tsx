"use client";

import { Check } from "@phosphor-icons/react";
import { finalRound, type CallStage, type TowerCall } from "@/lib/contracts";

const steps = ["Verify", "Code", "Search", "Negotiate", "Hold", "Booked"] as const;
type Step = (typeof steps)[number];

// The furthest step the call's data proves it reached; used once the call is no longer moving.
function reachedStep(call: TowerCall): number {
  const hold = call.hold?.status;
  if (hold === "booked" || hold === "booked_unconfirmed") return 5;
  if (call.hold !== null) return 4;
  if (call.offers.length > 0) return 3;
  if (call.verified) return 2;
  if (call.otp.attempts > 0 || call.events.some((event) => event.tool === "send_otp")) return 1;
  return 0;
}

// Stages that pin the rail to one step; released and ended fall back to what the call's data proves.
const stageStep: Partial<Record<CallStage, number>> = {
  connecting: 0,
  verifying: 0,
  otp: 1,
  searching: 2,
  negotiating: 3,
  holding: 4,
  booked: 5,
};

function stepIndex(call: TowerCall): number {
  return stageStep[call.stage] ?? reachedStep(call);
}

// Where a red or amber call went wrong, so the reason sits under the step it belongs to.
function riskStep(call: TowerCall, current: number): number | null {
  if (call.risk === "green") return null;
  if (!call.eligible) return 0;
  if (call.otp.locked) return 1;
  if (call.risk === "amber") return 3;
  return current;
}

function RoundDots({ round, tone }: { round: number | null; tone: string }) {
  return (
    <span className="flex items-center gap-1" aria-label={round === null ? "No offer yet" : `Round ${round} of ${finalRound}`}>
      {Array.from({ length: finalRound }, (_, i) => (
        <span
          key={i}
          title={`R${i + 1}`}
          className={`size-1.5 rounded-full ${round !== null && i < round ? tone : "bg-line-strong"}`}
        />
      ))}
    </span>
  );
}

export function StageRail({ call }: { call: TowerCall }) {
  const current = stepIndex(call);
  // A finished call has no step in progress; its last step reads as history, not as the AI acting.
  const moving = call.live && call.stage !== "ended" && call.stage !== "released";
  const flagged = riskStep(call, current);
  const riskTone = call.risk === "red" ? "text-risk" : "text-warn";

  return (
    <ol aria-label="Call progress" className="grid grid-cols-6 gap-1.5">
      {steps.map((step: Step, i) => {
        // Booked is an outcome, never work in progress, so reaching it reads as done.
        const done = i < current || (i === current && step === "Booked");
        const isCurrent = i === current && !done;
        const isFlagged = flagged === i;
        const bar = isFlagged
          ? call.risk === "red"
            ? "bg-risk"
            : "bg-warn"
          : isCurrent && moving
            ? "bg-accent"
            : done || isCurrent
              ? "bg-fg-faint"
              : "bg-line";
        const label = isFlagged ? riskTone : isCurrent && moving ? "text-accent" : done || isCurrent ? "text-fg-muted" : "text-fg-faint";

        return (
          <li key={step} aria-current={isCurrent ? "step" : undefined} className="flex min-w-0 flex-col gap-1.5">
            <span className={`h-0.5 rounded-full ${bar}`} />
            <span className={`flex items-center gap-1.5 text-xs font-medium ${label}`}>
              {done && <Check size={11} weight="bold" aria-label="Done" className="shrink-0" />}
              <span className="truncate">{step}</span>
              {step === "Negotiate" && (
                <RoundDots
                  round={call.offers.length > 0 ? call.round : null}
                  tone={isFlagged ? (call.risk === "red" ? "bg-risk" : "bg-warn") : isCurrent && moving ? "bg-accent" : "bg-fg-muted"}
                />
              )}
            </span>
            {isFlagged && call.riskReason && <span className={`text-[11px] leading-tight ${riskTone}`}>{call.riskReason}</span>}
          </li>
        );
      })}
    </ol>
  );
}
