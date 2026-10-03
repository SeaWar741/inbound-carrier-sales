import { Redis } from "ioredis";

// Fixed-window counters keyed by client. With REDIS_URL (Render Key Value) every tower instance counts
// together; without it, or while Redis is down, each instance counts in its own memory.

type Store = { incr(key: string, windowMs: number, now: number): Promise<number>; get(key: string, now: number): Promise<number> };

export function memoryStore(): Store {
  const windows = new Map<string, { start: number; count: number; windowMs: number }>();
  const current = (key: string, windowMs: number, now: number) => {
    const window = windows.get(key);
    if (window && now - window.start < window.windowMs) return window;
    // Expired windows go whenever one is opened, so the map holds one window of clients at most.
    for (const [k, w] of windows) if (now - w.start >= w.windowMs) windows.delete(k);
    const fresh = { start: now, count: 0, windowMs };
    windows.set(key, fresh);
    return fresh;
  };
  return {
    incr: async (key, windowMs, now) => ++current(key, windowMs, now).count,
    get: async (key, now) => {
      const window = windows.get(key);
      return window && now - window.start < window.windowMs ? window.count : 0;
    },
  };
}

// INCR plus an expiry set only on the first hit: the window starts with the first request in it.
export function redisStore(redis: Pick<Redis, "multi" | "get">): Store {
  return {
    incr: async (key, windowMs) => {
      const results = await redis.multi().incr(key).pexpire(key, windowMs, "NX").exec();
      const count = results?.[0]?.[1];
      if (typeof count !== "number") throw new Error("rate-limit: no INCR result");
      return count;
    },
    get: async (key) => Number((await redis.get(key)) ?? 0),
  };
}

const memory = memoryStore();
let shared: Store | null | undefined;
function sharedStore(): Store | null {
  if (shared === undefined) {
    const url = process.env.REDIS_URL;
    if (!url) return (shared = null);
    const redis = new Redis(url, { connectTimeout: 2_000, commandTimeout: 500, maxRetriesPerRequest: 1 });
    redis.on("error", () => undefined); // a down Redis falls back to memory below
    shared = redisStore(redis);
  }
  return shared;
}

// Shared store first, this instance's memory when there is none or it fails.
async function withStore<T>(run: (store: Store) => Promise<T>): Promise<T> {
  const store = sharedStore();
  if (store) {
    try {
      return await run(store);
    } catch {
      // fall through to memory
    }
  }
  return run(memory);
}

export function fixedWindow(name: string, limit: number, windowMs: number, now = () => Date.now()) {
  const key = (client: string) => `tower-rl:${name}:${client}`;
  return {
    blocked: async (client: string) => withStore(async (s) => (await s.get(key(client), now())) >= limit),
    record: async (client: string) => void (await withStore((s) => s.incr(key(client), windowMs, now()))),
    // Records the hit and answers whether it went over the limit.
    take: async (client: string) => withStore(async (s) => (await s.incr(key(client), windowMs, now())) > limit),
  };
}

// The client address as Render reports it. A forged X-Forwarded-For only buys a fresh per-client
// window, so every limit that guards a secret has a total cap as well.
export const clientOf = (headers: Headers) => headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
