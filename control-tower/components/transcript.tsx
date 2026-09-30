"use client";

import type { IconType } from "react-icons";
import {
  LuArrowDown,
  LuAudioWaveform,
  LuBot,
  LuCalculator,
  LuCheck,
  LuDollarSign,
  LuEar,
  LuHand,
  LuKeyRound,
  LuLock,
  LuMail,
  LuMessageCircleMore,
  LuMic,
  LuPhoneOff,
  LuRoute,
  LuSearch,
  LuShieldCheck,
  LuUser,
  LuWrench,
} from "react-icons/lu";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import type { SentIntervention } from "@/components/intervention-bar";
import type { StreamLine, TowerCall } from "@/lib/contracts";
import { formatClock, formatUsd, toolKey, toolLabel } from "@/lib/format";
import type { CallStream } from "@/lib/use-call-stream";

type Intervention = TowerCall["interventions"][number];

type Entry =
  | { type: "line"; key: string; at: number; line: StreamLine }
  | { type: "tool"; key: string; at: number; name: string }
  | { type: "operator"; key: string; at: number; kind: Intervention["kind"]; text: string; sent: SentIntervention | null };

function operatorText(kind: Intervention["kind"], message: string | null, loadId: string | null, amountUsd: number | null): string {
  switch (kind) {
    case "whisper":
      return `You whispered: ${message ?? ""}`;
    case "authorization":
      return `You authorized +${amountUsd === null ? "" : formatUsd(amountUsd)}${loadId ? ` on ${loadId}` : ""}`;
    case "listen":
      return "You started listening";
    case "takeover":
      return "You took over";
  }
}

// A recorded intervention and the one this browser sent are the same event; pair them so it shows once,
// with the delivery state attached. The record lands within seconds of the send, never before it.
const pairingWindowMs = 60_000;

function matches(record: Intervention, sent: SentIntervention): boolean {
  if (record.kind !== sent.kind) return false;
  const gap = Date.parse(record.createdAt) - Date.parse(sent.sentAt);
  if (gap < -pairingWindowMs || gap > pairingWindowMs) return false;
  return sent.kind === "whisper"
    ? record.message === sent.message
    : record.loadId === sent.loadId && record.amountUsd === sent.amountUsd;
}

function buildTimeline(stream: CallStream, interventions: Intervention[], sent: SentIntervention[]): Entry[] {
  const entries: Entry[] = [];
  for (const line of stream.lines) entries.push({ type: "line", key: `l-${line.id}`, at: Date.parse(line.at), line });
  for (const tool of stream.tools) {
    entries.push({ type: "tool", key: `t-${tool.name}-${tool.at}`, at: Date.parse(tool.at), name: tool.name });
  }
  const unpaired = [...sent];
  for (const record of interventions) {
    const index = unpaired.findIndex((item) => matches(record, item));
    const pair = index === -1 ? null : (unpaired.splice(index, 1)[0] ?? null);
    entries.push({
      type: "operator",
      key: pair ? `s-${pair.id}` : `i-${record.kind}-${record.createdAt}`,
      at: Date.parse(record.createdAt),
      kind: record.kind,
      text: operatorText(record.kind, record.message, record.loadId, record.amountUsd),
      sent: pair,
    });
  }
  // Sent but not yet on the wall: shown at the moment the operator pressed send.
  for (const item of unpaired) {
    entries.push({
      type: "operator",
      key: `s-${item.id}`,
      at: Date.parse(item.sentAt),
      kind: item.kind,
      text: operatorText(item.kind, item.message, item.loadId, item.amountUsd),
      sent: item,
    });
  }
  return entries.sort((a, b) => a.at - b.at);
}

const operatorIcon = { whisper: LuMessageCircleMore, authorization: LuDollarSign, listen: LuEar, takeover: LuMic };

// Publishing a signal takes about eleven seconds; the bar fills over that time so the wait reads as expected.
const expectedDeliveryS = 11;

function Delivery({ sent }: { sent: SentIntervention }) {
  const reduce = useReducedMotion();
  switch (sent.state) {
    case "sending":
    case "sent":
      return (
        <span className="flex items-center gap-2 text-[11px] text-fg-muted">
          <span className="relative h-0.5 w-20 overflow-hidden rounded-full bg-line" aria-hidden>
            <motion.span
              className="absolute inset-y-0 left-0 rounded-full bg-accent"
              initial={reduce ? false : { width: "4%" }}
              animate={{ width: reduce ? "60%" : "92%" }}
              transition={{ duration: expectedDeliveryS, ease: "easeOut" }}
            />
          </span>
          Sending...
        </span>
      );
    case "delivered":
      return (
        <span className="flex items-center gap-1 text-[11px] text-fg-muted">
          <LuCheck size={11} aria-hidden />
          Delivered
        </span>
      );
    case "not_delivered":
      return <span className="text-[11px] text-warn">Recorded, not delivered</span>;
    case "failed":
      return <span className="text-[11px] text-risk">{sent.error ?? "Not sent"}</span>;
  }
}

