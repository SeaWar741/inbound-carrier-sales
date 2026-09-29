"use client";

import { ChatText, Phone } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { useRef } from "react";
import type { CallStage, TowerCall } from "@/lib/contracts";
import { formatClock, formatElapsed, formatUsd } from "@/lib/format";

const riskRank: Record<TowerCall["risk"], number> = { red: 0, amber: 1, green: 2 };

// Live first, then the riskiest, then the newest: red calls rise to the top.
export function sortCalls(calls: TowerCall[]): TowerCall[] {
  return [...calls].sort(
    (a, b) =>
      Number(b.live) - Number(a.live) || riskRank[a.risk] - riskRank[b.risk] || b.createdAt.localeCompare(a.createdAt),
  );
}

const riskDot: Record<TowerCall["risk"], string> = { red: "bg-risk", amber: "bg-warn", green: "bg-ok" };
const riskLabel: Record<TowerCall["risk"], string> = { red: "High risk", amber: "Some risk", green: "Low risk" };

// Accent means the AI is still working the call; green, amber and neutral are outcomes.
const stageTone: Record<CallStage, string> = {
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

function stageLabel(call: TowerCall): string {
  switch (call.stage) {
    case "otp":
      return "OTP";
    case "negotiating":
      return call.round === null ? "Negotiating" : `Round ${call.round}`;
    default:
      return call.stage.charAt(0).toUpperCase() + call.stage.slice(1);
  }
}

function carrierId(call: TowerCall): string {
  if (call.mcNumber) return `MC ${call.mcNumber}`;
  if (call.dotNumber) return `DOT ${call.dotNumber}`;
  return "Unidentified";
}

function carrierState(call: TowerCall): string {
  if (call.otp.locked) return "OTP locked";
  if (call.verified) return call.eligible ? "Verified" : "Not eligible";
  if (call.mcNumber || call.dotNumber) return "Unverified";
  return "";
}

function latest<T extends { createdAt: string }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>((best, item) => (best === undefined || item.createdAt > best.createdAt ? item : best), undefined);
}

function lastSummary(call: TowerCall): string | null {
  const withSummary = call.events.filter((event) => event.summary);
  return latest(withSummary)?.summary ?? null;
}

function currentNumber(call: TowerCall): { ask: number; say: number | null } | null {
  if (call.stage !== "negotiating" && call.stage !== "holding") return null;
  const offer = latest(call.offers);
  return offer === undefined ? null : { ask: offer.carrierAsk, say: offer.rateToSay };
}

function elapsedLabel(call: TowerCall, now: number): string {
  // Once the carrier hung up the clock stops, whatever stage the call reached (a hold waits for the rep).
  if (!call.live && call.stage !== "connecting") {
    return formatClock(call.createdAt);
  }
  return formatElapsed(now - Date.parse(call.createdAt));
}

