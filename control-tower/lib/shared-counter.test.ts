import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SharedCounter } from "./shared-counter.ts";

const now = () => 1_790_000_000_000;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SharedCounter", () => {
  it("blocks once the shared total passes the limit", async () => {
    const rows = new Map<string, number>();
    const store = async (key: string) => {
      rows.set(key, (rows.get(key) ?? 0) + 1);
      return rows.get(key)!;
    };
    const a = new SharedCounter(store, now);
    const b = new SharedCounter(store, now);
    for (let i = 0; i < 3; i++) a.take("k", 4, 60_000);
    await flush();
    assert.ok(b.take("k", 4, 60_000).count <= 4);
    await flush();
    assert.equal(b.take("k", 4, 60_000).count, 5);
  });

  it("enforces its own hits when the store is down, and takeExact falls back to them", async () => {
    const a = new SharedCounter(() => Promise.reject(new Error("down")), now);
    for (let i = 0; i < 2; i++) a.take("k", 2, 60_000);
    assert.equal(a.take("k", 2, 60_000).count, 3);
    assert.equal(await a.takeExact("j", 5, 60_000), 1);
  });
});