// Icons for the agent's tools, keyed like toolLabel; unknown tools get a wrench.
const toolIcons: Record<string, IconType> = {
  verify_carrier: LuShieldCheck,
  send_otp: LuKeyRound,
  check_otp: LuKeyRound,
  search_loads: LuSearch,
  evaluate_offer: LuCalculator,
  create_hold: LuLock,
  request_human: LuHand,
  hangup: LuPhoneOff,
  get_trip_estimate: LuRoute,
  hold_notice: LuMail,
};

const avatar = "flex size-8 shrink-0 items-center justify-center rounded-full";

function EntryRow({ entry }: { entry: Entry }) {
  if (entry.type === "tool") {
    const Icon = toolIcons[toolKey(entry.name)] ?? LuWrench;
    const label = toolLabel(entry.name);
    return (
      <div className="flex justify-center">
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] text-fg-muted"
          title={`${entry.name} at ${formatClock(entry.at, true)}`}
        >
          <Icon size={12} className="shrink-0 text-fg-faint" aria-hidden />
          {label}
        </span>
      </div>
    );
  }
  if (entry.type === "operator") {
    const Icon = operatorIcon[entry.kind];
    return (
      <div className="flex flex-col gap-1 rounded-[var(--radius-panel)] border border-line-strong bg-panel px-2.5 py-1.5">
        <span className="flex items-start gap-2 text-xs text-fg">
          <Icon size={13} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
          <span className="min-w-0 flex-1">{entry.text}</span>
          <span className="tabular shrink-0 text-[10px] text-fg-faint">{formatClock(entry.at, true)}</span>
        </span>
        {entry.sent && (
          <span className="pl-5">
            <Delivery sent={entry.sent} />
          </span>
        )}
      </div>
    );
  }
  // The cortex chat: the carrier on the left in a white bubble, the agent on the right in accent.
  const agent = entry.line.role === "agent";
  return (
    <div className={`flex ${agent ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[75%] min-w-0 items-end gap-2 ${agent ? "flex-row-reverse" : ""}`}>
        {agent ? (
          <span className={`${avatar} bg-accent text-white shadow-md`} aria-hidden>
            <LuBot size={16} />
          </span>
        ) : (
          <span className={`${avatar} border border-line bg-panel text-fg-muted shadow-md`} aria-hidden>
            <LuUser size={16} />
          </span>
        )}
        <p
          className={`min-w-0 rounded-2xl px-4 py-2.5 text-sm leading-snug break-words ${
            agent ? "rounded-br-md bg-accent text-white" : "rounded-bl-md border border-line bg-panel text-fg shadow-md"
          }`}
          title={formatClock(entry.at, true)}
        >
          <span className="sr-only">{agent ? "Agent: " : "Carrier: "}</span>
          {entry.line.text}
        </p>
      </div>
    </div>
  );
}

function Quiet({ title, hint }: { title: string; hint?: string }) {
  return <EmptyState className="h-full" icon={<LuAudioWaveform size={20} />} title={title} hint={hint} />;
}

const stickThresholdPx = 32;

export function Transcript({
  streamId,
  stream,
  interventions,
  sent,
}: {
  streamId: string | null;
  stream: CallStream;
  interventions: Intervention[];
  sent: SentIntervention[];
}) {
  const reduce = useReducedMotion();
  const scroller = useRef<HTMLDivElement>(null);
  // Follows the newest line until the operator scrolls up to read; then a pill brings them back.
  const [following, setFollowing] = useState(true);
  const entries = buildTimeline(stream, interventions, sent);
  const lastKey = entries.at(-1)?.key;

  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && following) node.scrollTop = node.scrollHeight;
  }, [lastKey, entries.length, following, stream.status]);

  function onScroll() {
    const node = scroller.current;
    if (!node) return;
    setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < stickThresholdPx);
  }

  function jumpToLive() {
    const node = scroller.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: reduce ? "auto" : "smooth" });
    setFollowing(true);
  }

  if (streamId === null && entries.length === 0) {
    return <Quiet title="No transcript for this call" hint="The call has no live session to follow" />;
  }
  if (entries.length === 0) {
    if (stream.status === "error") return <Quiet title="Transcript unavailable" hint="The live session could not be reached" />;
    if (stream.status === "ended") return <Quiet title="Call ended" hint="Nothing was said on this session" />;
    return <Quiet title="Waiting for the first words" />;
  }

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={scroller}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label="Transcript"
        className="h-full overflow-y-auto bg-bg px-4 py-4"
      >
        <ol className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {entries.map((entry) => (
              <motion.li
                key={entry.key}
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
              >
                <EntryRow entry={entry} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>
        {stream.status === "ended" && (
          <p className="mt-3 flex items-center gap-2 text-[11px] uppercase tracking-wide text-fg-faint">
            <span className="h-px flex-1 bg-line" />
            Call ended
            <span className="h-px flex-1 bg-line" />
          </p>
        )}
        {stream.status === "error" && (
          <p className="mt-3 text-center text-[11px] text-warn">Live transcript unavailable; showing what arrived</p>
        )}
      </div>
      {!following && (
        <button
          type="button"
          onClick={jumpToLive}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-accent px-3 py-1 text-xs font-medium text-white shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-fg"
        >
          <LuArrowDown size={12} aria-hidden />
          {stream.status === "ended" ? "Jump to end" : "Jump to live"}
        </button>
      )}
    </div>
  );
}
