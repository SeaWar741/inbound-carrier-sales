// Fixed-window counters keyed by client. ponytail: in-memory, right for one tower instance; a shared
// store (Redis) if the tower ever runs more than one.
export function fixedWindow(limit: number, windowMs: number) {
  const windows = new Map<string, { start: number; count: number }>();
  const current = (key: string, now: number) => {
    const window = windows.get(key);
    if (window && now - window.start < windowMs) return window;
    // Expired windows go whenever one is opened, so the map holds one window of clients at most.
    for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
    const fresh = { start: now, count: 0 };
    windows.set(key, fresh);
    return fresh;
  };
  return {
    blocked: (key: string, now = Date.now()) => current(key, now).count >= limit,
    record: (key: string, now = Date.now()) => void (current(key, now).count += 1),
    // Records the hit and answers whether it went over the limit.
    take: (key: string, now = Date.now()) => ++current(key, now).count > limit,
  };
}

// The client address as Render reports it. A forged X-Forwarded-For only buys a fresh per-client
// window, so every limit that guards a secret has a total cap as well.
export const clientOf = (headers: Headers) => headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
