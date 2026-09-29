import { describe, expect, it } from "vitest";
import { evaluateOffer, finalRound, scheduledCounter } from "../src/domain/negotiation.ts";

const anchor = { postedRate: 2000, maxBuy: 2296 };

describe("scheduledCounter", () => {
  it("concedes 35/60/80% of the gap, floored to $25", () => {
    expect([1, 2, 3].map((round) => scheduledCounter(anchor.postedRate, anchor.maxBuy, round))).toEqual([2100, 2175, 2225]);
  });

  it("treats the posted rate as the ceiling when there is no gap", () => {
    expect(scheduledCounter(2000, 2000, 2)).toBe(2000);
    expect(scheduledCounter(2000, 1900, 3)).toBe(2000);
  });

  it("never floors below the posted rate on a small gap", () => {
    expect(scheduledCounter(2093, 2103, 1)).toBe(2093);
  });
});

describe("evaluateOffer", () => {
  it("counters a high ask with the schedule, marking round 3 final", () => {
    expect([1, 2, 3].map((round) => evaluateOffer({ ...anchor, carrierAsk: 2600, round }))).toEqual([
      { decision: "counter", rateToSay: 2100, isFinalRound: false },
      { decision: "counter", rateToSay: 2175, isFinalRound: false },
      { decision: "counter", rateToSay: 2225, isFinalRound: true },
    ]);
  });

  it("accepts an ask at or under the posted rate at the carrier's number", () => {
    expect(evaluateOffer({ ...anchor, carrierAsk: 1950, round: 1 })).toEqual({ decision: "accept", rateToSay: 1950, isFinalRound: false });
  });

  it("counters 2150 in round 1 and accepts it in round 2", () => {
    expect(evaluateOffer({ ...anchor, carrierAsk: 2150, round: 1 })).toMatchObject({ decision: "counter", rateToSay: 2100 });
    expect(evaluateOffer({ ...anchor, carrierAsk: 2150, round: 2 })).toMatchObject({ decision: "accept", rateToSay: 2150 });
  });

  it("accepts an ask equal to the scheduled counter", () => {
    expect(evaluateOffer({ ...anchor, carrierAsk: 2175, round: 2 })).toMatchObject({ decision: "accept", rateToSay: 2175 });
  });

  it("rejects a high ask after the final round but still honors the last counter", () => {
    expect(evaluateOffer({ ...anchor, carrierAsk: 2600, round: finalRound + 1 })).toEqual({
      decision: "reject",
      rateToSay: null,
      isFinalRound: true,
    });
    expect(evaluateOffer({ ...anchor, carrierAsk: 2225, round: finalRound + 1 })).toMatchObject({ decision: "accept", rateToSay: 2225 });
  });

  it("with no gap accepts only at or under the posted rate and counters at it", () => {
    expect(evaluateOffer({ postedRate: 2000, maxBuy: 1800, carrierAsk: 2000, round: 1 })).toMatchObject({ decision: "accept", rateToSay: 2000 });
    expect(evaluateOffer({ postedRate: 2000, maxBuy: 1800, carrierAsk: 2100, round: 3 })).toMatchObject({ decision: "counter", rateToSay: 2000 });
  });

  it("never says a number above the ask or the max buy", () => {
    for (const postedRate of [500, 1990, 2000, 2093, 6886]) {
      for (const gap of [-100, 0, 1, 24, 25, 296, 445, 798, 5000]) {
        const maxBuy = postedRate + gap;
        for (let carrierAsk = 400; carrierAsk <= 12_000; carrierAsk += 37) {
          for (let round = 1; round <= finalRound + 2; round++) {
            const { rateToSay } = evaluateOffer({ postedRate, maxBuy, carrierAsk, round });
            if (rateToSay === null) continue;
            expect(rateToSay).toBeLessThanOrEqual(carrierAsk);
            expect(rateToSay).toBeLessThanOrEqual(Math.max(maxBuy, postedRate));
          }
        }
      }
    }
  });
});
