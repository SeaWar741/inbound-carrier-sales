"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { LuChevronLeft, LuInbox } from "react-icons/lu";
import { CarrierDetail } from "@/components/inbox/carrier-detail";
import { CarrierList, type CarrierPages } from "@/components/inbox/carrier-list";
import { FilterBar, type InboxFilters } from "@/components/inbox/filter-bar";
import { InboxRail, selectedRailItem, type InboxTab, type InboxWindow, type RailItem } from "@/components/inbox/inbox-rail";
import { carrierStages, inboxTabs, type TowerCarrier, type TowerCarriers } from "@/lib/contracts";
import { deskDayKey } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { updateSearch } from "@/lib/url-search";
import { fetchTower, usePollWith } from "@/lib/use-poll";

const carriersPollMs = 5_000;

// Everything the carrier list query reads from the URL; carrier and call only drive the detail.
const listKeys = ["tab", "stage", "equipment", "origin", "destination", "since", "from", "to", "q", "sort"] as const;
// What "Clear filters" resets; the rail row (tab and stage) stays.
const filterKeys = ["equipment", "origin", "destination", "since", "from", "to", "q"] as const;
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

// Pages 1 to `pages` of the list in one go, merged in order. Every poll reads them all again, so a
// carrier that moves between loaded pages is never lost; a carrier on two pages shows once.
async function loadPages(query: string, pages: number, signal: AbortSignal): Promise<CarrierPages> {
  const answers = await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      const params = new URLSearchParams(query);
      if (i > 0) params.set("page", String(i + 1));
      const search = params.toString();
      return fetchTower<TowerCarriers>(`/api/carriers${search ? `?${search}` : ""}`, signal, "carrier list");
    }),
  );
  const seen = new Set<string>();
  const rows: TowerCarrier[] = [];
  for (const row of answers.flatMap((answer) => answer.rows)) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    rows.push(row);
  }
  const first = answers[0]!;
  return { ...first, rows, liveUnavailable: answers.some((answer) => answer.liveUnavailable), query, pages };
}