function LivePulse() {
  const reduce = useReducedMotion();
  return (
    <span className="relative inline-flex size-2" role="img" aria-label="Live">
      {!reduce && (
        <motion.span
          className="absolute inset-0 rounded-full bg-accent"
          animate={{ scale: [1, 2.2], opacity: [0.6, 0] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <span className="relative inline-flex size-2 rounded-full bg-accent" />
    </span>
  );
}

function CallRow({
  call,
  now,
  selected,
  takenOver,
  onSelect,
  buttonRef,
}: {
  call: TowerCall;
  now: number;
  selected: boolean;
  takenOver: boolean;
  onSelect: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
}) {
  const reduce = useReducedMotion();
  const summary = lastSummary(call);
  const number = currentNumber(call);
  const state = carrierState(call);
  const dimmed = call.stage === "ended" && !call.live;
  const ChannelIcon = call.channel === "text" ? ChatText : Phone;

  return (
    <motion.li layout={reduce ? false : "position"} transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={`${carrierId(call)}, ${stageLabel(call)}, ${riskLabel[call.risk]}${call.live ? ", live" : ""}`}
        className={`flex w-full flex-col gap-1 border-l-2 px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
          takenOver
            ? "border-accent bg-accent/35"
            : selected
              ? "border-accent bg-panel-raised"
              : "border-transparent hover:bg-panel-raised/60"
        } ${dimmed ? "opacity-60" : ""}`}
      >
        <span className="flex items-center gap-2 text-sm">
          <span
            className={`size-2 shrink-0 rounded-full ${riskDot[call.risk]}`}
            title={call.riskReason ?? riskLabel[call.risk]}
          />
          <span className="tabular truncate font-medium text-fg">{carrierId(call)}</span>
          {state && <span className="truncate text-xs text-fg-faint">{state}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {call.live && <LivePulse />}
            {call.channel && (
              <ChannelIcon
                size={14}
                weight="regular"
                className="text-fg-faint"
                aria-label={call.channel === "text" ? "Text call" : "Voice call"}
              />
            )}
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium leading-none ${stageTone[call.stage]}`}>
              {stageLabel(call)}
            </span>
            <span className="tabular w-14 text-right text-xs text-fg-muted">{elapsedLabel(call, now)}</span>
          </span>
        </span>
        <span className="flex items-center gap-2 pl-4 text-xs">
          <span className="min-w-0 flex-1 truncate text-fg-muted">{summary ?? " "}</span>
          {number && (
            <span className="tabular shrink-0 text-fg">
              {formatUsd(number.ask)}
              <span className="text-fg-faint"> vs </span>
              {number.say === null ? "-" : formatUsd(number.say)}
            </span>
          )}
        </span>
      </button>
    </motion.li>
  );
}

function SkeletonRows() {
  return (
    <ul aria-hidden className="divide-y divide-line">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="flex flex-col gap-2 px-3 py-2.5">
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-line-strong" />
            <span className="h-3 w-24 animate-pulse rounded bg-line" />
            <span className="ml-auto h-3 w-16 animate-pulse rounded-full bg-line" />
            <span className="h-3 w-10 animate-pulse rounded bg-line" />
          </span>
          <span className="ml-4 h-2.5 w-48 animate-pulse rounded bg-line" />
        </li>
      ))}
    </ul>
  );
}

export function CallWall({
  calls,
  loading,
  now,
  selectedCallId,
  takenOverCallId = null,
  onSelect,
}: {
  calls: TowerCall[] | null;
  loading: boolean;
  now: number;
  selectedCallId: string | null;
  // The call the operator took over; its row gets a solid accent fill.
  takenOverCallId?: string | null;
  onSelect: (callId: string) => void;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  if (calls === null) {
    return loading ? <SkeletonRows /> : null;
  }
  if (calls.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-fg">No calls yet today</p>
        <p className="mt-1 text-xs text-fg-muted">
          Run <span className="tabular text-fg">npm run simulate</span> or place a web call
        </p>
      </div>
    );
  }

  const sorted = sortCalls(calls);

  function onKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = sorted.findIndex((call) => call.callId === selectedCallId);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = index === -1 ? 0 : Math.min(sorted.length - 1, Math.max(0, index + step));
    const next = sorted[nextIndex];
    if (next === undefined) return;
    onSelect(next.callId);
    buttons.current.get(next.callId)?.focus();
  }

  return (
    <ul aria-label="Calls" onKeyDown={onKeyDown} className="divide-y divide-line">
      {sorted.map((call) => (
        <CallRow
          key={call.callId}
          call={call}
          now={now}
          selected={call.callId === selectedCallId}
          takenOver={call.callId === takenOverCallId}
          onSelect={() => onSelect(call.callId)}
          buttonRef={(node) => {
            if (node) buttons.current.set(call.callId, node);
            else buttons.current.delete(call.callId);
          }}
        />
      ))}
    </ul>
  );
}
