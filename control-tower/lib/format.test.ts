import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  carrierName,
  formatPerMile,
  formatSignedUsd,
  formatTimeAgo,
  groupCallsByLoad,
  timelineRows,
  type LoadSection,
} from "./format.ts";

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

describe("timelineRows", () => {
  // Desk time is Chicago: 2026-09-29T12:00Z is Sep 29 there, 2026-09-28T03:00Z is still Sep 27.
  const row = (callId: string, createdAt: string) => ({ callId, createdAt });
  const noLoad: LoadSection<ReturnType<typeof row>> = {
    loadId: null,
    calls: [row("c3", "2026-09-29T15:00:00Z"), row("c2", "2026-09-29T14:00:00Z"), row("c1", "2026-09-29T13:00:00Z")],
  };
  const shape = (rows: ReturnType<typeof timelineRows>) =>
    rows.map((r) => (r.kind === "call" ? `${(r.call as { callId: string }).callId}${r.day ? `@${r.day}` : ""}` : `no_load:${r.count}:${r.open}`));

  it("folds calls without a load into one closed row", () => {
    assert.deepEqual(shape(timelineRows(noLoad, { today: "2026-09-29", selectedCallId: null, expanded: false })), ["no_load:3:false"]);
  });

  it("opens the fold when expanded or when it holds the selected call", () => {
    const opened = ["no_load:3:true", "c3", "c2", "c1"];
    assert.deepEqual(shape(timelineRows(noLoad, { today: "2026-09-29", selectedCallId: null, expanded: true })), opened);
    assert.deepEqual(shape(timelineRows(noLoad, { today: "2026-09-29", selectedCallId: "c2", expanded: false })), opened);
  });

  it("never folds a load section", () => {
    const section = { loadId: "LD1", calls: noLoad.calls };
    assert.deepEqual(shape(timelineRows(section, { today: "2026-09-29", selectedCallId: null, expanded: false })), ["c3", "c2", "c1"]);
  });

  it("marks the first call of each day other than today, on the desk calendar", () => {
    const section = {
      loadId: "LD1",
      calls: [row("c4", "2026-09-29T12:00:00Z"), row("c3", "2026-09-28T15:00:00Z"), row("c2", "2026-09-28T14:00:00Z"), row("c1", "2026-09-28T03:00:00Z")],
    };
    assert.deepEqual(shape(timelineRows(section, { today: "2026-09-29", selectedCallId: null, expanded: false })), [
      "c4",
      "c3@2026-09-28",
      "c2",
      "c1@2026-09-27",
    ]);
  });
});

describe("formatSignedUsd and formatPerMile", () => {
  it("signs spreads and leaves zero bare", () => {
    assert.equal(formatSignedUsd(134), "+$134");
    assert.equal(formatSignedUsd(-50), "-$50");
    assert.equal(formatSignedUsd(0.2), "$0");
  });

  it("prints dollars per mile with cents", () => {
    assert.equal(formatPerMile(2150 / 742), "$2.90/mi");
  });
});
