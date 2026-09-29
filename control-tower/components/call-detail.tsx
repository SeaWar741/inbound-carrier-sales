"use client";

import { LuMessageSquareText, LuPhone } from "react-icons/lu";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityChips } from "@/components/activity-chips";
import { InterventionBar, type SentIntervention } from "@/components/intervention-bar";
import { PulseDot } from "@/components/pulse-dot";
import { StageRail } from "@/components/stage-rail";
import { Transcript } from "@/components/transcript";
import type { ErrorResponse, InterventionBody, InterventionResponse, TowerCall } from "@/lib/contracts";
import { carrierId, carrierState, formatClock, formatElapsed } from "@/lib/format";
import { useCallStream } from "@/lib/use-call-stream";
import { useVoice } from "@/lib/use-voice";

// Whispers and authorizations this browser sent, with delivery tracked from the stream's signal events.
function useSentInterventions(callId: string, hasSession: boolean, signalCount: number) {
  const [sent, setSent] = useState<SentIntervention[]>([]);
  const seenSignals = useRef(signalCount);

  // Each new signal on the stream is the agent receiving the oldest message still in flight.
  useEffect(() => {
    const arrived = signalCount - seenSignals.current;
    seenSignals.current = signalCount;
    if (arrived <= 0) return;
    setSent((prev) => {
      let left = arrived;
      return prev.map((item) => {
        if (left > 0 && (item.state === "sending" || item.state === "sent")) {
          left--;
          return { ...item, state: "delivered" };
        }
        return item;
      });
    });
  }, [signalCount]);

  const send = useCallback(
    async (body: InterventionBody, draft: Omit<SentIntervention, "id" | "sentAt" | "state">) => {
      const id = crypto.randomUUID();
      setSent((prev) => [...prev, { ...draft, id, sentAt: new Date().toISOString(), state: "sending" }]);
      const settle = (next: Pick<SentIntervention, "state" | "error">) =>
        setSent((prev) =>
          prev.map((item) =>
            // A signal can beat the HTTP answer; a delivered message never goes back to pending.
            item.id === id && item.state !== "delivered" ? { ...item, ...next } : item,
          ),
        );
      try {
        const res = await fetch(`/api/calls/${encodeURIComponent(callId)}/interventions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!res.ok) {
          const answer = (await res.json().catch(() => null)) as ErrorResponse | null;
          settle({ state: "failed", error: answer?.message ?? `Not sent (${res.status})` });
          return;
        }
        const answer = (await res.json()) as InterventionResponse;
        settle({ state: answer.status === "sent" ? "sent" : "not_delivered" });
      } catch {
        settle({ state: "failed", error: "Could not reach the tower" });
      }
    },
    [callId],
  );

  const whisper = useCallback(
    (message: string) => {
      if (!hasSession) return;
      void send({ kind: "whisper", message }, { kind: "whisper", message, loadId: null, amountUsd: null });
    },
    [send, hasSession],
  );

  const authorize = useCallback(
    (loadId: string, amountUsd: number) => {
      if (!hasSession) return;
      void send(
        { kind: "authorization", loadId, amountUsd },
        { kind: "authorization", message: null, loadId, amountUsd },
      );
    },
    [send, hasSession],
  );

  return { sent, whisper, authorize };
}

export function CallDetail({
  call,
  now,
  onTakeoverChange,
}: {
  call: TowerCall;
  now: number;
  onTakeoverChange: (callId: string | null) => void;
}) {
  // The transcript is looked up by call, so it stays readable after the call ends.
  const stream = useCallStream(call.callId);
  const voice = useVoice(call.callId, call.sessionId !== null);
  const { sent, whisper, authorize } = useSentInterventions(call.callId, call.sessionId !== null, stream.signals.length);
  const state = carrierState(call);
  const ChannelIcon = call.channel === "text" ? LuMessageSquareText : LuPhone;
  const takenOver = voice.mode === "takeover";

  useEffect(() => {
    onTakeoverChange(takenOver ? call.callId : null);
  }, [takenOver, call.callId, onTakeoverChange]);
  useEffect(() => () => onTakeoverChange(null), [onTakeoverChange]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2">
        <h2 className="tabular text-sm font-semibold text-fg">{carrierId(call)}</h2>
        {call.mcNumber && call.dotNumber && <span className="tabular text-xs text-fg-faint">DOT {call.dotNumber}</span>}
        {state && <span className={`text-xs ${state.tone}`}>{state.text}</span>}
        <span className="ml-auto flex items-center gap-3">
          {call.channel && (
            <span className="flex items-center gap-1 text-xs text-fg-muted">
              <ChannelIcon size={13} aria-hidden />
              {call.channel === "text" ? "Text" : "Voice"}
            </span>
          )}
          {call.live ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-accent">
              <PulseDot tone="accent" />
              Live
            </span>
          ) : <span className="text-xs text-fg-faint">Not live</span>}
          <span className="tabular text-xs text-fg-muted" title={`Started ${formatClock(call.createdAt, true)}`}>
            {call.live ? formatElapsed(now - Date.parse(call.createdAt)) : formatClock(call.createdAt)}
          </span>
        </span>
      </header>

      <div className="flex flex-col gap-3 border-b border-line px-3 py-3">
        <StageRail call={call} />
        <ActivityChips events={call.events} />
      </div>

      <div className="min-h-0 flex-1">
        <Transcript streamId={call.callId} stream={stream} interventions={call.interventions} sent={sent} />
      </div>

      <InterventionBar call={call} voice={voice} onWhisper={whisper} onAuthorize={authorize} />
    </div>
  );
}
