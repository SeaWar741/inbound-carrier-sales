"use client";

import type { IconType } from "react-icons";
import { LuCalendarDays, LuChevronDown, LuInbox } from "react-icons/lu";
import { sinceOptions } from "@/components/inbox/filter-bar";
import { carrierStageIcon } from "@/components/inbox/stage-pill";
import type { CarrierStage, inboxTabs, TowerCarriers } from "@/lib/contracts";
import { carrierStageLabels } from "@/lib/format";

export type InboxTab = (typeof inboxTabs)[number];

type Tone = "risk" | "ok" | "accent" | "neutral";
const tones: Record<Tone, { icon: string; pill: string }> = {
  risk: { icon: "text-risk", pill: "bg-risk-soft text-risk" },
  ok: { icon: "text-ok", pill: "bg-ok-soft text-ok" },
  accent: { icon: "text-accent", pill: "bg-accent-soft text-accent" },
  neutral: { icon: "text-fg-muted", pill: "bg-panel-raised text-fg-muted" },
};

// A rail row is a tab or a stage; "All carriers" is neither.
export type RailItem = {
  id: string;
  label: string;
  icon: IconType;
  tone: Tone;
  tab: InboxTab;
  stage: CarrierStage | null;
  count: (data: TowerCarriers) => number;
};

const stageItem = (stage: CarrierStage, tone: Tone): RailItem => ({
  id: stage,
  label: carrierStageLabels[stage],
  icon: carrierStageIcon[stage],
  tone,
  tab: "all",
  stage,
  count: (data) => data.stageCounts[stage],
});

const needsYou: RailItem[] = [
  { id: "needs_you", label: "Needs you", icon: carrierStageIcon.needs_approval, tone: "risk", tab: "needs_you", stage: null, count: (d) => d.counts.needsYou },
  { id: "live", label: "Live calls", icon: carrierStageIcon.live, tone: "ok", tab: "live", stage: null, count: (d) => d.counts.live },
];

const pipeline: RailItem[] = [
  // The four tabs split every carrier, so their sum is the whole list.
  {
    id: "all",
    label: "All carriers",
    icon: LuInbox,
    tone: "neutral",
    tab: "all",
    stage: null,
    count: (d) => d.counts.needsYou + d.counts.live + d.counts.active + d.counts.closed,
  },
  stageItem("negotiating", "accent"),
  stageItem("booked", "ok"),
  stageItem("in_transit", "accent"),
  stageItem("arrived", "neutral"),
  stageItem("lost", "neutral"),
];

const railItems: RailItem[] = [...needsYou, ...pipeline];

// The rail row the URL selects, or null when the tab and stage match none (a hand-edited link).
export function selectedRailItem(tab: InboxTab, stage: string): RailItem | null {
  return railItems.find((item) => item.tab === tab && (item.stage ?? "") === stage) ?? null;
}

function RailRow({ item, data, selected, onSelect }: { item: RailItem; data: TowerCarriers | null; selected: boolean; onSelect: () => void }) {
  const Icon = item.icon;
  const tone = tones[selected ? "accent" : item.tone];
  const count = data ? item.count(data) : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 ${
        selected ? "bg-accent-soft" : "hover:bg-panel-raised"
      }`}
    >
      <Icon size={18} className={`shrink-0 ${tone.icon}`} aria-hidden />
      <span className={`min-w-0 flex-1 truncate text-sm ${selected ? "font-semibold text-accent" : "font-medium text-fg"}`}>{item.label}</span>
      <span
        className={`tabular min-w-7 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-semibold ${
          // A quiet zero keeps an empty "Needs you" from reading as an alarm.
          count === 0 && !selected ? tones.neutral.pill : tone.pill
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

// The cortex stage rail: the date window on top, then "Needs you" and the pipeline, each row with
// its icon and count. One click selects a row.
export function InboxRail({
  data,
  selected,
  since,
  onSelect,
  onSince,
}: {
  data: TowerCarriers | null;
  selected: RailItem | null;
  since: string;
  onSelect: (item: RailItem) => void;
  onSince: (since: string) => void;
}) {
  const row = (item: RailItem) => (
    <RailRow key={item.id} item={item} data={data} selected={selected?.id === item.id} onSelect={() => onSelect(item)} />
  );
  return (
    <nav aria-label="Carrier stages" className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto border-r border-line bg-panel p-3">
      <div>
        <div className="mb-2 px-1 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">Date range</div>
        <label className="relative flex h-10 items-center rounded-lg border border-line bg-panel transition-colors focus-within:ring-2 focus-within:ring-accent/40 hover:bg-panel-raised">
          <LuCalendarDays size={16} className="pointer-events-none absolute left-3 text-fg-faint" aria-hidden />
          <select
            aria-label="Date range"
            value={since}
            onChange={(event) => onSince(event.target.value)}
            className="h-full w-full min-w-0 cursor-pointer appearance-none bg-transparent pr-9 pl-9 text-sm text-fg outline-none"
          >
            {sinceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <LuChevronDown size={16} className="pointer-events-none absolute right-3 text-fg-faint" aria-hidden />
        </label>
      </div>
      <Group title="Needs you">{needsYou.map(row)}</Group>
      <Group title="Pipeline">{pipeline.map(row)}</Group>
    </nav>
  );
}
