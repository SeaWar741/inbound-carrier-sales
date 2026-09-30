"use client";

import { ConfigProvider } from "antd";
import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { LuContainer, LuRoute, LuTriangleAlert } from "react-icons/lu";
import { DateRange } from "@/components/inbox/inbox-rail";
import { equipmentOptions, HeaderSelect, SearchInput, stateOptions } from "@/components/inbox/filter-bar";
import { NetworkList } from "@/components/network/network-list";
import { viewLabel, ViewSelect } from "@/components/network/view-select";
import { useLoadMore } from "@/components/paged-list";
import { networkViews, type NetworkView, type TowerNetwork } from "@/lib/contracts";
import { deskDayKey } from "@/lib/format";
import { fromInboxWindow, toInboxWindow, type NetworkWindow } from "@/lib/network";
import { useNow } from "@/lib/use-now";
import { updateSearch, usePagedList } from "@/lib/use-paged-list";

// The network changes with calls, not by the second, and each read also checks the TMS board.
const networkPollMs = 30_000;

// Everything else the adapter query reads from the URL; the view is resolved first. "Clear filters"
// resets the same keys and keeps the view.
const filterKeys = ["since", "from", "to", "equipment", "origin", "q"] as const;
// The adapter's `since` values; the URL omits its default (30d).
const sinceValues = ["today", "7d", "30d"];
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

// Who the desk's carriers are, sorted into at risk, growth, top and new, one line each with the
// reason; a row opens the carrier's page. Like the inbox, the whole state lives in the URL.
export function Network() {
  const searchParams = useSearchParams();
  const now = useNow();

  // A day range goes out only whole and in order; otherwise `since` (or its default) stands.
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const range = isoDay.test(from) && isoDay.test(to) && from <= to;
  const sinceParam = searchParams.get("since") ?? "";
  const since = sinceValues.includes(sinceParam) && sinceParam !== "30d" ? sinceParam : "";

  const q = searchParams.get("q") ?? "";
  // The page opens on the carriers that need a call. A search without a view (the Demand page's
  // /carriers?q= links) looks through every carrier; a picked view is always in the URL.
  const view: NetworkView = networkViews.find((v) => v === searchParams.get("view")) ?? (q === "" ? "at_risk" : "all");

  const listQuery = useMemo(() => {
    const query = new URLSearchParams({ view });
    for (const key of filterKeys) {
      const value = searchParams.get(key);
      // A hand-edited window the page would not show must not make the adapter refuse the query.
      if (key === "since" && !sinceValues.includes(value ?? "")) continue;
      if ((key === "from" || key === "to") && !range) continue;
      if (value) query.set(key, value);
    }
    return query.toString();
  }, [searchParams, range, view]);

  const { data, error, loading, loadingMore, hasMore, onLoadMore } = usePagedList<TowerNetwork>(
    "/api/network",
    listQuery,
    (row) => row.key,
    networkPollMs,
    "carrier network",
  );
  // The page scrolls as a whole, so the page is the scroller the next page loads against.
  const { scroller, sentinel } = useLoadMore(hasMore, data?.rows.length ?? 0, onLoadMore);

  const equipment = searchParams.get("equipment") ?? "";
  const origin = searchParams.get("origin") ?? "";
  const dateWindow: NetworkWindow = range ? { since: "", from, to } : { since, from: "", to: "" };
  const filtered = since !== "" || range || equipment !== "" || origin !== "" || q !== "";

  const onView = useCallback((next: NetworkView) => updateSearch({ view: next }), []);
  const onSearch = useCallback((next: string) => updateSearch({ q: next }), []);
  const onClearFilters = useCallback(() => updateSearch(Object.fromEntries(filterKeys.map((key) => [key, null]))), []);
  // The inbox picker reads the window its own way; the URL keeps the page's.
  const onWindow = useCallback((next: NetworkWindow) => updateSearch(fromInboxWindow(next)), []);

  return (
    <div ref={scroller} className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl px-8 py-8">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Carriers</h1>
        <p className="mt-1 text-sm text-fg-muted">Who to call back and why</p>

        <div className="mt-6 overflow-hidden rounded-lg border border-line bg-panel">
          {/* The theme's small controls are the search box's height, so the row lines up. */}
          <ConfigProvider componentSize="small">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <ViewSelect data={data} view={view} onView={onView} />
              <div className="w-60 shrink-0">
                <DateRange inline dateWindow={toInboxWindow(dateWindow)} today={deskDayKey(now)} onWindow={onWindow} />
              </div>
              <div className="flex w-32 shrink-0">
                <HeaderSelect label="From" icon={LuRoute} tone="text-ok" value={origin} onChange={(v) => updateSearch({ origin: v })} options={stateOptions} />
              </div>
              <div className="flex w-40 shrink-0">
                <HeaderSelect
                  label="Equipment"
                  icon={LuContainer}
                  tone="text-accent"
                  value={equipment}
                  onChange={(v) => updateSearch({ equipment: v })}
                  options={equipmentOptions}
                />
              </div>
              <SearchInput q={q} onSearch={onSearch} placeholder="MC, DOT or name" label="Search carriers" className="ml-auto w-64" />
            </div>
          </ConfigProvider>

          {data && !data.boardAvailable && (
            <p role="status" className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-xs text-warn">
              <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
              The TMS board is unavailable, so no carrier is marked Growth
            </p>
          )}
          {error && data && (
            <p role="status" className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-xs text-risk">
              <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
              <span className="truncate">{error}</span>
            </p>
          )}

          <NetworkList
            data={data}
            loading={loading}
            now={now}
            viewName={viewLabel(view)}
            filtered={filtered}
            loadingMore={loadingMore}
            hasMore={hasMore}
            sentinel={sentinel}
            onClearFilters={onClearFilters}
          />
        </div>
      </div>
    </div>
  );
}
