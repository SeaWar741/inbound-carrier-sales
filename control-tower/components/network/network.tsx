"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { LuContainer, LuMousePointerClick, LuRoute } from "react-icons/lu";
import { equipmentOptions, HeaderSelect, SearchInput, stateOptions } from "@/components/inbox/filter-bar";
import { NetworkDetail } from "@/components/network/network-detail";
import { NetworkList } from "@/components/network/network-list";
import { NetworkRail, viewLabel } from "@/components/network/network-rail";
import { networkViews, type NetworkView, type TowerNetwork } from "@/lib/contracts";
import { deskDayKey } from "@/lib/format";
import { fromInboxWindow, toInboxWindow, type NetworkWindow } from "@/lib/network";
import { useNow } from "@/lib/use-now";
import { updateSearch, usePagedList } from "@/lib/use-paged-list";
import { usePoll } from "@/lib/use-poll";

// The network changes with calls, not by the second, and each read also checks the TMS board.
const networkPollMs = 30_000;

// Everything else the adapter query reads from the URL; the view is resolved first, and carrier only
// drives the panel.
const listKeys = ["since", "from", "to", "equipment", "origin", "q"] as const;
// What "Clear filters" resets; the view stays.
const filterKeys = ["since", "from", "to", "equipment", "origin", "q"] as const;
// The adapter's `since` values; the URL omits its default (30d).
const sinceValues = ["today", "7d", "30d"];
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

// The selected carrier when the loaded pages do not hold it (a shared link to a carrier past page one,
// or one a filter hides): its row fetched by key, like the inbox detail fetches its carrier.
function CarrierByKey({ carrierKey, listQuery, now, dateWindow }: { carrierKey: string; listQuery: string; now: number; dateWindow: NetworkWindow }) {
  // Only the window carries over; the view (All when left out) and the filters would hide it again.
  const list = new URLSearchParams(listQuery);
  const params = new URLSearchParams({ key: carrierKey });
  for (const key of ["since", "from", "to"]) {
    const value = list.get(key);
    if (value) params.set(key, value);
  }
  const { data, loading } = usePoll<TowerNetwork>(`/api/network?${params.toString()}`, networkPollMs, "carrier network");
  const carrier = data?.rows[0];
  if (carrier) return <NetworkDetail carrier={carrier} now={now} dateWindow={dateWindow} />;
  return (
    <div className="grid h-full place-items-center border-l border-line bg-panel">
      <p className="px-8 text-center text-fg-muted">
        {loading ? "Loading carrier..." : data ? "No calls from this carrier in this window" : "The carrier network is unavailable"}
      </p>
    </div>
  );
}

// Who the desk's carriers are: the whole network sorted into new, at risk, top and growth, with the
// reason for each. Like the inbox, the whole state lives in the URL.
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
    for (const key of listKeys) {
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

  const equipment = searchParams.get("equipment") ?? "";
  const origin = searchParams.get("origin") ?? "";
  const dateWindow: NetworkWindow = range ? { since: "", from, to } : { since, from: "", to: "" };
  const filtered = since !== "" || range || equipment !== "" || origin !== "" || q !== "";

  const rows = data?.rows ?? [];
  const selectedKey = searchParams.get("carrier");
  // The panel is never empty: with nothing picked it shows the first row, without writing it to the URL.
  const selected = rows.find((row) => row.key === selectedKey) ?? (selectedKey === null ? (rows[0] ?? null) : null);
  // A selection the loaded rows do not hold is fetched on its own once the list has answered.
  const missingKey = selected === null && selectedKey !== null && data !== null ? selectedKey : null;

  // A new view is a new list, so the old pick goes with it.
  const onView = useCallback((next: NetworkView) => updateSearch({ view: next, carrier: null }), []);
  const onSearch = useCallback((next: string) => updateSearch({ q: next }), []);
  const onSelect = useCallback((key: string) => updateSearch({ carrier: key }), []);
  const onClearFilters = useCallback(() => updateSearch(Object.fromEntries(filterKeys.map((key) => [key, null]))), []);
  // The inbox picker reads the window its own way; the URL keeps the page's.
  const onWindow = useCallback((next: NetworkWindow) => updateSearch(fromInboxWindow(next)), []);

  const header = (
    <div className="flex min-w-0 items-center gap-1.5">
      <SearchInput q={q} onSearch={onSearch} placeholder="MC, DOT or name" label="Search carriers" className="min-w-0 flex-[2]" />
      <HeaderSelect label="From" icon={LuRoute} tone="text-ok" value={origin} onChange={(v) => updateSearch({ origin: v })} options={stateOptions} />
      <HeaderSelect
        label="Equipment"
        grow={1.2}
        icon={LuContainer}
        tone="text-accent"
        value={equipment}
        onChange={(v) => updateSearch({ equipment: v })}
        options={equipmentOptions}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="h-full min-h-0 w-56 shrink-0">
        <NetworkRail data={data} view={view} dateWindow={toInboxWindow(dateWindow)} today={deskDayKey(now)} onView={onView} onWindow={onWindow} />
      </div>

      <div className="h-full min-h-0 min-w-0 flex-1">
        <NetworkList
          data={data}
          loading={loading}
          error={error}
          now={now}
          title={viewLabel(view)}
          header={header}
          filtered={filtered}
          selectedKey={selected?.key ?? null}
          loadingMore={loadingMore}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
          onSelect={onSelect}
          onClearFilters={onClearFilters}
        />
      </div>

      <div className="h-full min-h-0 w-[400px] shrink-0">
        {selected ? (
          <NetworkDetail carrier={selected} now={now} dateWindow={dateWindow} />
        ) : missingKey ? (
          <CarrierByKey key={missingKey} carrierKey={missingKey} listQuery={listQuery} now={now} dateWindow={dateWindow} />
        ) : (
          <div className="grid h-full place-items-center border-l border-line bg-panel">
            <div className="text-center text-fg-muted">
              <LuMousePointerClick size={48} className="mx-auto mb-3 opacity-50" aria-hidden />
              <p>{data === null ? "Loading carriers..." : "No carrier to show"}</p>
              <p className="mt-1 text-xs text-fg-faint">Pick a view or clear the filters</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
