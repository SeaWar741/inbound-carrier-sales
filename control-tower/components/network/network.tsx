"use client";

import { ConfigProvider, Table, Tooltip, type TableColumnsType } from "antd";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { IconType } from "react-icons";
import {
  LuChevronDown,
  LuCircleCheck,
  LuCircleX,
  LuContainer,
  LuHand,
  LuInbox,
  LuListFilter,
  LuLoaderCircle,
  LuPhoneCall,
  LuPhoneOff,
  LuRoute,
  LuTrendingUp,
  LuTriangleAlert,
  LuUsers,
} from "react-icons/lu";
import { Tile } from "@/components/dashboard/kpi-tiles";
import { equipmentOptions, HeaderSelect, SearchInput, stateOptions } from "@/components/inbox/filter-bar";
import { StatusIcons, statusStyle, type NetworkStatus } from "@/components/network/network-chips";
import { ErrorBanner, iconButton, numberDirections, onSortClick, sortOrder, TablePager, textDirections } from "@/components/paged-table";
import { RankedMapPanel } from "@/components/ranked-map-panel";
import { networkSorts, networkViews, type NetworkCarrier, type TowerCall, type TowerCarrierCalls, type TowerNetwork } from "@/lib/contracts";
import { carrierName, equipmentLabel, formatDateTime, formatTimeAgo, plural } from "@/lib/format";
import { paging } from "@/lib/list-query";
import { callOutcome, callsWindow, defaultSort, inboxHref, networkFilterKeys, networkQuery, shortReason, type CallOutcome, type NetworkSort } from "@/lib/network";
import { useNow } from "@/lib/use-now";
import { updateSearch } from "@/lib/url-search";
import { usePoll } from "@/lib/use-poll";

// The network changes with calls, not by the second, and each read also checks the TMS board. An
// open timeline polls faster so a live call shows soon.
const networkPollMs = 30_000;
const callsPollMs = 15_000;
// A timeline shows the latest calls; the rest wait behind "Show N more".
const shownCalls = 8;

// Every filter "Clear filters" resets; any change to them goes back to page 1.
const filterKeys = ["view", ...networkFilterKeys] as const;

const statusOptions = (Object.keys(statusStyle) as NetworkStatus[]).map((status) => ({ value: status, label: statusStyle[status].label }));

// A status menu row carries the status's icon in its tone.
function statusOption(option: { value: string; label: string }) {
  const style = statusStyle[option.value as NetworkStatus];
  const Icon = style.icon;
  return (
    <span className="flex items-center gap-2">
      <Icon size={14} className={style.iconTone} aria-hidden />
      {style.label}
    </span>
  );
}

const outcomeStyle: Record<CallOutcome["kind"], { icon: IconType; tone: string }> = {
  live: { icon: LuPhoneCall, tone: "text-tone-green" },
  booked: { icon: LuCircleCheck, tone: "text-tone-emerald" },
  holding: { icon: LuHand, tone: "text-tone-amber" },
  lost: { icon: LuCircleX, tone: "text-tone-gray" },
  no_offer: { icon: LuPhoneOff, tone: "text-tone-gray" },
};

// The load a call was about: the held one, else the last one offered.
function callTitle(call: TowerCall): string {
  const load = call.hold ?? call.offers.at(-1);
  const parts = [formatDateTime(call.createdAt)];
  if (load) parts.push(load.loadId);
  if (load?.lane) parts.push(`${load.lane.origin.state} → ${load.lane.destination.state} ${equipmentLabel(load.lane.equipment)}`);
  return parts.join(" · ");
}

// An icon gutter with a connector line to the next call, then the call's title and how it ended.
function TimelineCall({ call, last }: { call: TowerCall; last: boolean }) {
  const outcome = callOutcome(call);
  const { icon: Icon, tone } = outcomeStyle[outcome.kind];
  return (
    <li className="flex items-start gap-2">
      <div className="flex flex-col items-center self-stretch">
        <span className="grid size-6 shrink-0 place-items-center">
          <Icon size={14} className={tone} aria-hidden />
        </span>
        {!last && <span className="w-px flex-1 bg-line-strong" aria-hidden />}
      </div>
      <div className={`min-w-0 flex-1 pt-0.5 ${last ? "" : "pb-4"}`}>
        <p className="truncate text-sm font-medium text-fg">{callTitle(call)}</p>
        <p className="mt-0.5 text-xs text-fg-muted">{outcome.text}</p>
      </div>
    </li>
  );
}

