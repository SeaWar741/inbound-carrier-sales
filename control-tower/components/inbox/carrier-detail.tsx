"use client";

import { Fragment, useMemo, useState, useSyncExternalStore } from "react";
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
import { Badge, CarrierStagePill } from "@/components/inbox/stage-pill";
import { LoadPanel } from "@/components/load-panel";
import { PulseDot } from "@/components/pulse-dot";
import type { TowerCall, TowerCarrier, TowerCarrierCalls } from "@/lib/contracts";
import {
  carrierId,
  carrierName,
  deskDayKey,
  formatClock,
  formatDateTime,
  formatDay,
  formatPercent,
  formatPerMile,
  formatUsd,
  groupCallsByLoad,
  lastSummary,
  outcomeLabel,
  timelineRows,
} from "@/lib/format";
import { carrierPricing, loadOutcome } from "@/lib/pricing";
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

// The cortex CRM card: an icon square and title over a two-column grid of facts.
function FactsCard({ carrier, calls }: { carrier: TowerCarrier | undefined; calls: TowerCall[] }) {
  const latest = calls[0];
  const mc = carrier?.mcNumber ?? latest?.mcNumber ?? null;
  const dot = carrier?.dotNumber ?? latest?.dotNumber ?? null;
  const hold = openHold(calls);
  const pricing = useMemo(() => carrierPricing(calls), [calls]);
  const orDash = (value: number | null, format: (v: number) => string) => (value === null ? "-" : format(value));
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-sm">
      <div className="flex items-center gap-2 border-b border-line p-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
          <LuBuilding2 size={16} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-fg">{carrier ? carrierName(carrier) : latest ? carrierId(latest) : "Carrier"}</div>
          <div className="text-[10px] tracking-wide text-fg-muted uppercase">Carrier</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 p-3 text-xs">
        <Fact label="MC">{mc ?? "-"}</Fact>
        <Fact label="DOT">{dot ?? "-"}</Fact>
        <Fact label="Calls">{carrier?.callsCount ?? calls.length}</Fact>
        <Fact label="Loads offered">{carrier ? carrier.loadsCount : "-"}</Fact>
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

function Aside({ carrier, calls, selected }: { carrier: TowerCarrier | undefined; calls: TowerCall[]; selected: TowerCall | null }) {
  return (
    <div className="space-y-3 p-3 pb-6">
      <FactsCard carrier={carrier} calls={calls} />
      <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-sm">
        <LoadPanel selectedCall={selected} history={calls} />
      </div>
    </div>
  );
}

// The slim header of one load's calls: the load, its lane, and where it stands with this carrier.
function LoadHeader({ loadId, section, calls }: { loadId: string; section: TowerCall[]; calls: TowerCall[] }) {
  const lane = section.flatMap((call) => call.offers).find((offer) => offer.loadId === loadId && offer.lane)?.lane ?? null;
  const outcome = outcomeLabel(loadOutcome(calls, loadId));
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 pt-3 pb-1 text-[11px]">
      <span className="tabular shrink-0 font-semibold text-fg">{loadId}</span>
      <span className="min-w-0 flex-1 truncate text-fg-muted">
        {lane ? (
          <>
            {lane.origin.city}, {lane.origin.state}
            <LuArrowRight size={10} className="mx-0.5 inline align-[-1px] text-fg-faint" aria-label="to" />
            {lane.destination.city}, {lane.destination.state}
          </>
        ) : null}
      </span>
      <span className={`tabular shrink-0 font-medium ${outcome.tone}`}>{outcome.text}</span>
    </div>
  );
}

