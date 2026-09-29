"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActiveLoads, carrierLabel } from "@/components/dashboard/active-loads";
import { KpiTiles } from "@/components/dashboard/kpi-tiles";
import { equipmentLabel } from "@/components/hold-card";
import { LaneMap, type LaneMapLoad } from "@/components/lane-map";
import type { TowerLoads } from "@/lib/contracts";
import { emptyLoadFilters, filterLoads, loadEquipments, sortLoads, statusCounts, type LoadFilters, type LoadSort } from "@/lib/load-filters";
import { usePoll } from "@/lib/use-poll";
import { useSharedWall } from "@/lib/use-wall";

const loadsPollMs = 15_000;

export default function DashboardPage() {
  const { wall } = useSharedWall();
  const { data, error } = usePoll<TowerLoads>("/api/loads", loadsPollMs, "load list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<LoadFilters>(emptyLoadFilters);
  const [sort, setSort] = useState<LoadSort>("");

  // The adapter orders by pickup; the sorts are stable, so ties keep that order.
  const loads = useMemo(() => (data ? sortLoads(data.loads, "") : null), [data]);
  // /api/loads returns the whole window unpaginated, so the list and the map narrow it here.
  const shown = useMemo(() => (data ? sortLoads(filterLoads(data.loads, filters), sort) : null), [data, filters, sort]);
  const counts = useMemo(() => (data ? statusCounts(data.loads, filters) : null), [data, filters]);
  const equipments = useMemo(() => loadEquipments(data?.loads ?? []), [data]);

  const onFilter = useCallback(<K extends keyof LoadFilters>(key: K, value: LoadFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  }, []);
  const onClear = useCallback(() => {
    setFilters(emptyLoadFilters);
    setSort("");
  }, []);

  // A selected load the filters (or the next poll) drop is no longer selected.
  useEffect(() => {
    if (shown !== null && selectedId !== null && !shown.some((load) => load.holdId === selectedId)) setSelectedId(null);
  }, [shown, selectedId]);

  const mapLoads = useMemo<LaneMapLoad[]>(
    () =>
      (shown ?? []).map((load) => {
        const origin = `${load.lane.origin.city}, ${load.lane.origin.state}`;
        const destination = `${load.lane.destination.city}, ${load.lane.destination.state}`;
        return {
          id: load.holdId,
          originZip: load.lane.origin.zip,
          destinationZip: load.lane.destination.zip,
          progress: load.progress,
          status: load.status,
          label: `${load.loadId} ${origin} to ${destination}, ${carrierLabel(load)}`,
          loadId: load.loadId,
          origin,
          destination,
          carrier: carrierLabel(load),
          etaAt: load.etaAt,
          rate: load.agreedRate,
          equipment: equipmentLabel(load.lane.equipment),
        };
      }),
    [shown],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3">
      <KpiTiles loads={loads} counters={wall?.counters ?? null} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] gap-3">
        <section aria-label="Load map" className="h-full min-h-0 overflow-hidden rounded-[var(--radius-panel)] border border-line bg-panel">
          <LaneMap loads={mapLoads} selectedId={selectedId} onSelect={setSelectedId} overview />
        </section>
        <ActiveLoads
          loads={shown}
          total={loads?.length ?? null}
          error={error}
          selectedId={selectedId}
          onSelect={setSelectedId}
          filters={filters}
          sort={sort}
          counts={counts}
          equipments={equipments}
          onFilter={onFilter}
          onSort={setSort}
          onClear={onClear}
        />
      </div>
    </div>
  );
}
