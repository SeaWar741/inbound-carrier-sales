"use client";

import { Select } from "antd";
import { LuUsers } from "react-icons/lu";
import { neutralTone } from "@/components/inbox/stage-pill";
import { growthStyle, relationshipStyle, topStyle, type ChipStyle } from "@/components/network/network-chips";
import type { NetworkView, TowerNetwork } from "@/lib/contracts";

type ViewItem = { view: NetworkView; style: ChipStyle; hint: string; count: (counts: TowerNetwork["counts"]) => number };

const allStyle: ChipStyle = { label: "All", icon: LuUsers, iconTone: neutralTone.icon, pill: neutralTone.pill };

// The views that ask for a call come first; Top and Growth are tags, so their counts overlap the others.
const views: ViewItem[] = [
  { view: "at_risk", style: relationshipStyle.at_risk, hint: "No call in 14 d or calling less", count: (c) => c.atRisk },
  { view: "growth", style: growthStyle, hint: "Its lane is open on the board now", count: (c) => c.growth },
  { view: "top", style: topStyle, hint: "Books most of its offers", count: (c) => c.top },
  { view: "new", style: relationshipStyle.new, hint: "Fewer than 3 calls", count: (c) => c.new },
  { view: "all", style: allStyle, hint: "Every carrier in the window", count: (c) => c.all },
];

// The label of a view, for the list's empty state.
export function viewLabel(view: NetworkView): string {
  return views.find((item) => item.view === view)?.style.label ?? "All";
}

function ViewLabel({ item, count }: { item: ViewItem; count: number | null }) {
  const { icon: Icon, iconTone, label, pill } = item.style;
  return (
    <span className="flex items-center gap-2">
      <Icon size={15} className={`shrink-0 ${iconTone}`} aria-hidden />
      <span className="font-medium text-fg">{label}</span>
      {/* A quiet zero keeps an empty "At risk" from reading as an alarm. */}
      <span className={`tabular min-w-6 rounded-full px-1.5 py-0.5 text-center text-[11px] leading-none font-semibold ${count ? pill : neutralTone.pill}`}>
        {count ?? "-"}
      </span>
    </span>
  );
}

// The list's view as one compact select: each view with its icon and count, and its hint in the menu.
export function ViewSelect({ data, view, onView }: { data: TowerNetwork | null; view: NetworkView; onView: (view: NetworkView) => void }) {
  return (
    <Select<NetworkView, { value: NetworkView; label: React.ReactNode; hint: string }>
      aria-label="Carrier view"
      value={view}
      onChange={onView}
      popupMatchSelectWidth={false}
      options={views.map((item) => ({
        value: item.view,
        label: <ViewLabel item={item} count={data ? item.count(data.counts) : null} />,
        hint: item.hint,
      }))}
      optionRender={(option) => (
        <span className="block py-0.5">
          {option.label}
          <span className="mt-0.5 block pl-[23px] text-xs text-fg-faint">{option.data.hint}</span>
        </span>
      )}
      style={{ width: 150 }}
    />
  );
}
