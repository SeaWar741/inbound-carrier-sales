"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { LuContainer, LuRoute } from "react-icons/lu";
import { DemandList } from "@/components/demand/demand-list";
import { equipmentOptions, HeaderSelect, stateOptions } from "@/components/inbox/filter-bar";
import type { TowerDemand } from "@/lib/contracts";
import { demandKey } from "@/lib/demand";
import { updateSearch, usePagedList } from "@/lib/use-paged-list";

// Demand builds up over days, not seconds.
const demandPollMs = 60_000;

// Everything the adapter query reads from the URL; both are filters "Clear filters" resets.
const filterKeys = ["equipment", "origin"] as const;

// Lanes carriers asked for that the board did not cover: searches with no load and offers that
// ended without a booking. The filters live in the URL; one row opens at a time to show its carriers.
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

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const onToggle = useCallback((key: string) => setExpandedKey((prev) => (prev === key ? null : key)), []);

  const equipment = searchParams.get("equipment") ?? "";
  const origin = searchParams.get("origin") ?? "";
  const filtered = equipment !== "" || origin !== "";

  const onClearFilters = useCallback(() => updateSearch(Object.fromEntries(filterKeys.map((key) => [key, null]))), []);

  const header = (
    <>
      <div className="px-4 pt-3">
        <h1 className="font-semibold text-fg">Demand</h1>
        <p className="mt-0.5 text-sm text-fg-muted">Last 4 weeks · searches and offers the board did not cover</p>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 px-4 py-3">
        <div className="flex w-full max-w-md min-w-0 items-center gap-1.5">
          <HeaderSelect label="From" icon={LuRoute} tone="text-ok" value={origin} onChange={(v) => updateSearch({ origin: v })} options={stateOptions} />
          <HeaderSelect
            label="Equipment"
            grow={1.5}
            icon={LuContainer}
            tone="text-accent"
            value={equipment}
            onChange={(v) => updateSearch({ equipment: v })}
            options={equipmentOptions}
          />
        </div>
      </div>
    </>
  );

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <DemandList
        data={data}
        loading={loading}
        error={error}
        header={header}
        filtered={filtered}
        expandedKey={expandedKey}
        loadingMore={loadingMore}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        onToggle={onToggle}
        onClearFilters={onClearFilters}
      />
    </div>
  );
}
