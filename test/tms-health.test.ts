import { describe, expect, it } from "vitest";
import { TmsHealthRecorder } from "../src/infra/tms/tms-health.ts";

const since = new Date("2026-09-29T12:00:00.000Z");

describe("TmsHealthRecorder", () => {
  it("reports nothing before the first attempt", () => {
    expect(new TmsHealthRecorder({ now: since }).snapshot()).toEqual({
      since: since.toISOString(),
      attempts: 0,
      retries: 0,
      faultsAbsorbed: 0,
      latencySamples: 0,
      latencyP50Ms: null,
      latencyP95Ms: null,
    });
  });

  it("computes nearest-rank p50 and p95", () => {
    const health = new TmsHealthRecorder({ now: since });
    // Recorded out of order: 1..100 ms.
    for (let i = 100; i >= 1; i--) health.record({ attempt: 1, latencyMs: i, outcome: "ok" });
    expect(health.snapshot()).toMatchObject({ attempts: 100, latencySamples: 100, latencyP50Ms: 50, latencyP95Ms: 95 });
  });

  it("counts retries and the faults a later success absorbed", () => {
    const health = new TmsHealthRecorder({ now: since });
    // Command A: two faults then ok. Command B: one fault then ok. Command C: three faults, never ok.
    // Command D: a business error on the first attempt.
    health.record({ attempt: 1, latencyMs: 2000, outcome: "timeout" });
    health.record({ attempt: 1, latencyMs: 5, outcome: "empty-close" });
    health.record({ attempt: 2, latencyMs: 40, outcome: "partial" });
    health.record({ attempt: 2, latencyMs: 300, outcome: "ok" });
    health.record({ attempt: 3, latencyMs: 250, outcome: "ok" });
    health.record({ attempt: 1, latencyMs: 2000, outcome: "timeout" });
    health.record({ attempt: 2, latencyMs: 2000, outcome: "timeout" });
    health.record({ attempt: 3, latencyMs: 2000, outcome: "timeout" });
    health.record({ attempt: 1, latencyMs: 220, outcome: "business-error" });
    expect(health.snapshot()).toMatchObject({ attempts: 9, retries: 5, faultsAbsorbed: 3 });
  });

  it("keeps only the most recent latencies", () => {
    const health = new TmsHealthRecorder({ capacity: 4, now: since });
    for (const latencyMs of [1000, 1000, 1000, 1000, 10, 20, 30]) health.record({ attempt: 1, latencyMs, outcome: "ok" });
    // Window is [10, 20, 30, 1000]; the attempt count still covers every attempt.
    expect(health.snapshot()).toMatchObject({ attempts: 7, latencySamples: 4, latencyP50Ms: 20, latencyP95Ms: 1000 });
  });
});
