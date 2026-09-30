"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IconType } from "react-icons";
import {
  LuArrowLeft,
  LuChevronRight,
  LuCircleCheck,
  LuCircleX,
  LuHand,
  LuHistory,
  LuLightbulb,
  LuPhone,
  LuPhoneCall,
  LuPhoneOff,
  LuRoute,
} from "react-icons/lu";
import { Badge } from "@/components/inbox/stage-pill";
import { growthStyle, NetworkChips, reasonStyle, trendStyle } from "@/components/network/network-chips";
import type { NetworkCarrier, TowerCall, TowerCarrierCalls, TowerDemand, TowerNetwork } from "@/lib/contracts";
import { carrierName, equipmentLabel, formatDateTime, formatTimeAgo } from "@/lib/format";
import {
  callOutcome,
  callsTrend,
  carrierDecision,
  carrierLanes,
  demandHref,
  inboxHref,
  networkReasons,
  recentDays,
  type CallOutcome,
  type CarrierLane,
} from "@/lib/network";
import { useNow } from "@/lib/use-now";
import { usePoll } from "@/lib/use-poll";

// The network and demand change with calls; the calls poll faster so a live call shows soon.
const networkPollMs = 30_000;
const callsPollMs = 15_000;
// The timeline shows the latest calls; the rest wait behind "Show N more".
const shownCalls = 8;

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

function BackLink() {
  const router = useRouter();
  return (
    <Link
      href="/carriers"
      // Back keeps the list's view, filters and scroll; a link opened on its own falls back to the list.
      onClick={(event) => {
        if (window.history.length <= 1) return;
        event.preventDefault();
        router.back();
      }}
      className="inline-flex items-center gap-1.5 text-sm text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <LuArrowLeft size={14} aria-hidden />
      Carriers
    </Link>
  );
}

function SectionTitle({ icon: Icon, title, aside }: { icon: IconType; title: string; aside?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Icon size={15} className="text-fg-muted" aria-hidden />
        {title}
      </h2>
      {aside}
    </div>
  );
}

// Who the carrier is in three lines: name and status pills, its numbers and last call.
function Header({ carrier, now }: { carrier: NetworkCarrier; now: number }) {
  const name = carrierName(carrier);
  // The meta line never repeats what the name already says.
  const numbers = [carrier.mcNumber && `MC ${carrier.mcNumber}`, carrier.dotNumber && `DOT ${carrier.dotNumber}`].filter(
    (part): part is string => Boolean(part) && part !== name,
  );
  return (
    <header>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">{name}</h1>
        <NetworkChips carrier={carrier} size="md" />
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-fg-muted">
        {numbers.map((part) => (
          <span key={part} className="font-mono text-xs">
            {part}
            <span className="ml-2 font-sans text-fg-faint">·</span>
          </span>
        ))}
        <span title={formatDateTime(carrier.facts.lastCallAt)}>last call {formatTimeAgo(carrier.facts.lastCallAt, now)} ago</span>
        <span className="text-fg-faint">·</span>
        {carrier.eligible ? <span>Eligible</span> : <span className="text-risk">Not eligible</span>}
      </p>
    </header>
  );
}

