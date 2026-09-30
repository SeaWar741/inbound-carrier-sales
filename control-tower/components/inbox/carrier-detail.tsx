"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { IconType } from "react-icons";
import {
  LuArrowRight,
  LuCalendarClock,
  LuChevronDown,
  LuCircleCheck,
  LuDollarSign,
  LuHand,
  LuHeadset,
  LuIdCard,
  LuLock,
  LuPackage,
  LuPhone,
  LuPiggyBank,
  LuRepeat,
  LuTriangleAlert,
  LuTruck,
} from "react-icons/lu";
import { CallDetail } from "@/components/call-detail";
import { equipmentLabel, HoldCard } from "@/components/hold-card";
import type { InboxWindow } from "@/components/inbox/inbox-rail";
import { Badge, CarrierStagePill, carrierStageStyle } from "@/components/inbox/stage-pill";
import { VoiceControls } from "@/components/intervention-bar";
import { LoadPanel } from "@/components/load-panel";
import { PulseDot } from "@/components/pulse-dot";
import { ActionCard, Section } from "@/components/section";
import type { TowerCall, TowerCarrier, TowerCarrierCalls, WallLane } from "@/lib/contracts";
import {
  callSummary,
  carrierId,
  carrierName,
  deskDayKey,
  formatDateTime,
  formatElapsed,
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
import { useVoice, type Voice } from "@/lib/use-voice";

const callsPollMs = 5_000;

// The hold still waiting on the desk, newest first.
function openHold(calls: TowerCall[]) {
  for (const call of calls) {
    if (call.hold && (call.hold.status === "held" || call.hold.status === "confirming")) return call.hold;
  }
  return null;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function Fact({ icon: Icon, label, children }: { icon: IconType; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-fg-muted">
        <Icon size={13} className="shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <div className="tabular mt-0.5 truncate pl-[19px] font-semibold text-fg">{children}</div>
    </div>
  );
}

// The carrier's record: every aggregate reads the calls on file, so it never mixes them with the
// list's `since` window.
function CarrierRecord({ carrier, calls }: { carrier: TowerCarrier | null; calls: TowerCall[] }) {
  const hold = openHold(calls);
  const pricing = useMemo(() => carrierPricing(calls), [calls]);
  const orDash = (value: number | null, format: (v: number) => string) => (value === null ? "-" : format(value));
  return (
    <Section icon={LuIdCard} title="Carrier record">
      <div className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
        <Fact icon={LuCircleCheck} label="Booked">
          {pricing.booked} of {pricing.loadsOffered}
          {pricing.bookingRate !== null && <span className="font-normal text-fg-muted"> ({formatPercent(pricing.bookingRate)})</span>}
        </Fact>
        <Fact icon={LuDollarSign} label="Avg agreed $/mi">{orDash(pricing.avgAgreedPerMile, formatPerMile)}</Fact>
        <Fact icon={LuPiggyBank} label="Avg margin kept">{orDash(pricing.avgMarginKept, formatUsd)}</Fact>
        <Fact icon={LuRepeat} label="Avg round at agreement">{orDash(pricing.avgRoundsToAgree, (v) => `R${v.toFixed(1)}`)}</Fact>
        <Fact icon={LuCalendarClock} label="Next pickup">{carrier?.nextTrip?.pickupAt ? formatDateTime(carrier.nextTrip.pickupAt) : "-"}</Fact>
        <Fact icon={LuLock} label="Open hold">
          {hold ? `${hold.loadId} at ${formatUsd(hold.agreedRate)}${hold.status === "confirming" ? ", confirming" : ""}` : "None"}
        </Fact>
      </div>
      <p className="mt-3 text-[11px] text-fg-faint">Across the {plural(calls.length, "call")} on file.</p>
    </Section>
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

const cardKey = (card: LoadCard<TowerCall>) => card.loadId ?? "none";

function LiveMark() {
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-ok">
      <PulseDot tone="ok" />
      Live
    </span>
  );
}

// One load in the selector, as the trigger shows it (one line) or as an option (lane and meta below).
function CardSummary({ card, calls, today, detailed }: { card: LoadCard<TowerCall>; calls: TowerCall[]; today: string; detailed: boolean }) {
  const live = card.calls.some((call) => call.live);
  if (card.loadId === null) {
    return (
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{plural(card.calls.length, "call")} without a load</span>
          {live && <LiveMark />}
        </span>
        {detailed && <span className="truncate text-[11px] text-fg-faint">Verification only, no load offered</span>}
      </span>
    );
  }
  const lane = laneOf(card);
  const outcome = loadOutcome(calls, card.loadId);
  const label = outcomeLabel(outcome).text;
  const meta = [lane && equipmentLabel(lane.equipment), lane && `${lane.miles.toLocaleString("en-US")} mi`, formatDeskWhen(card.lastAt, today), plural(card.calls.length, "call")]
    .filter(Boolean)
    .join(" · ");
  const laneText = lane ? (
    <>
      {lane.origin.city}, {lane.origin.state}
      <LuArrowRight size={12} className="mx-1 inline align-[-2px] text-fg-faint" aria-label="to" />
      {lane.destination.city}, {lane.destination.state}
    </>
  ) : (
    <span className="text-fg-faint">Lane not recorded</span>
  );
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm text-fg">
          <span className="tabular font-medium">{card.loadId}</span>
          {!detailed && (
            <>
              <span className="text-fg-faint"> · </span>
              {laneText}
            </>
          )}
        </span>
        {live && <LiveMark />}
        <Badge tone={outcomeTone[outcome.kind]}>{label}</Badge>
      </span>
      {detailed && (
        <>
          <span className="mt-0.5 truncate text-sm text-fg">{laneText}</span>
          <span className="tabular mt-0.5 truncate text-[11px] text-fg-muted">{meta}</span>
        </>
      )}
    </span>
  );
}

// The load picker: a button naming the selected load that opens the carrier's loads, and a select
// for the call when the load had more than one.
function LoadSelector({
  calls,
  selected,
  takenOverCallId,
  now,
  onSelect,
}: {
  calls: TowerCall[];
  selected: TowerCall;
  takenOverCallId: string | null;
  now: number;
  onSelect: (callId: string) => void;
}) {
  const cards = useMemo(() => loadCards(calls), [calls]);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const today = deskDayKey(now);
  const current = cards.find((card) => card.calls.some((call) => call.callId === selected.callId)) ?? cards[0];

  // A click outside or Esc closes the list; Esc hands focus back to the button.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    list.current?.querySelector<HTMLButtonElement>("[aria-current='true']")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (current === undefined) return null;

  // Up and down move between the options.
  function onListKey(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[Math.min(buttons.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
    next?.focus();
  }

  const pick = (callId: string) => {
    onSelect(callId);
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div ref={root} className="relative min-w-0 flex-1">
        <button
          ref={trigger}
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="carrier-loads"
          aria-label={`Load: ${current.loadId ?? "calls without a load"}. ${plural(cards.length, "load group")} with this carrier`}
          className="flex h-10 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-line bg-panel px-3 text-left outline-none transition-colors hover:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <LuPackage size={16} className="shrink-0 text-accent" aria-hidden />
          <CardSummary card={current} calls={calls} today={today} detailed={false} />
          <LuChevronDown size={16} className={`shrink-0 text-fg-faint transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
        {open && (
          <ul
            ref={list}
            id="carrier-loads"
            aria-label="Loads with this carrier"
            onKeyDown={onListKey}
            className="absolute top-full right-0 left-0 z-20 mt-1 flex max-h-96 flex-col gap-0.5 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-lg"
          >
            {cards.map((card) => {
              const isCurrent = card === current;
              const takenOver = card.calls.some((call) => call.callId === takenOverCallId);
              return (
                <li key={cardKey(card)}>
                  <button
                    type="button"
                    onClick={() => pick(card.calls[0]!.callId)}
                    aria-current={isCurrent}
                    className={`flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-md px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 ${
                      isCurrent ? "bg-accent-soft" : "hover:bg-panel-raised"
                    }`}
                  >
                    <CardSummary card={card} calls={calls} today={today} detailed />
                    {takenOver && <span className="shrink-0 text-[11px] font-medium text-accent">You</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {current.calls.length > 1 && (
        <label className="relative flex h-10 max-w-[15rem] min-w-0 shrink items-center rounded-lg border border-line bg-panel transition-colors focus-within:ring-2 focus-within:ring-accent/40 hover:bg-panel-raised">
          <LuPhone size={14} className="pointer-events-none absolute left-3 text-fg-faint" aria-hidden />
          <select
            aria-label="Call on this load"
            value={selected.callId}
            onChange={(event) => onSelect(event.target.value)}
            className="field-sizing-content h-full w-full min-w-0 cursor-pointer appearance-none truncate bg-transparent pr-8 pl-8 text-sm text-fg outline-none"
          >
            {current.calls.map((call) => (
              <option key={call.callId} value={call.callId}>
                {[formatDeskWhen(call.createdAt, today), callSummary(call) ?? "No summary yet", call.live && "Live", call.callId === takenOverCallId && "You"]
                  .filter(Boolean)
                  .join(" · ")}
              </option>
            ))}
          </select>
          <LuChevronDown size={14} className="pointer-events-none absolute right-3 text-fg-faint" aria-hidden />
        </label>
      )}
    </div>
  );
}

// The live call on which the carrier asked for a person, newest first.
function humanRequest(calls: TowerCall[]): { call: TowerCall; reason: string } | null {
  for (const call of calls) {
    if (!call.live) continue;
    const event = call.events.find((e) => e.tool === "request_human");
    if (event) return { call, reason: event.summary ?? call.riskReason ?? "The carrier asked to speak with a person." };
  }
  return null;
}

// The top of the detail panel whenever a person is needed: each hold waiting on the desk and a
// carrier asking for a person, as action cards. The voice controls act on the selected call, so a
// request on another call offers to open it first.
function NeedsYou({
  calls,
  selected,
  voice,
  now,
  onSelectCall,
}: {
  calls: TowerCall[];
  selected: TowerCall | null;
  voice: Voice;
  now: number;
  onSelectCall: (callId: string) => void;
}) {
  const holds = calls.flatMap((call) => (call.hold && (call.hold.status === "held" || call.hold.status === "confirming") ? [{ call, hold: call.hold }] : []));
  const request = humanRequest(calls);
  if (holds.length === 0 && request === null) return null;
  return (
    <div className="flex flex-col gap-3 p-4">
      {request && (
        <ActionCard tone="red" icon={LuHeadset} title="Carrier asked for a person">
          <p className="text-sm text-fg">{request.reason}</p>
          <p className="tabular mt-1 text-xs text-fg-muted">
            {carrierId(request.call)} · on the line {formatElapsed(now - Date.parse(request.call.createdAt))}
          </p>
          <div className="mt-3">
            {selected?.callId === request.call.callId ? (
              <>
                <VoiceControls call={selected} voice={voice} />
                {voice.error && (
                  <p role="alert" className="mt-2 flex items-center gap-1.5 text-xs text-risk">
                    <LuTriangleAlert size={12} aria-hidden />
                    {voice.error}
                  </p>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={() => onSelectCall(request.call.callId)}
                className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
              >
                <LuPhone size={14} aria-hidden />
                Open this call
              </button>
            )}
          </div>
        </ActionCard>
      )}
      {holds.map(({ call, hold }) => (
        <HoldCard key={hold.holdId} call={call} hold={hold} />
      ))}
    </div>
  );
}

// One carrier: the conversation (header, load picker, the selected call) in the middle and the
// detail panel on the right, one scroll: what needs a person, the load and its map, pricing, and
// the carrier record.
export function CarrierDetail({
  carrierKey,
  dateWindow,
  selectedCallId,
  now,
  onSelectCall,
}: {
  carrierKey: string;
  // The list's window, so the carrier's row here matches its row there; empty values are defaults.
  dateWindow: InboxWindow;
  selectedCallId: string | null;
  now: number;
  onSelectCall: (callId: string) => void;
}) {
  const query = new URLSearchParams(Object.entries(dateWindow).filter(([, value]) => value !== "")).toString();
  const url = `/api/carriers/${encodeURIComponent(carrierKey)}/calls${query ? `?${query}` : ""}`;
  const { data, error, loading } = usePoll<TowerCarrierCalls>(url, callsPollMs, "call list");

  const calls = data?.calls ?? [];
  // The carrier's list row; null when it has no call in the window, and the header falls back to its calls.
  const carrier = data?.carrier ?? null;
  const latest = calls[0];
  const selected = calls.find((call) => call.callId === selectedCallId) ?? latest ?? null;
  // One voice connection to the selected call, shared by its intervention bar and the action card.
  const voice = useVoice(selected?.callId ?? "", selected?.sessionId != null);
  // The call the operator is speaking on, so the load picker keeps it marked.
  const takenOverCallId = voice.mode === "takeover" && selected ? selected.callId : null;
  const name = carrier ? carrierName(carrier) : latest ? carrierId(latest) : "Carrier";
  const mc = carrier?.mcNumber ?? latest?.mcNumber ?? null;
  const dot = carrier?.dotNumber ?? latest?.dotNumber ?? null;
  // The numbers line never repeats what the name already says ("MC 135797" over "DOT 80806").
  const numbers = [mc && `MC ${mc}`, dot && `DOT ${dot}`].filter((part) => part && part !== name).join(" · ");
  const eta = carrier?.nextTrip?.etaAt ?? null;
  const callsCount = carrier?.callsCount ?? calls.length;
  const loadsCount = carrier?.loadsCount ?? null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-panel">
        <div className="shrink-0 border-b border-line px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate font-semibold text-fg">{name}</h2>
            {carrier && <CarrierStagePill stage={carrier.carrierStage} size="md" />}
            <span className="min-w-0 flex-1" />
            <span className="flex shrink-0 items-center gap-2 text-xs text-fg-muted">
              <span className="flex items-center gap-1" title={`${callsCount} calls`}>
                <LuPhone size={12} aria-hidden />
                <span className="tabular">{plural(callsCount, "call")}</span>
              </span>
              {loadsCount !== null && (
                <span className="flex items-center gap-1" title={`${loadsCount} loads offered`}>
                  <LuPackage size={12} aria-hidden />
                  <span className="tabular">{plural(loadsCount, "load")}</span>
                </span>
              )}
            </span>
          </div>
          <div className="mt-1.5 flex min-w-0 items-center gap-2 overflow-hidden">
            {numbers && <span className="tabular min-w-0 shrink-[3] truncate text-sm text-fg-muted">{numbers}</span>}
            {carrier?.needsHuman && (
              <Badge tone={carrierStageStyle.needs_approval.tone.pill}>
                <LuHand size={11} aria-hidden />
                Needs human
              </Badge>
            )}
            {latest?.live && (
              <Badge tone={carrierStageStyle.live.tone.pill}>
                <PulseDot tone="live" />
                On a call
              </Badge>
            )}
            {eta && (
              <Badge tone={carrierStageStyle.in_transit.tone.pill}>
                <LuTruck size={12} aria-hidden />
                Next trip ETA {formatDateTime(eta)}
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

        {selected ? (
          <>
            <div className="shrink-0 border-b border-line bg-bg px-4 py-2.5">
              <LoadSelector calls={calls} selected={selected} takenOverCallId={takenOverCallId} now={now} onSelect={onSelectCall} />
            </div>
            <section aria-label="Call" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              <CallDetail key={selected.callId} call={selected} voice={voice} now={now} />
            </section>
          </>
        ) : (
          <div className="grid flex-1 place-items-center text-sm text-fg-muted">{loading ? "Loading calls..." : "No calls for this carrier"}</div>
        )}
      </div>

      <aside aria-label="Carrier and load" className="h-full min-h-0 w-[340px] shrink-0 overflow-y-auto border-l border-line bg-panel pb-6">
        <NeedsYou calls={calls} selected={selected} voice={voice} now={now} onSelectCall={onSelectCall} />
        <LoadPanel selectedCall={selected} history={calls} nextTrip={carrier?.nextTrip ?? null} />
        <CarrierRecord carrier={carrier} calls={calls} />
      </aside>
    </div>
  );
}
