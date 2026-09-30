"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import type { IconType } from "react-icons";
import { LuContainer, LuHandshake, LuRadar, LuRoute, LuSearchX, LuTriangleAlert, LuUsers } from "react-icons/lu";
import { DemandDetail } from "@/components/demand/demand-detail";
import { DemandList } from "@/components/demand/demand-list";
import { equipmentOptions, HeaderSelect, stateOptions } from "@/components/inbox/filter-bar";
import type { TowerDemand } from "@/lib/contracts";
import { demandKey, demandTotalsLabels, parseDemandKey } from "@/lib/demand";
import { updateSearch, usePagedList } from "@/lib/use-paged-list";

// Demand builds up over days, not seconds.
const demandPollMs = 60_000;

// Everything the adapter query reads from the URL; both are filters "Clear filters" resets. `lane`
// only drives the panel.
const filterKeys = ["equipment", "origin"] as const;

function Total({ icon: Icon, tone, text }: { icon: IconType; tone: string; text: string }) {
  // Every label starts with its count, which reads bold.
  const [count, ...words] = text.split(" ");
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-sm text-fg">
      <Icon size={15} className={`shrink-0 ${tone}`} aria-hidden />
      <span>
        <span className="font-semibold tabular-nums">{count}</span> {words.join(" ")}
      </span>
    </span>
  );
}

// Lanes carriers asked for that the board did not cover: searches with no load and offers that
// ended without a booking. A ranked list on the left, the selected lane and who asked on the right.
// Filters and the clicked lane live in the URL; with no lane there, the first row shows.
export function Demand() {
  const searchParams = useSearchParams();

  const listQuery = useMemo(() => {
    const query = new URLSearchParams();
    for (const key of filterKeys) {
      const value = searchParams.get(key);
      if (value) query.set(key, value);
    }
    return query.toString();
  }, [searchParams]);

  const { data, error, loading, loadingMore, hasMore, onLoadMore } = usePagedList<TowerDemand>("/api/demand", listQuery, demandKey, demandPollMs, "demand data");

  const equipment = searchParams.get("equipment") ?? "";
  const origin = searchParams.get("origin") ?? "";
  const filtered = equipment !== "" || origin !== "";

  // A filter change drops the lane, which the new list may no longer hold.
  const onFilter = useCallback((key: (typeof filterKeys)[number], value: string) => updateSearch({ [key]: value, lane: null }), []);
  const onClearFilters = useCallback(() => updateSearch({ ...Object.fromEntries(filterKeys.map((key) => [key, null])), lane: null }), []);
  const onSelect = useCallback((key: string) => updateSearch({ lane: key }), []);

  const rows = data?.rows ?? [];
  const laneParam = searchParams.get("lane");
  const linked = laneParam ? parseDemandKey(laneParam) : null;
  const selectedRow = linked ? (rows.find((row) => demandKey(row) === laneParam) ?? null) : (rows[0] ?? null);
  const selected = selectedRow ?? linked;
  const selectedKey = selected ? demandKey(selected) : null;
  const totals = data ? demandTotalsLabels(data.totals) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-panel">
      <div className="shrink-0 border-b border-line px-4 py-3">
        <h1 className="font-semibold text-fg">Demand</h1>
        <p className="mt-0.5 text-sm text-fg-muted">Last 4 weeks · lanes carriers asked for that we could not cover</p>
        <div className="mt-3 flex min-w-0 items-center gap-5">
          {totals ? (
            <>
              <Total icon={LuSearchX} tone="text-tone-amber" text={totals.noMatch} />
              <Total icon={LuHandshake} tone="text-tone-amber" text={totals.offeredNoBooking} />
              <Total icon={LuUsers} tone="text-accent" text={totals.carriers} />
            </>
          ) : (
            <span aria-hidden className="h-4 w-96 animate-pulse rounded-md bg-panel-raised" />
          )}
          <div className="ml-auto flex w-80 shrink-0 items-center gap-1.5">
            <HeaderSelect label="From" icon={LuRoute} tone="text-ok" value={origin} onChange={(v) => onFilter("origin", v)} options={stateOptions} />
            <HeaderSelect
              label="Equipment"
              grow={1.5}
              icon={LuContainer}
              tone="text-accent"
              value={equipment}
              onChange={(v) => onFilter("equipment", v)}
              options={equipmentOptions}
            />
          </div>
        </div>
        {error && data && (
          <p role="status" className="mt-2 flex items-center gap-1 text-xs text-risk">
            <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
            <span className="truncate">{error}</span>
          </p>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="h-full min-h-0 min-w-0 flex-[3] border-r border-line">
          <DemandList
            data={data}
            loading={loading}
            filtered={filtered}
            selectedKey={selectedKey}
            loadingMore={loadingMore}
            hasMore={hasMore}
            onLoadMore={onLoadMore}
            onSelect={onSelect}
            onClearFilters={onClearFilters}
          />
        </div>
        <div className="h-full min-h-0 min-w-0 flex-[2]">
          {selected ? (
            // Keyed so a new lane starts with an empty carrier list instead of the last lane's.
            <DemandDetail key={selectedKey} lane={selected} row={selectedRow} listLoaded={data !== null} />
          ) : (
            <div className="grid h-full place-items-center bg-bg">
              <div className="text-center text-fg-muted">
                <LuRadar size={48} className="mx-auto mb-3 opacity-50" aria-hidden />
                <p>{data === null ? (loading ? "Loading lanes..." : "The demand data is unavailable") : "No lane to show"}</p>
                <p className="mt-1 text-xs text-fg-faint">The top lane opens here once there is one</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
