import { describe, expect, it } from "vitest";
import { tripProgress, tripSql } from "../src/domain/trip.ts";

// A 500-mile lane picked up at 14:00 UTC arrives at 00:00 UTC at 50 mph.
const pickup = new Date("2026-09-29T14:00:00Z");
const eta = new Date("2026-09-30T00:00:00Z");

describe("tripProgress", () => {
  it("is 0 before pickup", () => {
    expect(tripProgress(pickup, eta, new Date("2026-09-29T09:00:00Z"))).toBe(0);
    expect(tripProgress(pickup, eta, pickup)).toBe(0);
  });

  it("is the elapsed share mid trip", () => {
    expect(tripProgress(pickup, eta, new Date("2026-09-29T16:30:00Z"))).toBe(0.25);
    expect(tripProgress(pickup, eta, new Date("2026-09-29T19:00:00Z"))).toBe(0.5);
  });

  it("is 1 at and after the ETA", () => {
    expect(tripProgress(pickup, eta, eta)).toBe(1);
    expect(tripProgress(pickup, eta, new Date("2026-10-01T00:00:00Z"))).toBe(1);
  });

  it("does not divide by zero on a zero-mile trip", () => {
    expect(tripProgress(pickup, pickup, new Date("2026-09-29T13:00:00Z"))).toBe(0);
    expect(tripProgress(pickup, pickup, pickup)).toBe(1);
  });
});

describe("tripSql", () => {
  it("reads pickup_at as the desk's wall clock and derives ETA from one speed", () => {
    expect(tripSql.text).toContain("to_timestamp(lane.pickup_at, 'YYYYMMDDHH24MISS')::timestamp AT TIME ZONE E'America/Chicago'");
    expect(tripSql.text).toContain("lane.miles::float8 / 50 * interval '1 hour'");
  });

  it("never parses a pickup_at that is not 14 digits", () => {
    expect(tripSql.text).toMatch(/CASE WHEN lane\.pickup_at ~ '\^\[0-9\]\{14\}\$'\s+THEN to_timestamp/);
  });
});
