import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { carrierName, formatTimeAgo, groupCallsByLoad } from "./format.ts";

const call = (id: string, ...loadIds: string[]) => ({ id, offers: loadIds.map((loadId) => ({ loadId })) });

describe("groupCallsByLoad", () => {
  it("puts each call in the load of its latest offer", () => {
    const sections = groupCallsByLoad([call("c3", "LD2"), call("c2", "LD9", "LD1"), call("c1", "LD2")]);
    assert.deepEqual(
      sections.map((s) => [s.loadId, s.calls.map((c) => c.id)]),
      [
        ["LD2", ["c3", "c1"]],
        ["LD1", ["c2"]],
      ],
    );
  });

  it("collects calls without offers in one no-load section", () => {
    const sections = groupCallsByLoad([call("c3"), call("c2", "LD1"), call("c1")]);
    assert.deepEqual(
      sections.map((s) => [s.loadId, s.calls.map((c) => c.id)]),
      [
        [null, ["c3", "c1"]],
        ["LD1", ["c2"]],
      ],
    );
  });

  it("answers no sections for no calls", () => {
    assert.deepEqual(groupCallsByLoad([]), []);
  });
});

describe("formatTimeAgo", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  it("rounds down to minutes, hours and days", () => {
    assert.equal(formatTimeAgo("2026-09-29T11:59:30Z", now), "now");
    assert.equal(formatTimeAgo("2026-09-29T11:55:00Z", now), "5m");
    assert.equal(formatTimeAgo("2026-09-29T09:00:00Z", now), "3h");
    assert.equal(formatTimeAgo("2026-09-27T11:00:00Z", now), "2d");
  });
});

describe("carrierName", () => {
  it("prefers the stored name, then MC, then DOT", () => {
    assert.equal(carrierName({ carrierName: "Acme", mcNumber: "1", dotNumber: "2" }), "Acme");
    assert.equal(carrierName({ carrierName: null, mcNumber: "1", dotNumber: "2" }), "MC 1");
    assert.equal(carrierName({ carrierName: null, mcNumber: null, dotNumber: "2" }), "DOT 2");
    assert.equal(carrierName({ carrierName: null, mcNumber: null, dotNumber: null }), "Unidentified carrier");
  });
});
