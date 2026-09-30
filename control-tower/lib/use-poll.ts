"use client";

import { useEffect, useEffectEvent, useState } from "react";

export type PollState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  // When the shown data was fetched; used to tell the operator how stale it is after an error.
  updatedAt: number | null;
};

// A 401 already sent the operator to the login page; the poll stops quietly.
class SignedOut extends Error {}

// GETs a tower route as JSON. `name` words the errors ("The wall answered 503").
export async function fetchTower<T>(url: string, signal: AbortSignal, name: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store", signal });
  if (res.status === 401) {
    window.location.assign("/login");
    throw new SignedOut();
  }
  if (!res.ok) throw new Error(`The ${name} answered ${res.status}`);
  return (await res.json()) as T;
}

// Polls a tower route every `intervalMs` while the tab is visible. A failed poll keeps the last good
// answer; a 401 sends the operator to the login page. `name` words the errors ("The wall answered 503").
export function usePoll<T>(url: string, intervalMs: number, name: string): PollState<T> {
  return usePollWith<T>(url, (signal) => fetchTower<T>(url, signal, name), intervalMs, name);
}

// usePoll over any loader: `key` names what `load` reads, and a new key polls again at once.
export function usePollWith<T>(key: string, load: (signal: AbortSignal) => Promise<T>, intervalMs: number, name: string): PollState<T> {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, loading: true, updatedAt: null });
  // Always the latest render's loader; the key, not the function identity, decides when to restart.
  const loadLatest = useEffectEvent(load);

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
        const data = await loadLatest(current.signal);
        setState({ data, error: null, loading: false, updatedAt: Date.now() });
      } catch (err) {
        if (current.signal.aborted || err instanceof SignedOut) return;
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
  }, [key, intervalMs, name]);

  return state;
}
