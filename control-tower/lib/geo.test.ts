import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arcPoints, dashFrames, placeZip, pointOnArc, splitArc, type LngLat } from "./geo.ts";

const chicago: LngLat = [-87.63, 41.88];
const dallas: LngLat = [-96.8, 32.78];

describe("placeZip", () => {
  it("places a ZIP by its 3-digit prefix in lng/lat", () => {
    const point = placeZip("60601");
    assert.ok(point);
    const [lng, lat] = point;
    // Chicago, within a degree.
    assert.ok(Math.abs(lng - -87.6) < 1, `lng ${lng}`);
    assert.ok(Math.abs(lat - 41.9) < 1, `lat ${lat}`);
  });

  it("skips missing and unknown prefixes", () => {
    assert.equal(placeZip(undefined), null);
    assert.equal(placeZip(""), null);
    assert.equal(placeZip("00000"), null);
  });
});

describe("arcPoints", () => {
  it("starts at the origin and ends at the destination", () => {
    const points = arcPoints(chicago, dallas);
    assert.equal(points.length, 49);
    assert.deepEqual(points[0], chicago);
    assert.deepEqual(points.at(-1), dallas);
  });

  it("bows to the left of travel", () => {
    // Heading east, left is north: the midpoint sits above the straight line.
    const [, lat] = pointOnArc([-100, 40], [-80, 40], 0.5);
    assert.ok(lat > 40, `lat ${lat}`);
  });
});

describe("pointOnArc", () => {
  it("is the origin at progress 0 and the destination at progress 1", () => {
    assert.deepEqual(pointOnArc(chicago, dallas, 0), chicago);
    assert.deepEqual(pointOnArc(chicago, dallas, 1), dallas);
  });

  it("clamps progress outside 0..1", () => {
    assert.deepEqual(pointOnArc(chicago, dallas, -0.5), chicago);
    assert.deepEqual(pointOnArc(chicago, dallas, 1.5), dallas);
  });
});

describe("splitArc", () => {
  it("meets at the truck: traveled ends where remaining starts", () => {
    const [traveled, remaining] = splitArc(chicago, dallas, 0.4);
    assert.deepEqual(traveled[0], chicago);
    assert.deepEqual(remaining.at(-1), dallas);
    assert.deepEqual(traveled.at(-1), pointOnArc(chicago, dallas, 0.4));
    assert.deepEqual(remaining[0], pointOnArc(chicago, dallas, 0.4));
  });

  it("covers every arc point once besides the cut", () => {
    const [traveled, remaining] = splitArc(chicago, dallas, 0.4);
    assert.equal(traveled.length + remaining.length, arcPoints(chicago, dallas).length + 2);
  });

  it("leaves a single point on the empty side at the ends of the trip and clamps", () => {
    const [notStarted, all] = splitArc(chicago, dallas, -1);
    assert.equal(notStarted.length, 1);
    assert.deepEqual(all, arcPoints(chicago, dallas));
    const [done, none] = splitArc(chicago, dallas, 2);
    assert.deepEqual(done, arcPoints(chicago, dallas));
    assert.equal(none.length, 1);
  });
});

describe("dashFrames", () => {
  it("keeps the dash and gap lengths in every frame", () => {
    for (const frame of dashFrames(2.5, 2, 12)) {
      const [dashHead = NaN, gapHead = NaN, dashTail = NaN, gapTail = NaN] = frame;
      assert.equal(frame.length, 4);
      assert.ok(frame.every((value) => value >= 0), `${frame}`);
      assert.ok(Math.abs(dashHead + dashTail - 2.5) < 1e-9, `dash ${frame}`);
      assert.ok(Math.abs(gapHead + gapTail - 2) < 1e-9, `gap ${frame}`);
    }
  });

  it("moves the first dash forward frame by frame", () => {
    const frames = dashFrames(2, 2, 8);
    assert.deepEqual(frames[0], [0, 0, 2, 2]);
    assert.deepEqual(frames[2], [0, 1, 2, 1]);
    assert.deepEqual(frames[6], [1, 2, 1, 0]);
  });
});
