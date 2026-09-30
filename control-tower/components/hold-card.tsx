"use client";

import { LuArrowRight, LuCircleCheck, LuLock, LuTriangleAlert } from "react-icons/lu";
import { useEffect, useRef, useState } from "react";
import { Section } from "@/components/section";
import type { ConfirmHoldResponse, ReleaseHoldResponse, TowerCall, WallLane } from "@/lib/contracts";
import { carrierId, formatUsd } from "@/lib/format";

type Hold = NonNullable<TowerCall["hold"]>;
type HoldStatus = Hold["status"];

// The second press must land within this window, so a stray click never books a load.
const armWindowMs = 4_000;

const equipmentLabels: Record<string, string> = {
  DRY_VAN: "Dry van",
  REEFER: "Reefer",
  FLATBED: "Flatbed",
  STEP_DECK: "Step deck",
  POWER_ONLY: "Power only",
};

export function equipmentLabel(code: string): string {
  return equipmentLabels[code] ?? code;
}

// The TMS gives YYYYMMDDHHMMSS with no timezone, so it is shown as written.
const pickupFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
export function formatPickup(wire: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(wire);
  if (!match) return wire;
  const [, year, month, day, hour, minute] = match;
  return `${pickupFormat.format(new Date(`${year}-${month}-${day}T00:00:00Z`))}, ${hour}:${minute}`;
}

const finalStatuses: readonly HoldStatus[] = ["booked", "booked_unconfirmed", "released"];

const statusChip: Record<HoldStatus, { text: string; tone: string }> = {
  held: { text: "Held", tone: "bg-accent-soft text-accent" },
  confirming: { text: "Booking", tone: "bg-warn-soft text-warn" },
  booked: { text: "Booked", tone: "bg-ok-soft text-ok" },
  booked_unconfirmed: { text: "Booked, unconfirmed", tone: "bg-warn-soft text-warn" },
  released: { text: "Released", tone: "bg-line text-fg-muted" },
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-xs text-fg-faint">{label}</dt>
      <dd className="text-right text-xs text-fg">{children}</dd>
    </div>
  );
}

// className adds the call site's own sizing, such as truncation in a narrow row.
export function LaneText({ lane, className = "" }: { lane: WallLane; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {lane.origin.city}, {lane.origin.state}
      <LuArrowRight size={11} className="shrink-0 text-fg-faint" aria-label="to" />
      {lane.destination.city}, {lane.destination.state}
    </span>
  );
}

// What this browser learned from its own confirm or release, shown until the wall catches up.
type Outcome = { status: HoldStatus; bookingRef: string | null; message: string };

async function postHold(url: string, headers: Record<string, string>): Promise<ConfirmHoldResponse | ReleaseHoldResponse | null> {
  const res = await fetch(url, { method: "POST", headers });
  if (res.status === 401) {
    window.location.assign("/login");
    return null;
  }
  const body = (await res.json().catch(() => null)) as ConfirmHoldResponse | ReleaseHoldResponse | null;
  if (!body) throw new Error(`The tower answered ${res.status}`);
  return body;
}

