"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import type { IconType } from "react-icons";
import { LuContainer, LuHandshake, LuLoaderCircle, LuRoute, LuSearchX, LuTriangleAlert, LuUsers } from "react-icons/lu";
import { DemandList } from "@/components/demand/demand-list";
import { equipmentOptions, HeaderSelect, stateOptions } from "@/components/inbox/filter-bar";
import { useLoadMore } from "@/components/paged-list";
import type { TowerDemand } from "@/lib/contracts";
import { demandKey, demandTotalsLabels } from "@/lib/demand";
import { updateSearch, usePagedList } from "@/lib/use-paged-list";

// Demand builds up over days, not seconds.
const demandPollMs = 60_000;

// Everything the adapter query reads from the URL; both are filters "Clear filters" resets.
const filterKeys = ["equipment", "origin"] as const;

function Total({ icon: Icon, text }: { icon: IconType; text: string }) {
  // Every label starts with its count, which reads darker than its words.
  const [count, ...words] = text.split(" ");
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Icon size={14} className="shrink-0 text-fg-faint" aria-hidden />
      <span>
        <span className="font-medium tabular-nums text-fg">{count}</span> {words.join(" ")}
      </span>
    </span>
  );
}

// Lanes carriers asked for that the board did not cover: searches with no load and offers that
// ended without a booking. One card with the filters and the ranked lanes; a lane opens its own page.
// The filters live in the URL.
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
  const rowCount = data?.rows.length ?? 0;
  const { scroller, sentinel } = useLoadMore(hasMore, rowCount, onLoadMore);

  const equipment = searchParams.get("equipment") ?? "";
  const origin = searchParams.get("origin") ?? "";
  const filtered = equipment !== "" || origin !== "";

  const onFilter = useCallback((key: (typeof filterKeys)[number], value: string) => updateSearch({ [key]: value }), []);
  const onClearFilters = useCallback(() => updateSearch(Object.fromEntries(filterKeys.map((key) => [key, null]))), []);

  const totals = data ? demandTotalsLabels(data.totals) : null;

  return (
    <div ref={scroller} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-8 py-8">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Demand</h1>
        <p className="mt-1 text-sm text-fg-muted">Last 4 weeks · lanes carriers asked for that we could not cover</p>
        <div className="mt-3 flex h-5 min-w-0 items-center gap-5 text-xs text-fg-muted">
          {totals ? (
            <>
              <Total icon={LuSearchX} text={totals.noMatch} />
              <Total icon={LuHandshake} text={totals.offeredNoBooking} />
              <Total icon={LuUsers} text={totals.carriers} />
            </>
          ) : (
            <span aria-hidden className="h-3 w-80 animate-pulse rounded-md bg-panel-raised" />
          )}
        </div>
        {error && data && (
          <p role="status" className="mt-2 flex items-center gap-1 text-xs text-risk">
            <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
            <span className="truncate">{error}</span>
          </p>
        )}

        <div className="mt-6 overflow-hidden rounded-lg border border-line bg-panel">
          <div className="flex items-center border-b border-line px-4 py-3">
            <div className="flex w-80 items-center gap-2">
              <HeaderSelect label="From" icon={LuRoute} tone="text-fg-faint" value={origin} onChange={(v) => onFilter("origin", v)} options={stateOptions} />
              <HeaderSelect
                label="Equipment"
                grow={1.5}
                icon={LuContainer}
                tone="text-fg-faint"
                value={equipment}
                onChange={(v) => onFilter("equipment", v)}
                options={equipmentOptions}
              />
            </div>
            {data && data.total > 0 && <span className="tabular ml-auto text-xs text-fg-faint">{data.total} lanes</span>}
          </div>
          <DemandList data={data} loading={loading} filtered={filtered} onClearFilters={onClearFilters} />
          {hasMore && rowCount > 0 && (
            <div ref={sentinel} role="status" className="flex items-center justify-center gap-2 border-t border-line px-4 py-3 text-xs text-fg-faint">
              {loadingMore && <LuLoaderCircle size={14} className="animate-spin" aria-hidden />}
              {loadingMore ? "Loading more lanes..." : `${rowCount} of ${data?.total ?? 0}`}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
