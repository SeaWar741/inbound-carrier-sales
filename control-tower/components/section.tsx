import type { IconType } from "react-icons";

// The detail panel's section label: 11px uppercase with a small icon, and an optional right side.
function SectionTitle({ icon: Icon, title, children }: { icon: IconType; title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex min-w-0 items-center justify-between gap-2">
      <h3 className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold tracking-wide text-fg-faint uppercase">
        <Icon size={12} aria-hidden />
        {title}
      </h3>
      {children}
    </div>
  );
}

// One block of the detail panel's single scroll; sections after the first get a top rule.
export function Section({
  icon,
  title,
  aside,
  label,
  children,
}: {
  icon: IconType;
  title: string;
  aside?: React.ReactNode;
  // The section's accessible name when the visible title is not enough.
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={label ?? title} className="border-t border-line p-4 first:border-t-0">
      <SectionTitle icon={icon} title={title}>
        {aside}
      </SectionTitle>
      {children}
    </section>
  );
}

const actionTones = {
  red: { card: "border-tone-red/30", header: "bg-tone-red-soft text-tone-red" },
  amber: { card: "border-tone-amber/30", header: "bg-tone-amber-soft text-tone-amber" },
  emerald: { card: "border-tone-emerald/30", header: "bg-tone-emerald-soft text-tone-emerald" },
  gray: { card: "border-line-strong", header: "bg-tone-gray-soft text-tone-gray" },
};
export type ActionTone = keyof typeof actionTones;

// Something a person has to do, at the top of the detail panel: a bordered card whose tinted header
// names the action. The caller spaces the cards.
export function ActionCard({
  tone,
  icon: Icon,
  title,
  aside,
  children,
}: {
  tone: ActionTone;
  icon: IconType;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const style = actionTones[tone];
  return (
    <section aria-label={title} className={`overflow-hidden rounded-lg border bg-panel ${style.card}`}>
      <div className={`flex min-w-0 items-center justify-between gap-2 px-3 py-2 ${style.header}`}>
        <h3 className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
          <Icon size={14} className="shrink-0" aria-hidden />
          <span className="truncate">{title}</span>
        </h3>
        {aside}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}
