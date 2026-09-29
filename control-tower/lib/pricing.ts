import type { TowerCall, WallOffer } from "./contracts";

// Rate math for the operator's pricing views. The posted rate is the target buy (the approximate
// cost of the load) and the max buy is the ceiling; margin is what stays under the ceiling.

type PricedCall = Pick<TowerCall, "offers" | "hold" | "live" | "createdAt">;

// Margin kept under the ceiling, in dollars and as a share of it. Negative when the rate is over.
export function marginKept(maxBuy: number | null, rate: number | null): { usd: number; pct: number } | null {
  if (maxBuy === null || rate === null) return null;
  const usd = maxBuy - rate;
  return { usd, pct: maxBuy > 0 ? (usd / maxBuy) * 100 : 0 };
}

// Dollars per loaded mile; null when the lane distance is missing or zero.
export function perMile(rate: number | null, miles: number | null | undefined): number | null {
  if (rate === null || miles == null || miles <= 0) return null;
  return rate / miles;
}

// Signed distance from the posted rate: positive pays over the target buy.
export function spreadVsPosted(rate: number | null, postedRate: number | null): number | null {
  if (rate === null || postedRate === null) return null;
  return rate - postedRate;
}

export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Every recorded offer on one load across a carrier's calls, oldest first. A call keeps only its
// latest offer per load, so each entry is where one call left the negotiation.
export function negotiationPath(calls: Pick<TowerCall, "offers">[], loadId: string): WallOffer[] {
  return calls
    .flatMap((call) => call.offers.filter((offer) => offer.loadId === loadId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export type LoadOutcome =
  | { kind: "booked" | "holding"; amount: number }
  | { kind: "negotiating" | "lost" | "no_offer" };

// Where a load stands with this carrier: its newest hold decides; without one, a live call is still
// negotiating, a load we put a number on is lost, and one we never countered had no offer.
export function loadOutcome(calls: PricedCall[], loadId: string): LoadOutcome {
  const hold = calls
    .flatMap((call) => (call.hold?.loadId === loadId ? [call.hold] : []))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (hold) {
    if (hold.status === "booked" || hold.status === "booked_unconfirmed") return { kind: "booked", amount: hold.agreedRate };
    if (hold.status === "held" || hold.status === "confirming") return { kind: "holding", amount: hold.agreedRate };
    return { kind: "lost" };
  }
  if (calls.some((call) => call.live && call.offers.some((offer) => offer.loadId === loadId))) return { kind: "negotiating" };
  const countered = calls.some((call) => call.offers.some((offer) => offer.loadId === loadId && offer.rateToSay !== null));
  return countered ? { kind: "lost" } : { kind: "no_offer" };
}

export type CarrierPricing = {
  loadsOffered: number;
  booked: number;
  // Booked loads over loads offered, 0..100; null with nothing offered.
  bookingRate: number | null;
  avgAgreedPerMile: number | null;
  avgMarginKept: number | null;
  // The negotiation round the booked loads closed in.
  avgRoundsToAgree: number | null;
};

// The carrier's pricing record from its loaded calls. A load booked twice counts once, at its newest hold.
export function carrierPricing(calls: PricedCall[]): CarrierPricing {
  const offered = new Set(calls.flatMap((call) => call.offers.map((offer) => offer.loadId)));
  const bookedByLoad = new Map<string, { agreedRate: number; maxBuy: number | null; miles: number | null; round: number | null; at: string }>();
  for (const call of calls) {
    const hold = call.hold;
    if (!hold || (hold.status !== "booked" && hold.status !== "booked_unconfirmed")) continue;
    const previous = bookedByLoad.get(hold.loadId);
    if (previous && previous.at >= hold.createdAt) continue;
    const offer = call.offers.find((o) => o.loadId === hold.loadId);
    bookedByLoad.set(hold.loadId, {
      agreedRate: hold.agreedRate,
      maxBuy: hold.maxBuy ?? offer?.maxBuy ?? null,
      miles: hold.lane?.miles ?? offer?.lane?.miles ?? null,
      round: offer?.round ?? null,
      at: hold.createdAt,
    });
  }
  const booked = [...bookedByLoad.values()];
  const loadsOffered = offered.size;
  return {
    loadsOffered,
    booked: booked.length,
    bookingRate: loadsOffered > 0 ? (booked.length / loadsOffered) * 100 : null,
    avgAgreedPerMile: average(booked.flatMap((b) => perMile(b.agreedRate, b.miles) ?? [])),
    avgMarginKept: average(booked.flatMap((b) => marginKept(b.maxBuy, b.agreedRate)?.usd ?? [])),
    avgRoundsToAgree: average(booked.flatMap((b) => b.round ?? [])),
  };
}
