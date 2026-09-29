"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  LuArrowRight,
  LuBuilding2,
  LuChevronDown,
  LuChevronRight,
  LuMessageSquareText,
  LuPhone,
  LuTriangleAlert,
  LuTruck,
} from "react-icons/lu";
import { CallDetail } from "@/components/call-detail";
import { equipmentLabel } from "@/components/hold-card";
import { SkeletonRows } from "@/components/inbox/carrier-list";
import { Badge, CarrierStagePill } from "@/components/inbox/stage-pill";
import { LoadPanel } from "@/components/load-panel";
import { PulseDot } from "@/components/pulse-dot";
import type { TowerCall, TowerCarrier, TowerCarrierCalls, WallLane } from "@/lib/contracts";
import {
  callSummary,
  carrierId,
  carrierName,
  deskDayKey,
  formatDateTime,
  formatDeskWhen,
  formatPercent,
  formatPerMile,
  formatUsd,
  loadCards,
  outcomeLabel,
  type LoadCard,
} from "@/lib/format";
import { carrierPricing, loadOutcome, type LoadOutcome } from "@/lib/pricing";
import { usePoll } from "@/lib/use-poll";

const callsPollMs = 5_000;

// From 1720 px the carrier facts and the load get their own column (the call keeps ~560 px);
// narrower, they sit under the call instead of squeezing it.
const wideQuery = "(min-width: 1720px)";
function subscribeWide(onChange: () => void) {
  const media = window.matchMedia(wideQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(wideQuery).matches, () => false);
}

// The hold still waiting on the desk, newest first.
function openHold(calls: TowerCall[]) {
  for (const call of calls) {
    if (call.hold && (call.hold.status === "held" || call.hold.status === "confirming")) return call.hold;
  }
  return null;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-fg-muted">{label}</div>
      <div className="tabular truncate font-semibold text-fg">{children}</div>
    </div>
  );
}

// The cortex CRM card: an icon square and title over a two-column grid of facts. Every count reads
// the calls on file, so the card never mixes them with the list's `since` window.
function FactsCard({ carrier, calls }: { carrier: TowerCarrier | null; calls: TowerCall[] }) {
  const hold = openHold(calls);
  const pricing = useMemo(() => carrierPricing(calls), [calls]);
  const orDash = (value: number | null, format: (v: number) => string) => (value === null ? "-" : format(value));
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-sm">
      <div className="flex items-center gap-2 border-b border-line p-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <LuBuilding2 size={16} aria-hidden />
        </div>
        <div className="min-w-0 flex-1 text-sm font-semibold text-fg">Carrier record</div>
      </div>
      <div className="grid grid-cols-2 gap-3 p-3 text-xs">
        <Fact label="Calls">{calls.length}</Fact>
        <Fact label="Loads offered">{pricing.loadsOffered}</Fact>
        <Fact label="Next pickup">{carrier?.nextTrip?.pickupAt ? formatDateTime(carrier.nextTrip.pickupAt) : "-"}</Fact>
        <Fact label="ETA">{carrier?.nextTrip?.etaAt ? formatDateTime(carrier.nextTrip.etaAt) : "-"}</Fact>
        <div className="col-span-2 min-w-0">
          <div className="text-fg-muted">Open hold</div>
          <div className="tabular truncate font-semibold text-fg">
            {hold ? `${hold.loadId} at ${formatUsd(hold.agreedRate)}${hold.status === "confirming" ? ", confirming" : ""}` : "None"}
          </div>
        </div>
      </div>
      <div className="border-t border-line p-3">
        <h3 className="mb-2 text-[11px] font-medium tracking-wide text-fg-faint uppercase">Pricing with this carrier</h3>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <Fact label="Booked">
            {pricing.booked} of {pricing.loadsOffered}
            {pricing.bookingRate !== null && <span className="font-normal text-fg-muted"> ({formatPercent(pricing.bookingRate)})</span>}
          </Fact>
          <Fact label="Avg agreed $/mi">{orDash(pricing.avgAgreedPerMile, formatPerMile)}</Fact>
          <Fact label="Avg margin kept">{orDash(pricing.avgMarginKept, formatUsd)}</Fact>
          <Fact label="Avg round at agreement">{orDash(pricing.avgRoundsToAgree, (v) => `R${v.toFixed(1)}`)}</Fact>
        </div>
        <p className="mt-2 text-[11px] text-fg-faint">Across the {calls.length} calls on file.</p>
      </div>
    </div>
  );
}

