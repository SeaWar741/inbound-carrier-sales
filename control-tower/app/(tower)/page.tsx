"use client";

import { useMemo, useState } from "react";
import { ActiveLoads, carrierLabel } from "@/components/dashboard/active-loads";
import { KpiTiles } from "@/components/dashboard/kpi-tiles";
import { LaneMap, type LaneMapLoad } from "@/components/lane-map";
import type { TowerLoads, TripStatus } from "@/lib/contracts";
import { usePoll } from "@/lib/use-poll";
import { useSharedWall } from "@/lib/use-wall";

const loadsPollMs = 15_000;

// Trucks on the road first, then the ones about to pick up, then the ones already delivered.
const statusRank: Record<TripStatus, number> = { in_transit: 0, upcoming: 1, arrived: 2 };

export default function DashboardPage() {
  const { wall } = useSharedWall();
  const { data, error } = usePoll<TowerLoads>("/api/loads", loadsPollMs, "load list");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The adapter orders by pickup; the sort is stable, so each status keeps that order.
  const loads = useMemo(() => (data ? [...data.loads].sort((a, b) => statusRank[a.status] - statusRank[b.status]) : null), [data]);
  const mapLoads = useMemo<LaneMapLoad[]>(
    () =>
      (loads ?? []).map((load) => ({
        id: load.holdId,
        originZip: load.lane.origin.zip,
        destinationZip: load.lane.destination.zip,
        progress: load.progress,
        status: load.status,
        label: `${load.loadId} ${load.lane.origin.city}, ${load.lane.origin.state} to ${load.lane.destination.city}, ${load.lane.destination.state}, ${carrierLabel(load)}`,
      })),
    [loads],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3">
      <KpiTiles loads={loads} counters={wall?.counters ?? null} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] gap-3">
        <section aria-label="Load map" className="h-full min-h-0 overflow-hidden rounded-[var(--radius-panel)] border border-line bg-panel">
          <LaneMap loads={mapLoads} selectedId={selectedId} onSelect={setSelectedId} />
        </section>
        <ActiveLoads loads={loads} error={error} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
    </div>
  );
}