// The carrier's calls in a window that holds its last one, newest first, polled while the row is open.
function CarrierCalls({ carrier, now }: { carrier: NetworkCarrier; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const url = `/api/carriers/${encodeURIComponent(carrier.key)}/calls?${new URLSearchParams(callsWindow(carrier, now)).toString()}`;
  const { data, error } = usePoll<TowerCarrierCalls>(url, callsPollMs, "call list");

  if (data === null) {
    return (
      <p role="status" className="flex items-center gap-1.5 py-1 text-xs text-fg-muted">
        {error ? <LuTriangleAlert size={12} className="text-risk" aria-hidden /> : <LuLoaderCircle size={12} className="animate-spin" aria-hidden />}
        {error ?? "Loading calls..."}
      </p>
    );
  }
  if (data.calls.length === 0) return <p className="py-1 text-xs text-fg-muted">No calls in this window.</p>;
  const shown = expanded ? data.calls : data.calls.slice(0, shownCalls);
  const hidden = data.calls.length - shown.length;
  return (
    <div className="py-1">
      <ol aria-label={`Calls from ${carrierName(carrier)}`}>
        {shown.map((call, i) => (
          <TimelineCall key={call.callId} call={call} last={i === shown.length - 1} />
        ))}
      </ol>
      {hidden > 0 && (
        <button type="button" onClick={() => setExpanded(true)} className="mt-2 ml-8 cursor-pointer text-xs font-medium text-accent hover:underline">
          Show {hidden} more
        </button>
      )}
    </div>
  );
}

// Lanes open now: carriers per origin state on the map, the top lanes below it.
function SidePanel({
  data,
  view,
  origin,
  equipment,
  onPick,
}: {
  data: TowerNetwork | null;
  view: string;
  origin: string;
  equipment: string;
  onPick: (origin: string, equipment: string | null) => void;
}) {
  const origins = useMemo(() => (data?.openOrigins ?? []).map((row) => ({ state: row.originState, count: row.carriers })), [data?.openOrigins]);
  const growth = view === "growth";
  // A second click on the picked state lets it go.
  const onState = useCallback((state: string) => onPick(growth && state === origin ? "" : state, null), [growth, origin, onPick]);
  // The adapter lists open lanes most carriers first.
  const rows = (data?.openLanes ?? []).map((lane) => ({
    key: `${lane.originState}|${lane.equipment}`,
    label: `${lane.originState} · ${equipmentLabel(lane.equipment)}`,
    count: lane.carriers,
    countLabel: plural(lane.carriers, "carrier"),
    picked: growth && lane.originState === origin && lane.equipment === equipment,
    onClick: () => onPick(lane.originState, lane.equipment),
  }));

  return (
    <RankedMapPanel
      title="Lanes open now"
      icon={LuTrendingUp}
      tone="ok"
      badge="Top 5"
      notice={
        data &&
        !data.boardAvailable && (
          <p role="status" className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-xs text-warn">
            <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
            The TMS board is unavailable, so no lane shows as open
          </p>
        )
      }
      map={{ counts: origins, selected: growth && origin ? origin : null, onSelect: onState, label: "Carriers with an open lane, by origin state", unit: "carrier" }}
      rowIcon={LuContainer}
      rows={rows}
      empty={data === null ? "Loading open lanes..." : "No lane a listed carrier ran is open right now."}
      footer="Carriers who ran a lane that has a load on the board now. Click a state or a lane to list them."
    />
  );
}

// How the desk's carriers are doing and who needs a call: the numbers, then a sorted, paged table
// whose rows open the carrier's calls, beside the lanes open now. The whole state lives in the URL.
export function Network() {
  const searchParams = useSearchParams();
  const now = useNow();
  const [openKeys, setOpenKeys] = useState<string[]>([]);

  const query = useMemo(() => networkQuery(searchParams), [searchParams]);
  const { sort, dir, page, pageSize } = paging(searchParams, networkSorts, defaultSort);
  const { data, error, loading } = usePoll<TowerNetwork>(`/api/network${query ? `?${query}` : ""}`, networkPollMs, "carrier network");

  const view = networkViews.find((v) => v === searchParams.get("view")) ?? "all";
  const status: NetworkStatus | "" = view === "all" ? "" : view;
  const q = searchParams.get("q") ?? "";
  const equipment = searchParams.get("equipment") ?? "";
  const origin = searchParams.get("origin") ?? "";
  const filtered = status !== "" || q !== "" || equipment !== "" || origin !== "";

  const onFilter = useCallback((key: (typeof filterKeys)[number], value: string) => updateSearch({ [key]: value || null, page: null }), []);
  const onSearch = useCallback((next: string) => onFilter("q", next), [onFilter]);
  const onClearFilters = useCallback(() => updateSearch({ ...Object.fromEntries(filterKeys.map((key) => [key, null])), page: null }), []);
  // A state or lane on the side panel lists the carriers it counted, so the list's total matches it:
  // the Lane open status with that origin (and equipment), and no other filter.
  const onPick = useCallback(
    (pickedOrigin: string, pickedEquipment: string | null) =>
      updateSearch(pickedOrigin ? { view: "growth", origin: pickedOrigin, equipment: pickedEquipment, q: null, page: null } : { origin: null, equipment: null, page: null }),
    [],
  );

  const sorted = (key: NetworkSort) => sortOrder(key, sort, dir);
  const toggle = (key: string) => setOpenKeys((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));

  const columns: TableColumnsType<NetworkCarrier> = [
    {
      key: "mc",
      title: "MC",
      width: 96,
      sorter: true,
      sortOrder: sorted("mc"),
      sortDirections: textDirections,
      render: (_, carrier) => <span className="font-mono text-xs text-fg-muted">{carrier.mcNumber ?? "-"}</span>,
    },
    {
      key: "carrier",
      title: "Carrier",
      sorter: true,
      sortOrder: sorted("carrier"),
      sortDirections: textDirections,
      ellipsis: true,
      render: (_, carrier) => <span className="font-medium text-fg">{carrierName(carrier)}</span>,
    },
    { key: "status", title: "Status", width: 88, render: (_, carrier) => <StatusIcons carrier={carrier} /> },
    {
      key: "why",
      title: "Why",
      ellipsis: { showTitle: false },
      render: (_, carrier) => {
        const reason = shortReason(carrier, now);
        return (
          <Tooltip title={reason} placement="topLeft">
            <span className="text-fg-muted">{reason}</span>
          </Tooltip>
        );
      },
    },
    {
      key: "lastCall",
      title: "Last call",
      width: 112,
      sorter: true,
      sortOrder: sorted("lastCall"),
      sortDirections: numberDirections,
      render: (_, carrier) => {
        const ago = formatTimeAgo(carrier.facts.lastCallAt, now);
        return (
          <Tooltip title={formatDateTime(carrier.facts.lastCallAt)}>
            <span className="tabular text-fg-muted">{ago === "now" ? "now" : `${ago} ago`}</span>
          </Tooltip>
        );
      },
    },
    {
      key: "calls",
      title: "Calls 30 d",
      width: 104,
      align: "right",
      sorter: true,
      sortOrder: sorted("calls"),
      sortDirections: numberDirections,
      render: (_, carrier) => <span className="tabular">{carrier.facts.calls}</span>,
    },
    {
      key: "bookings",
      title: "Booked",
      width: 92,
      align: "right",
      sorter: true,
      sortOrder: sorted("bookings"),
      sortDirections: numberDirections,
      render: (_, carrier) => <span className="tabular">{carrier.facts.bookings}</span>,
    },
    {
      key: "actions",
      title: <span className="sr-only">Actions</span>,
      width: 76,
      render: (_, carrier) => {
        const open = openKeys.includes(carrier.key);
        return (
          <span className="flex items-center justify-end gap-0.5">
            <Tooltip title={open ? "Hide calls" : "Show calls"}>
              <button type="button" aria-expanded={open} aria-label={open ? "Hide calls" : "Show calls"} onClick={() => toggle(carrier.key)} className={iconButton}>
                <LuChevronDown size={15} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip title="Open in Inbox">
              <Link href={inboxHref(carrier, now)} aria-label="Open in Inbox" className={iconButton}>
                <LuInbox size={15} aria-hidden />
              </Link>
            </Tooltip>
          </span>
        );
      },
    },
  ];

  const empty =
    data === null ? (
      loading ? (
        "Loading carriers..."
      ) : (
        `The carrier network is unavailable. It retries every ${networkPollMs / 1000} seconds.`
      )
    ) : filtered ? (
      <>
        No carriers match these filters.{" "}
        <button type="button" onClick={onClearFilters} className="cursor-pointer font-medium text-accent hover:underline">
          Clear filters
        </button>
      </>
    ) : data.counts.all === 0 ? (
      "No carriers yet. Carriers show up here after their first call."
    ) : (
      "No carriers to list."
    );

  const kpis = data?.kpis;
  const bookedShare = kpis && kpis.negotiated > 0 ? `${Math.round((kpis.booked / kpis.negotiated) * 100)}% of negotiations` : "No negotiations yet";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1480px] flex-col gap-4 px-8 py-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Carriers</h1>
          <p className="mt-1 text-sm text-fg-muted">How the network is doing, and who needs a call</p>
        </header>

        <section aria-label="Key numbers" aria-live="polite">
          <dl className="grid grid-cols-4 gap-3">
            <Tile label="Carriers" icon={LuUsers} value={data ? String(data.counts.all) : "-"} hint={kpis ? `${kpis.called} called in the last 30 days` : ""} />
            <Tile label="Loads booked" icon={LuCircleCheck} iconTone="text-tone-emerald" value={kpis ? String(kpis.booked) : "-"} hint={kpis ? bookedShare : ""} />
            <Tile
              label="At risk"
              icon={statusStyle.at_risk.icon}
              iconTone={statusStyle.at_risk.iconTone}
              value={data ? String(data.counts.atRisk) : "-"}
              hint="Booked before, now quiet or calling less"
            />
            <Tile
              label="Lane open"
              icon={statusStyle.growth.icon}
              iconTone={statusStyle.growth.iconTone}
              value={data ? String(data.counts.growth) : "-"}
              hint="Carriers with a load waiting"
            />
          </dl>
        </section>

        <div className="grid grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] items-start gap-4">
          <section aria-label="Carriers" className="min-w-0 overflow-hidden rounded-lg border border-line bg-panel">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold text-fg">
              <LuUsers size={15} className="text-fg-muted" aria-hidden />
              Carriers
              <span className="tabular font-medium text-fg-faint">{data?.total ?? "-"}</span>
            </div>
            {/* The theme's small controls are the search box's height, so the row lines up. */}
            <ConfigProvider componentSize="small">
              <div className="flex items-center gap-1.5 border-b border-line px-4 py-3">
                <SearchInput q={q} onSearch={onSearch} placeholder="MC, DOT or name" label="Search carriers" className="min-w-0 flex-[2]" />
                <HeaderSelect
                  label="Status"
                  placeholder="All statuses"
                  icon={status ? statusStyle[status].icon : LuListFilter}
                  tone={status ? statusStyle[status].iconTone : "text-accent"}
                  value={status}
                  onChange={(v) => onFilter("view", v)}
                  options={statusOptions}
                  optionRender={statusOption}
                />
                <HeaderSelect label="Equipment" icon={LuContainer} tone="text-accent" value={equipment} onChange={(v) => onFilter("equipment", v)} options={equipmentOptions} />
                <HeaderSelect label="From" icon={LuRoute} tone="text-ok" value={origin} onChange={(v) => onFilter("origin", v)} options={stateOptions} />
              </div>
            </ConfigProvider>

            <ErrorBanner error={data ? error : null} />

            <Table<NetworkCarrier>
              rowKey="key"
              size="small"
              columns={columns}
              dataSource={data?.rows ?? []}
              loading={loading && data === null}
              pagination={false}
              onChange={onSortClick<NetworkCarrier, NetworkSort>(networkSorts, defaultSort)}
              locale={{ emptyText: <span className="block py-8 text-sm text-fg-muted">{empty}</span> }}
              expandable={{
                expandedRowKeys: openKeys,
                showExpandColumn: false,
                expandedRowRender: (carrier) => <CarrierCalls carrier={carrier} now={now} />,
              }}
            />
            <TablePager page={page} pageSize={pageSize} total={data?.total ?? 0} />
          </section>

          <SidePanel data={data} view={view} origin={origin} equipment={equipment} onPick={onPick} />
        </div>
      </div>
    </div>
  );
}
