import zip3Centroids from "./zip3-centroids.json" with { type: "json" };

// [longitude, latitude] in degrees (WGS84), as MapLibre takes them.
export type LngLat = [number, number];

// [longitude, latitude] per 3-digit ZIP prefix, from scripts/build-zip3.ts.
const centroids: Record<string, number[] | undefined> = zip3Centroids;

// Placed by the 3-digit ZIP prefix; unknown prefixes are skipped.
export function placeZip(zip: string | undefined): LngLat | null {
  const [lng, lat] = (zip ? centroids[zip.slice(0, 3)] : undefined) ?? [];
  if (lng === undefined || lat === undefined) return null;
  return [lng, lat];
}

// Control point of a quadratic curve bowed to the left of travel, higher for longer hauls.
function control([x1, y1]: LngLat, [x2, y2]: LngLat): LngLat {
  const bow = 0.22;
  const dx = x2 - x1;
  const dy = y2 - y1;
  // Latitude grows northward, so left of travel is (-dy, dx).
  return [(x1 + x2) / 2 - dy * bow, (y1 + y2) / 2 + dx * bow];
}

// The point at fraction t (clamped to 0..1) along the arc from origin to destination.
export function pointOnArc(from: LngLat, to: LngLat, t: number): LngLat {
  const [cx, cy] = control(from, to);
  const s = Math.min(1, Math.max(0, t));
  const a = (1 - s) * (1 - s);
  const b = 2 * (1 - s) * s;
  const c = s * s;
  return [a * from[0] + b * cx + c * to[0], a * from[1] + b * cy + c * to[1]];
}

// The arc as a polyline for a GeoJSON LineString; starts at the origin and ends at the destination.
export function arcPoints(from: LngLat, to: LngLat, segments = 48): LngLat[] {
  return Array.from({ length: segments + 1 }, (_, index) => pointOnArc(from, to, index / segments));
}

// The arc cut at a share of the trip: the part already driven and the part still ahead. Both keep
// the cut point, so they meet without a gap; either has a single point when progress is 0 or 1.
export function splitArc(from: LngLat, to: LngLat, progress: number, segments = 48): [LngLat[], LngLat[]] {
  const cut = Math.min(1, Math.max(0, progress));
  const at = pointOnArc(from, to, cut);
  const traveled: LngLat[] = [];
  const remaining: LngLat[] = [at];
  for (let index = 0; index <= segments; index++) {
    const t = index / segments;
    if (t < cut) traveled.push(pointOnArc(from, to, t));
    else if (t > cut) remaining.push(pointOnArc(from, to, t));
  }
  traveled.push(at);
  return [traveled, remaining];
}

// Frames of a line-dasharray (in line widths) whose dashes shift forward one step per frame, so a
// dashed line appears to flow from its first coordinate toward its last.
export function dashFrames(dash: number, gap: number, steps: number): number[][] {
  const period = dash + gap;
  return Array.from({ length: steps }, (_, index) => {
    const offset = (period * index) / steps;
    // Up to one gap of offset, the line opens on a gap; past it, on the tail of the previous dash.
    return offset <= gap ? [0, offset, dash, gap - offset] : [offset - gap, gap, dash - (offset - gap), 0];
  });
}

// A marker point per state and DC, near each state's geographic center; enough to place one circle per
// state on a country-scale map.
export const stateCentroids: Record<string, LngLat> = {
  AL: [-86.8, 32.8],
  AK: [-152.3, 64.2],
  AZ: [-111.7, 34.3],
  AR: [-92.4, 34.9],
  CA: [-119.6, 37.2],
  CO: [-105.5, 39.0],
  CT: [-72.7, 41.6],
  DE: [-75.5, 39.0],
  DC: [-77.0, 38.9],
  FL: [-81.7, 28.6],
  GA: [-83.4, 32.7],
  HI: [-157.0, 20.8],
  ID: [-114.6, 44.4],
  IL: [-89.2, 40.0],
  IN: [-86.3, 39.9],
  IA: [-93.5, 42.1],
  KS: [-98.4, 38.5],
  KY: [-85.3, 37.5],
  LA: [-92.0, 31.1],
  ME: [-69.2, 45.4],
  MD: [-76.8, 39.0],
  MA: [-71.8, 42.3],
  MI: [-84.7, 43.7],
  MN: [-94.3, 46.3],
  MS: [-89.7, 32.7],
  MO: [-92.5, 38.4],
  MT: [-109.6, 47.0],
  NE: [-99.8, 41.5],
  NV: [-116.6, 39.3],
  NH: [-71.6, 43.7],
  NJ: [-74.7, 40.2],
  NM: [-106.1, 34.4],
  NY: [-75.5, 42.9],
  NC: [-79.4, 35.6],
  ND: [-100.5, 47.5],
  OH: [-82.8, 40.3],
  OK: [-97.5, 35.6],
  OR: [-120.6, 43.9],
  PA: [-77.8, 40.9],
  RI: [-71.5, 41.7],
  SC: [-80.9, 33.9],
  SD: [-100.2, 44.4],
  TN: [-86.3, 35.9],
  TX: [-99.3, 31.5],
  UT: [-111.7, 39.3],
  VT: [-72.7, 44.1],
  VA: [-78.8, 37.5],
  WA: [-120.4, 47.4],
  WV: [-80.6, 38.6],
  WI: [-89.8, 44.6],
  WY: [-107.6, 43.0],
};
