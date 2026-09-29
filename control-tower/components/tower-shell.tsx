"use client";

import { LuMousePointerClick, LuTriangleAlert } from "react-icons/lu";
import { useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { CallDetail } from "@/components/call-detail";
import { CallWall } from "@/components/call-wall";
import { EmptyState } from "@/components/empty-state";
import { LoadPanel } from "@/components/load-panel";
import { useNow } from "@/lib/use-now";
import { useSharedWall } from "@/lib/use-wall";

function PanelHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="border-b border-line px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-faint">{children}</h2>
  );
}

export function TowerShell() {
  const { wall, loading } = useSharedWall();
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

  return (
    <div className="grid h-full min-h-0 grid-cols-[340px_minmax(0,1fr)_320px] gap-3 p-3">
      <section aria-label="Call wall" className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-panel">
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
        className="flex h-full min-h-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-panel"
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
        className="flex h-full min-h-0 flex-col overflow-y-auto rounded-[var(--radius-panel)] border border-line bg-panel"
      >
        <LoadPanel calls={wall?.calls ?? []} selectedCall={selectedCall} />
      </section>
    </div>
  );
}
