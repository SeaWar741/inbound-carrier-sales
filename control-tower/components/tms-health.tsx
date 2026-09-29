"use client";

import { Plugs } from "@phosphor-icons/react";
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">{label}</span>
      <span className="tabular text-sm leading-tight text-fg">{value}</span>
    </div>
  );
}

export function TmsHealth({ health }: { health: Health | null }) {
  const lastFaultAt = useLastFaultAt(health?.faultsAbsorbed);
  const noTraffic = health === null || health.latencySamples === 0;
  // Date.now() is read at render; the wall re-renders every second, which keeps the window honest.
  const faultIsRecent = lastFaultAt !== null && Date.now() - lastFaultAt < recentFaultMs;
  const healthy = !noTraffic && (health.latencyP95Ms ?? 0) < slowP95Ms && !faultIsRecent;
  const statusLabel = noTraffic ? "No TMS traffic" : healthy ? "TMS healthy" : "TMS degraded";

  return (
    <section aria-label="TMS health" className="flex items-center gap-4">
      <div className="flex items-center gap-2 text-fg-muted">
        <span
          role="img"
          aria-label={statusLabel}
          title={statusLabel}
          className={`size-2 rounded-full ${noTraffic ? "bg-fg-faint" : healthy ? "bg-ok" : "bg-warn"}`}
        />
        <Plugs size={16} weight="regular" aria-hidden />
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">TMS</span>
      </div>
      {noTraffic ? (
        <span className="text-xs text-fg-muted">No TMS traffic yet</span>
      ) : (
        <div className="flex items-center gap-4">
          <Stat label="p50 ms" value={formatMs(health.latencyP50Ms)} />
          <Stat label="p95 ms" value={formatMs(health.latencyP95Ms)} />
          <Stat label="Retries" value={String(health.retries)} />
          <Stat label="Faults absorbed" value={String(health.faultsAbsorbed)} />
        </div>
      )}
    </section>
  );
}