function Aside({ carrier, calls, selected }: { carrier: TowerCarrier | null; calls: TowerCall[]; selected: TowerCall | null }) {
  return (
    <div className="space-y-3 p-3 pb-6">
      <FactsCard carrier={carrier} calls={calls} />
      <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-sm">
        <LoadPanel selectedCall={selected} history={calls} />
      </div>
    </div>
  );
}

const outcomeTone: Record<LoadOutcome["kind"], string> = {
  booked: "bg-ok-soft text-ok",
  holding: "bg-warn-soft text-warn",
  negotiating: "bg-accent-soft text-accent",
  lost: "bg-panel-raised text-fg-muted",
  no_offer: "bg-panel-raised text-fg-muted",
};

function laneOf(card: LoadCard<TowerCall>): WallLane | null {
  for (const call of card.calls) {
    const lane = call.offers.find((offer) => offer.loadId === card.loadId && offer.lane)?.lane ?? (call.hold?.loadId === card.loadId ? call.hold.lane : null);
    if (lane) return lane;
  }
  return null;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function CallRow({
  call,
  today,
  selected,
  takenOver,
  onSelect,
}: {
  call: TowerCall;
  today: string;
  selected: boolean;
  takenOver: boolean;
  onSelect: () => void;
}) {
  const summary = callSummary(call);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`flex w-full min-w-0 cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 ${
          selected || takenOver ? "bg-panel text-fg shadow-xs" : "text-fg-muted hover:bg-panel"
        }`}
      >
        <span className="tabular shrink-0 text-[11px] text-fg-faint">{formatDeskWhen(call.createdAt, today)}</span>
        <span className="min-w-0 flex-1 truncate">{summary ?? "No summary yet"}</span>
        {call.live && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-accent">
            {call.channel === "text" ? <LuMessageSquareText size={11} aria-hidden /> : <LuPhone size={11} aria-hidden />}
            Live
          </span>
        )}
        {takenOver && <span className="shrink-0 text-[11px] font-medium text-accent">You</span>}
      </button>
    </li>
  );
}

