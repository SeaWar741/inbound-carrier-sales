"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { LuContainer, LuRoute } from "react-icons/lu";
import { DemandList, type DemandPages } from "@/components/demand/demand-list";
import { equipmentOptions, HeaderSelect, stateOptions } from "@/components/inbox/filter-bar";
import type { DemandLane, TowerDemand } from "@/lib/contracts";
import { demandKey } from "@/lib/demand";
import { fetchTower, usePollWith } from "@/lib/use-poll";

// Demand builds up over days, not seconds.
const demandPollMs = 60_000;

// Everything the adapter query reads from the URL; both are filters "Clear filters" resets.
const filterKeys = ["equipment", "origin"] as const;

// Pages 1 to `pages` in one go, merged in order like the carriers list; a lane on two pages shows once.
async function loadPages(query: string, pages: number, signal: AbortSignal): Promise<DemandPages> {
  const answers = await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      const params = new URLSearchParams(query);
      if (i > 0) params.set("page", String(i + 1));
      const search = params.toString();
      return fetchTower<TowerDemand>(`/api/demand${search ? `?${search}` : ""}`, signal, "demand data");
    }),
  );
  const seen = new Set<string>();
  const rows: DemandLane[] = [];
  for (const row of answers.flatMap((answer) => answer.rows)) {
    const key = demandKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return { ...answers[0]!, rows, query, pages };
}

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

  // How many pages the list shows; any new query starts again at one.
  const [paging, setPaging] = useState({ query: listQuery, pages: 1 });
  const pages = paging.query === listQuery ? paging.pages : 1;
  const { data, error, loading } = usePollWith<DemandPages>(
    `${listQuery}#${pages}`,
    (signal) => loadPages(listQuery, pages, signal),
    demandPollMs,
    "demand data",
  );
  // Until the new query answers, the list shows the old one, which must not ask for more pages.
  const current = data !== null && data.query === listQuery ? data : null;
  const loadingMore = current !== null && current.pages < pages;
  const hasMore = current !== null && current.rows.length < current.total && current.pages * current.pageSize < current.total;
  const onLoadMore = useCallback(() => {
    if (current === null || loadingMore || !hasMore) return;
    setPaging({ query: listQuery, pages: current.pages + 1 });
  }, [current, loadingMore, hasMore, listQuery]);

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const onToggle = useCallback((key: string) => setExpandedKey((prev) => (prev === key ? null : key)), []);

  const equipment = searchParams.get("equipment") ?? "";
  const origin = searchParams.get("origin") ?? "";
  const filtered = equipment !== "" || origin !== "";

  // Empty values drop the key. replaceState keeps the back button for leaving the page, not for every click.
  const update = useCallback((changes: Record<string, string | null>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  }, []);
  const onClearFilters = useCallback(() => update(Object.fromEntries(filterKeys.map((key) => [key, null]))), [update]);

  const header = (
    <>
      <div className="px-4 pt-3">
        <h1 className="font-semibold text-fg">Demand</h1>
        <p className="mt-0.5 text-sm text-fg-muted">Last 4 weeks · searches and offers the board did not cover</p>
      </div>
      <div className="flex min-w-0 items-center gap-1.5 px-4 py-3">
        <div className="flex w-full max-w-md min-w-0 items-center gap-1.5">
          <HeaderSelect label="From" icon={LuRoute} tone="text-ok" value={origin} onChange={(v) => update({ origin: v })} options={stateOptions} />
          <HeaderSelect
            label="Equipment"
            grow={1.5}
            icon={LuContainer}
            tone="text-accent"
            value={equipment}
            onChange={(v) => update({ equipment: v })}
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
