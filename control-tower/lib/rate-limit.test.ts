import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixedWindow } from "./rate-limit.ts";

const now = 1_790_000_000_000;

describe("fixedWindow", () => {
  it("blocks a client at its limit and frees it once the window passes", () => {
    const limit = fixedWindow(2, 1_000);
    assert.equal(limit.take("a", now), false);
    assert.equal(limit.take("a", now), false);
    assert.equal(limit.take("a", now), true);
    assert.equal(limit.take("b", now), false);
    assert.equal(limit.take("a", now + 1_000), false);
  });

  it("counts only what is recorded", () => {
    const limit = fixedWindow(1, 1_000);
    assert.equal(limit.blocked("a", now), false);
    limit.record("a", now);
    assert.equal(limit.blocked("a", now), true);
  });
});
