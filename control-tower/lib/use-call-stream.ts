"use client";

import { useEffect, useState } from "react";
import type { StreamLine, StreamSignal, StreamTool } from "@/lib/contracts";

export type StreamStatus = "idle" | "connecting" | "open" | "ended" | "error";

export type CallStream = {
  lines: StreamLine[];
  tools: StreamTool[];
  signals: StreamSignal[];
  status: StreamStatus;
};

const empty: CallStream = { lines: [], tools: [], signals: [], status: "idle" };

function parse<T>(event: MessageEvent<string>): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

// Follows /api/calls/<callId>/stream, live or ended. Every connect replays the session from the start, so a
// reconnect after a drop sends events already held; those are dropped by id (lines) or by name and time.
export function useCallStream(callId: string | null): CallStream {
  const [state, setState] = useState<CallStream>(empty);

  useEffect(() => {
    if (callId === null) {
      setState(empty);
      return;
    }
    setState({ ...empty, status: "connecting" });
    const source = new EventSource(`/api/calls/${encodeURIComponent(callId)}/stream`);

    source.onopen = () => setState((prev) => (prev.status === "ended" ? prev : { ...prev, status: "open" }));

    // Appends a parsed event to its list unless an equal one is already held.
    const follow = <K extends "lines" | "tools" | "signals">(
      name: string,
      key: K,
      same: (a: CallStream[K][number], b: CallStream[K][number]) => boolean,
    ) =>
      source.addEventListener(name, (event) => {
        const item = parse<CallStream[K][number]>(event);
        if (item === null) return;
        setState((prev) => {
          const list = prev[key] as CallStream[K][number][];
          return list.some((held) => same(held, item)) ? prev : { ...prev, [key]: [...list, item] };
        });
      });
    follow("line", "lines", (a, b) => a.id === b.id);
    follow("tool", "tools", (a, b) => a.name === b.name && a.at === b.at);
    follow("signal", "signals", (a, b) => a.at === b.at);

    // The session is over; closing stops the browser from reconnecting and replaying it again.
    source.addEventListener("ended", () => {
      source.close();
      setState((prev) => ({ ...prev, status: "ended" }));
    });

    // A non-stream answer (502, 404) closes the source for good; a dropped stream reconnects on its own.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setState((prev) => (prev.status === "ended" ? prev : { ...prev, status: "error" }));
      } else {
        setState((prev) => (prev.status === "ended" ? prev : { ...prev, status: "connecting" }));
      }
    };

    return () => source.close();
  }, [callId]);

  return state;
}
