"use client";

import { LuChevronLeft, LuChevronRight, LuReceipt, LuRoute } from "react-icons/lu";
import { motion, useReducedMotion } from "motion/react";
import { Badge } from "@/components/inbox/stage-pill";
import { Section } from "@/components/section";
import { finalRound, type TripSnapshot, type WallOffer } from "@/lib/contracts";
import {
  feasibilityBadge,
  formatClock,
  formatDateTime,
  formatHours,
  formatPercent,
  formatPerMile,
  formatSignedUsd,
  formatUsd,
  outcomeLabel,
} from "@/lib/format";
import { pricingBreakdown, type LoadOutcome } from "@/lib/pricing";

// Position on a min-to-max scale as a percentage, clamped to the track.
function percentOf(value: number, min: number, max: number): number {
  if (max <= min) return 100;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

// A label pinned to a point on the track that never overflows either end.
function Pinned({ at, className, children }: { at: number; className: string; children: React.ReactNode }) {
  return (
    <span
      className={`absolute whitespace-nowrap text-[11px] leading-none ${className}`}
      style={{ left: `${at}%`, transform: `translateX(-${at}%)` }}
    >
      {children}
    </span>
  );
}

// One line of the pricing receipt: a short muted label, the amount right-aligned, and a note
// (usually $/mi) in its own right-aligned column so amounts line up down the card.
function Line({
  label,
  value,
  tone = "text-fg",
  note,
  total = false,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  note?: string | null;
  total?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto_4.5rem] items-baseline gap-x-3 ${total ? "mt-1 border-t border-line-strong pt-1.5 font-semibold" : ""}`}
    >
      <dt className={`truncate ${total ? "text-fg" : "text-fg-muted"}`} title={hint}>
        {label}
      </dt>
      <dd className={`tabular text-right ${tone}`}>{value}</dd>
      <dd className="tabular truncate text-right text-[11px] font-normal text-fg-faint">{note}</dd>
    </div>
  );
}

// What the carrier keeps on the held load once diesel and tolls are paid, and when it can legally
// deliver. Estimates snapshotted when the hold was placed, laid out on the receipt's grid.
function TripBlock({ trip, miles }: { trip: TripSnapshot; miles: number | null }) {
  const badge = feasibilityBadge(trip);
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <h4 className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
        <LuRoute size={12} aria-hidden />
        Trip
      </h4>
      <dl className="flex flex-col gap-1.5 text-xs">
        <Line label="Diesel (est.)" hint="Fuel for the route at the lane's diesel price" value={formatUsd(trip.dieselUsd)} note={`$${trip.dieselPerGal.toFixed(2)}/gal`} />
        <Line label="Tolls (est.)" hint="Tolls on the route" value={formatUsd(trip.tollsUsd)} note={`${Math.round(trip.tollShare * 100)}% toll`} />
        <Line
          label="Carrier net"
          hint="Agreed rate minus diesel and tolls"
          value={formatUsd(trip.carrierNetUsd)}
          tone={trip.carrierNetUsd < 0 ? "text-risk" : "text-fg"}
          note={miles ? formatPerMile(trip.carrierNetUsd / miles) : null}
        />
        {trip.deliveryAt && <Line label="Delivery appt" hint="The delivery appointment in the TMS" value={formatDateTime(trip.deliveryAt)} />}
        <Line label="Legal ETA" hint="Earliest delivery within hours-of-service rules" value={formatDateTime(trip.legalEtaAt)} />
        {/* Its own row: next to the label the narrow panel cut it off. */}
        {badge && (
          <div className="flex justify-end">
            <Badge tone={badge.tone}>{badge.text}</Badge>
          </div>
        )}
        <Line label="Net per hour" hint="Carrier net over driving and required rest" value={`${formatUsd(trip.netPerHour)}/h`} note={formatHours(trip.legalHours)} />
      </dl>
    </div>
  );
}

// Each call's last offer on the load, oldest first: the carrier ask and our counter on a scale
// from the posted rate to the highest ask (or the ceiling when every ask stayed under it).
function NegotiationPath({ path, postedRate, maxBuy, outcome }: { path: WallOffer[]; postedRate: number; maxBuy: number; outcome: LoadOutcome }) {
  const top = Math.max(maxBuy, ...path.map((offer) => offer.carrierAsk));
  const pct = (value: number) => percentOf(value, postedRate, top);
  const ceiling = pct(maxBuy);
  const last = path.at(-1);
  const result = outcomeLabel(outcome);
  // The agreed amount is on the receipt above; the result line only names the outcome.
  const resultText = outcome.kind === "booked" ? "Booked" : outcome.kind === "holding" ? "Holding" : result.text;
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex items-baseline justify-between text-[11px]">
        <h4 className="font-semibold uppercase tracking-wide text-fg-faint">Negotiation</h4>
        <span className="flex gap-2">
          <span className="text-warn">Ask</span>
          <span className="text-accent">Counter</span>
          <span className="text-fg-faint">| Ceiling</span>
        </span>
      </div>
      <ol className="flex flex-col gap-1">
        {path.map((offer) => {
          const ask = pct(offer.carrierAsk);
          const counter = offer.rateToSay === null ? null : pct(offer.rateToSay);
          const from = counter === null ? ask : Math.min(ask, counter);
          const to = counter === null ? ask : Math.max(ask, counter);
          return (
            <li key={offer.createdAt} className="grid grid-cols-[4.5rem_minmax(0,1fr)_3.25rem] items-center gap-2 text-[11px]">
              <span className="tabular truncate text-fg-muted">
                R{offer.round} <span className="text-fg-faint">{formatClock(offer.createdAt)}</span>
              </span>
              <span className="relative h-3" aria-hidden>
                <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line" />
                <span className="absolute top-1/2 h-1 -translate-y-1/2 bg-warn-soft" style={{ left: `${from}%`, width: `${to - from}%` }} />
                <span className="absolute inset-y-0 w-px bg-fg-faint" style={{ left: `${ceiling}%` }} />
                {counter !== null && <span className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-accent" style={{ left: `${counter}%` }} />}
                <span className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-warn" style={{ left: `${ask}%` }} />
              </span>
              <span className="tabular text-right text-warn">{formatUsd(offer.carrierAsk)}</span>
            </li>
          );
        })}
      </ol>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-fg-muted">Result</span>
        <span className={`tabular font-medium ${result.tone}`}>
          {resultText}
          {last && (outcome.kind === "booked" || outcome.kind === "holding") && <span className="font-normal text-fg-faint"> in R{last.round}</span>}
        </span>
      </div>
    </div>
  );
}

// Operator only: the load's max buy is on screen here and nowhere the agent can reach.
// The pricing card of the load on the table: the meter from posted to ceiling, a receipt of the
// numbers top to bottom, and the negotiation that led here.
export function MarginMeter({
  offer,
  authorizedUsd,
  agreedRate,
  trip,
  path,
  outcome,
}: {
  offer: WallOffer;
  // Authorizations on the load not yet priced into the latest counter.
  authorizedUsd: number;
  // Set while the load is held or booked on this call.
  agreedRate: number | null;
  // The trip estimate of that hold, when it has one.
  trip: TripSnapshot | null;
  // Every recorded offer on this load with this carrier, oldest first.
  path: WallOffer[];
  outcome: LoadOutcome;
}) {
  const reduce = useReducedMotion();
  const spring = reduce ? { duration: 0 } : { type: "spring" as const, stiffness: 140, damping: 22 };
  const { postedRate, maxBuy } = offer;
  const miles = offer.lane?.miles ?? null;

  const rounds = (
    <span className="flex items-center gap-1" aria-label={`Round ${offer.round} of ${finalRound}`}>
      {Array.from({ length: finalRound }, (_, index) => index + 1).map((round) => (
        <span
          key={round}
          className={`tabular rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
            round === offer.round ? "bg-accent-soft text-accent" : round < offer.round ? "text-fg-muted" : "text-fg-faint"
          }`}
        >
          R{round}
        </span>
      ))}
    </span>
  );

  const aside = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="tabular truncate text-xs text-fg-muted">{offer.loadId}</span>
      {rounds}
    </span>
  );

  if (postedRate === null || maxBuy === null) {
    return (
      <Section icon={LuReceipt} title="Pricing" aside={aside}>
        <p className="text-xs text-fg-faint">Rates were not recorded for this offer.</p>
      </Section>
    );
  }

  const ourRate = agreedRate ?? offer.rateToSay;
  const pct = (value: number) => percentOf(value, postedRate, maxBuy);
  const ourPct = ourRate === null ? 0 : pct(ourRate);
  const authorizedTop = ourRate === null ? null : Math.min(maxBuy, ourRate + authorizedUsd);
  const bandWidth = authorizedTop === null || authorizedUsd <= 0 ? 0 : pct(authorizedTop) - ourPct;
  const askPct = pct(offer.carrierAsk);
  const askAbove = offer.carrierAsk > maxBuy;
  const askBelow = offer.carrierAsk < postedRate;

  const agreed = agreedRate !== null;
  const receipt = pricingBreakdown({
    postedRate,
    maxBuy,
    miles,
    path: path.length > 0 ? path : [offer],
    agreedRate,
    latestAsk: offer.carrierAsk,
  });
  const mile = (value: number | null) => (value === null ? null : formatPerMile(value));

  return (
    <Section icon={LuReceipt} title="Pricing" aside={aside}>
      <div className="flex flex-col gap-4">
        <div className="relative pt-5 pb-5">
          {/* Carrier ask above the track; clamped with an arrow when it is off the scale. */}
          <Pinned at={askPct} className="top-0 flex items-center gap-0.5 text-warn">
            {askBelow && <LuChevronLeft size={10} aria-hidden />}
            <span>Ask{askAbove && " over ceiling"}</span>
            {askAbove && <LuChevronRight size={10} aria-hidden />}
          </Pinned>

          <div className="relative h-2 overflow-hidden rounded-full bg-line">
            <motion.div
              className={`absolute inset-y-0 left-0 ${agreedRate !== null ? "bg-ok" : "bg-accent"}`}
              initial={false}
              animate={{ width: `${ourPct}%` }}
              transition={spring}
            />
            <motion.div
              className="absolute inset-y-0 bg-accent-soft outline outline-1 -outline-offset-1 outline-accent/60"
              initial={false}
              animate={{ left: `${ourPct}%`, width: `${bandWidth}%` }}
              transition={spring}
              aria-hidden
            />
          </div>

          <motion.span
            className="absolute top-4 h-4 w-0.5 -translate-x-1/2 rounded-full bg-warn"
            initial={false}
            animate={{ left: `${askPct}%` }}
            transition={spring}
            aria-hidden
          />

          {ourRate !== null && (
            <Pinned at={ourPct} className={`bottom-0 ${agreedRate !== null ? "text-ok" : "text-accent"}`}>
              {agreedRate !== null ? "Agreed" : "Counter"}
              {authorizedUsd > 0 && agreedRate === null && <span className="text-fg-muted"> + authorized</span>}
            </Pinned>
          )}
        </div>

        <dl className="flex flex-col gap-1.5 text-xs">
          <Line label="Posted" hint="Approximate cost: the posted rate" value={formatUsd(postedRate)} note={mile(receipt.posted.perMile)} />
          <Line label="Ceiling" hint="Max buy for this load" value={formatUsd(maxBuy)} note={mile(receipt.ceiling.perMile)} />
          <Line label="Headroom" hint="Ceiling minus posted" value={formatUsd(receipt.headroom)} />
          {receipt.openingAsk && (
            <Line label={`Opening ask R${receipt.openingAsk.round}`} hint="The carrier's first ask on this load" value={formatUsd(receipt.openingAsk.usd)} tone="text-warn" />
          )}
          {receipt.counters.map((counter) => (
            <Line key={counter.at} label={`R${counter.round} counter`} value={formatUsd(counter.usd)} tone="text-accent" />
          ))}
          {agreedRate === null && authorizedUsd > 0 && (
            <Line label="Authorized" hint="Raised by an operator, not yet offered" value={formatSignedUsd(authorizedUsd)} tone="text-accent" />
          )}
          <Line
            label={agreed ? "Agreed" : "Latest ask"}
            value={formatUsd(receipt.final.usd)}
            tone={agreed ? "font-semibold text-fg" : "text-warn"}
            note={mile(receipt.final.perMile)}
          />
          <Line label="Over posted" hint={agreed ? "Agreed minus posted" : "Latest ask minus posted"} value={formatSignedUsd(receipt.overPosted)} />
          <Line
            total
            label={agreed ? "Margin kept" : "Margin at ask"} hint={agreed ? "Ceiling minus agreed" : "Ceiling minus latest ask"}
            value={formatUsd(receipt.margin.usd)}
            tone={receipt.margin.usd < 0 ? "text-risk" : "text-ok"}
            note={formatPercent(receipt.margin.pct)}
          />
          <Line
            label="Headroom kept" hint="Margin as a share of the headroom"
            value={receipt.headroomSharePct === null ? "-" : `${Math.round(receipt.headroomSharePct)}%`}
            tone={receipt.headroomSharePct !== null && receipt.headroomSharePct < 0 ? "text-risk" : "text-fg"}
          />
        </dl>

        {trip && <TripBlock trip={trip} miles={miles} />}

        {path.length > 0 && <NegotiationPath path={path} postedRate={postedRate} maxBuy={maxBuy} outcome={outcome} />}
      </div>
    </Section>
  );
}