// One load with this carrier: where it stands, the lane, and how far the talks went. Only the
// selected card opens to list its calls.
function LoadCardView({
  card,
  calls,
  today,
  selectedCallId,
  takenOverCallId,
  onSelect,
  cardRef,
}: {
  card: LoadCard<TowerCall>;
  calls: TowerCall[];
  today: string;
  selectedCallId: string | null;
  takenOverCallId: string | null;
  onSelect: (callId: string) => void;
  cardRef: (element: HTMLButtonElement | null) => void;
}) {
  const open = card.calls.some((call) => call.callId === selectedCallId);
  const takenOver = card.calls.some((call) => call.callId === takenOverCallId);
  const live = card.calls.some((call) => call.live);
  const latest = card.calls[0]!;
  const lane = card.loadId ? laneOf(card) : null;
  const outcome = card.loadId ? loadOutcome(calls, card.loadId) : null;
  const label = outcome ? outcomeLabel(outcome).text : null;
  const meta = [card.rounds > 0 && plural(card.rounds, "round"), plural(card.calls.length, "call"), formatDeskWhen(card.lastAt, today)]
    .filter(Boolean)
    .join(" · ");

  return (
    <li
      className={`overflow-hidden rounded-lg border transition-colors ${
        open || takenOver ? "border-accent bg-accent-soft/60" : card.loadId ? "border-line bg-panel hover:bg-panel-raised" : "border-line bg-bg hover:bg-panel-raised"
      }`}
    >
      <button
        ref={cardRef}
        type="button"
        onClick={() => onSelect(latest.callId)}
        aria-expanded={open}
        className="block w-full cursor-pointer p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
      >
        {card.loadId ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="tabular text-[11px] text-fg-faint">{card.loadId}</span>
              {outcome && label && <Badge tone={outcomeTone[outcome.kind]}>{label}</Badge>}
            </div>
            <div className="mt-1.5 text-sm font-medium text-fg">
              {lane ? (
                <>
                  {lane.origin.city}, {lane.origin.state}
                  <LuArrowRight size={13} className="mx-1 inline align-[-2px] text-fg-faint" aria-label="to" />
                  {lane.destination.city}, {lane.destination.state}
                </>
              ) : (
                "Lane not recorded"
              )}
            </div>
            {lane && (
              <div className="mt-0.5 text-xs text-fg-muted">
                {equipmentLabel(lane.equipment)} · {lane.miles.toLocaleString("en-US")} mi
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5 text-sm text-fg-muted">
              {open ? <LuChevronDown size={14} aria-hidden /> : <LuChevronRight size={14} aria-hidden />}
              {plural(card.calls.length, "call")} without a load
            </div>
            <div className="mt-0.5 text-xs text-fg-faint">Verification only, no load offered</div>
          </>
        )}
        <div className="mt-2 flex items-center gap-2 text-xs text-fg-faint">
          <span className="min-w-0 flex-1 truncate">{meta}</span>
          {live && (
            <span className="flex shrink-0 items-center gap-1 font-medium text-accent">
              <LuPhone size={11} aria-hidden />
              Live
            </span>
          )}
        </div>
      </button>
      {open && (
        <ol aria-label={card.loadId ? `Calls on ${card.loadId}` : "Calls without a load"} className="space-y-0.5 border-t border-line/70 p-1.5">
          {card.calls.map((call) => (
            <CallRow
              key={call.callId}
              call={call}
              today={today}
              selected={call.callId === selectedCallId}
              takenOver={call.callId === takenOverCallId}
              onSelect={() => onSelect(call.callId)}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

function Timeline({
  calls,
  selectedCallId,
  takenOverCallId,
  now,
  onSelect,
}: {
  calls: TowerCall[];
  selectedCallId: string | null;
  takenOverCallId: string | null;
  now: number;
  onSelect: (callId: string) => void;
}) {
  const cards = useMemo(() => loadCards(calls), [calls]);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const today = deskDayKey(now);
  const cardKey = (card: LoadCard<TowerCall>) => card.loadId ?? "none";

  // Up and down move between cards, selecting each card's latest call.
  function onKeyDown(event: React.KeyboardEvent<HTMLOListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = cards.findIndex((card) => card.calls.some((call) => call.callId === selectedCallId));
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = cards[index === -1 ? 0 : Math.min(cards.length - 1, Math.max(0, index + step))];
    if (next === undefined) return;
    onSelect(next.calls[0]!.callId);
    buttons.current.get(cardKey(next))?.focus();
  }

  return (
    <ol aria-label="Loads" onKeyDown={onKeyDown} className="space-y-2 p-3">
      {cards.map((card) => (
        <LoadCardView
          key={cardKey(card)}
          card={card}
          calls={calls}
          today={today}
          selectedCallId={selectedCallId}
          takenOverCallId={takenOverCallId}
          onSelect={onSelect}
          cardRef={(element) => {
            if (element) buttons.current.set(cardKey(card), element);
            else buttons.current.delete(cardKey(card));
          }}
        />
      ))}
    </ol>
  );
}

// One carrier: the cortex conversation header, the call timeline sectioned by load, the selected
// call's live detail, and the carrier facts with the load on the table.
export function CarrierDetail({
  carrierKey,
  since,
  selectedCallId,
  now,
  onSelectCall,
}: {
  carrierKey: string;
  // The list's window, so the carrier's row here matches its row there; empty for the default.
  since: string;
  selectedCallId: string | null;
  now: number;
  onSelectCall: (callId: string) => void;
}) {
  const url = `/api/carriers/${encodeURIComponent(carrierKey)}/calls${since ? `?since=${encodeURIComponent(since)}` : ""}`;
  const { data, error, loading } = usePoll<TowerCarrierCalls>(url, callsPollMs, "call list");
  // The call the operator is speaking on, so its timeline entry stays marked.
  const [takenOverCallId, setTakenOverCallId] = useState<string | null>(null);
  const wide = useWide();

  const calls = data?.calls ?? [];
  // The carrier's list row; null when it has no call in the window, and the header falls back to its calls.
  const carrier = data?.carrier ?? null;
  const latest = calls[0];
  const selected = calls.find((call) => call.callId === selectedCallId) ?? latest ?? null;
  const name = carrier ? carrierName(carrier) : latest ? carrierId(latest) : "Carrier";
  const mc = carrier?.mcNumber ?? latest?.mcNumber ?? null;
  const dot = carrier?.dotNumber ?? latest?.dotNumber ?? null;
  // The numbers line never repeats what the name already says ("MC 135797" over "DOT 80806").
  const numbers = [mc && `MC ${mc}`, dot && `DOT ${dot}`].filter((part) => part && part !== name).join(" · ");
  const eta = carrier?.nextTrip?.etaAt ?? null;

  const callPane = selected ? (
    <CallDetail key={selected.callId} call={selected} now={now} onTakeoverChange={setTakenOverCallId} />
  ) : (
    <div className="grid flex-1 place-items-center text-sm text-fg-muted">{loading ? "Loading calls..." : "No calls for this carrier"}</div>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-panel">
        <div className="shrink-0 border-b border-line px-4 py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-semibold text-fg">{name}</h2>
              {numbers && <p className="tabular truncate text-sm text-fg-muted">{numbers}</p>}
            </div>
            {carrier && <CarrierStagePill stage={carrier.carrierStage} size="md" />}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {carrier?.needsHuman && <Badge tone="bg-risk-soft text-risk">Needs human</Badge>}
            {latest?.live && (
              <Badge tone="bg-accent-soft text-accent">
                <PulseDot tone="accent" />
                On a call
              </Badge>
            )}
            {eta && (
              <Badge tone="bg-panel-raised text-fg">
                <LuTruck size={12} aria-hidden />
                Next trip ETA {formatDateTime(eta)}
              </Badge>
            )}
            {carrier && (
              <Badge tone="bg-panel-raised text-fg-muted">
                {carrier.callsCount} calls · {carrier.loadsCount} loads
              </Badge>
            )}
            {error && (
              <span role="status" className="flex min-w-0 items-center gap-1 text-xs text-risk">
                <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
                <span className="truncate">{error}</span>
              </span>
            )}
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
          <aside aria-label="Loads with this carrier" className="min-h-0 overflow-y-auto border-r border-line bg-bg">
            {data === null && loading ? (
              <SkeletonRows rows={4} />
            ) : (
              <Timeline
                calls={calls}
                selectedCallId={selected?.callId ?? null}
                takenOverCallId={takenOverCallId}
                now={now}
                onSelect={onSelectCall}
              />
            )}
          </aside>

          {/* One tree in both widths, so a resize never remounts the call (and drops a takeover). */}
          <div className={`grid min-h-0 min-w-0 ${wide ? "grid-rows-[minmax(0,1fr)]" : "grid-rows-[minmax(0,3fr)_minmax(0,2fr)]"}`}>
            <section aria-label="Call" className="flex min-h-0 min-w-0 flex-col overflow-hidden">
              {callPane}
            </section>
            {!wide && (
              <section aria-label="Carrier and load" className="min-h-0 overflow-y-auto border-t border-line bg-bg">
                <Aside carrier={carrier} calls={calls} selected={selected} />
              </section>
            )}
          </div>
        </div>
      </div>

      {wide && (
        <aside aria-label="Carrier and load" className="h-full min-h-0 w-[300px] shrink-0 overflow-y-auto border-l border-line bg-bg">
          <Aside carrier={carrier} calls={calls} selected={selected} />
        </aside>
      )}
    </div>
  );
}
