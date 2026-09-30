"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { LuContainer, LuMousePointerClick, LuRoute, LuTriangleAlert, LuUsers } from "react-icons/lu";
import { equipmentOptions, HeaderSelect, SearchInput, stateOptions, TabStrip, type Tab } from "@/components/inbox/filter-bar";
import { DateRange } from "@/components/inbox/inbox-rail";
import { growthStyle, relationshipStyle, topStyle, type ChipStyle } from "@/components/network/network-chips";
import { NetworkDetail } from "@/components/network/network-detail";
import { NetworkList, type NetworkPages } from "@/components/network/network-list";
import { networkViews, type NetworkCarrier, type NetworkView, type TowerNetwork } from "@/lib/contracts";
import { deskDayKey } from "@/lib/format";
import { fromInboxWindow, toInboxWindow, type NetworkWindow } from "@/lib/network";
import { useNow } from "@/lib/use-now";
import { fetchTower, usePollWith } from "@/lib/use-poll";

// The network changes with calls, not by the second, and each read also checks the TMS board.
const networkPollMs = 30_000;

// Everything the adapter query reads from the URL; carrier only drives the panel.
const listKeys = ["view", "since", "from", "to", "equipment", "origin", "q"] as const;
// What "Clear filters" resets; the view stays.
const filterKeys = ["since", "from", "to", "equipment", "origin", "q"] as const;
// The adapter's `since` values; the URL omits its default (30d).
const sinceValues = ["today", "7d", "30d"];
const isoDay = /^\d{4}-\d{2}-\d{2}$/;
const allStyle: Pick<ChipStyle, "label" | "icon" | "iconTone"> = { label: "All", icon: LuUsers, iconTone: "text-fg-muted" };

// Pages 1 to `pages` in one go, merged in order like the inbox list; a carrier on two pages shows once.
async function loadPages(query: string, pages: number, signal: AbortSignal): Promise<NetworkPages> {
  const answers = await Promise.all(
    Array.from({ length: pages }, (_, i) => {
      const params = new URLSearchParams(query);
      if (i > 0) params.set("page", String(i + 1));
      const search = params.toString();
      return fetchTower<TowerNetwork>(`/api/network${search ? `?${search}` : ""}`, signal, "carrier network");
    }),
  );
  const seen = new Set<string>();
  const rows: NetworkCarrier[] = [];
  for (const row of answers.flatMap((answer) => answer.rows)) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    rows.push(row);
  }
  return { ...answers[0]!, rows, query, pages };
}