function WhyHere({ carrier, now }: { carrier: NetworkCarrier; now: number }) {
  const reasons = networkReasons(carrier, now, { since: "", from: "", to: "" });
  // A plain active carrier has nothing to explain; the decision card already says so.
  if (reasons.every((reason) => reason.kind === "active")) return null;
  return (
    <section aria-label="Why it's here">
      <SectionTitle icon={LuLightbulb} title="Why it's here" />
      <ul className="flex flex-col gap-2 text-sm text-fg">
        {reasons.map((reason) => {
          const { icon: Icon, iconTone, label } = reasonStyle[reason.kind];
          return (
            <li key={reason.kind} className="flex min-w-0 items-start gap-2">
              <Icon size={15} className={`mt-0.5 shrink-0 ${iconTone}`} aria-hidden />
              <span className="min-w-0">
                <span className="sr-only">{label}: </span>
                {reason.text}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const outcomeStyle: Record<CallOutcome["kind"], { icon: IconType; tone: string }> = {
  live: { icon: LuPhoneCall, tone: "text-tone-green" },
  booked: { icon: LuCircleCheck, tone: "text-tone-emerald" },
  holding: { icon: LuHand, tone: "text-tone-amber" },
  lost: { icon: LuCircleX, tone: "text-tone-gray" },
  no_offer: { icon: LuPhoneOff, tone: "text-tone-gray" },
};

// The load a call was about: the held one, else the last one offered.
function callTitle(call: TowerCall): string {
  const load = call.hold ?? call.offers.at(-1);
  const parts = [formatDateTime(call.createdAt)];
  if (load) parts.push(load.loadId);
  if (load?.lane) parts.push(`${load.lane.origin.state} → ${load.lane.destination.state} ${equipmentLabel(load.lane.equipment)}`);
  return parts.join(" · ");
}

// An icon gutter with a connector line to the next call, then the call's title and how it ended.
function TimelineCall({ call, last }: { call: TowerCall; last: boolean }) {
  const outcome = callOutcome(call);
  const { icon: Icon, tone } = outcomeStyle[outcome.kind];
  return (
    <li className="flex items-start gap-2">
      <div className="flex flex-col items-center self-stretch">
        <span className="grid size-6 shrink-0 place-items-center">
          <Icon size={14} className={tone} aria-hidden />
        </span>
        {!last && <span className="w-px flex-1 bg-line-strong" aria-hidden />}
      </div>
      <div className={`min-w-0 flex-1 pt-0.5 ${last ? "" : "pb-5"}`}>
        <p className="truncate text-sm font-medium text-fg">{callTitle(call)}</p>
        <p className="mt-0.5 text-xs text-fg-muted">{outcome.text}</p>
      </div>
    </li>
  );
}

function RecentCalls({ calls }: { calls: TowerCall[] }) {
  const [expanded, setExpanded] = useState(false);
  if (calls.length === 0) return null;
  const shown = expanded ? calls : calls.slice(0, shownCalls);
  const hidden = calls.length - shown.length;
  return (
    <section aria-label="Recent calls">
      <SectionTitle icon={LuHistory} title="Recent calls" />
      <ol>
        {shown.map((call, i) => (
          <TimelineCall key={call.callId} call={call} last={i === shown.length - 1} />
        ))}
      </ol>
      {hidden > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="mt-3 ml-8 cursor-pointer text-sm font-medium text-accent hover:underline">
          Show {hidden} more
        </button>
      )}
    </section>
  );
}

function LaneRow({ lane }: { lane: CarrierLane }) {
  const body = (
    <>
      <span className="min-w-0 truncate font-medium text-fg">
        {lane.originState ?? "Any"} → {lane.destinationState ?? "Any"}
        <span className="font-normal text-fg-muted"> · {lane.equipment ? equipmentLabel(lane.equipment) : "Any equipment"}</span>
      </span>
      <span className="min-w-0 flex-1" />
      {lane.calls !== null && <span className="tabular shrink-0 text-xs text-fg-muted">{plural(lane.calls, "call")}</span>}
      {lane.open && (
        <Badge tone={growthStyle.pill}>
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          Open now
        </Badge>
      )}
      {lane.unmet > 0 && (
        <>
          <span className="tabular shrink-0 text-xs text-fg-muted">{plural(lane.unmet, "unmet ask")}</span>
          <LuChevronRight size={15} className="shrink-0 text-fg-faint" aria-hidden />
        </>
      )}
    </>
  );
  const rowClass = "flex h-10 min-w-0 items-center gap-3 px-3 text-sm";
  if (lane.unmet === 0) return <li className={rowClass}>{body}</li>;
  // The originState of an unmet lane always comes from demand, which never leaves it out.
  return (
    <li>
      <Link
        href={demandHref({ originState: lane.originState ?? "", destinationState: lane.destinationState, equipment: lane.equipment })}
        className={`${rowClass} outline-none transition-colors hover:bg-panel-raised focus-visible:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset`}
      >
        {body}
      </Link>
    </li>
  );
}

function Lanes({ lanes }: { lanes: CarrierLane[] }) {
  if (lanes.length === 0) return null;
  return (
    <section aria-label="Lanes it runs">
      <SectionTitle icon={LuRoute} title="Lanes it runs" />
      <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
        {lanes.map((lane) => (
          <LaneRow key={lane.key} lane={lane} />
        ))}
      </ul>
    </section>
  );
}

// The one thing to do with this carrier: a neutral card with the decision, why, and its one button.
function DecisionCard({ carrier, now }: { carrier: NetworkCarrier; now: number }) {
  const decision = carrierDecision(carrier, now);
  const { icon: Icon, iconTone } = reasonStyle[decision.kind];
  return (
    <section aria-label={decision.title} className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line bg-panel-raised px-3 py-2.5">
        <Icon size={15} className={iconTone} aria-hidden />
        <h2 className="text-sm font-medium text-fg">{decision.title}</h2>
      </div>
      <div className="flex flex-col gap-3 p-3">
        <p className="text-sm text-fg-muted">{decision.sentence}</p>
        <Link
          href={inboxHref(carrier, now)}
          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-white outline-none transition-colors hover:bg-accent/90 focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <LuPhone size={14} aria-hidden />
          Open call history
        </Link>
      </div>
    </section>
  );
}

function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-4 text-sm">
      <span className="shrink-0 text-fg-muted">{label}</span>
      <span className="min-w-0 text-right font-medium text-fg">{children}</span>
    </div>
  );
}

function Facts({ carrier }: { carrier: NetworkCarrier }) {
  const { facts } = carrier;
  const trend = trendStyle[callsTrend(carrier)];
  const TrendIcon = trend.icon;
  return (
    <section aria-label="Facts" className="flex flex-col gap-1">
      <KeyValue label="Calls in 30 d">
        <span className="tabular">{facts.calls}</span>
      </KeyValue>
      <KeyValue label="Booked in 30 d">
        <span className="tabular">{facts.bookings}</span>
      </KeyValue>
      <KeyValue label="Load searches">
        <span className="tabular">{facts.searches}</span>
      </KeyValue>
      <KeyValue label="Loads negotiated">
        <span className="tabular">{facts.loadsNegotiated}</span>
      </KeyValue>
      <KeyValue label="All time">
        {plural(facts.lifetimeCalls, "call")} · {facts.lifetimeBookings} booked
      </KeyValue>
      <KeyValue label="Trend">
        <span
          className="inline-flex items-center gap-1"
          title={`${facts.callsRecent} in the last ${recentDays} d vs ${facts.callsPrior} in the ${recentDays} d before`}
        >
          <TrendIcon size={14} className={trend.tone} aria-hidden />
          {trend.word}
        </span>
      </KeyValue>
    </section>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-8 py-8">
        <BackLink />
        <p className="mt-10 text-center text-sm text-fg-muted">{children}</p>
      </div>
    </div>
  );
}

// One carrier on its own page: the story on the left (why it is listed, its calls, its lanes), the
// state and the one decision on the right. The network row is the default 30-day window, which
// always holds an at-risk carrier; the calls are its latest regardless of window.
export function CarrierPage({ carrierKey }: { carrierKey: string }) {
  const now = useNow();
  const encoded = encodeURIComponent(carrierKey);
  const network = usePoll<TowerNetwork>(`/api/network?${new URLSearchParams({ view: "all", key: carrierKey }).toString()}`, networkPollMs, "carrier network");
  const calls = usePoll<TowerCarrierCalls>(`/api/carriers/${encoded}/calls`, callsPollMs, "call list");
  const demand = usePoll<TowerDemand>(`/api/demand?${new URLSearchParams({ carrier: carrierKey }).toString()}`, networkPollMs, "demand");

  const carrier = network.data?.rows[0];
  if (!carrier) {
    if (network.data) return <Notice>No carrier with this key.</Notice>;
    return <Notice>{network.loading ? "Loading carrier..." : "The carrier network is unavailable. It retries every few seconds."}</Notice>;
  }

  const lanes = carrierLanes(carrier.lanes, demand.data?.rows ?? []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-8 py-8">
        <BackLink />
        <div className="mt-4">
          <Header carrier={carrier} now={now} />
        </div>

        <div className="mt-8 flex items-start gap-8">
          <div className="flex min-w-0 flex-1 flex-col gap-10">
            <WhyHere carrier={carrier} now={now} />
            <RecentCalls calls={calls.data?.calls ?? []} />
            <Lanes lanes={lanes} />
          </div>
          <aside aria-label="Carrier state" className="flex w-80 shrink-0 flex-col gap-6">
            <DecisionCard carrier={carrier} now={now} />
            <Facts carrier={carrier} />
          </aside>
        </div>
      </div>
    </div>
  );
}
