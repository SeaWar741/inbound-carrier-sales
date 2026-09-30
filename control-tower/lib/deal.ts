import type { TowerCall, TripSnapshot, WallOffer } from "./contracts";
import { formatUsd } from "./format.ts";
import { marginKept } from "./pricing.ts";

// The Deal card's story of one call on one load: where it stands, the rounds that led there, the
// price bar, who earns what, and the trip. Pure, so the card only lays it out.

type Hold = NonNullable<TowerCall["hold"]>;
type DealCall = Pick<TowerCall, "live" | "offers" | "hold" | "events">;

export type DealStatus = Hold["status"] | "negotiating" | "no_deal";

// This call's hold on the load decides; without one a live call is still negotiating and an ended
// one closed without a deal.
export function dealStatus(call: DealCall, loadId: string): DealStatus {
  if (call.hold?.loadId === loadId) return call.hold.status;
  return call.live ? "negotiating" : "no_deal";
}

export type DealRound = { round: number; carrierAsk: number; ourOffer: number | null; decision: WallOffer["decision"] };

// The call's rounds on the load, in order. Offers on other loads belong to other deals.
export function dealRounds(offers: Pick<WallOffer, "loadId" | "round" | "carrierAsk" | "rateToSay" | "decision" | "createdAt">[], loadId: string): DealRound[] {
  return offers
    .filter((offer) => offer.loadId === loadId)
    .sort((a, b) => a.round - b.round || a.createdAt.localeCompare(b.createdAt))
    .map((offer) => ({ round: offer.round, carrierAsk: offer.carrierAsk, ourOffer: offer.rateToSay, decision: offer.decision }));
}

export type DealEnd =
  | { kind: "deal"; amount: number }
  | { kind: "released"; amount: number }
  | { kind: "handed_to_rep" }
  | { kind: "passed" }
  | { kind: "open" };

// The last line of "How it went". A hold is the deal; without one, a call that asked for a person
// went to a rep, an ended call means the carrier passed, and a live one is still going.
export function dealEnd(call: DealCall, loadId: string): DealEnd {
  const status = dealStatus(call, loadId);
  if (status === "negotiating") return { kind: "open" };
  if (status === "no_deal") return call.events.some((event) => event.tool === "request_human") ? { kind: "handed_to_rep" } : { kind: "passed" };
  const amount = call.hold!.agreedRate;
  return status === "released" ? { kind: "released", amount } : { kind: "deal", amount };
}

// What the carrier's arrival looks like in plain words: on time with one driver, only with a team,
// or late even with a team.
export function arrivalText(trip: Pick<TripSnapshot, "feasibility" | "lateHours">): { text: string; tone: "ok" | "warn" | "risk" } {
  switch (trip.feasibility) {
    case "solo":
      return { text: "Arrives on time, one driver", tone: "ok" };
    case "team":
      return { text: "Needs a team to arrive on time", tone: "warn" };
    case "impossible":
      return { text: `Arrives ~${Math.round(trip.lateHours)}h late`, tone: "risk" };
  }
}

// One row of "Who earns what": "We earn $25 · 2%" over a muted line that shows the subtraction.
export type EarningsRow = { lead: string; amount: string; pct: string; note: string; loss: boolean };

const pctText = (pct: number) => `${Math.round(Math.abs(pct))}%`;

// What we make on the load: our max minus the rate, as a share of our max. At an agreed rate the
// note shows that subtraction; while negotiating it is our latest offer, and says so.
export function ourEarnings(maxBuy: number | null, rate: number | null, basis: "agreed" | "offer"): EarningsRow | null {
  const kept = marginKept(maxBuy, rate);
  if (!kept || maxBuy === null || rate === null) return null;
  const loss = kept.usd < 0;
  return {
    lead: loss ? "We lose" : "We earn",
    amount: formatUsd(Math.abs(kept.usd)),
    pct: pctText(kept.pct),
    note: basis === "agreed" ? `Our max ${formatUsd(maxBuy)} − agreed ${formatUsd(rate)}` : `At our offer of ${formatUsd(rate)} · our max ${formatUsd(maxBuy)}`,
    loss,
  };
}

// What the carrier keeps from the rate once diesel and tolls are paid, as a share of the rate, from
// the hold's trip estimate. Null without an estimate: the card then says it was not estimated.
export function carrierEarnings(trip: Pick<TripSnapshot, "rate" | "dieselUsd" | "tollsUsd" | "carrierNetUsd" | "netPerHour" | "tollShare"> | null): EarningsRow | null {
  if (!trip) return null;
  const loss = trip.carrierNetUsd < 0;
  const tolls = trip.tollShare === null ? ", tolls not counted" : ` − ~${formatUsd(trip.tollsUsd)} tolls`;
  return {
    lead: loss ? "Carrier loses" : "Carrier earns",
    amount: `~${formatUsd(Math.abs(trip.carrierNetUsd))}`,
    pct: pctText(trip.rate > 0 ? (trip.carrierNetUsd / trip.rate) * 100 : 0),
    note: `${formatUsd(trip.rate)} − ~${formatUsd(trip.dieselUsd)} diesel${tolls} · ${formatUsd(trip.netPerHour)}/h`,
    loss,
  };
}

export type BarLabel = { kind: "posted" | "ours" | "max" | "ask"; usd: number; at: number; row: "above" | "below" };

export type PriceBar = {
  labels: BarLabel[];
  // Where our max sits on the track; everything to its right is over it.
  maxAt: number;
  // The filled stretch, from posted to our number; null before we said one.
  fill: { from: number; to: number } | null;
};

// Labels closer than this share of the track would overlap at the panel's width.
export const labelGap = 15;

// The track runs from the posted rate to our max, stretched to reach any carrier ask above it.
// Every marker gets a label at its spot: posted, our number and our max above the track, the ask
// below; a label that would crowd its neighbor on the same row moves to the other row.
export function priceBar(input: { posted: number; max: number; ours: number | null; ask: number | null }): PriceBar {
  const { posted, max, ours, ask } = input;
  const values = [posted, max, ...(ours === null ? [] : [ours]), ...(ask === null ? [] : [ask])];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const at = (usd: number) => (high > low ? ((usd - low) / (high - low)) * 100 : 0);

  const wanted: Omit<BarLabel, "row">[] = [
    { kind: "posted", usd: posted, at: at(posted) },
    ...(ours === null ? [] : [{ kind: "ours" as const, usd: ours, at: at(ours) }]),
    { kind: "max", usd: max, at: at(max) },
    // The ask says nothing new when it is the number we landed on.
    ...(ask === null || ask === ours ? [] : [{ kind: "ask" as const, usd: ask, at: at(ask) }]),
  ];
  const lastAt: Record<BarLabel["row"], number | null> = { above: null, below: null };
  const labels = [...wanted]
    .sort((a, b) => a.at - b.at)
    .map((label): BarLabel => {
      const preferred = label.kind === "ask" ? "below" : "above";
      const other = preferred === "above" ? "below" : "above";
      const crowds = (row: BarLabel["row"]) => lastAt[row] !== null && label.at - lastAt[row]! < labelGap;
      const row = crowds(preferred) && !crowds(other) ? other : preferred;
      lastAt[row] = label.at;
      return { ...label, row };
    });
  return {
    labels,
    maxAt: at(max),
    fill: ours === null ? null : { from: Math.min(at(posted), at(ours)), to: Math.max(at(posted), at(ours)) },
  };
}
