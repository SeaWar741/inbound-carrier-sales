"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { IconType } from "react-icons";
import { LuArrowLeft, LuBadgeDollarSign, LuListChecks, LuSearch } from "react-icons/lu";
import { DemandCarriers } from "@/components/demand/demand-carriers";
import { Pill, trendStyle } from "@/components/demand/demand-parts";
import type { DemandLane as DemandLaneRow, TowerDemand } from "@/lib/contracts";
import { demandKey, demandNextStep, demandSignal, demandTrend, demandUnmet, laneTitle, type DemandNextStep } from "@/lib/demand";
import { usePoll } from "@/lib/use-poll";

type LaneId = Pick<DemandLaneRow, "originState" | "destinationState" | "equipment">;

// Demand builds up over days, not seconds.
const demandPollMs = 60_000;

const nextStepIcon: Record<DemandNextStep["kind"], IconType> = { source: LuSearch, rate: LuBadgeDollarSign, both: LuListChecks };

// Back to the list the operator came from, filters and scroll kept; a lane opened from a pasted link
// has nothing to go back to, so it goes to the list.
export function BackToDemand() {
  const router = useRouter();
  return (
    <Link
      href="/demand"
      onClick={(event) => {
        if (window.history.length <= 1) return;
        event.preventDefault();
        router.back();
      }}
      className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-sm text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <LuArrowLeft size={14} aria-hidden />
      Demand
    </Link>
  );
}

// The frame every state of the lane page shares: centered, with the back link on top.
export function LaneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-8 py-6">
        <BackToDemand />
        {children}
      </div>
    </div>
  );
}

// Label muted on the left, value on the right, one fact per row.
function Fact({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-4 text-xs">
      <span className="text-fg-muted">{label}</span>
      <span className="tabular font-medium text-fg">{value}</span>
    </div>
  );
}

// The one thing to do about the lane: a header strip naming it and one sentence saying why.
function NextStepCard({ step }: { step: DemandNextStep }) {
  const Icon = nextStepIcon[step.kind];
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line bg-panel-raised px-3 py-2.5">
        <Icon size={15} className="shrink-0 text-fg-muted" aria-hidden />
        <span className="text-sm font-medium text-fg">{step.title}</span>
      </div>
      <p className="p-3 text-xs text-fg-muted">{step.body}</p>
    </div>
  );
}

function LaneBody({ row }: { row: DemandLaneRow }) {
  const { trend, text } = demandTrend(row);
  const style = trendStyle[trend];
  const step = demandNextStep(row);
  return (
    <>
      <div className="mt-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight text-fg">{laneTitle(row)}</h1>
          <Pill tone="bg-tone-amber-soft text-tone-amber">{demandUnmet(row)} unmet</Pill>
          <span title={`Unmet this week vs last week: ${text}`}>
            <Pill icon={style.icon} tone={style.pill}>
              {style.word}
            </Pill>
          </span>
        </div>
        <p className="mt-2 text-sm text-fg-muted">{demandSignal(row, { asked: true })} · last 4 weeks</p>
      </div>

      <div className="mt-8 flex items-start gap-6">
        <div className="min-w-0 flex-1">
          <DemandCarriers key={demandKey(row)} lane={row} />
        </div>
        <aside aria-label="Lane state" className="flex w-80 shrink-0 flex-col gap-5">
          {step && <NextStepCard step={step} />}
          <div className="flex flex-col gap-1">
            <Fact label="Searches" value={row.searches} />
            <Fact label="No match" value={row.noMatch} />
            <Fact label="Offered, no booking" value={row.offeredNoBooking} />
            <Fact label="This week" value={row.thisWeek} />
            <Fact label="Last week" value={row.previousWeek} />
          </div>
        </aside>
      </div>
    </>
  );
}

// One lane carriers asked for: what went unmet, who asked, and what to do about it. The lane's
// counts are the list's row for it, read by its exact key.
export function DemandLane({ lane }: { lane: LaneId }) {
  const { data, loading } = usePoll<TowerDemand>(`/api/demand?${new URLSearchParams({ lane: demandKey(lane) }).toString()}`, demandPollMs, "demand data");
  const row = data?.rows.find((candidate) => demandKey(candidate) === demandKey(lane)) ?? null;

  let body: React.ReactNode;
  if (row) {
    body = <LaneBody row={row} />;
  } else if (data === null && loading) {
    body = (
      <div aria-hidden className="mt-4 space-y-3">
        <div className="h-8 w-80 animate-pulse rounded-md bg-panel-raised" />
        <div className="h-4 w-96 animate-pulse rounded-md bg-panel-raised" />
      </div>
    );
  } else {
    body = (
      <div className="mt-4">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">{laneTitle(lane)}</h1>
        <p className="mt-2 text-sm text-fg-muted">
          {data === null ? "The demand data is unavailable. It retries every few seconds." : "No unmet asks on this lane in the last 4 weeks."}
        </p>
      </div>
    );
  }
  return <LaneFrame>{body}</LaneFrame>;
}