// The simulated handoff: the operator books or releases the load the agent held. Rendered as a
// section of the detail panel.
export function HoldCard({ call, hold }: { call: TowerCall; hold: Hold }) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState<"confirm" | "release" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(disarmTimer.current), []);

  // Once the wall reports a final state it wins; until then this browser's own answer is newer.
  const wallFinal = finalStatuses.includes(hold.status);
  const status: HoldStatus = wallFinal ? hold.status : (outcome?.status ?? hold.status);
  const bookingRef = hold.bookingRef ?? outcome?.bookingRef ?? null;
  const chip = statusChip[status];
  const lane = hold.lane;
  const margin = hold.maxBuy === null ? null : hold.maxBuy - hold.agreedRate;
  const actionable = status === "held" && pending === null;

  const settle = (answer: ConfirmHoldResponse | ReleaseHoldResponse | null) => {
    if (!answer) return;
    if (answer.holdStatus && answer.holdStatus !== "held") {
      setOutcome({ status: answer.holdStatus, bookingRef: answer.bookingRef, message: answer.message });
    }
    const done = (finalStatuses as readonly string[]).includes(answer.status);
    if (!done) setError(answer.message);
  };

  const confirm = async () => {
    if (!armed) {
      setArmed(true);
      setError(null);
      clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setArmed(false), armWindowMs);
      return;
    }
    clearTimeout(disarmTimer.current);
    setArmed(false);
    setPending("confirm");
    setError(null);
    // One key per deliberate press: a network retry of this request can never book twice.
    const key = crypto.randomUUID();
    try {
      settle(await postHold(`/api/holds/${encodeURIComponent(hold.holdId)}/confirm`, { "idempotency-key": key }));
    } catch {
      setError("Could not reach the tower. The booking may still go through; check the status before retrying.");
    } finally {
      setPending(null);
    }
  };

  const release = async () => {
    clearTimeout(disarmTimer.current);
    setArmed(false);
    setPending("release");
    setError(null);
    try {
      settle(await postHold(`/api/holds/${encodeURIComponent(hold.holdId)}/release`, {}));
    } catch {
      setError("Could not reach the tower. The hold was not released.");
    } finally {
      setPending(null);
    }
  };

  const chipEl = <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium leading-none ${chip.tone}`}>{chip.text}</span>;
  // While the hold waits on the desk the card is the action: the amount, the load, and the buttons.
  const open = status === "held" || status === "confirming";

  return (
    <Section icon={LuLock} title="Hold" aside={chipEl}>
      {open ? (
        <div className="flex flex-col gap-1">
          <span className="tabular text-2xl font-semibold text-fg">{formatUsd(hold.agreedRate)}</span>
          <span className="min-w-0 truncate text-sm text-fg">
            <span className="tabular font-medium">{hold.loadId}</span>
            {lane && (
              <>
                <span className="text-fg-faint"> · </span>
                <LaneText lane={lane} />
              </>
            )}
          </span>
          <span className="text-xs text-fg-muted">
            {carrierId(call)} · margin vs max buy <span className="tabular text-ok">{margin === null ? "-" : formatUsd(margin)}</span>
          </span>
        </div>
      ) : (
        <dl className="divide-y divide-line">
          <Row label="Carrier">
            <span className="tabular">{carrierId(call)}</span>
            {call.mcNumber && call.dotNumber && <span className="tabular text-fg-faint"> DOT {call.dotNumber}</span>}
          </Row>
          <Row label="Load">
            <span className="tabular">{hold.loadId}</span>
          </Row>
          <Row label="Lane">{lane ? <LaneText lane={lane} /> : <span className="text-fg-faint">Not recorded</span>}</Row>
          {lane && (
            <>
              <Row label="Pickup">
                <span className="tabular">{formatPickup(lane.pickupAt)}</span>
              </Row>
              <Row label="Equipment">{equipmentLabel(lane.equipment)}</Row>
              <Row label="Miles">
                <span className="tabular">{lane.miles.toLocaleString("en-US")}</span>
              </Row>
            </>
          )}
          <Row label="Agreed rate">
            <span className="tabular font-semibold">{formatUsd(hold.agreedRate)}</span>
          </Row>
          <Row label="Margin vs max buy">
            <span className="tabular text-ok">{margin === null ? "-" : formatUsd(margin)}</span>
          </Row>
        </dl>
      )}

      {(status === "booked" || status === "booked_unconfirmed") && (
        <p className={`mt-2 flex items-center gap-1.5 text-xs ${status === "booked" ? "text-ok" : "text-warn"}`}>
          <LuCircleCheck size={14} aria-hidden />
          {status === "booked" ? "Booked" : "Booked, TMS confirmation pending"}
          {bookingRef && (
            <span>
              {" "}
              ref <span className="tabular font-semibold">{bookingRef}</span>
            </span>
          )}
        </p>
      )}
      {status === "released" && (
        <p className="mt-2 text-xs text-fg-muted">{outcome?.message ?? "The hold was released and the load is back on the board."}</p>
      )}
      {status === "confirming" && <p className="mt-2 text-xs text-warn">Booking in progress with the TMS.</p>}

      {status === "held" && (
        <div className="mt-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!actionable}
            aria-live="polite"
            className={`h-10 w-full cursor-pointer rounded-[var(--radius-panel)] px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              armed ? "bg-ok text-white" : "bg-accent text-white hover:bg-accent/90"
            }`}
          >
            {pending === "confirm" ? (
              "Booking..."
            ) : armed ? (
              <>
                Tap again to book <span className="tabular">{hold.loadId}</span> at{" "}
                <span className="tabular">{formatUsd(hold.agreedRate)}</span>
              </>
            ) : (
              "Confirm booking"
            )}
          </button>
          <button
            type="button"
            onClick={() => void release()}
            disabled={!actionable}
            className="h-10 w-full cursor-pointer rounded-[var(--radius-panel)] border border-line-strong bg-panel px-3 text-sm font-medium text-fg-muted transition-colors hover:bg-panel-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending === "release" ? "Releasing..." : "Release hold"}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-risk">
          <LuTriangleAlert size={14} className="mt-px shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </Section>
  );
}
