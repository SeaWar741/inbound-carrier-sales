"use client";

import Link from "next/link";
import type { IconType } from "react-icons";
import {
  LuArrowRight,
  LuChartColumn,
  LuCircleCheck,
  LuClock,
  LuExternalLink,
  LuHandshake,
  LuHistory,
  LuPhone,
  LuRoute,
  LuSearch,
  LuShieldCheck,
  LuShieldX,
} from "react-icons/lu";
import { equipmentLabel } from "@/components/hold-card";
import { Badge } from "@/components/inbox/stage-pill";
import { growthStyle, NetworkChips, TrendArrow } from "@/components/network/network-chips";
import { Section } from "@/components/section";
import type { NetworkCarrier } from "@/lib/contracts";
import { carrierName, formatDateTime, formatTimeAgo } from "@/lib/format";
import { inboxHref, networkReason, windowPhrase, type NetworkWindow } from "@/lib/network";

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

// The selected carrier, read from its list row: nothing here fetches.
export function NetworkDetail({ carrier, now, dateWindow }: { carrier: NetworkCarrier; now: number; dateWindow: NetworkWindow }) {
  const { facts } = carrier;
  const numbers = [carrier.mcNumber && `MC ${carrier.mcNumber}`, carrier.dotNumber && `DOT ${carrier.dotNumber}`].filter(Boolean).join(" · ");
  const when = windowPhrase(dateWindow);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-bg">
      <div className="border-b border-line bg-panel px-5 py-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-fg">{carrierName(carrier)}</h2>
            {numbers && <p className="tabular mt-0.5 truncate text-sm text-fg-muted">{numbers}</p>}
          </div>
          {carrier.eligible ? (
            <Badge tone="bg-ok-soft text-ok" size="md">
              <LuShieldCheck size={13} aria-hidden />
              Eligible
            </Badge>
          ) : (
            <Badge tone="bg-risk-soft text-risk" size="md">
              <LuShieldX size={13} aria-hidden />
              Not eligible
            </Badge>
          )}
        </div>
        <div className="mt-3">
          <NetworkChips carrier={carrier} size="md" />
        </div>
        <p className="mt-2 text-sm text-fg">{networkReason(carrier, now, dateWindow)}</p>
        <Link
          href={inboxHref(carrier, now)}
          className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-panel px-3 text-sm font-medium text-fg shadow-xs outline-none hover:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <LuExternalLink size={14} aria-hidden />
          Open in Inbox
        </Link>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <Section icon={LuChartColumn} title={`Activity ${when}`}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
            <Fact icon={LuPhone} label="Calls">{facts.calls}</Fact>
            <Fact icon={LuSearch} label="Load searches">{facts.searches}</Fact>
            <Fact icon={LuHandshake} label="Loads negotiated">{facts.loadsNegotiated}</Fact>
            <Fact icon={LuCircleCheck} label="Bookings">{facts.bookings}</Fact>
          </div>
        </Section>

        <Section icon={LuHistory} title="All time">
          <div className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
            <Fact icon={LuPhone} label="Calls">{facts.lifetimeCalls}</Fact>
            <Fact icon={LuCircleCheck} label="Bookings">{facts.lifetimeBookings}</Fact>
            <Fact icon={LuClock} label="Last call">
              {formatDateTime(facts.lastCallAt)} <span className="font-normal text-fg-muted">({formatTimeAgo(facts.lastCallAt, now)} ago)</span>
            </Fact>
          </div>
          <div className="mt-3 text-xs">
            <TrendArrow carrier={carrier} withText />
          </div>
        </Section>

        <Section icon={LuRoute} title={`Lanes seen ${when}`}>
          {carrier.lanes.length === 0 ? (
            <p className="text-sm text-fg-muted">No searches or negotiated loads {when}.</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {carrier.lanes.map((lane) => (
                <li
                  key={`${lane.originState}|${lane.destinationState}|${lane.equipment}`}
                  className="flex min-w-0 items-center gap-2 py-1.5"
                >
                  <span className="font-medium text-fg">{lane.originState ?? "Any"}</span>
                  <LuArrowRight size={12} className="shrink-0 text-fg-faint" aria-hidden />
                  <span className="font-medium text-fg">{lane.destinationState ?? "Any"}</span>
                  <span className="min-w-0 truncate text-fg-muted">· {lane.equipment ? equipmentLabel(lane.equipment) : "Any equipment"}</span>
                  {lane.open && <Badge tone={growthStyle.pill}>Open on board</Badge>}
                  <span className="tabular ml-auto shrink-0 text-fg-muted" title={`On ${lane.count} ${lane.count === 1 ? "call" : "calls"}`}>
                    {lane.count}×
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
