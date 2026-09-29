"use client";

import { useEffect, useState } from "react";

export type PollState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  // When the shown data was fetched; used to tell the operator how stale it is after an error.
  updatedAt: number | null;
};

// Polls a tower route every `intervalMs` while the tab is visible. A failed poll keeps the last good
// answer; a 401 sends the operator to the login page. `name` words the errors ("The wall answered 503").
export function usePoll<T>(url: string, intervalMs: number, name: string): PollState<T> {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, loading: true, updatedAt: null });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let stopped = false;
    const answered = `The ${name} answered`;

    async function poll() {
      clearTimeout(timer);
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const res = await fetch(url, { cache: "no-store", signal: current.signal });
        if (res.status === 401) {
          window.location.assign("/login");
          return;
        }
        if (!res.ok) throw new Error(`${answered} ${res.status}`);
        const data = (await res.json()) as T;
        setState({ data, error: null, loading: false, updatedAt: Date.now() });
      } catch (err) {
        if (current.signal.aborted) return;
        const message = err instanceof Error && err.message.startsWith(answered) ? err.message : `Could not reach the ${name}`;
        setState((prev) => ({ ...prev, error: message, loading: false }));
      }
      // Chain the next poll after this one settles, so slow answers never pile up.
      if (!stopped && controller === current && document.visibilityState === "visible") {
        timer = setTimeout(poll, intervalMs);
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
  }, [url, intervalMs, name]);

  return state;
}
