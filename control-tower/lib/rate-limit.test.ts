import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixedWindow, redisStore } from "./rate-limit.ts";

describe("fixedWindow", () => {
  it("blocks a client at its limit and frees it once the window passes", async () => {
    let now = 1_790_000_000_000;
    const limit = fixedWindow("t1", 2, 1_000, () => now);
    assert.equal(await limit.take("a"), false);
    assert.equal(await limit.take("a"), false);
    assert.equal(await limit.take("a"), true);
    assert.equal(await limit.take("b"), false);
    now += 1_000;
    assert.equal(await limit.take("a"), false);
  });

  it("counts only what is recorded", async () => {
    const limit = fixedWindow("t2", 1, 1_000);
    assert.equal(await limit.blocked("a"), false);
    await limit.record("a");
    assert.equal(await limit.blocked("a"), true);
  });
});

describe("redisStore", () => {
  it("sets the expiry only on the first hit of a window", async () => {
    const calls: unknown[][] = [];
    const counts = new Map<string, number>();
    const fake = {
      multi() {
        const ops: (() => [null, number])[] = [];
        const chain = {
          incr(key: string) {
            ops.push(() => {
              const n = (counts.get(key) ?? 0) + 1;
              counts.set(key, n);
              return [null, n];
            });
            return chain;
          },
          pexpire(...args: unknown[]) {
            calls.push(args);
            ops.push(() => [null, 1]);
            return chain;
          },
          exec: async () => ops.map((op) => op()),
        };
        return chain;
      },
      get: async (key: string) => String(counts.get(key) ?? 0),
    };
    const store = redisStore(fake as never);
    assert.equal(await store.incr("k", 60_000, 0), 1);
    assert.equal(await store.incr("k", 60_000, 0), 2);
    assert.equal(await store.get("k", 0), 2);
    assert.deepEqual(calls[0], ["k", 60_000, "NX"]);
  });
});
