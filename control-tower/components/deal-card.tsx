"use client";

import type { IconType } from "react-icons";
import {
  LuBuilding2,
  LuCircleCheck,
  LuCircleX,
  LuClock,
  LuCoins,
  LuFuel,
  LuHand,
  LuHandshake,
  LuHeadset,
  LuHourglass,
  LuLock,
  LuMail,
  LuMessageSquare,
  LuRoute,
  LuTruck,
  LuUndo2,
} from "react-icons/lu";
import { holdNotice } from "@/components/hold-card";
import { Badge } from "@/components/inbox/stage-pill";
import { Section } from "@/components/section";
import type { TowerCall, TripSnapshot } from "@/lib/contracts";
import {
  arrivalText,
  carrierEarnings,
  dealEnd,
  dealRounds,
  dealStatus,
  ourEarnings,
  priceBar,
  type BarLabel,
  type DealEnd,
  type DealRound,
  type DealStatus,
  type EarningsRow,
} from "@/lib/deal";
import { formatDateTime, formatPerMile, formatUsd } from "@/lib/format";
import { perMile } from "@/lib/pricing";

// Same tones the hold chips used, one per way a deal can stand.
const statusChip: Record<DealStatus, { text: string; tone: string; icon: IconType }> = {
  booked: { text: "Booked", tone: "bg-ok-soft text-ok", icon: LuCircleCheck },
  booked_unconfirmed: { text: "Booked, unconfirmed", tone: "bg-warn-soft text-warn", icon: LuCircleCheck },
  held: { text: "On hold", tone: "bg-accent-soft text-accent", icon: LuHand },
  confirming: { text: "Booking", tone: "bg-warn-soft text-warn", icon: LuLock },
  released: { text: "Released", tone: "bg-line text-fg-muted", icon: LuUndo2 },
  negotiating: { text: "Negotiating", tone: "bg-accent-soft text-accent", icon: LuHandshake },
  no_deal: { text: "No deal", tone: "bg-line text-fg-muted", icon: LuCircleX },
};

const toneText = { ok: "text-ok", warn: "text-warn", risk: "text-risk" };

