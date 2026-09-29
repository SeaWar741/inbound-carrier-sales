// A centered placeholder for a panel with nothing to show yet. className sets the call site's size and spacing.
export function EmptyState({
  icon,
  title,
  hint,
  className = "",
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={`grid place-items-center px-6 text-center ${className}`}>
      <div className="flex flex-col items-center gap-2">
        <span className="text-fg-faint" aria-hidden>
          {icon}
        </span>
        <p className="text-sm text-fg-muted">{title}</p>
        {hint && <p className="text-xs text-fg-faint">{hint}</p>}
      </div>
    </div>
  );
}
