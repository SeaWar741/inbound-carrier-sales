import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arcPoints, placeZip, pointOnArc, type LngLat } from "./geo.ts";

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