// One line of the card: a 14px muted icon in the left column, then the words.
function Line({ icon: Icon, className = "text-fg", children }: { icon: IconType; className?: string; children: React.ReactNode }) {
  return (
    <div className={`flex items-start gap-2 text-xs ${className}`}>
      <Icon size={14} className="mt-px shrink-0 text-fg-faint" aria-hidden />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Subhead({ icon: Icon, children }: { icon: IconType; children: React.ReactNode }) {
  return (
    <h4 className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">
      <Icon size={14} aria-hidden />
      {children}
    </h4>
  );
}

const labelStyle: Record<BarLabel["kind"], { name: string; tone: string }> = {
  posted: { name: "Posted", tone: "text-fg-muted" },
  ours: { name: "", tone: "" },
  max: { name: "Our max", tone: "text-fg" },
  ask: { name: "Carrier asked", tone: "text-warn" },
};

// A two-line label pinned over its spot on the track; it shifts by its own position so it never
// spills past either end.
function BarLabelText({ label, name, tone }: { label: BarLabel; name: string; tone: string }) {
  return (
    <span
      className={`absolute flex flex-col whitespace-nowrap leading-tight ${label.row === "above" ? "bottom-0" : "top-0"}`}
      style={{ left: `${label.at}%`, transform: `translateX(-${label.at}%)`, alignItems: label.at < 50 ? "flex-start" : "flex-end" }}
    >
      {label.row === "below" && <span className={`tabular text-[11px] font-medium ${tone}`}>{formatUsd(label.usd)}</span>}
      <span className="text-[10px] text-fg-faint">{name}</span>
      {label.row === "above" && <span className={`tabular text-[11px] font-medium ${tone}`}>{formatUsd(label.usd)}</span>}
    </span>
  );
}

// Posted to our max on one track, stretched in the risk tone past our max when the carrier asked
// for more; our number fills from posted and the carrier's ask is a caret under the track.
function PriceBar({ posted, max, ours, oursName, agreed, ask }: { posted: number; max: number; ours: number | null; oursName: string; agreed: boolean; ask: number | null }) {
  const bar = priceBar({ posted, max, ours, ask });
  const above = bar.labels.filter((label) => label.row === "above");
  const below = bar.labels.filter((label) => label.row === "below");
  const style = (label: BarLabel) =>
    label.kind === "ours" ? { name: oursName, tone: agreed ? "text-ok" : "text-accent" } : labelStyle[label.kind];
  const askLabel = bar.labels.find((label) => label.kind === "ask");
  return (
    <div role="img" aria-label={bar.labels.map((label) => `${style(label).name} ${formatUsd(label.usd)}`).join(", ")}>
      <div className="relative h-7">
        {above.map((label) => (
          <BarLabelText key={label.kind} label={label} {...style(label)} />
        ))}
      </div>
      <div className="relative my-1.5 h-2 rounded-full bg-line">
        {bar.maxAt < 100 && <span className="absolute inset-y-0 right-0 rounded-r-full bg-risk-soft" style={{ left: `${bar.maxAt}%` }} />}
        {bar.fill && (
          <span className={`absolute inset-y-0 rounded-full ${agreed ? "bg-ok" : "bg-accent"}`} style={{ left: `${bar.fill.from}%`, width: `${bar.fill.to - bar.fill.from}%` }} />
        )}
        {bar.labels
          .filter((label) => label.kind !== "ask")
          .map((label) => (
            <span
              key={label.kind}
              className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel ${
                label.kind === "ours" ? (agreed ? "bg-ok" : "bg-accent") : label.kind === "max" ? "bg-fg" : "bg-fg-muted"
              }`}
              style={{ left: `${label.at}%` }}
            />
          ))}
        {askLabel && (
          <span
            className="absolute top-full mt-px size-0 -translate-x-1/2 border-x-4 border-b-[5px] border-x-transparent border-b-warn"
            style={{ left: `${askLabel.at}%` }}
          />
        )}
      </div>
      <div className="relative h-7">
        {below.map((label) => (
          <BarLabelText key={label.kind} label={label} {...style(label)} />
        ))}
      </div>
    </div>
  );
}

function RoundLine({ round, isLast, end }: { round: DealRound; isLast: boolean; end: DealEnd }) {
  const closes = isLast && end.kind === "deal" && round.decision === "accept";
  let reply: React.ReactNode;
  if (closes && end.kind === "deal") {
    reply = (
      <span className="inline-flex items-center gap-1 font-medium text-ok">
        <LuCircleCheck size={12} aria-hidden />
        Deal{end.amount !== round.carrierAsk && <span className="tabular"> at {formatUsd(end.amount)}</span>}
      </span>
    );
  } else if (round.decision === "accept") {
    reply = <span className="tabular text-ok">We said yes at {formatUsd(round.ourOffer ?? round.carrierAsk)}</span>;
  } else if (round.ourOffer !== null) {
    reply = (
      <span>
        We offered <span className="tabular text-accent">{formatUsd(round.ourOffer)}</span>
      </span>
    );
  } else {
    reply = <span className="text-fg-muted">We said no</span>;
  }
  return (
    <li className="flex items-center gap-2 text-xs text-fg">
      <span className="tabular grid size-[14px] shrink-0 place-items-center rounded-full bg-line text-[9px] font-semibold text-fg-muted">{round.round}</span>
      <span className="min-w-0">
        Carrier <span className="tabular text-warn">{formatUsd(round.carrierAsk)}</span>
        <span className="text-fg-faint"> → </span>
        {reply}
      </span>
    </li>
  );
}

// The line after the rounds, unless the last round already closed the deal.
function EndLine({ end, closedInRound }: { end: DealEnd; closedInRound: boolean }) {
  switch (end.kind) {
    case "deal":
      if (closedInRound) return null;
      return (
        <Line icon={LuCircleCheck} className="font-medium text-ok">
          Deal at <span className="tabular">{formatUsd(end.amount)}</span>
        </Line>
      );
    case "released":
      return (
        <Line icon={LuUndo2} className="text-fg-muted">
          Deal at <span className="tabular">{formatUsd(end.amount)}</span>, then released
        </Line>
      );
    case "handed_to_rep":
      return <Line icon={LuHeadset}>Handed to a rep</Line>;
    case "passed":
      return (
        <Line icon={LuCircleX} className="text-fg-muted">
          Carrier passed
        </Line>
      );
    case "open":
      return (
        <Line icon={LuHourglass} className="text-fg-muted">
          Waiting for the carrier
        </Line>
      );
  }
}

// One "Who earns what" row: the amount in bold, its share muted, and the subtraction under it.
function EarnsLine({ icon: Icon, row }: { icon: IconType; row: EarningsRow }) {
  return (
    <div className={`flex items-start gap-2 text-xs ${row.loss ? "text-risk" : "text-fg"}`}>
      <Icon size={14} className="mt-px shrink-0 text-fg-faint" aria-hidden />
      <span className="min-w-0">
        {row.lead} <span className="tabular font-semibold">{row.amount}</span>
        <span className="tabular text-fg-muted"> · {row.pct}</span>
        <span className="tabular mt-0.5 block text-[11px] text-fg-faint">{row.note}</span>
      </span>
    </div>
  );
}

// Our headroom under the max and the carrier's take, side by side, so the deal reads at a glance.
function WhoEarnsWhat({ ours, carrier }: { ours: EarningsRow | null; carrier: EarningsRow | null }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <Subhead icon={LuCoins}>Who earns what</Subhead>
      {ours && <EarnsLine icon={LuBuilding2} row={ours} />}
      {carrier ? (
        <EarnsLine icon={LuTruck} row={carrier} />
      ) : (
        <Line icon={LuTruck} className="text-fg-muted">
          Carrier earnings not estimated for this load
        </Line>
      )}
    </div>
  );
}

// The held load's trip: diesel, tolls and whether it arrives on time. Estimates snapshotted when the
// hold was placed; what the carrier keeps from them is in "Who earns what". It sits in the rail
// between the load and the carrier record, since it describes the load, not the negotiation.
export function TripSection({ trip }: { trip: TripSnapshot }) {
  const arrival = arrivalText(trip);
  return (
    <Section icon={LuFuel} title="Trip estimate">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          <Line icon={LuFuel}>
            Diesel <span className="tabular">~{formatUsd(trip.dieselUsd)}</span>
          </Line>
          {trip.tollShare === null ? (
            <Line icon={LuRoute} className="text-fg-muted">
              Tolls not counted
            </Line>
          ) : (
            <Line icon={LuRoute}>
              Tolls <span className="tabular">~{formatUsd(trip.tollsUsd)}</span>
            </Line>
          )}
        </div>
        <Line icon={LuClock} className={toneText[arrival.tone]}>
          {arrival.text}
          <span className="tabular mt-0.5 block text-[11px] text-fg-faint">
            {trip.deliveryAt && <>Delivery {formatDateTime(trip.deliveryAt)} · </>}
            legal arrival {formatDateTime(trip.legalEtaAt)}
          </span>
        </Line>
      </div>
    </Section>
  );
}

// How the rounds on one load went, as its own rail section below the load: the deal card above says
// where it stands, this says how it got there.
export function HowItWent({ call, loadId }: { call: TowerCall; loadId: string }) {
  const end = dealEnd(call, loadId);
  const rounds = dealRounds(call.rounds.length > 0 ? call.rounds : call.offers, loadId);
  const last = rounds.at(-1) ?? null;
  return (
    <Section icon={LuMessageSquare} title="How it went">
      <div className="flex flex-col gap-1.5">
        {rounds.length === 0 ? (
          <p className="text-xs text-fg-faint">No offers were recorded on this call.</p>
        ) : (
          <>
            {rounds[0]!.round > 1 && <p className="text-[11px] text-fg-faint">Rounds before {rounds[0]!.round} are not shown.</p>}
            <ol className="flex flex-col gap-1.5">
              {rounds.map((round, index) => (
                <RoundLine key={`${round.round}-${index}`} round={round} isLast={index === rounds.length - 1} end={end} />
              ))}
            </ol>
          </>
        )}
        <EndLine end={end} closedInRound={last?.decision === "accept"} />
      </div>
    </Section>
  );
}

// Operator only: our max for the load is on screen here and nowhere the agent can reach.
// The selected call's deal on one load, top to bottom: where it stands, who earns what, the price
// bar, and whether the carrier was told. The rounds live in HowItWent, below the load.
export function DealCard({
  call,
  loadId,
  postedRate,
  maxBuy,
  miles,
  trip,
  action,
}: {
  call: TowerCall;
  loadId: string;
  postedRate: number | null;
  maxBuy: number | null;
  miles: number | null;
  // The trip estimate of this call's hold on the load, when it has one.
  trip: TripSnapshot | null;
  // The open hold's action card, drawn first because it is what the operator has to do.
  action?: React.ReactNode;
}) {
  const status = dealStatus(call, loadId);
  const rounds = dealRounds(call.rounds.length > 0 ? call.rounds : call.offers, loadId);
  const last = rounds.at(-1) ?? null;
  const hold = call.hold?.loadId === loadId ? call.hold : null;
  const chip = statusChip[status];
  const agreed = hold && status !== "released" ? hold.agreedRate : null;
  // Earnings at the agreed rate, or at our latest offer while the carrier is still on the line.
  const lastOffer = [...rounds].reverse().find((round) => round.ourOffer !== null)?.ourOffer ?? null;
  const ours = agreed !== null ? ourEarnings(maxBuy, agreed, "agreed") : status === "negotiating" ? ourEarnings(maxBuy, lastOffer, "offer") : null;
  const showEarnings = agreed !== null || ours !== null;
  const agreedPerMile = perMile(agreed, miles);
  const notice = hold && status !== "held" && status !== "confirming" ? holdNotice(call, hold) : null;

  let headline: React.ReactNode;
  if (agreed !== null) {
    headline = (
      <>
        <span className="text-base font-semibold text-fg">{formatUsd(agreed)} agreed</span>
        {agreedPerMile !== null && <span className="text-fg-muted"> · {formatPerMile(agreedPerMile)}</span>}
      </>
    );
  } else if (hold && status === "released") {
    headline = <span className="font-semibold text-fg-muted">{formatUsd(hold.agreedRate)} agreed, then released</span>;
  } else if (status === "negotiating") {
    headline = <span className="font-semibold text-fg">Negotiating{last && ` · round ${last.round}`}</span>;
  } else {
    headline = <span className="font-semibold text-fg-muted">No deal{last && ` after round ${last.round}`}</span>;
  }

  return (
    <Section
      icon={LuHandshake}
      title="Deal"
      aside={
        <Badge tone={chip.tone}>
          <chip.icon size={11} aria-hidden />
          {chip.text}
        </Badge>
      }
    >
      <div className="flex flex-col gap-3">
        {action}

        <div className="flex flex-col gap-1.5">
          <span className="tabular text-sm">{headline}</span>
          {/* Its own line: TMS references run long enough to push the rate off the headline. */}
          {hold?.bookingRef && (
            <span className="text-xs text-fg-muted">
              Booking ref <span className="tabular font-semibold text-fg">{hold.bookingRef}</span>
            </span>
          )}
        </div>

        {showEarnings && <WhoEarnsWhat ours={ours} carrier={carrierEarnings(agreed !== null ? trip : null)} />}

        {postedRate !== null && maxBuy !== null ? (
          <PriceBar
            posted={postedRate}
            max={maxBuy}
            ours={agreed ?? last?.ourOffer ?? null}
            oursName={agreed !== null ? "Agreed" : "We offered"}
            agreed={agreed !== null}
            ask={last?.carrierAsk ?? null}
          />
        ) : (
          <p className="text-xs text-fg-faint">Rates were not recorded for this load.</p>
        )}

        {notice?.summary ? (
          <Line icon={LuMail} className={notice.status === "sent" ? "text-fg-muted" : "text-warn"}>
            {notice.summary}
          </Line>
        ) : (
          status === "released" && (
            <Line icon={LuUndo2} className="text-fg-muted">
              The hold was released and the load is back on the board.
            </Line>
          )
        )}
      </div>
    </Section>
  );
}
