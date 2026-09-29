"use client";

import { LuMousePointerClick, LuRadioTower, LuTriangleAlert } from "react-icons/lu";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AutonomySwitch } from "@/components/autonomy-switch";
import { CallDetail } from "@/components/call-detail";
import { CallWall } from "@/components/call-wall";
import { DayCounters } from "@/components/day-counters";
import { EmptyState } from "@/components/empty-state";
import { LoadPanel } from "@/components/load-panel";
import { PulseDot } from "@/components/pulse-dot";
import { TmsHealth } from "@/components/tms-health";
import { formatClock, formatDay } from "@/lib/format";
import { useWall } from "@/lib/use-wall";

// Elapsed times tick every second even between wall answers.
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function LiveIndicator({ stale }: { stale: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
      {stale ? <span className="inline-flex size-2 rounded-full bg-warn" aria-hidden /> : <PulseDot tone="ok" />}
      <span className={stale ? "text-warn" : "text-ok"}>{stale ? "Stale" : "Live"}</span>
    </span>
  );
}

function PanelHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="border-b border-line px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-faint">{children}</h2>
  );
}

export function TowerShell() {
  const { wall, error, loading, updatedAt } = useWall();
  const now = useNow();
  const searchParams = useSearchParams();
  const selectedCallId = searchParams.get("call");
  const selectedCall = wall?.calls.find((call) => call.callId === selectedCallId) ?? null;
  // The call the operator is speaking on, so the wall can mark it.
  const [takenOverCallId, setTakenOverCallId] = useState<string | null>(null);

  // The selection lives in ?call= so a reload keeps the operator on the same call.
  const select = useCallback(
    (callId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("call", callId);
      window.history.replaceState(null, "", `?${params.toString()}`);
    },
    [searchParams],
  );

  const stale = error !== null && wall !== null;

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-line bg-panel px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="grid size-7 place-items-center rounded-full bg-accent-soft text-accent">
            <LuRadioTower size={14} />
          </span>
          <h1 className="text-sm font-semibold tracking-tight">Control Tower</h1>
          <LiveIndicator stale={stale || (error !== null && wall === null)} />
          {wall && <span className="tabular text-xs text-fg-muted">{formatDay(wall.day)}</span>}
        </div>
        <div className="flex flex-1 justify-center">
          <DayCounters counters={wall?.counters ?? null} />
        </div>
        <AutonomySwitch mode={wall?.autonomy ?? null} />
        <TmsHealth health={wall?.tmsHealth ?? null} />
      </header>

      {error !== null && (
        <div role="status" className="flex items-center gap-2 border-b border-line bg-risk-soft px-4 py-1.5 text-xs text-risk">
          <LuTriangleAlert size={14} aria-hidden />
          <span>{error}.</span>
          {updatedAt !== null && (
            <span className="text-fg-muted">
              Showing data from <span className="tabular">{formatClock(updatedAt, true)}</span>
            </span>
          )}
        </div>
      )}

      <main className="grid flex-1 gap-3 p-3 lg:grid-cols-[380px_minmax(0,1fr)_360px]">
        <section aria-label="Call wall" className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-panel">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-fg-faint">Calls</h2>
            {wall?.liveUnavailable && (
              <span className="flex items-center gap-1 text-xs text-warn">
                <LuTriangleAlert size={12} aria-hidden />
                Live status unavailable
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <CallWall
              calls={wall?.calls ?? null}
              loading={loading}
              now={now}
              selectedCallId={selectedCallId}
              takenOverCallId={takenOverCallId}
              onSelect={select}
            />
          </div>
        </section>

        <section
          aria-label="Call detail"
          className="flex h-[calc(100dvh-4.75rem)] min-h-[560px] flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-panel"
        >
          {selectedCall ? (
            <CallDetail key={selectedCall.callId} call={selectedCall} now={now} onTakeoverChange={setTakenOverCallId} />
          ) : (
            <>
              <PanelHeading>Call</PanelHeading>
              <EmptyState
                className="flex-1 py-16"
                icon={<LuMousePointerClick size={20} />}
                title="Select a call to follow it"
                hint="Pick a row on the wall or use the arrow keys"
              />
            </>
          )}
        </section>

        <section
          aria-label="Load context"
          className="flex min-h-0 flex-col overflow-y-auto rounded-[var(--radius-panel)] border border-line bg-panel lg:h-[calc(100dvh-4.75rem)]"
        >
          <LoadPanel calls={wall?.calls ?? []} selectedCall={selectedCall} />
        </section>
      </main>
    </div>
  );
}
