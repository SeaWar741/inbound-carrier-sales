"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { LuInbox } from "react-icons/lu";
import { CarrierDetail } from "@/components/inbox/carrier-detail";
import { CarrierList } from "@/components/inbox/carrier-list";
import { FilterBar, type InboxFilters } from "@/components/inbox/filter-bar";
import { InboxRail, selectedRailItem, type InboxTab, type RailItem } from "@/components/inbox/inbox-rail";
import { carrierStages, inboxTabs, type TowerCarriers } from "@/lib/contracts";
import { useNow } from "@/lib/use-now";
import { usePoll } from "@/lib/use-poll";

const carriersPollMs = 5_000;

// Everything the carrier list query reads from the URL; carrier and call only drive the detail.
const listKeys = ["tab", "stage", "equipment", "origin", "destination", "since", "q", "sort", "page"] as const;
// What "Clear filters" resets; the rail row (tab and stage) stays.
const filterKeys = ["equipment", "origin", "destination", "since", "q"] as const;

// The inbox keeps its whole state in the URL, so a reload or a shared link lands on the same view.
// Four panes: the stage rail, the carrier list, the conversation, and the detail panel.
export function Inbox() {
  const searchParams = useSearchParams();
  const now = useNow();

  const listQuery = useMemo(() => {
    const query = new URLSearchParams();
    for (const key of listKeys) {
      const value = searchParams.get(key);
      // A hand-edited tab or stage the rail would not show must not make the adapter refuse the query.
      if (key === "tab" && !inboxTabs.some((t) => t === value)) continue;
      if (key === "stage" && !carrierStages.some((s) => s === value)) continue;
      if (value) query.set(key, value);
    }
    return query.toString();
  }, [searchParams]);
  const { data, error, loading } = usePoll<TowerCarriers>(`/api/carriers${listQuery ? `?${listQuery}` : ""}`, carriersPollMs, "carrier list");

  const tabParam = searchParams.get("tab");
  const tab: InboxTab = inboxTabs.find((t) => t === tabParam) ?? "all";
  const stage = carrierStages.find((s) => s === searchParams.get("stage")) ?? "";
  const railItem = selectedRailItem(tab, stage);
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const selectedKey = searchParams.get("carrier");
  const selectedCallId = searchParams.get("call");
  const filters: InboxFilters = {
    stage,
    equipment: searchParams.get("equipment") ?? "",
    origin: searchParams.get("origin") ?? "",
    destination: searchParams.get("destination") ?? "",
    since: searchParams.get("since") ?? "",
    q: searchParams.get("q") ?? "",
    sort: searchParams.get("sort") ?? "",
  };
  const filtered = filterKeys.some((key) => filters[key] !== "");

  // Empty values drop the key. replaceState keeps the back button for leaving the inbox, not for every click.
  const update = useCallback(
    (changes: Record<string, string | null>) => {
      const params = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries(changes)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const query = params.toString();
      window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
    },
    [],
  );

  // A new filter, sort or rail row starts again on page 1. A rail row sets its tab or stage and clears the other.
  const onFilter = useCallback((key: keyof InboxFilters, value: string) => update({ [key]: value, page: null }), [update]);
  const onRail = useCallback(
    (item: RailItem) => update({ tab: item.tab === "all" ? null : item.tab, stage: item.stage, page: null }),
    [update],
  );
  const onSince = useCallback((since: string) => update({ since, page: null }), [update]);
  const onPage = useCallback((next: number) => update({ page: next > 1 ? String(next) : null }), [update]);
  const onSelect = useCallback((key: string) => update({ carrier: key, call: null }), [update]);
  const onSelectCall = useCallback((callId: string) => update({ call: callId }), [update]);
  const onClearFilters = useCallback(
    () => update(Object.fromEntries([...filterKeys.map((key) => [key, null]), ["page", null]])),
    [update],
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="h-full min-h-0 w-56 shrink-0">
        <InboxRail data={data} selected={railItem} since={filters.since} onSelect={onRail} onSince={onSince} />
      </div>

      <div className="h-full min-h-0 w-[360px] shrink-0">
        <CarrierList
          data={data}
          loading={loading}
          error={error}
          now={now}
          title={railItem?.label ?? "Carriers"}
          page={page}
          filters={<FilterBar filters={filters} onChange={onFilter} />}
          filtered={filtered}
          selectedKey={selectedKey}
          onPage={onPage}
          onSelect={onSelect}
          onClearFilters={onClearFilters}
        />
      </div>

      {selectedKey ? (
        // Keyed so a new carrier starts with an empty call list instead of the last carrier's.
        <CarrierDetail key={selectedKey} carrierKey={selectedKey} since={filters.since} selectedCallId={selectedCallId} now={now} onSelectCall={onSelectCall} />
      ) : (
        <div className="grid h-full min-w-0 flex-1 place-items-center bg-bg">
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
