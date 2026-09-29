"use client";

import { useEffect, useState } from "react";
import type { TowerWall } from "@/lib/contracts";

const pollMs = 1_000;

export type WallState = {
  wall: TowerWall | null;
  error: string | null;
  loading: boolean;
  // When the shown wall was fetched; used to tell the operator how stale it is after an error.
  updatedAt: number | null;
};

// Polls /api/wall once a second while the tab is visible. A failed poll keeps the last good wall.
export function useWall(): WallState {
  const [state, setState] = useState<WallState>({ wall: null, error: null, loading: true, updatedAt: null });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let stopped = false;

    async function poll() {
      clearTimeout(timer);
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const res = await fetch("/api/wall", { cache: "no-store", signal: current.signal });
        if (res.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!res.ok) throw new Error(`The wall answered ${res.status}`);
        const wall = (await res.json()) as TowerWall;
        setState({ wall, error: null, loading: false, updatedAt: Date.now() });
      } catch (err) {
        if (current.signal.aborted) return;
        const message = err instanceof Error && err.message.startsWith("The wall") ? err.message : "Could not reach the wall";
        setState((prev) => ({ ...prev, error: message, loading: false }));
      }
      // Chain the next poll after this one settles, so slow answers never pile up.
      if (!stopped && controller === current && document.visibilityState === "visible") {
        timer = setTimeout(poll, pollMs);
      }
    }

    function onVisibility() {
      if (document.visibilityState === "visible") {
        void poll();
      } else {
        clearTimeout(timer);
        controller?.abort();
      }
    }

    // The first load always runs so a tab opened in the background is not blank; only the
    // repeat polling waits for visibility.
    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return state;
}
