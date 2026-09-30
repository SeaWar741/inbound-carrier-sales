"use client";

import { ConfigProvider, Pagination, Table, Tooltip, type TableColumnsType, type TableProps } from "antd";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { LuBadgeDollarSign, LuChevronDown, LuChevronRight, LuContainer, LuFlag, LuRadar, LuRoute, LuSearchX, LuTriangleAlert, LuUsers } from "react-icons/lu";
import { Tile } from "@/components/dashboard/kpi-tiles";
import { DemandCarriers } from "@/components/demand/demand-carriers";
import { EquipmentTag, nextStyle, trendStyle } from "@/components/demand/demand-parts";
import { equipmentOptions, HeaderSelect, SearchInput, stateOptions } from "@/components/inbox/filter-bar";
import { StateMap } from "@/components/state-map";
import { demandSorts, pageSizes, type DemandLane, type TowerDemand } from "@/lib/contracts";
import {
  defaultDemandSort,
  demandKey,
  demandFilterKeys,
  demandPaging,
  demandQuery,
  demandSaid,
  demandSortChange,
  demandTrend,
  demandUnmet,
  laneLabel,
  nextOf,
  nextStepHref,
  topOrigins,
  unmetBarPercent,
  weekChange,
  type DemandSort,
} from "@/lib/demand";
import { defaultPageSize } from "@/lib/network";
import { updateSearch } from "@/lib/use-paged-list";
import { usePoll } from "@/lib/use-poll";

// Demand builds up over days, not seconds.
const demandPollMs = 60_000;

// Every filter "Clear filters" resets; any change to them goes back to page 1.
const filterKeys = ["next", ...demandFilterKeys] as const;

const nextOptions = [
  { value: "source", label: nextStyle.source.label },
  { value: "rate", label: nextStyle.rate.label },
];

const iconButton =
  "grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted outline-none transition-colors hover:bg-panel-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40";

type AntdOrder = "ascend" | "descend";

// Text sorts A to Z first, numbers most first. Neither direction clears the sort, so a header click
// always shows a sorted list.
const textDirections: AntdOrder[] = ["ascend", "descend", "ascend"];
const numberDirections: AntdOrder[] = ["descend", "ascend", "descend"];