function CallRow({
  call,
  selected,
  takenOver,
  onSelect,
}: {
  call: TowerCall;
  selected: boolean;
  takenOver: boolean;
  onSelect: () => void;
}) {
  const summary = lastSummary(call);
  const marked = selected || takenOver;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`relative flex w-full min-w-0 cursor-pointer items-center gap-2 py-1.5 pr-3 pl-3 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
          marked ? "bg-accent-soft" : "hover:bg-panel-raised"
        }`}
      >
        {marked && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
        <span className="tabular w-14 shrink-0 text-[11px] text-fg-faint">{formatClock(call.createdAt)}</span>
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-fg" : "text-fg-muted"}`}>{summary ?? "No summary yet"}</span>
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
  const [noLoadOpen, setNoLoadOpen] = useState(false);
  const today = deskDayKey(now);
  return (
    <div className="pb-3">
      {groupCallsByLoad(calls).map((section) => {
        const holdsSelected = section.calls.some((call) => call.callId === selectedCallId);
        return (
          <section key={section.loadId ?? "none"} aria-label={section.loadId ? `Load ${section.loadId}` : "Calls without a load"}>
            {section.loadId && <LoadHeader loadId={section.loadId} section={section.calls} calls={calls} />}
            <ol>
              {timelineRows(section, { today, selectedCallId, expanded: noLoadOpen }).map((row) =>
                row.kind === "no_load" ? (
                  <li key="no-load">
                    <button
                      type="button"
                      onClick={() => setNoLoadOpen(!row.open)}
                      disabled={holdsSelected}
                      aria-expanded={row.open}
                      className="flex w-full cursor-pointer items-center gap-1.5 px-3 pt-3 pb-1 text-left text-[11px] text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset disabled:cursor-default disabled:hover:text-fg-muted"
                    >
                      {row.open ? <LuChevronDown size={12} aria-hidden /> : <LuChevronRight size={12} aria-hidden />}
                      <span className="tabular">{row.count}</span> {row.count === 1 ? "call" : "calls"} without a load
                    </button>
                  </li>
                ) : (
                  <Fragment key={row.call.callId}>
                    {row.day && (
                      <li className="sticky top-0 z-10 bg-bg/95 px-3 py-0.5 text-[10px] font-medium tracking-wide text-fg-faint uppercase backdrop-blur-sm">
                        {formatDay(row.day)}
                      </li>
                    )}
                    <CallRow
                      call={row.call}
                      selected={row.call.callId === selectedCallId}
                      takenOver={row.call.callId === takenOverCallId}
                      onSelect={() => onSelect(row.call.callId)}
                    />
                  </Fragment>
                ),
              )}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

// One carrier: the cortex conversation header, the call timeline sectioned by load, the selected
// call's live detail, and the carrier facts with the load on the table.
export function CarrierDetail({
  carrierKey,
  carrier,
  selectedCallId,
  now,
  onSelectCall,
}: {
  carrierKey: string;
  // The carrier's row when it is on the list page; the header falls back to its calls otherwise.
  carrier: TowerCarrier | undefined;
  selectedCallId: string | null;
  now: number;
  onSelectCall: (callId: string) => void;
}) {
  const { data, error, loading } = usePoll<TowerCarrierCalls>(`/api/carriers/${encodeURIComponent(carrierKey)}/calls`, callsPollMs, "call list");
  // The call the operator is speaking on, so its timeline entry stays marked.
  const [takenOverCallId, setTakenOverCallId] = useState<string | null>(null);
  const wide = useWide();

  const calls = data?.calls ?? [];
  const latest = calls[0];
  const selected = calls.find((call) => call.callId === selectedCallId) ?? latest ?? null;
  const name = carrier ? carrierName(carrier) : latest ? carrierId(latest) : "Carrier";
  const mc = carrier?.mcNumber ?? latest?.mcNumber ?? null;
  const dot = carrier?.dotNumber ?? latest?.dotNumber ?? null;
  const numbers = [mc && `MC ${mc}`, dot && `DOT ${dot}`].filter(Boolean).join(" · ");
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

        <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
          <aside aria-label="Calls by load" className="min-h-0 overflow-y-auto border-r border-line bg-bg">
            {data === null && loading ? (
              <div aria-hidden className="space-y-3 p-4">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="space-y-2">
                    <div className="h-4 w-3/4 animate-pulse rounded-md bg-panel-raised" />
                    <div className="h-3 w-1/2 animate-pulse rounded-md bg-panel-raised" />
                  </div>
                ))}
              </div>
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
