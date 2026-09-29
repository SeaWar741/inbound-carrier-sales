import { concessionSchedule, counterRoundingUsd } from "../constants.ts";

export const finalRound = concessionSchedule.length;

// How a rate is spoken back to the carrier.
export const dollars = (usd: number) => `$${usd.toLocaleString("en-US")}`;

// authorizedUsd: what a senior rep added on this call for this load.
export type OfferInput = { postedRate: number; maxBuy: number; carrierAsk: number; round: number; authorizedUsd?: number };

export type OfferEvaluation =
  | { decision: "accept" | "counter"; rateToSay: number; isFinalRound: boolean }
  | { decision: "reject"; rateToSay: null; isFinalRound: true };

// The counter scheduled for a round, always within [postedRate, maxBuy].
// With no gap above the posted rate, the posted rate is the ceiling.
export function scheduledCounter(postedRate: number, maxBuy: number, round: number): number {
  const gap = maxBuy - postedRate;
  if (gap <= 0) return postedRate;
  const step = concessionSchedule[Math.min(Math.max(round, 1), finalRound) - 1] ?? 0;
  const rounded = Math.floor((postedRate + step * gap) / counterRoundingUsd) * counterRoundingUsd;
  return Math.min(Math.max(rounded, postedRate), maxBuy);
}

// Past the final round the last counter stands: an ask at or under it is still accepted.
// An authorization lifts the scheduled counter but never past the max buy, and never lowers it.
export function evaluateOffer({ postedRate, maxBuy, carrierAsk, round, authorizedUsd = 0 }: OfferInput): OfferEvaluation {
  const scheduled = scheduledCounter(postedRate, maxBuy, round);
  const counter = Math.max(scheduled, Math.min(scheduled + authorizedUsd, maxBuy));
  const isFinalRound = round >= finalRound;
  if (carrierAsk <= counter) return { decision: "accept", rateToSay: carrierAsk, isFinalRound };
  if (round > finalRound) return { decision: "reject", rateToSay: null, isFinalRound: true };
  return { decision: "counter", rateToSay: counter, isFinalRound };
}
