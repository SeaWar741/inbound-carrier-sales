import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SharedCounter } from "./shared-counter.ts";

const now = () => 1_790_000_000_000;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SharedCounter", () => {
  it("blocks once the shared total passes the limit", async () => {
    const rows = new Map<string, number>();
    let writes = 0;
    const store = async (key: string, _windowStart: number, hits: number) => {
      writes += 1;
      rows.set(key, (rows.get(key) ?? 0) + hits);
      return rows.get(key)!;
    };
    const a = new SharedCounter(store, now, 0);
    const b = new SharedCounter(store, now, 0);
    for (let i = 0; i < 3; i++) a.take("k", 4, 60_000);
    await flush();
    assert.equal(writes, 1);
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
