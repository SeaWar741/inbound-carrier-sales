import { avgTransitMph, operatorTimeZone } from "../constants.ts";
import { sql } from "../infra/twin-client.ts";

export const tripStatuses = ["upcoming", "in_transit", "arrived"] as const;
export type TripStatus = (typeof tripStatuses)[number];

// The only ETA formula and the only place a trip status is decided. A lateral join over a row
// aliased `lane` with the TMS `pickup_at` (YYYYMMDDHHMMSS wall clock, read as the desk's zone)
// and `miles`; it yields `trip.pickup_ts`, `trip.eta_ts` and `trip.trip_status`. Rows whose
// pickup_at is missing or not 14 digits get nulls instead of a to_timestamp error.
export const tripSql = sql`CROSS JOIN LATERAL (
      SELECT p.pickup_ts, e.eta_ts,
        CASE WHEN now() < p.pickup_ts THEN 'upcoming' WHEN now() < e.eta_ts THEN 'in_transit' WHEN now() >= e.eta_ts THEN 'arrived' END AS trip_status
      FROM (SELECT CASE WHEN lane.pickup_at ~ '^[0-9]{14}$'
          THEN to_timestamp(lane.pickup_at, 'YYYYMMDDHH24MISS')::timestamp AT TIME ZONE ${operatorTimeZone} END AS pickup_ts) p
      CROSS JOIN LATERAL (SELECT p.pickup_ts + lane.miles::float8 / ${avgTransitMph} * interval '1 hour' AS eta_ts) e
    ) trip`;

// Share of the trip covered at `now`, for placing the truck on its lane. Arithmetic only: the
// status comes from tripSql.
export function tripProgress(pickupAt: Date, etaAt: Date, now: Date): number {
  const total = etaAt.getTime() - pickupAt.getTime();
  const elapsed = now.getTime() - pickupAt.getTime();
  if (total <= 0) return elapsed >= 0 ? 1 : 0;
  return Math.min(1, Math.max(0, elapsed / total));
}
