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
