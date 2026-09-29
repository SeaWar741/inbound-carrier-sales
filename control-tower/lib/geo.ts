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
