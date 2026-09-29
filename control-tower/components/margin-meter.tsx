"use client";

import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { finalRound, type WallOffer } from "@/lib/contracts";
import { formatUsd } from "@/lib/format";

// Position on the posted-to-max-buy scale as a percentage, clamped to the track.
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

// Operator only: the load's max buy is on screen here and nowhere the agent can reach.
export function MarginMeter({
  offer,
  authorizedUsd,
  agreedRate,
}: {
  offer: WallOffer;
  // Authorizations on the load not yet priced into the latest counter.
  authorizedUsd: number;
  // Set while the load is held or booked on this call.
  agreedRate: number | null;
}) {
  const reduce = useReducedMotion();
  const spring = reduce ? { duration: 0 } : { type: "spring" as const, stiffness: 140, damping: 22 };
  const { postedRate, maxBuy } = offer;

  if (postedRate === null || maxBuy === null) {
    return <p className="px-3 py-3 text-xs text-fg-faint">Rates were not recorded for this offer.</p>;
  }

  const ourRate = agreedRate ?? offer.rateToSay;
  const pct = (value: number) => percentOf(value, postedRate, maxBuy);
  const ourPct = ourRate === null ? 0 : pct(ourRate);
  const authorizedTop = ourRate === null ? null : Math.min(maxBuy, ourRate + authorizedUsd);
  const bandWidth = authorizedTop === null || authorizedUsd <= 0 ? 0 : pct(authorizedTop) - ourPct;
  const askPct = pct(offer.carrierAsk);
  const askAbove = offer.carrierAsk > maxBuy;
  const askBelow = offer.carrierAsk < postedRate;
  const marginKept = ourRate === null ? null : maxBuy - ourRate;

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-fg-faint">Margin</h3>
        <span className="tabular text-xs text-fg-muted">{offer.loadId}</span>
      </div>

      <div className="relative pt-5 pb-5">
        {/* Carrier ask above the track; clamped with an arrow when it is off the scale. */}
        <Pinned at={askPct} className="top-0 flex items-center gap-0.5 text-warn">
          {askBelow && <CaretLeft size={10} weight="bold" aria-hidden />}
          <span>
            Ask <span className="tabular">{formatUsd(offer.carrierAsk)}</span>
            {askAbove && " over max"}
          </span>
          {askAbove && <CaretRight size={10} weight="bold" aria-hidden />}
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
            {agreedRate !== null ? "Agreed" : "Counter"} <span className="tabular">{formatUsd(ourRate)}</span>
            {authorizedUsd > 0 && agreedRate === null && (
              <span className="text-fg-muted">
                {" "}
                + <span className="tabular">{formatUsd(authorizedUsd)}</span> authorized
              </span>
            )}
          </Pinned>
        )}
      </div>

      <div className="flex justify-between text-[11px] text-fg-faint">
        <span>
          Posted <span className="tabular text-fg-muted">{formatUsd(postedRate)}</span>
        </span>
        <span>
          Max buy <span className="tabular text-fg-muted">{formatUsd(maxBuy)}</span>
        </span>
      </div>

      <div className="flex items-center justify-between border-t border-line pt-2">
        <span className="text-xs text-fg-muted">
          Margin kept{" "}
          <span className="tabular text-sm font-semibold text-ok">{marginKept === null ? "-" : formatUsd(marginKept)}</span>
        </span>
        <span className="flex items-center gap-1" aria-label={`Round ${offer.round} of ${finalRound}`}>
          {Array.from({ length: finalRound }, (_, index) => index + 1).map((round) => (
            <span
              key={round}
              className={`tabular rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
                round === offer.round
                  ? "bg-accent-soft text-accent"
                  : round < offer.round
                    ? "text-fg-muted"
                    : "text-fg-faint"
              }`}
            >
              R{round}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
