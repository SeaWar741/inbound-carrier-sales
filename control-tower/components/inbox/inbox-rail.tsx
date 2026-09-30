"use client";

import { DatePicker } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import type { IconType } from "react-icons";
import { LuInbox } from "react-icons/lu";
import { carrierStageStyle, neutralTone, type StageTone } from "@/components/inbox/stage-pill";
import type { CarrierStage, inboxTabs, TowerCarriers } from "@/lib/contracts";

export type InboxTab = (typeof inboxTabs)[number];

// A rail row is a tab or a stage; "All carriers" is neither.
export type RailItem = {
  id: string;
  label: string;
  icon: IconType;
  tone: StageTone;
  tab: InboxTab;
  stage: CarrierStage | null;
  count: (data: TowerCarriers) => number;
};

const stageItem = (stage: CarrierStage): RailItem => ({
  id: stage,
  label: carrierStageStyle[stage].label,
  icon: carrierStageStyle[stage].icon,
  tone: carrierStageStyle[stage].tone,
  tab: "all",
  stage,
  count: (data) => data.stageCounts[stage],
});

// "Needs you" and "Live calls" are tabs, drawn like the stage that fills them.
const needsYou: RailItem[] = [
  { ...stageItem("needs_approval"), id: "needs_you", label: "Needs you", tab: "needs_you", stage: null, count: (d) => d.counts.needsYou },
  { ...stageItem("live"), id: "live", label: "Live calls", tab: "live", stage: null, count: (d) => d.counts.live },
];

const pipeline: RailItem[] = [
  // The four tabs split every carrier, so their sum is the whole list.
  {
    id: "all",
    label: "All carriers",
    icon: LuInbox,
    tone: neutralTone,
    tab: "all",
    stage: null,
    count: (d) => d.counts.needsYou + d.counts.live + d.counts.active + d.counts.closed,
  },
  stageItem("negotiating"),
  stageItem("booked"),
  stageItem("in_transit"),
  stageItem("arrived"),
  stageItem("lost"),
];

const railItems: RailItem[] = [...needsYou, ...pipeline];

// The rail row the URL selects, or null when the tab and stage match none (a hand-edited link).
export function selectedRailItem(tab: InboxTab, stage: string): RailItem | null {
  return railItems.find((item) => item.tab === tab && (item.stage ?? "") === stage) ?? null;
}

function RailRow({ item, data, selected, onSelect }: { item: RailItem; data: TowerCarriers | null; selected: boolean; onSelect: () => void }) {
  const Icon = item.icon;
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
      <Icon size={18} className={`shrink-0 ${item.tone.icon}`} aria-hidden />
      <span className={`min-w-0 flex-1 truncate text-sm ${selected ? "font-semibold text-accent" : "font-medium text-fg"}`}>{item.label}</span>
      <span
        className={`tabular min-w-7 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-semibold ${
          // A quiet zero keeps an empty "Needs you" from reading as an alarm.
          count === 0 ? neutralTone.pill : item.tone.pill
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

// The adapter's `since` presets; the URL omits the default (7d). Each also names the day range it
// shows in the picker, ending on the desk's today.
const sincePresets = [
  { since: "today", label: "Today", days: 0 },
  { since: "", label: "Last 7 days", days: 7 },
  { since: "30d", label: "Last 30 days", days: 30 },
];
const dayFormat = "YYYY-MM-DD";

// The URL's window: a picked day range, or a `since` preset with the other two empty.
export type InboxWindow = { since: string; from: string; to: string };

// The date window as an antd range picker. A preset (or a range equal to one) keeps the rolling
// `since` window, so it follows the clock; any other range is sent as whole desk days.
// `inline` drops the label for a filter row, where the picker sits beside the other controls.
export function DateRange({
  dateWindow: current,
  today,
  onWindow,
  inline = false,
}: {
  dateWindow: InboxWindow;
  today: string;
  onWindow: (next: InboxWindow) => void;
  inline?: boolean;
}) {
  const end = dayjs(today);
  const presetRange = (days: number): [Dayjs, Dayjs] => [end.subtract(days, "day"), end];
  const preset = current.from && current.to ? null : (sincePresets.find((p) => p.since === current.since) ?? sincePresets[1]!);
  const value: [Dayjs, Dayjs] = preset ? presetRange(preset.days) : [dayjs(current.from), dayjs(current.to)];

  const onChange = (dates: [Dayjs | null, Dayjs | null] | null) => {
    const [start, stop] = dates ?? [];
    if (!start || !stop) return;
    const from = start.format(dayFormat);
    const to = stop.format(dayFormat);
    const match = to === today ? sincePresets.find((p) => presetRange(p.days)[0].format(dayFormat) === from) : undefined;
    onWindow(match ? { since: match.since, from: "", to: "" } : { since: "", from, to });
  };

  return (
    <div>
      {!inline && (
        <div className="mb-2 flex items-baseline justify-between gap-2 px-1 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">
          <span>Date range</span>
          <span className="truncate font-medium tracking-normal normal-case">{preset ? preset.label : "Custom"}</span>
        </div>
      )}
      <DatePicker.RangePicker
        aria-label="Date range"
        value={value}
        onChange={onChange}
        format="MMM D"
        allowClear={false}
        presets={sincePresets.map((p) => ({ label: p.label, value: presetRange(p.days) }))}
        disabledDate={(day) => day.isAfter(end, "day")}
        placement="bottomLeft"
        style={{ width: "100%" }}
      />
    </div>
  );
}

// The cortex stage rail: the date window on top, then "Needs you" and the pipeline, each row with
// its stage icon, tone and count. One click selects a row.
export function InboxRail({
  data,
  selected,
  dateWindow: current,
  today,
  onSelect,
  onWindow,
}: {
  data: TowerCarriers | null;
  selected: RailItem | null;
  dateWindow: InboxWindow;
  // The desk's calendar day, YYYY-MM-DD.
  today: string;
  onSelect: (item: RailItem) => void;
  onWindow: (next: InboxWindow) => void;
}) {
  const row = (item: RailItem) => (
    <RailRow key={item.id} item={item} data={data} selected={selected?.id === item.id} onSelect={() => onSelect(item)} />
  );
  return (
    <nav aria-label="Carrier stages" className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto border-r border-line bg-panel p-3">
      <DateRange dateWindow={current} today={today} onWindow={onWindow} />
      <Group title="Needs you">{needsYou.map(row)}</Group>
      <Group title="Pipeline">{pipeline.map(row)}</Group>
    </nav>
  );
}