// A view chip's label: the same icon and tone as the chip on its rows, with an optional hint below.
function ViewLabel({ style, hint }: { style: Pick<ChipStyle, "label" | "icon" | "iconTone">; hint?: string }) {
  const { icon: Icon, iconTone, label } = style;
  return (
    <span className="flex items-center gap-1.5">
      <Icon size={14} className={iconTone} aria-hidden />
      {hint ? (
        <span className="flex flex-col items-start leading-tight">
          <span>{label}</span>
          <span className="text-[10px] font-normal text-fg-faint">{hint}</span>
        </span>
      ) : (
        label
      )}
    </span>
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

  const listQuery = useMemo(() => {
    const query = new URLSearchParams();
    for (const key of listKeys) {
      const value = searchParams.get(key);
      // A hand-edited view or window the page would not show must not make the adapter refuse the query.
      if (key === "view" && !networkViews.some((v) => v === value)) continue;
      if (key === "since" && !sinceValues.includes(value ?? "")) continue;
      if ((key === "from" || key === "to") && !range) continue;
      if (value) query.set(key, value);
    }
    return query.toString();
  }, [searchParams, range]);

  // How many pages the list shows; any new query starts again at one.
  const [paging, setPaging] = useState({ query: listQuery, pages: 1 });
  const pages = paging.query === listQuery ? paging.pages : 1;
  const { data, error, loading } = usePollWith<NetworkPages>(
    `${listQuery}#${pages}`,
    (signal) => loadPages(listQuery, pages, signal),
    networkPollMs,
    "carrier network",
  );
  // Until the new query answers, the list shows the old one, which must not ask for more pages.
  const current = data !== null && data.query === listQuery ? data : null;
  const loadingMore = current !== null && current.pages < pages;
  const hasMore = current !== null && current.rows.length < current.total && current.pages * current.pageSize < current.total;
  const onLoadMore = useCallback(() => {
    if (current === null || loadingMore || !hasMore) return;
    setPaging({ query: listQuery, pages: current.pages + 1 });
  }, [current, loadingMore, hasMore, listQuery]);

  const view: NetworkView = networkViews.find((v) => v === searchParams.get("view")) ?? "all";
  const q = searchParams.get("q") ?? "";
  const equipment = searchParams.get("equipment") ?? "";
  const origin = searchParams.get("origin") ?? "";
  const dateWindow: NetworkWindow = range ? { since: "", from, to } : { since, from: "", to: "" };
  const filtered = since !== "" || range || equipment !== "" || origin !== "" || q !== "";

  const rows = data?.rows ?? [];
  const selectedKey = searchParams.get("carrier");
  // A search that leaves one carrier (the /carriers?q= links) shows it without another click.
  const selected = rows.find((row) => row.key === selectedKey) ?? (selectedKey === null && q !== "" && rows.length === 1 ? rows[0]! : null);

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

  const onView = useCallback((next: NetworkView) => update({ view: next === "all" ? null : next }), [update]);
  const onSearch = useCallback((next: string) => update({ q: next }), [update]);
  const onSelect = useCallback((key: string) => update({ carrier: key }), [update]);
  const onClearFilters = useCallback(() => update(Object.fromEntries(filterKeys.map((key) => [key, null]))), [update]);
  // The inbox picker reads the window its own way; the URL keeps the page's.
  const onWindow = useCallback((next: NetworkWindow) => update(fromInboxWindow(next)), [update]);

  const counts = data?.counts;
  // Top and Growth are tags on top of the relationship, so their counts overlap the others.
  const tabs: Tab<NetworkView>[] = [
    { value: "all", label: <ViewLabel style={allStyle} />, count: counts?.all ?? null },
    { value: "new", label: <ViewLabel style={relationshipStyle.new} />, count: counts?.new ?? null },
    { value: "at_risk", label: <ViewLabel style={relationshipStyle.at_risk} hint="No recent calls" />, count: counts?.atRisk ?? null, urgent: true },
    { value: "top", label: <ViewLabel style={topStyle} />, count: counts?.top ?? null },
    { value: "growth", label: <ViewLabel style={growthStyle} />, count: counts?.growth ?? null },
  ];

  const header = (
    <>
      <div className="px-4 pt-3">
        <h1 className="font-semibold text-fg">Carriers</h1>
      </div>
      <TabStrip label="Carrier views" tabs={tabs} active={view} onTab={onView} />
      {data && !data.boardAvailable && (
        <p role="status" className="flex items-center gap-1 px-4 pt-2 text-xs text-warn">
          <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
          Board unavailable, Growth hidden
        </p>
      )}
      <div className="flex min-w-0 items-end gap-2 px-4 py-3">
        <div className="w-64 shrink-0">
          <DateRange dateWindow={toInboxWindow(dateWindow)} today={deskDayKey(now)} onWindow={onWindow} />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
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
          <SearchInput q={q} onSearch={onSearch} placeholder="MC, DOT or carrier" label="Search carriers" className="min-w-0 flex-[2]" />
        </div>
      </div>
    </>
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="h-full min-h-0 min-w-0 flex-1">
        <NetworkList
          data={data}
          loading={loading}
          error={error}
          now={now}
          dateWindow={dateWindow}
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

      <div className="h-full min-h-0 w-[420px] shrink-0">
        {selected ? (
          <NetworkDetail carrier={selected} now={now} dateWindow={dateWindow} />
        ) : (
          <div className="grid h-full place-items-center bg-bg">
            <div className="text-center text-fg-muted">
              <LuMousePointerClick size={48} className="mx-auto mb-3 opacity-50" aria-hidden />
              <p>Select a carrier to see why it is here</p>
              <p className="mt-1 text-xs text-fg-faint">Pick a row or use the arrow keys</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
