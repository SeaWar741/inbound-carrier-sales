"use client";

import { LuPlug } from "react-icons/lu";
import { useEffect, useRef, useState } from "react";
import type { TowerWall } from "@/lib/contracts";
import { formatMs } from "@/lib/format";

type Health = TowerWall["tmsHealth"];

const slowP95Ms = 1_500;
// A fault counts as recent for this long after the absorbed-faults counter last went up.
const recentFaultMs = 60_000;

// The adapter reports cumulative faults, so "recent" is tracked here from when the count last grew.
function useLastFaultAt(faults: number | undefined): number | null {
  const previous = useRef<number | undefined>(undefined);
  const [lastFaultAt, setLastFaultAt] = useState<number | null>(null);
  useEffect(() => {
    if (faults === undefined) return;
    if (previous.current !== undefined && faults > previous.current) setLastFaultAt(Date.now());
    previous.current = faults;
  }, [faults]);
  return lastFaultAt;
}

// "304 ms", or "-" when there are no samples.
const ms = (value: number | null) => (value === null ? "-" : `${formatMs(value)} ms`);

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="tabular text-fg">{value}</dd>
    </div>
  );
}

// A compact chip for the header: status dot, "TMS" and the p95. The full metrics open in a small
// panel on hover or keyboard focus so the header never grows past its width.
export function TmsHealth({ health }: { health: Health | null }) {
  const lastFaultAt = useLastFaultAt(health?.faultsAbsorbed);
  const noTraffic = health === null || health.latencySamples === 0;
  // Date.now() is read at render; the wall re-renders every second, which keeps the window honest.
  const faultIsRecent = lastFaultAt !== null && Date.now() - lastFaultAt < recentFaultMs;
  const healthy = !noTraffic && (health.latencyP95Ms ?? 0) < slowP95Ms && !faultIsRecent;
  const statusLabel = noTraffic ? "No TMS traffic" : healthy ? "TMS healthy" : "TMS degraded";

  return (
    <section aria-label="TMS health" className="group relative shrink-0">
      <button
        type="button"
        aria-describedby="tms-health-detail"
        className="flex cursor-default items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-fg-muted outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span role="img" aria-label={statusLabel} className={`size-2 rounded-full ${noTraffic ? "bg-fg-faint" : healthy ? "bg-ok" : "bg-warn"}`} />
        <LuPlug size={14} aria-hidden />
        <span className="font-medium uppercase tracking-wide">TMS</span>
        <span className="tabular text-fg">{noTraffic ? "-" : `p95 ${ms(health.latencyP95Ms)}`}</span>
      </button>
      <div
        id="tms-health-detail"
        role="tooltip"
        className="invisible absolute right-0 top-full z-50 mt-1.5 w-52 rounded-[var(--radius-panel)] border border-line bg-panel p-3 text-xs opacity-0 shadow-md transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        <p className="mb-2 font-medium text-fg">{statusLabel}</p>
        {noTraffic ? (
          <p className="text-fg-muted">No TMS traffic yet</p>
        ) : (
          <dl className="flex flex-col gap-1">
            <Stat label="p50 latency" value={ms(health.latencyP50Ms)} />
            <Stat label="p95 latency" value={ms(health.latencyP95Ms)} />
            <Stat label="Retries" value={String(health.retries)} />
            <Stat label="Faults absorbed" value={String(health.faultsAbsorbed)} />
          </dl>
        )}
      </div>
    </section>
  );
}
