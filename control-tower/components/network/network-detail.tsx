"use client";

import Link from "next/link";
import type { IconType } from "react-icons";
import {
  LuArrowRight,
  LuChartColumn,
  LuCircleCheck,
  LuClock,
  LuHandshake,
  LuHistory,
  LuLightbulb,
  LuPhone,
  LuRoute,
  LuSearch,
  LuShieldCheck,
  LuShieldX,
} from "react-icons/lu";
import { Badge } from "@/components/inbox/stage-pill";
import { growthStyle, NetworkChips, reasonStyle, TrendArrow } from "@/components/network/network-chips";
import { Section } from "@/components/section";
import type { NetworkCarrier } from "@/lib/contracts";
import { carrierName, equipmentLabel, formatDateTime, formatTimeAgo } from "@/lib/format";
import { inboxHref, networkReasons, windowPhrase, type NetworkWindow } from "@/lib/network";

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

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

// The selected carrier, read from its list row: nothing here fetches. Attio's order: who it is, the
// one action, why it is on the list, then the numbers behind it.
export function NetworkDetail({ carrier, now, dateWindow }: { carrier: NetworkCarrier; now: number; dateWindow: NetworkWindow }) {
  const { facts } = carrier;
  const name = carrierName(carrier);
  // The numbers line never repeats what the name already says.
  const numbers = [carrier.mcNumber && `MC ${carrier.mcNumber}`, carrier.dotNumber && `DOT ${carrier.dotNumber}`]
    .filter((part) => part && part !== name)
    .join(" · ");
  const when = windowPhrase(dateWindow);

  return (
    <aside aria-label="Carrier" className="flex h-full min-h-0 flex-col overflow-y-auto border-l border-line bg-panel pb-6">
      <div className="border-b border-line p-4">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-fg">{name}</h2>
            {numbers && <p className="tabular mt-0.5 truncate font-mono text-xs text-fg-muted">{numbers}</p>}
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
        <Link
          href={inboxHref(carrier, now)}
          className="mt-4 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-semibold text-white outline-none transition-colors hover:bg-accent/90 focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <LuPhone size={14} aria-hidden />
          Open call history
          <LuArrowRight size={14} aria-hidden />
        </Link>
      </div>

      <Section icon={LuLightbulb} title="Why it's here">
        <ul className="flex flex-col gap-2 text-sm text-fg">
          {networkReasons(carrier, now, dateWindow).map((reason) => {
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
      </Section>

      <Section icon={LuChartColumn} title={`Activity ${when}`}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
          <Fact icon={LuPhone} label="Calls">{facts.calls}</Fact>
          <Fact icon={LuSearch} label="Load searches">{facts.searches}</Fact>
          <Fact icon={LuHandshake} label="Loads negotiated">{facts.loadsNegotiated}</Fact>
          <Fact icon={LuCircleCheck} label="Booked">{facts.bookings}</Fact>
        </div>
        <div className="mt-3 flex flex-col gap-2 text-xs">
          <p className="flex min-w-0 items-center gap-1.5 text-fg-muted">
            <LuClock size={13} className="shrink-0" aria-hidden />
            <span className="truncate">
              Last call <span className="tabular font-semibold text-fg">{formatTimeAgo(facts.lastCallAt, now)} ago</span> ({formatDateTime(facts.lastCallAt)})
            </span>
          </p>
          <p className="flex min-w-0 items-center gap-1.5 text-fg-muted">
            <LuHistory size={13} className="shrink-0" aria-hidden />
            <span className="tabular truncate">
              All time: {plural(facts.lifetimeCalls, "call")} · {facts.lifetimeBookings} booked
            </span>
          </p>
          <TrendArrow carrier={carrier} withText />
        </div>
      </Section>

      <Section icon={LuRoute} title="Lanes it runs">
        {carrier.lanes.length === 0 ? (
          <p className="text-sm text-fg-muted">No searches or negotiated loads {when}.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {carrier.lanes.map((lane) => (
              <li key={`${lane.originState}|${lane.destinationState}|${lane.equipment}`} className="flex min-w-0 items-center gap-2 py-1.5">
                <span className="min-w-0 truncate font-medium text-fg">
                  {lane.originState ?? "Any"} → {lane.destinationState ?? "Any"}
                  <span className="font-normal text-fg-muted"> · {lane.equipment ? equipmentLabel(lane.equipment) : "Any equipment"}</span>
                </span>
                <span className="min-w-0 flex-1" />
                <span className="tabular shrink-0 text-xs text-fg-muted">{plural(lane.count, "call")}</span>
                {lane.open && (
                  <Badge tone={growthStyle.pill}>
                    <span className="size-1.5 rounded-full bg-current" aria-hidden />
                    Open now
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </aside>
  );
}
