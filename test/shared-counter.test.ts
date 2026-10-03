import { describe, expect, it } from "vitest";
import { SharedCounter, type HitStore } from "../src/infra/shared-counter.ts";
import { rateLimitRoutes } from "../src/routes/rate-limits.ts";
import { buildServer } from "../src/server.ts";
import { testConfig } from "./test-config.ts";

// Twin as one Map that every instance writes to.
function fakeTwin() {
  const rows = new Map<string, number>();
  let writes = 0;
  const store: HitStore = async (key, windowStart, hits) => {
    writes += 1;
    const total = (rows.get(`${key}@${windowStart}`) ?? 0) + hits;
    rows.set(`${key}@${windowStart}`, total);
    return total;
  };
  return { store, writes: () => writes };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const now = () => 1_790_000_000_000;

describe("SharedCounter", () => {
  it("blocks on one instance once hits on others fill the window", async () => {
    const twin = fakeTwin();
    const a = new SharedCounter(twin.store, now, 0);
    const b = new SharedCounter(twin.store, now, 0);
    for (let i = 0; i < 4; i++) a.take("k", 5, 60_000);
    await flush();
    // B's first hit is the 5th in the window and learns the total from Twin; its next is the 6th.
    expect(b.take("k", 5, 60_000).count).toBeLessThanOrEqual(5);
    await flush();
    expect(b.take("k", 5, 60_000).count).toBe(6);
  });

  it("batches a burst into one write and stops counting toward Twin once over the limit", async () => {
    const twin = fakeTwin();
    const a = new SharedCounter(twin.store, now, 0);
    const b = new SharedCounter(twin.store, now, 0);
    for (let i = 0; i < 100; i++) a.take("k", 3, 60_000);
    await flush();
    expect(twin.writes()).toBe(1);
    // Only the 3 hits under the limit reached Twin, so another instance sees the window as full.
    expect(b.take("k", 3, 60_000).count).toBe(1);
    await flush();
    expect(b.take("k", 3, 60_000).count).toBe(5);
  });

  it("stamps a late flush with the window its hits belong to", async () => {
    let t = 1_790_000_000_000 - (1_790_000_000_000 % 60_000) + 59_000;
    const stamps: number[] = [];
    const a = new SharedCounter(async (_key, windowStart) => (stamps.push(windowStart), 1), () => t, 0);
    a.take("k", 5, 60_000);
    t += 2_000;
    await flush();
    expect(stamps).toEqual([(t - 61_000) / 1000]);
  });

  it("still enforces the limit on its own hits when Twin is down", () => {
    const a = new SharedCounter(() => Promise.reject(new Error("twin down")), now);
    for (let i = 0; i < 3; i++) a.take("k", 3, 60_000);
    expect(a.take("k", 3, 60_000).count).toBe(4);
  });

  it("starts a new window on the epoch boundary", () => {
    let t = 1_790_000_000_000 - (1_790_000_000_000 % 60_000);
    const a = new SharedCounter(() => Promise.reject(new Error("twin down")), () => t);
    a.take("k", 1, 60_000);
    expect(a.take("k", 1, 60_000).count).toBe(2);
    t += 60_000;
    expect(a.take("k", 1, 60_000).count).toBe(1);
  });

  it("waits for the shared total in takeExact and falls back to its own count", async () => {
    const twin = fakeTwin();
    const a = new SharedCounter(twin.store, now);
    a.take("k", 10, 60_000);
    // takeExact sends the batched hit with its own, so the total counts both without waiting for a flush.
    expect(await a.takeExact("k", 10, 60_000)).toBe(2);
    expect(await new SharedCounter(twin.store, now).takeExact("k", 10, 60_000)).toBe(3);
    expect(await new SharedCounter(() => Promise.reject(new Error("down")), now).takeExact("k", 10, 60_000)).toBe(1);
  });

  it("stops writing in takeExact once the window is over the limit", async () => {
    const twin = fakeTwin();
    const a = new SharedCounter(twin.store, now);
    let last = 0;
    for (let i = 0; i < 50; i++) last = await a.takeExact("k", 3, 60_000);
    expect(last).toBe(50);
    expect(twin.writes()).toBe(3);
  });
});

describe("POST /v1/operator/rate-limits/hit", () => {
  const twin = fakeTwin();
  const app = buildServer(testConfig, { agentRoutes: [], operatorRoutes: [rateLimitRoutes({ hits: twin.store })] });
  const hit = (payload: unknown) =>
    app.inject({ method: "POST", url: "/v1/operator/rate-limits/hit", headers: { "x-api-key": testConfig.OPERATOR_API_KEY }, payload: payload as object });

  it("counts the tower's hit and answers the total", async () => {
    expect((await hit({ key: "login:1.2.3.4", windowStartSeconds: 1_790_000_100, hits: 1 })).json()).toEqual({ hits: 1 });
    expect((await hit({ key: "login:1.2.3.4", windowStartSeconds: 1_790_000_100, hits: 3 })).json()).toEqual({ hits: 4 });
  });

  it("refuses a malformed hit", async () => {
    expect((await hit({ key: "", windowStartSeconds: -1, hits: 0 })).statusCode).toBe(400);
  });
});
