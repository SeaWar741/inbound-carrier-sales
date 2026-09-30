"use client";

import { LuTriangleAlert, LuUsers } from "react-icons/lu";
import { DateRange, type InboxWindow } from "@/components/inbox/inbox-rail";
import { neutralTone } from "@/components/inbox/stage-pill";
import { growthStyle, relationshipStyle, topStyle, type ChipStyle } from "@/components/network/network-chips";
import type { NetworkView, TowerNetwork } from "@/lib/contracts";

type ViewItem = { view: NetworkView; style: ChipStyle; hint?: string; count: (counts: TowerNetwork["counts"]) => number };

const allStyle: ChipStyle = { label: "All", icon: LuUsers, iconTone: neutralTone.icon, pill: neutralTone.pill };

// The views that ask for a call come first; Top and Growth are tags, so their counts overlap the others.
const needsACall: ViewItem[] = [
  { view: "at_risk", style: relationshipStyle.at_risk, hint: "No call in 14 d or calling less", count: (c) => c.atRisk },
  { view: "growth", style: growthStyle, hint: "Its lane is open on the board now", count: (c) => c.growth },
];
const network: ViewItem[] = [
  { view: "top", style: topStyle, hint: "Books most of its offers", count: (c) => c.top },
  { view: "new", style: relationshipStyle.new, hint: "Fewer than 3 calls", count: (c) => c.new },
  { view: "all", style: allStyle, count: (c) => c.all },
];

// The label of a view, for the list's count line.
export function viewLabel(view: NetworkView): string {
  return [...needsACall, ...network].find((item) => item.view === view)?.style.label ?? "All";
}

// The inbox rail row, with the view's hint under its label.
function ViewRow({ item, count, selected, onSelect }: { item: ViewItem; count: number | null; selected: boolean; onSelect: () => void }) {
  const { icon: Icon, iconTone, label, pill } = item.style;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 ${
        selected ? "bg-accent-soft" : "hover:bg-panel-raised"
      }`}
    >
      <Icon size={18} className={`shrink-0 ${iconTone}`} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-sm ${selected ? "font-semibold text-accent" : "font-medium text-fg"}`}>{label}</span>
        {item.hint && <span className="mt-0.5 block text-[11px] leading-snug text-fg-faint">{item.hint}</span>}
      </span>
      <span
        className={`tabular min-w-7 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-semibold ${
          // A quiet zero keeps an empty "At risk" from reading as an alarm.
          count === 0 ? neutralTone.pill : pill
        }`}
      >
        {count ?? "-"}
      </span>
    </button>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 px-1 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">{title}</div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

// The carriers rail, drawn like the inbox's: the date window on top, then the views that need a
// call and the rest of the network, each with its icon, hint and count. One click picks a view.
export function NetworkRail({
  data,
  view,
  dateWindow,
  today,
  onView,
  onWindow,
}: {
  data: TowerNetwork | null;
  view: NetworkView;
  // The window as the inbox picker reads it.
  dateWindow: InboxWindow;
  today: string;
  onView: (view: NetworkView) => void;
  onWindow: (next: InboxWindow) => void;
}) {
  const row = (item: ViewItem) => (
    <ViewRow
      key={item.view}
      item={item}
      count={data ? item.count(data.counts) : null}
      selected={item.view === view}
      onSelect={() => onView(item.view)}
    />
  );
  return (
    <nav aria-label="Carrier views" className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto border-r border-line bg-panel p-3">
      <DateRange dateWindow={dateWindow} today={today} onWindow={onWindow} />
      <Group title="Needs a call">
        {needsACall.map(row)}
        {data && !data.boardAvailable && (
          <p role="status" className="flex items-center gap-1 px-3 text-xs text-warn">
            <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
            Board unavailable, Growth hidden
          </p>
        )}
      </Group>
      <Group title="Network">{network.map(row)}</Group>
    </nav>
  );
}