// The inbox keeps its whole state in the URL, so a reload or a shared link lands on the same view.
// Four panes: the stage rail, the carrier list, the conversation, and the detail panel.
export function Inbox() {
  const searchParams = useSearchParams();
  const now = useNow();

  // A day range goes out only whole and in order; otherwise `since` (or its default) stands.
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const range = isoDay.test(from) && isoDay.test(to) && from <= to;

  const listQuery = useMemo(() => {
    const query = new URLSearchParams();
    for (const key of listKeys) {
      const value = searchParams.get(key);
      // A hand-edited tab or stage the rail would not show must not make the adapter refuse the query.
      if (key === "tab" && !inboxTabs.some((t) => t === value)) continue;
      if (key === "stage" && !carrierStages.some((s) => s === value)) continue;
      if ((key === "from" || key === "to") && !range) continue;
      if (value) query.set(key, value);
    }
    return query.toString();
  }, [searchParams, range]);

  // How many pages the list shows; any new query starts again at one.
  const [paging, setPaging] = useState({ query: listQuery, pages: 1 });
  const pages = paging.query === listQuery ? paging.pages : 1;
  const { data, error, loading } = usePollWith<CarrierPages>(
    `${listQuery}#${pages}`,
    (signal) => loadPages(listQuery, pages, signal),
    carriersPollMs,
    "carrier list",
  );
  // Until the new query answers, the list shows the old one, which must not ask for more pages.
  const current = data !== null && data.query === listQuery ? data : null;
  const loadingMore = current !== null && current.pages < pages;
  const hasMore = current !== null && current.rows.length < current.total && current.pages * current.pageSize < current.total;
  const onLoadMore = useCallback(() => {
    if (current === null || loadingMore || !hasMore) return;
    setPaging({ query: listQuery, pages: current.pages + 1 });
  }, [current, loadingMore, hasMore, listQuery]);

  const tabParam = searchParams.get("tab");
  const tab: InboxTab = inboxTabs.find((t) => t === tabParam) ?? "all";
  const stage = carrierStages.find((s) => s === searchParams.get("stage")) ?? "";
  const railItem = selectedRailItem(tab, stage);
  const selectedKey = searchParams.get("carrier");
  const selectedCallId = searchParams.get("call");
  const filters: InboxFilters = {
    stage,
    equipment: searchParams.get("equipment") ?? "",
    origin: searchParams.get("origin") ?? "",
    destination: searchParams.get("destination") ?? "",
    since: searchParams.get("since") ?? "",
    from: range ? from : "",
    to: range ? to : "",
    q: searchParams.get("q") ?? "",
    sort: searchParams.get("sort") ?? "",
  };
  const filtered = filterKeys.some((key) => filters[key] !== "");

  // A rail row sets its tab or stage and clears the other. The list restarts at the top on its own.
  const onFilter = useCallback((key: keyof InboxFilters, value: string) => updateSearch({ [key]: value }), []);
  const onRail = useCallback((item: RailItem) => updateSearch({ tab: item.tab === "all" ? null : item.tab, stage: item.stage }), []);
  const onWindow = useCallback((next: InboxWindow) => updateSearch(next), []);
  const onSelect = useCallback((key: string) => updateSearch({ carrier: key, call: null }), []);
  const onSelectCall = useCallback((callId: string) => updateSearch({ call: callId }), []);
  const onBack = useCallback(() => updateSearch({ carrier: null, call: null }), []);
  const onClearFilters = useCallback(() => updateSearch(Object.fromEntries(filterKeys.map((key) => [key, null]))), []);
  const dateWindow: InboxWindow = { since: filters.since, from: filters.from, to: filters.to };

  return (
    // On a phone the panes stack and a picked carrier takes the whole screen, with a way back.
    <div className="flex h-full min-h-0 overflow-hidden max-md:flex-col">
      <div className={`h-full min-h-0 w-56 shrink-0 max-md:h-auto max-md:w-full ${selectedKey ? "max-md:hidden" : ""}`}>
        <InboxRail data={data} selected={railItem} dateWindow={dateWindow} today={deskDayKey(now)} onSelect={onRail} onWindow={onWindow} />
      </div>

      <div className={`h-full min-h-0 w-[360px] shrink-0 max-md:w-full max-md:flex-1 ${selectedKey ? "max-md:hidden" : ""}`}>
        <CarrierList
          data={data}
          loading={loading}
          error={error}
          now={now}
          title={railItem?.label ?? "Carriers"}
          filters={<FilterBar filters={filters} onChange={onFilter} />}
          filtered={filtered}
          selectedKey={selectedKey}
          loadingMore={loadingMore}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
          onSelect={onSelect}
          onClearFilters={onClearFilters}
        />
      </div>

      {selectedKey ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:contents">
          <button
            type="button"
            onClick={onBack}
            className="flex h-10 shrink-0 cursor-pointer items-center gap-1 border-b border-line bg-panel px-2 text-sm font-medium text-accent md:hidden"
          >
            <LuChevronLeft size={18} aria-hidden />
            {railItem?.label ?? "Carriers"}
          </button>
          {/* Keyed so a new carrier starts with an empty call list instead of the last carrier's. */}
          <CarrierDetail key={selectedKey} carrierKey={selectedKey} dateWindow={dateWindow} selectedCallId={selectedCallId} now={now} onSelectCall={onSelectCall} />
        </div>
      ) : (
        <div className="grid h-full min-w-0 flex-1 place-items-center bg-bg max-md:hidden">
          <div className="text-center text-fg-muted">
            <LuInbox size={48} className="mx-auto mb-3 opacity-50" aria-hidden />
            <p>Select a carrier to see its calls</p>
            <p className="mt-1 text-xs text-fg-faint">Pick a row or use the arrow keys</p>
          </div>
        </div>
      )}
    </div>
  );
}
