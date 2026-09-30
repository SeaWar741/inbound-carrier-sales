"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { ActiveLoads } from "@/components/dashboard/active-loads";
import { KpiTiles } from "@/components/dashboard/kpi-tiles";
import { LaneMap, type LaneMapLoad } from "@/components/lane-map";
import type { TowerLoads } from "@/lib/contracts";
import { carrierName, equipmentLabel } from "@/lib/format";
import { emptyLoadFilters, filterLoads, loadEquipments, loadOrigins, sortLoads, statusCounts, type LoadFilters, type LoadSort } from "@/lib/load-filters";
import { updateSearch } from "@/lib/url-search";
import { usePoll } from "@/lib/use-poll";
import { useSharedWall } from "@/lib/use-wall";

const loadsPollMs = 15_000;

// useSearchParams needs a Suspense boundary to prerender.
export default function DashboardPage() {
  return (
    <Suspense>
      <Dashboard />
    </Suspense>
  );
}

function Dashboard() {
  const searchParams = useSearchParams();
  const { data: wall } = useSharedWall();
  const { data, error } = usePoll<TowerLoads>("/api/loads", loadsPollMs, "load list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Links from other pages (/?origin=TX&equipment=REEFER) open the list already narrowed. Origin and
  // equipment changes write back to the URL, so a cleared filter stays cleared on reload.
  const [filters, setFilters] = useState<LoadFilters>(() => ({
    ...emptyLoadFilters,
    origin: (searchParams.get("origin") ?? "").trim().toUpperCase(),
    equipment: (searchParams.get("equipment") ?? "").trim().toUpperCase(),
  }));
  const [sort, setSort] = useState<LoadSort>("");

  const loads = data?.loads ?? null;
  // The adapter orders by pickup; the sorts are stable, so ties keep that order.
  // /api/loads returns the whole window unpaginated, so the list and the map narrow it here.
  const shown = useMemo(() => (data ? sortLoads(filterLoads(data.loads, filters), sort) : null), [data, filters, sort]);
  const counts = useMemo(() => (data ? statusCounts(data.loads, filters) : null), [data, filters]);
  const equipments = useMemo(() => loadEquipments(data?.loads ?? []), [data]);
  const origins = useMemo(() => loadOrigins(data?.loads ?? []), [data]);

  const onFilter = useCallback(<K extends keyof LoadFilters>(key: K, value: LoadFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    if (key === "origin" || key === "equipment") updateSearch({ [key]: value || null });
  }, []);
  const onClear = useCallback(() => {
    setFilters(emptyLoadFilters);
    setSort("");
    updateSearch({ origin: null, equipment: null });
  }, []);

  // A selected load the filters (or the next poll) drop is no longer selected.
  const selected = shown?.some((load) => load.holdId === selectedId) ? selectedId : null;

  const mapLoads = useMemo<LaneMapLoad[]>(
    () =>
      (shown ?? []).map((load) => {
        const origin = `${load.lane.origin.city}, ${load.lane.origin.state}`;
        const destination = `${load.lane.destination.city}, ${load.lane.destination.state}`;
        const carrier = carrierName({ ...load, dotNumber: null });
        return {
          id: load.holdId,
          originZip: load.lane.origin.zip,
          destinationZip: load.lane.destination.zip,
          progress: load.progress,
          status: load.status,
          label: `${load.loadId} ${origin} to ${destination}, ${carrier}`,
          loadId: load.loadId,
          origin,
          destination,
          carrier,
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
          <LaneMap loads={mapLoads} selectedId={selected} onSelect={setSelectedId} overview />
        </section>
        <ActiveLoads
          loads={shown}
          total={loads?.length ?? null}
          error={error}
          selectedId={selected}
          onSelect={setSelectedId}
          filters={filters}
          sort={sort}
          counts={counts}
          equipments={equipments}
          origins={origins}
          onFilter={onFilter}
          onSort={setSort}
          onClear={onClear}
        />
      </div>
    </div>
  );
}