function SidePanel({ data, origin, onPick }: { data: TowerDemand | null; origin: string; onPick: (origin: string) => void }) {
  const counts = useMemo(() => (data?.origins ?? []).filter((row) => row.unmet > 0).map((row) => ({ state: row.originState, count: row.unmet })), [data?.origins]);
  const top = topOrigins(data?.origins ?? []);
  const maxUnmet = top[0]?.unmet ?? 1;
  // A second click on the picked state lets it go.
  const onState = useCallback((state: string) => onPick(state === origin ? "" : state), [origin, onPick]);

  return (
    <aside aria-label="Where carriers wait" className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold text-fg">
        <LuRoute size={15} className="text-warn" aria-hidden />
        Where carriers wait
        <span className="ml-auto text-xs font-normal text-fg-muted">Top 5 origins</span>
      </div>
      <div className="h-56 border-b border-line">
        <StateMap counts={counts} selected={origin || null} onSelect={onState} tone="warn" label="Unmet asks by origin state" unit="unmet ask" />
      </div>
      {top.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-fg-muted">{data === null ? "Loading origins..." : "No origin has unmet asks."}</p>
      ) : (
        <ul className="divide-y divide-line">
          {top.map((row) => {
            const picked = row.originState === origin;
            return (
              <li key={row.originState}>
                <button
                  type="button"
                  aria-pressed={picked}
                  onClick={() => onState(row.originState)}
                  className={`flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-panel-raised focus-visible:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${picked ? "bg-panel-raised" : ""}`}
                >
                  <LuRoute size={14} className="shrink-0 text-fg-faint" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{row.originState}</span>
                    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-panel-raised" aria-hidden>
                      <span className="block h-full rounded-full bg-warn" style={{ width: `${(row.unmet / maxUnmet) * 100}%` }} />
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-xs text-fg-muted">{row.unmet} unmet</span>
                  <LuChevronRight size={14} className="shrink-0 text-fg-faint" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="border-t border-line px-4 py-3 text-xs text-fg-faint">Unmet asks by origin state, over every lane. Click a state to filter the lanes.</p>
    </aside>
  );
}

// Lanes carriers asked for in the last 4 weeks that the board did not cover: the numbers, then a
// sorted, paged table whose rows open who asked, beside where carriers wait. The whole state lives in
// the URL.
export function Demand() {
  const searchParams = useSearchParams();
  const [openKeys, setOpenKeys] = useState<string[]>([]);

  const query = useMemo(() => demandQuery(searchParams), [searchParams]);
  const { sort, dir, page, pageSize } = demandPaging(searchParams);
  const { data, error, loading } = usePoll<TowerDemand>(`/api/demand${query ? `?${query}` : ""}`, demandPollMs, "demand data");

  const q = searchParams.get("q") ?? "";
  const next = searchParams.get("next") ?? "";
  const equipment = searchParams.get("equipment") ?? "";
  const origin = searchParams.get("origin") ?? "";
  const filtered = q !== "" || next !== "" || equipment !== "" || origin !== "";

  const onFilter = useCallback((key: (typeof filterKeys)[number], value: string) => updateSearch({ [key]: value || null, page: null }), []);
  const onSearch = useCallback((value: string) => onFilter("q", value), [onFilter]);
  const onPick = useCallback((picked: string) => onFilter("origin", picked), [onFilter]);
  const onClearFilters = useCallback(() => updateSearch({ ...Object.fromEntries(filterKeys.map((key) => [key, null])), page: null }), []);

  const onTable: TableProps<DemandLane>["onChange"] = (_pagination, _filters, sorter) => {
    const picked = Array.isArray(sorter) ? sorter[0] : sorter;
    // The table's column keys are the adapter's sort names.
    const nextSort = picked?.order ? demandSorts.find((s) => s === picked.columnKey) : undefined;
    updateSearch(nextSort ? demandSortChange(nextSort, picked?.order === "ascend" ? "asc" : "desc") : demandSortChange(defaultDemandSort, "desc"));
  };
  const onPage = (nextPage: number, nextSize: number) =>
    updateSearch(
      nextSize !== pageSize
        ? { pageSize: nextSize === defaultPageSize ? null : String(nextSize), page: null }
        : { page: nextPage === 1 ? null : String(nextPage) },
    );

  const sorted = (key: DemandSort): AntdOrder | null => (sort === key ? (dir === "asc" ? "ascend" : "descend") : null);
  const toggle = (key: string) => setOpenKeys((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));
  // The bars compare the lanes on screen.
  const largest = (data?.rows ?? []).reduce((max, lane) => Math.max(max, demandUnmet(lane)), 0);

  const columns: TableColumnsType<DemandLane> = [
    {
      key: "lane",
      title: "Lane",
      width: 104,
      sorter: true,
      sortOrder: sorted("lane"),
      sortDirections: textDirections,
      render: (_, lane) => <span className="font-medium whitespace-nowrap text-fg">{laneLabel(lane)}</span>,
    },
    {
      key: "equipment",
      title: "Equipment",
      width: 136,
      sorter: true,
      sortOrder: sorted("equipment"),
      sortDirections: textDirections,
      render: (_, lane) => <EquipmentTag equipment={lane.equipment} />,
    },
    {
      key: "unmet",
      title: "Unmet",
      width: 124,
      sorter: true,
      sortOrder: sorted("unmet"),
      sortDirections: numberDirections,
      render: (_, lane) => {
        const unmet = demandUnmet(lane);
        return (
          <span className="flex items-center gap-2">
            <span className="tabular w-7 shrink-0 text-right font-medium text-fg">{unmet}</span>
            <span className="h-1.5 w-14 overflow-hidden rounded-full bg-panel-raised" aria-hidden>
              <span className="block h-full rounded-full bg-warn" style={{ width: `${unmetBarPercent(unmet, largest)}%` }} />
            </span>
          </span>
        );
      },
    },
    {
      key: "thisWeek",
      title: "Last → this wk",
      width: 136,
      sorter: true,
      sortOrder: sorted("thisWeek"),
      sortDirections: numberDirections,
      render: (_, lane) => {
        const { trend, text, tip } = demandTrend(lane);
        const { icon: Icon, tone } = trendStyle[trend];
        return (
          <Tooltip title={tip}>
            <span tabIndex={0} aria-label={tip} className={`inline-flex items-center gap-1.5 rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${tone}`}>
              <Icon size={14} className="shrink-0" aria-hidden />
              <span className="tabular">{text}</span>
            </span>
          </Tooltip>
        );
      },
    },
    {
      key: "said",
      title: "What happened",
      ellipsis: { showTitle: false },
      render: (_, lane) => {
        const said = demandSaid(lane);
        return (
          <Tooltip title={said} placement="topLeft">
            <span className="text-fg-muted">{said}</span>
          </Tooltip>
        );
      },
    },
    {
      key: "carriers",
      title: "Carriers",
      width: 96,
      align: "right",
      sorter: true,
      sortOrder: sorted("carriers"),
      sortDirections: numberDirections,
      render: (_, lane) => <span className="tabular">{lane.carriers}</span>,
    },
    {
      key: "next",
      title: "Next step",
      width: 196,
      render: (_, lane) => {
        const style = nextStyle[nextOf(lane)];
        const Icon = style.icon;
        return (
          <Tooltip title={`Open the dashboard on loads from ${lane.originState}`}>
            <Link
              href={nextStepHref(lane)}
              className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-line bg-panel px-2 text-xs font-medium text-fg outline-none transition-colors hover:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Icon size={13} className={`shrink-0 ${style.tone}`} aria-hidden />
              <span className="truncate">{style.label}</span>
            </Link>
          </Tooltip>
        );
      },
    },
    {
      key: "actions",
      title: <span className="sr-only">Who asked</span>,
      width: 48,
      render: (_, lane) => {
        const key = demandKey(lane);
        const open = openKeys.includes(key);
        return (
          <span className="flex justify-end">
            <Tooltip title={open ? "Hide who asked" : "Who asked"}>
              <button type="button" aria-expanded={open} aria-label={open ? "Hide who asked" : "Who asked"} onClick={() => toggle(key)} className={iconButton}>
                <LuChevronDown size={15} className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
              </button>
            </Tooltip>
          </span>
        );
      },
    },
  ];

  const empty =
    data === null ? (
      loading ? (
        "Loading lanes..."
      ) : (
        `The demand data is unavailable. It retries every ${demandPollMs / 1000} seconds.`
      )
    ) : filtered ? (
      <>
        No lanes match these filters.{" "}
        <button type="button" onClick={onClearFilters} className="cursor-pointer font-medium text-accent hover:underline">
          Clear filters
        </button>
      </>
    ) : (
      "No unmet demand in the last 4 weeks. Lanes show up here when a search finds no load or an offer ends without a booking."
    );

  const totals = data?.totals;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1480px] flex-col gap-4 px-8 py-8">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Demand</h1>
          <p className="mt-1 text-sm text-fg-muted">What carriers asked for in the last 4 weeks that we could not cover</p>
        </header>

        <section aria-label="Key numbers" aria-live="polite">
          <dl className="grid grid-cols-4 gap-3">
            <Tile label="Unmet this week" icon={LuRadar} iconTone="text-tone-amber" value={totals ? String(totals.thisWeek) : "-"} hint={totals ? weekChange(totals) : ""} />
            <Tile label="Carriers waiting" icon={LuUsers} value={totals ? String(totals.carriers) : "-"} hint="Asked and left without a load" />
            <Tile label="Board had nothing" icon={LuSearchX} iconTone="text-tone-blue" value={totals ? String(totals.noMatch) : "-"} hint="Fix: find loads on those lanes" />
            <Tile label="Offered, not booked" icon={LuBadgeDollarSign} iconTone="text-tone-amber" value={totals ? String(totals.offeredNoBooking) : "-"} hint="Fix: check the rate" />
          </dl>
        </section>

        <div className="grid grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] items-start gap-4">
          <section aria-label="Lanes" className="min-w-0 overflow-hidden rounded-lg border border-line bg-panel">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold text-fg">
              <LuRadar size={15} className="text-fg-muted" aria-hidden />
              Lanes
              <span className="tabular font-medium text-fg-faint">{data?.total ?? "-"}</span>
            </div>
            {/* The theme's small controls are the search box's height, so the row lines up. */}
            <ConfigProvider componentSize="small">
              <div className="flex items-center gap-1.5 border-b border-line px-4 py-3">
                <SearchInput q={q} onSearch={onSearch} placeholder="Search lane, state, carrier or MC" label="Search lanes" className="min-w-0 flex-[2]" />
                <HeaderSelect label="Next step" placeholder="Any next step" icon={LuFlag} tone="text-accent" value={next} onChange={(v) => onFilter("next", v)} options={nextOptions} />
                <HeaderSelect label="Equipment" icon={LuContainer} tone="text-accent" value={equipment} onChange={(v) => onFilter("equipment", v)} options={equipmentOptions} />
                <HeaderSelect label="From" icon={LuRoute} tone="text-ok" value={origin} onChange={(v) => onFilter("origin", v)} options={stateOptions} />
              </div>
            </ConfigProvider>

            {error && data && (
              <p role="status" className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-xs text-risk">
                <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
                <span className="truncate">{error}</span>
              </p>
            )}

            <Table<DemandLane>
              rowKey={demandKey}
              size="small"
              columns={columns}
              dataSource={data?.rows ?? []}
              loading={loading && data === null}
              pagination={false}
              onChange={onTable}
              locale={{ emptyText: <span className="block py-8 text-sm text-fg-muted">{empty}</span> }}
              expandable={{
                expandedRowKeys: openKeys,
                showExpandColumn: false,
                expandedRowRender: (lane) => <DemandCarriers lane={lane} />,
              }}
            />
            {data !== null && data.total > 0 && (
              <div className="flex justify-end border-t border-line px-4 py-3">
                <Pagination
                  size="small"
                  current={page}
                  pageSize={pageSize}
                  total={data.total}
                  pageSizeOptions={pageSizes.map(String)}
                  showSizeChanger
                  showTotal={(total, [from, to]) => `${from}-${to} of ${total}`}
                  onChange={onPage}
                />
              </div>
            )}
          </section>

          <SidePanel data={data} origin={origin} onPick={onPick} />
        </div>
      </div>
    </div>
  );
}
