"use client";

import { LuEar, LuEarOff, LuMic, LuPhoneOff, LuSendHorizontal, LuTriangleAlert } from "react-icons/lu";
import { useState } from "react";
import type { TowerCall } from "@/lib/contracts";
import type { Voice } from "@/lib/use-voice";

// One whisper or authorization this browser sent, tracked until the agent receives it.
// "sent" means the tower published it and the stream has not yet shown the agent receiving it.
export type SentIntervention = {
  id: string;
  kind: "whisper" | "authorization";
  message: string | null;
  loadId: string | null;
  amountUsd: number | null;
  sentAt: string;
  state: "sending" | "sent" | "delivered" | "not_delivered" | "failed";
  error?: string;
};

const authorizationUsd = 50;

const quickWhispers = [
  { label: "Offer quick pay", message: "Offer quick pay if it helps close." },
  { label: "Offer the backhaul", message: "Mention we may have a backhaul out of their destination; a senior rep will follow up." },
  { label: "Close it kindly", message: "Wrap up politely and end the call." },
] as const;

const pill =
  "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40";
const pillQuiet = `${pill} border-line-strong bg-panel-raised text-fg hover:border-fg-faint disabled:hover:border-line-strong`;

export function InterventionBar({
  call,
  voice,
  onWhisper,
  onAuthorize,
}: {
  call: TowerCall;
  voice: Voice;
  onWhisper: (message: string) => void;
  onAuthorize: (loadId: string, amountUsd: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const loadId = call.offers.at(-1)?.loadId ?? null;
  const onCall = voice.mode === "takeover";

  // Why nothing can be sent right now, or null when the call accepts interventions.
  const blocked = !call.live
    ? "The call is not live"
    : call.sessionId === null
      ? "Waiting for the live session"
      : onCall
        ? "You are on the call"
        : null;
  const listenBlocked = !call.live
    ? "The call is not live"
    : call.sessionId === null
      ? "Waiting for the live session"
      : call.channel !== "voice"
        ? "Text session"
        : null;

  function sendDraft() {
    const message = draft.trim();
    if (!message || blocked) return;
    onWhisper(message);
    setDraft("");
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line bg-panel px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {onCall ? (
          <>
            <span className="flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-xs font-medium text-white">
              <LuMic size={12} aria-hidden />
              You are on the call
            </span>
            <button
              type="button"
              onClick={() => void voice.stop()}
              className={pillQuiet}
            >
              <LuPhoneOff size={13} aria-hidden />
              Hang up
            </button>
          </>
        ) : (
          <>
            {voice.mode === "listening" ? (
              <button type="button" onClick={() => void voice.stop()} className={`${pill} border-accent/60 bg-accent-soft text-accent`}>
                <LuEarOff size={13} aria-hidden />
                Stop listening
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void voice.listen()}
                disabled={listenBlocked !== null || voice.pending !== null}
                title={listenBlocked ?? undefined}
                className={pillQuiet}
              >
                <LuEar size={13} aria-hidden />
                {voice.pending === "listen" ? "Joining..." : "Listen"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void voice.takeOver()}
              disabled={voice.mode !== "listening" || voice.pending !== null}
              title={voice.mode === "listening" ? "Speak to the carrier yourself" : "Listen first"}
              className={pillQuiet}
            >
              <LuMic size={13} aria-hidden />
              {voice.pending === "takeover" ? "Taking over..." : "Take over"}
            </button>
            {listenBlocked && <span className="text-xs text-fg-faint">{listenBlocked}</span>}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {quickWhispers.map((quick) => (
          <button
            key={quick.label}
            type="button"
            disabled={blocked !== null}
            onClick={() => onWhisper(quick.message)}
            title={blocked ?? quick.message}
            className={pillQuiet}
          >
            {quick.label}
          </button>
        ))}
        <button
          type="button"
          disabled={blocked !== null || loadId === null}
          onClick={() => loadId && onAuthorize(loadId, authorizationUsd)}
          title={blocked ?? (loadId ? `Allow $${authorizationUsd} more on ${loadId}` : "No offer yet")}
          className={pillQuiet}
        >
          Authorize <span className="tabular">+${authorizationUsd}</span>
        </button>
      </div>

      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          sendDraft();
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={blocked !== null}
          maxLength={500}
          placeholder={blocked ?? "Whisper to the agent, Enter sends"}
          aria-label="Whisper to the agent"
          className="h-8 min-w-0 flex-1 rounded-[var(--radius-panel)] border border-line-strong bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-faint focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={blocked !== null || draft.trim() === ""}
          aria-label="Send whisper"
          className="grid size-8 place-items-center rounded-[var(--radius-panel)] bg-accent text-white outline-none focus-visible:ring-2 focus-visible:ring-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          <LuSendHorizontal size={14} aria-hidden />
        </button>
      </form>

      {voice.error && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-risk">
          <LuTriangleAlert size={12} aria-hidden />
          {voice.error}
        </p>
      )}
    </div>
  );
}
