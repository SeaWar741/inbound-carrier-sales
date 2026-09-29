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

    source.addEventListener("line", (event) => {
      const line = parse<StreamLine>(event);
      if (line === null) return;
      setState((prev) => (prev.lines.some((held) => held.id === line.id) ? prev : { ...prev, lines: [...prev.lines, line] }));
    });

    source.addEventListener("tool", (event) => {
      const tool = parse<StreamTool>(event);
      if (tool === null) return;
      setState((prev) =>
        prev.tools.some((held) => held.name === tool.name && held.at === tool.at) ? prev : { ...prev, tools: [...prev.tools, tool] },
      );
    });

    source.addEventListener("signal", (event) => {
      const signal = parse<StreamSignal>(event);
      if (signal === null) return;
      setState((prev) =>
        prev.signals.some((held) => held.at === signal.at) ? prev : { ...prev, signals: [...prev.signals, signal] },
      );
    });

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
