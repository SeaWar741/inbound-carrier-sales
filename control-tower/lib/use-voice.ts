"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ErrorResponse, VoiceTokenBody, VoiceTokenResponse } from "@/lib/contracts";

export type VoiceMode = "idle" | "listening" | "takeover";

export type Voice = {
  mode: VoiceMode;
  // Which join is in flight, so the bar can show progress on the right button.
  pending: "listen" | "takeover" | null;
  error: string | null;
  listen: () => Promise<void>;
  takeOver: () => Promise<void>;
  stop: () => Promise<void>;
};

type Connection = { disconnect: () => Promise<void> };

async function fetchToken(callId: string, body: VoiceTokenBody): Promise<VoiceTokenResponse> {
  const res = await fetch(`/api/calls/${encodeURIComponent(callId)}/voice-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.assign("/login");
    throw new Error("Your session expired");
  }
  if (!res.ok) {
    const answer = (await res.json().catch(() => null)) as ErrorResponse | null;
    throw new Error(answer?.message ?? `Could not join the call (${res.status})`);
  }
  return (await res.json()) as VoiceTokenResponse;
}

function describe(err: unknown): string {
  if (err instanceof DOMException && err.name === "NotAllowedError") return "Microphone access was blocked";
  if (err instanceof DOMException && err.name === "NotFoundError") return "No microphone found";
  return err instanceof Error && err.message ? err.message : "Could not join the call";
}

// Owns the operator's LiveKit connection to one call: listen silently, then take over with the mic.
// A new call or unmount disconnects whatever is open. The tower resolves the call's session itself;
// hasSession only says whether one exists yet.
export function useVoice(callId: string, hasSession: boolean): Voice {
  const [mode, setMode] = useState<VoiceMode>("idle");
  const [pending, setPending] = useState<Voice["pending"]>(null);
  const [error, setError] = useState<string | null>(null);
  const connection = useRef<Connection | null>(null);
  // Bumped on every call change so a join that resolves late for an old call is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setMode("idle");
    setPending(null);
    setError(null);
    return () => {
      if (generation.current === current) generation.current++;
      const open = connection.current;
      connection.current = null;
      void open?.disconnect().catch(() => undefined);
    };
  }, [callId, hasSession]);

  // The room closing on its own (call ended, network gone) returns the bar to idle.
  const onDropped = useCallback((dropped: () => Connection | null) => {
    if (connection.current !== null && connection.current === dropped()) {
      connection.current = null;
      setMode("idle");
    }
  }, []);

  // Listening joins silently; taking over joins with the mic. A second listen while connected is ignored.
  const join = useCallback(
    async (kind: "listen" | "takeover") => {
      if (!hasSession || (kind === "listen" && connection.current !== null)) return;
      const current = generation.current;
      setPending(kind);
      setError(null);
      try {
        const token = await fetchToken(callId, { mode: kind });
        const { HappyRobotVoiceClient } = await import("@happyrobot-ai/sdk/voice");
        const client = new HappyRobotVoiceClient({ url: token.url, token: token.token });
        let self: Connection | null = null;
        const options = { onDisconnected: () => onDropped(() => self) };
        // The listener stays typed as such so startAudio is checked by the compiler.
        const listener = kind === "listen" ? await client.listen(options) : null;
        const joined = listener ?? (await client.connect(options));
        self = joined;
        if (generation.current !== current) {
          await joined.disconnect();
          return;
        }
        if (kind === "listen") {
          // Browsers only start audio from a user gesture; this still runs inside the click that asked to listen.
          await listener?.startAudio().catch(() => undefined);
          connection.current = joined;
          setMode("listening");
        } else {
          // The speaking connection hears the call too, so the silent listener is closed to avoid double audio.
          const previous = connection.current;
          connection.current = joined;
          await previous?.disconnect().catch(() => undefined);
          setMode("takeover");
        }
      } catch (err) {
        if (generation.current === current) setError(describe(err));
      } finally {
        if (generation.current === current) setPending(null);
      }
    },
    [callId, hasSession, onDropped],
  );
  const listen = useCallback(() => join("listen"), [join]);
  const takeOver = useCallback(() => join("takeover"), [join]);

  const stop = useCallback(async () => {
    const open = connection.current;
    connection.current = null;
    setMode("idle");
    await open?.disconnect().catch(() => undefined);
  }, []);

  return { mode, pending, error, listen, takeOver, stop };
}
