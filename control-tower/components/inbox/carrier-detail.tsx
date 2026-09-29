"use client";

import { useState, useSyncExternalStore } from "react";
import { LuBuilding2, LuMessageSquareText, LuPhone, LuTriangleAlert, LuTruck } from "react-icons/lu";
import { CallDetail } from "@/components/call-detail";
import { Badge, CallStagePill, CarrierStagePill } from "@/components/inbox/stage-pill";
import { LoadPanel } from "@/components/load-panel";
import { PulseDot } from "@/components/pulse-dot";
import type { TowerCall, TowerCarrier, TowerCarrierCalls } from "@/lib/contracts";
import { carrierId, carrierName, formatDateTime, formatUsd, groupCallsByLoad, lastSummary } from "@/lib/format";
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
    </div>
  );
}

function Aside({ carrier, calls, selected }: { carrier: TowerCarrier | undefined; calls: TowerCall[]; selected: TowerCall | null }) {
  return (
    <div className="space-y-3 p-3 pb-6">
      <FactsCard carrier={carrier} calls={calls} />
      <div className="overflow-hidden rounded-lg border border-line bg-panel shadow-sm">
        <LoadPanel selectedCall={selected} />
      </div>
    </div>
  );
}

function TimelineEntry({
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
  const ChannelIcon = call.channel === "text" ? LuMessageSquareText : LuPhone;
  return (
    <li className="relative pl-9">
      <span
        className={`absolute top-2 left-1.5 grid size-6 place-items-center rounded-full border-2 border-panel shadow-sm ${
          call.live ? "bg-accent text-white" : "bg-panel-raised text-fg-muted"
        }`}
        aria-hidden
      >
        <ChannelIcon size={12} />
      </span>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`w-full min-w-0 cursor-pointer rounded-lg border p-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 ${
          takenOver ? "border-accent bg-accent-soft" : selected ? "border-accent/50 bg-accent-soft/60" : "border-line bg-panel hover:bg-panel-raised"
        }`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <CallStagePill call={call} />
          {call.live && (
            <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-accent">
              <PulseDot tone="accent" />
              Live
            </span>
          )}
          {takenOver && <span className="shrink-0 text-[11px] font-medium text-accent">You</span>}
          <span className="min-w-0 flex-1" />
          <span className="tabular shrink-0 text-[11px] whitespace-nowrap text-fg-faint">{formatDateTime(call.createdAt)}</span>
        </span>
        <span className="mt-1 line-clamp-2 text-xs text-fg-muted">{summary ?? "No summary yet"}</span>
      </button>
    </li>
  );
}

function Timeline({
  calls,
  selectedCallId,
  takenOverCallId,
  onSelect,
}: {
  calls: TowerCall[];
  selectedCallId: string | null;
  takenOverCallId: string | null;
  onSelect: (callId: string) => void;
}) {
  return (
    <div className="space-y-2 p-3">
      {groupCallsByLoad(calls).map((section) => (
        <section key={section.loadId ?? "none"} aria-label={section.loadId ? `Load ${section.loadId}` : "No load"}>
          <div className="my-2 flex justify-center">
            <span className="tabular rounded-full border border-line bg-panel px-3 py-1.5 text-xs font-medium text-fg-muted shadow-md">
              {section.loadId ? `New load ${section.loadId}` : "No load"}
            </span>
          </div>
          <div className="relative">
            <div className="absolute top-0 bottom-0 left-4.5 w-px bg-line" aria-hidden />
            <ol className="space-y-2">
              {section.calls.map((call) => (
                <TimelineEntry
                  key={call.callId}
                  call={call}
                  selected={call.callId === selectedCallId}
                  takenOver={call.callId === takenOverCallId}
                  onSelect={() => onSelect(call.callId)}
                />
              ))}
            </ol>
          </div>
        </section>
      ))}
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
