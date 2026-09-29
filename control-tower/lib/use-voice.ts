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
// A new call or unmount disconnects whatever is open.
export function useVoice(callId: string, sessionId: string | null): Voice {
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
  }, [callId, sessionId]);

  // The room closing on its own (call ended, network gone) returns the bar to idle.
  const onDropped = useCallback((dropped: () => Connection | null) => {
    if (connection.current !== null && connection.current === dropped()) {
      connection.current = null;
      setMode("idle");
    }
  }, []);

  const listen = useCallback(async () => {
    if (sessionId === null || connection.current !== null) return;
    const current = generation.current;
    setPending("listen");
    setError(null);
    try {
      const token = await fetchToken(callId, { mode: "listen", sessionId });
      const { HappyRobotVoiceClient } = await import("@happyrobot-ai/sdk/voice");
      let self: Connection | null = null;
      const listener = await new HappyRobotVoiceClient({ url: token.url, token: token.token }).listen({
        onDisconnected: () => onDropped(() => self),
      });
      self = listener;
      if (generation.current !== current) {
        await listener.disconnect();
        return;
      }
      // Browsers only start audio from a user gesture; this still runs inside the click that asked to listen.
      await listener.startAudio().catch(() => undefined);
      connection.current = listener;
      setMode("listening");
    } catch (err) {
      if (generation.current === current) setError(describe(err));
    } finally {
      if (generation.current === current) setPending(null);
    }
  }, [callId, sessionId, onDropped]);

  const takeOver = useCallback(async () => {
    if (sessionId === null) return;
    const current = generation.current;
    setPending("takeover");
    setError(null);
    try {
      const token = await fetchToken(callId, { mode: "takeover", sessionId });
      const { HappyRobotVoiceClient } = await import("@happyrobot-ai/sdk/voice");
      let self: Connection | null = null;
      const speaker = await new HappyRobotVoiceClient({ url: token.url, token: token.token }).connect({
        onDisconnected: () => onDropped(() => self),
      });
      self = speaker;
      if (generation.current !== current) {
        await speaker.disconnect();
        return;
      }
      // The speaking connection hears the call too, so the silent listener is closed to avoid double audio.
      const listener = connection.current;
      connection.current = speaker;
      await listener?.disconnect().catch(() => undefined);
      setMode("takeover");
    } catch (err) {
      if (generation.current === current) setError(describe(err));
    } finally {
      if (generation.current === current) setPending(null);
    }
  }, [callId, sessionId, onDropped]);

  const stop = useCallback(async () => {
    const open = connection.current;
    connection.current = null;
    setMode("idle");
    await open?.disconnect().catch(() => undefined);
  }, []);

  return { mode, pending, error, listen, takeOver, stop };
}
