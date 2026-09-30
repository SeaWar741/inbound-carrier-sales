import { describe, expect, it } from "vitest";
import { baselinePolicy, gateCells, runTournament } from "../scripts/negotiation-sim.ts";
import { evaluateOffer } from "../src/domain/negotiation.ts";

// Same tolerance as the tournament's gate: float noise only.
const bookingTolerance = 1e-9;

describe("negotiation tournament", () => {
  it("plays the production schedule as its baseline", () => {
    const inputs = [
      { postedRate: 2000, maxBuy: 2296, carrierAsk: 2600, round: 1 },
      { postedRate: 2000, maxBuy: 2296, carrierAsk: 2150, round: 2 },
      { postedRate: 2000, maxBuy: 2296, carrierAsk: 2230, round: 3 },
      { postedRate: 2000, maxBuy: 2296, carrierAsk: 2225, round: 4 },
      { postedRate: 2000, maxBuy: 2296, carrierAsk: 2300, round: 4 },
      { postedRate: 2000, maxBuy: 2142, carrierAsk: 1950, round: 1 },
      { postedRate: 2093, maxBuy: 2103, carrierAsk: 2200, round: 1 },
    ];
    for (const input of inputs) {
      const { decision, rateToSay } = evaluateOffer(input);
      const sim = baselinePolicy({
        posted: input.postedRate,
        maxBuy: input.maxBuy,
        ask: input.carrierAsk,
        round: input.round,
        lastOffer: input.postedRate,
        laneSupply: 0,
      });
      expect(sim).toEqual({ decision, rateToSay });
    }
  });

  // No candidate keeps the baseline's bookings in every cell, so production keeps the baseline.
  // A new candidate that wins must ship in src/domain/negotiation.ts, and this test must change with it.
  it("keeps the baseline because no candidate books as much in every cell", () => {
    const { baseline, results, winner } = runTournament();
    expect(winner).toBeUndefined();
    for (const result of results.filter((r) => r !== baseline)) {
      const losesACell = gateCells.some(
        (cell) => result.cells[cell]!.bookingRate < baseline.cells[cell]!.bookingRate - bookingTolerance,
      );
      expect(losesACell, result.name).toBe(true);
    }
  });
});
