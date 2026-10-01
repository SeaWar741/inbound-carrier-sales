"use client";

import { useState } from "react";
import { LuArrowRight, LuChevronDown, LuMail, LuMessageSquareText, LuSend, LuStar, LuTriangleAlert, LuTruck } from "react-icons/lu";
import { EmptyState } from "@/components/empty-state";
import type { CapacityLoad, CapacityTruck, ErrorResponse, NotifyCapacityResponse, TowerCapacity } from "@/lib/contracts";
import { carrierName, equipmentLabel, formatClock, formatUsd, plural } from "@/lib/format";
import { fetchTower, usePollWith } from "@/lib/use-poll";

const capacityPollMs = 60_000;

// freeDate is a calendar date, so it is formatted as a plain date in UTC ("Oct 2").
const freeDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const formatFreeDay = (isoDate: string) => freeDay.format(new Date(`${isoDate}T00:00:00Z`));

const truckEquipment = (truck: CapacityTruck) => (truck.equipment === null ? "Any equipment" : equipmentLabel(truck.equipment));

const channelIcons = { email: LuMail, sms: LuMessageSquareText } as const;

// What the last notice from this browser answered, shown under the truck until the next one.
type Notice = { tone: string; text: string };

const noticeTones: Record<NotifyCapacityResponse["status"], string> = {
  sent: "text-ok",
  already_notified: "text-fg-muted",
  load_unavailable: "text-warn",
  no_contact: "text-warn",
  failed: "text-warn",
};

// A 400 or 404 from the tower carries a status the notice tones do not list.
const isNoticeStatus = (status: string): status is NotifyCapacityResponse["status"] => Object.hasOwn(noticeTones, status);

