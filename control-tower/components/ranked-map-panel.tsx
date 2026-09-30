"use client";

import type { ReactNode } from "react";
import type { IconType } from "react-icons";
import { LuChevronRight } from "react-icons/lu";
import { StateMap, type StateCount } from "@/components/state-map";

export type RankedRow = { key: string; label: ReactNode; count: number; countLabel: string; picked: boolean; onClick: () => void };

// The header icon and the bars wear the map's tone.
const panelTones = {
  ok: { icon: "text-tone-emerald", bar: "bg-tone-emerald" },
  warn: { icon: "text-warn", bar: "bg-warn" },
};

// How many ranked rows the panel lists.
const shownRows = 5;

// The side panel of the Carriers and Demand pages: a state map, then the top rows as buttons with a
// bar each, then a footer. Rows come most first, so the first one sets the bar scale.
export function RankedMapPanel({
  title,
  icon: Icon,
  tone,
  badge,
  notice,
  map,
  rowIcon: RowIcon,
  rows,
  empty,
  footer,
}: {
  title: string;
  icon: IconType;
  tone: keyof typeof panelTones;
  badge: string;
  // A warning between the header and the map.
  notice?: ReactNode;
  map: { counts: StateCount[]; selected: string | null; onSelect: (state: string) => void; label: string; unit: string };
  rowIcon: IconType;
  rows: RankedRow[];
  empty: string;
  footer: string;
}) {
  const shown = rows.slice(0, shownRows);
  const largest = shown[0]?.count || 1;
  const style = panelTones[tone];

  return (
    <aside aria-label={title} className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold text-fg">
        <Icon size={15} className={style.icon} aria-hidden />
        {title}
        <span className="ml-auto text-xs font-normal text-fg-muted">{badge}</span>
      </div>
      {notice}
      <div className="h-56 border-b border-line">
        <StateMap counts={map.counts} selected={map.selected} onSelect={map.onSelect} tone={tone} label={map.label} unit={map.unit} />
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-fg-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                aria-pressed={row.picked}
                onClick={row.onClick}
                className={`flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-panel-raised focus-visible:bg-panel-raised focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${row.picked ? "bg-panel-raised" : ""}`}
              >
                <RowIcon size={14} className="shrink-0 text-fg-faint" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{row.label}</span>
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-panel-raised" aria-hidden>
                    <span className={`block h-full rounded-full ${style.bar}`} style={{ width: `${(row.count / largest) * 100}%` }} />
                  </span>
                </span>
                <span className="tabular shrink-0 text-xs text-fg-muted">{row.countLabel}</span>
                <LuChevronRight size={14} className="shrink-0 text-fg-faint" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line px-4 py-3 text-xs text-fg-faint">{footer}</p>
    </aside>
  );
}
