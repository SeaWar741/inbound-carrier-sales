"use client";

import type { IconType } from "react-icons";
import { LuArrowRight, LuCircleCheck, LuHand, LuLock, LuMail, LuTriangleAlert } from "react-icons/lu";
import { useEffect, useRef, useState } from "react";
import { ActionCard, type ActionTone } from "@/components/section";
import type { ConfirmHoldResponse, ReleaseHoldResponse, TowerCall, WallLane } from "@/lib/contracts";
import { carrierId, formatUsd } from "@/lib/format";

type Hold = NonNullable<TowerCall["hold"]>;
type HoldStatus = Hold["status"];

// The second press must land within this window, so a stray click never books a load.
const armWindowMs = 4_000;

// The TMS gives YYYYMMDDHHMMSS with no timezone, so it is shown as written.
const pickupFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
export function formatPickup(wire: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(wire);
  if (!match) return wire;
  const [, year, month, day, hour, minute] = match;
  return `${pickupFormat.format(new Date(`${year}-${month}-${day}T00:00:00Z`))}, ${hour}:${minute}`;
}

const finalStatuses: readonly HoldStatus[] = ["booked", "booked_unconfirmed", "released"];

// The action card's header for each status: red while it waits on the desk.
const holdAction: Record<HoldStatus, { title: string; tone: ActionTone; icon: IconType }> = {
  held: { title: "Hold waiting for your approval", tone: "red", icon: LuHand },
  confirming: { title: "Booking with the TMS", tone: "amber", icon: LuLock },
  booked: { title: "Booked", tone: "emerald", icon: LuCircleCheck },
  booked_unconfirmed: { title: "Booked, unconfirmed", tone: "amber", icon: LuCircleCheck },
  released: { title: "Hold released", tone: "gray", icon: LuLock },
};

// The adapter writes a hold_notice when it tells the carrier how a hold ended, so an open hold has
// none yet. Events come oldest first, and the latest one naming this load is the one that counts.
export function holdNotice(call: Pick<TowerCall, "events">, hold: Pick<Hold, "loadId">): TowerCall["events"][number] | null {
  return call.events.findLast((event) => event.tool === "hold_notice" && event.summary?.includes(hold.loadId)) ?? null;
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

// The simulated handoff: the operator books or releases the load the agent held. Only an open hold
// is drawn here, as an action card; the Deal card tells how a settled one ended. The load's lane,
// pickup and equipment are in the Load section, so the card keeps to the amount, load and carrier.
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
  const actionable = status === "held" && pending === null;
  const open = status === "held" || status === "confirming";
  const notice = open ? null : holdNotice(call, hold);

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

  const content = (
    <>
      <div className="flex flex-col gap-1">
        <span className="tabular text-2xl font-semibold text-fg">{formatUsd(hold.agreedRate)}</span>
        <span className="tabular min-w-0 truncate text-xs text-fg-muted">
          <span className="font-medium text-fg">{hold.loadId}</span>
          <span className="text-fg-faint"> · </span>
          {carrierId(call)}
        </span>
      </div>

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
      {notice?.summary && (
        <p className={`mt-1 flex items-center gap-1.5 text-xs ${notice.status === "sent" ? "text-fg-muted" : "text-warn"}`}>
          <LuMail size={14} aria-hidden />
          {notice.summary}
        </p>
      )}

      {status === "held" && (
        <div className="mt-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!actionable}
            aria-live="polite"
            className={`h-11 w-full cursor-pointer rounded-lg px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
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
            className="h-11 w-full cursor-pointer rounded-lg border border-line-strong bg-panel px-3 text-sm font-medium text-fg-muted transition-colors hover:bg-panel-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
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
    </>
  );

  // While the wall still reports the hold open it is an action card, and stays one while this
  // browser's own answer settles; once the wall settles it the Deal card takes over.
  if (hold.status !== "held" && hold.status !== "confirming") return null;
  const action = holdAction[status];
  return (
    <ActionCard tone={action.tone} icon={action.icon} title={action.title}>
      {content}
    </ActionCard>
  );
}
