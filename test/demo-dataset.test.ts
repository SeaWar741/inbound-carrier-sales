import { describe, expect, it } from "vitest";
import { buildDataset, spoken, type DatasetInput, type DemoCarrier, type LaneTemplate } from "../scripts/demo-dataset.ts";
import { evaluateOffer } from "../src/domain/negotiation.ts";
import type { TripSnapshot } from "../src/domain/trip-estimate.ts";

const place = (city: string, state: string, zip: string) => ({ city, state, zip });
const lanes: LaneTemplate[] = [
  { origin: place("Dallas", "TX", "75201"), destination: place("Atlanta", "GA", "30303"), miles: 781, equipment: "REEFER", ratePerMile: 2.3, maxBuyRatio: 1.18, commodity: "Frozen Goods", weight: 41000, pieces: 22, notes: "Appt required." },
  { origin: place("Chicago", "IL", "60601"), destination: place("Columbus", "OH", "43215"), miles: 355, equipment: "DRY_VAN", ratePerMile: 2.6, maxBuyRatio: 1.2, commodity: "Paper Products", weight: 30000, pieces: 26, notes: "" },
];
const cadences = ["top", "regular", "occasional", "lapsed", "new"] as const;
const carriers: DemoCarrier[] = Array.from({ length: 30 }, (_, i) => ({
  mc: String(2_100_000 + i * 7919),
  dot: String(5_100_000 + i),
  name: `Carrier ${i} LLC`,
  real: false,
  status: i === 0 ? "not_eligible" : "ok",
  equipment: i % 2 ? "REEFER" : "DRY_VAN",
  home: place("Dallas", "TX", "75201"),
  contact: "Mike",
  cadence: cadences[i % 5]!,
}));
const input: DatasetInput = {
  now: new Date("2026-10-01T18:00:00Z"),
  days: 30,
  seed: 7,
  carriers,
  lanes,
  unmetLanes: [lanes[0]!],
  liveLoads: [],
  estimate: async (trip) => ({ rate: trip.rate, dieselUsd: 300, tollsUsd: 40, carrierNetUsd: trip.rate - 340, tollShare: 0.1 }) as TripSnapshot,
  noticeEmail: "demo@example.com",
};

describe("demo dataset", () => {
  it("says numbers in pairs, like a dispatcher", () => {
    expect([657, 2100, 2702, 6425, 13825, 2000].map(spoken)).toEqual([
      "six fifty-seven",
      "twenty-one hundred",
      "twenty-seven oh two",
      "sixty-four twenty-five",
      "thirteen thousand eight twenty-five",
      "two thousand",
    ]);
  });

  it("is deterministic, follows evaluateOffer, and keeps the transcript in step with the events", async () => {
    const data = await buildDataset(input);
    expect(await buildDataset(input)).toEqual(data);
    expect(data.calls.length).toBeGreaterThan(150);
    expect(data.calls.every((c) => String(c.call_id).startsWith("demo-"))).toBe(true);

    const authorized = new Map<string, number>();
    for (const i of data.interventions) if (i.kind === "authorization") authorized.set(`${i.call_id}|${i.load_id}`, Number(i.amount_usd));
    for (const o of data.offers) {
      // An authorization lands after round 1, so it only counts from round 2 on.
      const extra = Number(o.round) >= 2 ? (authorized.get(`${o.call_id}|${o.load_id}`) ?? 0) : 0;
      const expected = evaluateOffer({ postedRate: Number(o.posted_rate), maxBuy: Number(o.max_buy), carrierAsk: Number(o.carrier_ask), round: Number(o.round), authorizedUsd: extra });
      expect({ decision: o.decision, rate: o.rate_to_say }).toEqual({ decision: expected.decision, rate: expected.rateToSay });
    }

    for (const call of data.calls) {
      const tools = data.transcripts.filter((t) => t.call_id === call.call_id && t.role === "tool").map((t) => t.text);
      const events = data.events.filter((e) => e.call_id === call.call_id && e.tool !== "hold_notice").map((e) => e.tool);
      expect(tools).toEqual(events);
    }

    const active = data.holds.filter((h) => h.status !== "released").map((h) => h.load_id);
    expect(new Set(active).size).toBe(active.length);
    expect(data.holds.every((h) => Number(h.agreed_rate) <= Number(h.max_buy))).toBe(true);
  });
});