async function postNotice(truckId: string, loadId: string): Promise<Notice | null> {
  const res = await fetch(`/api/capacity/${encodeURIComponent(truckId)}/notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loadId }),
  });
  if (res.status === 401) {
    window.location.assign("/login");
    return null;
  }
  const body = (await res.json().catch(() => null)) as NotifyCapacityResponse | ErrorResponse | null;
  if (!body) return { tone: "text-warn", text: `The tower answered ${res.status}` };
  return { tone: isNoticeStatus(body.status) ? noticeTones[body.status] : "text-warn", text: body.message };
}

function FitBadge({ truck }: { truck: CapacityTruck }) {
  if (truck.notifiedLoadId !== null) {
    const Icon = truck.noticeChannel ? channelIcons[truck.noticeChannel] : LuSend;
    return (
      <span
        title={truck.notifiedAt ? `Notified at ${formatClock(truck.notifiedAt)}` : undefined}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ok-soft px-2 py-0.5 text-[11px] font-medium text-ok"
      >
        <Icon size={11} aria-hidden />
        Notified {truck.notifiedLoadId}
      </span>
    );
  }
  if (truck.loads === null) {
    return <span className="shrink-0 rounded-full bg-tone-amber-soft px-2 py-0.5 text-[11px] font-medium text-tone-amber">Board unavailable</span>;
  }
  if (truck.loads.length === 0) {
    return <span className="shrink-0 rounded-full bg-panel-raised px-2 py-0.5 text-[11px] font-medium text-fg-muted">No loads yet</span>;
  }
  return (
    <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">
      {truck.loads.length === 1 ? "1 load fits" : `${plural(truck.loads.length, "load")} fit`}
    </span>
  );
}

function FitLoad({
  truck,
  load,
  sending,
  blocked,
  onNotify,
}: {
  truck: CapacityTruck;
  load: CapacityLoad;
  sending: boolean;
  // The truck cannot take a notice: already notified, no verified contact, or another notice in flight.
  blocked: boolean;
  onNotify: (loadId: string) => void;
}) {
  const equipment = truck.equipment === null ? equipmentLabel(load.equipmentType) : truckEquipment(truck);
  return (
    <li className="flex min-w-0 flex-col gap-1 border-t border-line px-4 py-2.5 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="tabular shrink-0 text-xs text-fg-muted">{load.loadId}</span>
        {load.preferred && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
            <LuStar size={10} aria-hidden />
            Preferred lane
          </span>
        )}
        <span className="tabular ml-auto shrink-0 text-xs text-fg">{formatUsd(load.loadboardRate)}</span>
      </div>
      <div className="flex min-w-0 items-center gap-1 text-sm text-fg">
        <span className="truncate">{load.origin}</span>
        <LuArrowRight size={12} className="shrink-0 text-fg-faint" aria-label="to" />
        <span className="truncate">{load.destination}</span>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="text-xs text-fg-muted">
          {equipment} · {truck.state} origin · pickup {load.pickupDateTime} (free {formatFreeDay(truck.freeDate)})
        </span>
        <button
          type="button"
          onClick={() => onNotify(load.loadId)}
          disabled={blocked}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-line px-2.5 text-xs font-medium text-fg transition-colors hover:bg-panel-raised disabled:cursor-not-allowed disabled:opacity-50"
        >
          <LuSend size={12} aria-hidden />
          {sending ? "Sending" : "Notify"}
        </button>
      </div>
    </li>
  );
}

function TruckRow({
  truck,
  open,
  onToggle,
  sendingLoadId,
  busy,
  notice,
  onNotify,
}: {
  truck: CapacityTruck;
  open: boolean;
  onToggle: () => void;
  // The load this truck's notice is sending, if any.
  sendingLoadId: string | null;
  // Any notice is in flight; one at a time.
  busy: boolean;
  notice: Notice | null;
  onNotify: (loadId: string) => void;
}) {
  const blocked = busy || truck.notifiedLoadId !== null || truck.noticeChannel === null;
  return (
    <div className="border-b border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`flex w-full min-w-0 items-center gap-2.5 px-4 py-2.5 text-left transition focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
          open ? "bg-panel-raised" : "hover:bg-panel-raised"
        }`}
      >
        <LuTruck size={16} className="shrink-0 text-fg-muted" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-fg">{carrierName({ ...truck, dotNumber: null })}</span>
          <span className="truncate text-xs text-fg-muted">
            Free in {truck.city}, {truck.state} · {formatFreeDay(truck.freeDate)} · {truckEquipment(truck)}
          </span>
        </span>
        <FitBadge truck={truck} />
        <LuChevronDown size={14} className={`shrink-0 text-fg-faint transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && (
        <div className="bg-panel-raised/40">
          {truck.noticeChannel === null && (
            <p className="flex items-center gap-1 px-4 pt-2 text-xs text-warn">
              <LuTriangleAlert size={12} aria-hidden />
              No verified contact
            </p>
          )}
          {notice && <p className={`px-4 pt-2 text-xs ${notice.tone}`}>{notice.text}</p>}
          {truck.loads === null ? (
            <p className="px-4 py-3 text-xs text-fg-muted">The load board could not be read for this truck. Retry shortly.</p>
          ) : truck.loads.length === 0 ? (
            <p className="px-4 py-3 text-xs text-fg-muted">No open load fits this truck yet.</p>
          ) : (
            <ul>
              {truck.loads.map((load) => (
                <FitLoad
                  key={load.loadId}
                  truck={truck}
                  load={load}
                  sending={sendingLoadId === load.loadId}
                  blocked={blocked}
                  onNotify={onNotify}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Trucks carriers said free up, with the open loads that fit each; the operator sends one load per truck.
export function FreeTrucks() {
  // A new tick polls again at once, so a notice shows on the row without waiting a minute.
  const [tick, setTick] = useState(0);
  const { data, error } = usePollWith<TowerCapacity>(
    `/api/capacity#${tick}`,
    (signal) => fetchTower<TowerCapacity>("/api/capacity", signal, "capacity list"),
    capacityPollMs,
    "capacity list",
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [sending, setSending] = useState<{ truckId: string; loadId: string } | null>(null);
  const [notices, setNotices] = useState<Record<string, Notice>>({});

  const trucks = data?.trucks ?? null;

  async function onNotify(truckId: string, loadId: string) {
    setSending({ truckId, loadId });
    try {
      const notice = await postNotice(truckId, loadId);
      if (notice) setNotices((current) => ({ ...current, [truckId]: notice }));
    } catch {
      setNotices((current) => ({ ...current, [truckId]: { tone: "text-warn", text: "Could not reach the tower. Retry shortly." } }));
    } finally {
      setSending(null);
      setTick((n) => n + 1);
    }
  }

  return (
    <section
      aria-label="Free trucks"
      className="flex max-h-[40%] shrink-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-panel"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-fg">
          <LuTruck size={14} className="text-fg-muted" aria-hidden />
          Free trucks
        </h2>
        {error !== null ? (
          <span className="flex items-center gap-1 text-xs text-warn">
            <LuTriangleAlert size={12} aria-hidden />
            {trucks === null ? error : "Stale"}
          </span>
        ) : (
          <span className="tabular text-xs text-fg-faint">{trucks === null ? "-" : trucks.length}</span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {trucks === null ? (
          <EmptyState className="py-6" icon={<LuTruck size={20} />} title={error === null ? "Loading trucks" : "Free trucks unavailable"} />
        ) : trucks.length === 0 ? (
          <EmptyState
            className="py-6"
            icon={<LuTruck size={20} />}
            title="No free trucks on file"
            hint="Trucks show here when a carrier without a load says when it frees up"
          />
        ) : (
          trucks.map((truck) => (
            <TruckRow
              key={truck.id}
              truck={truck}
              open={openId === truck.id}
              onToggle={() => setOpenId((current) => (current === truck.id ? null : truck.id))}
              sendingLoadId={sending?.truckId === truck.id ? sending.loadId : null}
              busy={sending !== null}
              notice={notices[truck.id] ?? null}
              onNotify={(loadId) => void onNotify(truck.id, loadId)}
            />
          ))
        )}
      </div>
    </section>
  );
}
