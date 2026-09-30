"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LuRadioTower, LuTriangleAlert } from "react-icons/lu";
import { AutonomySwitch } from "@/components/autonomy-switch";
import { PulseDot } from "@/components/pulse-dot";
import { TmsHealth } from "@/components/tms-health";
import type { TowerWall } from "@/lib/contracts";
import { formatClock, formatDay } from "@/lib/format";
import { usePoll } from "@/lib/use-poll";
import { WallContext } from "@/lib/use-wall";

const nav = [
  { href: "/", label: "Dashboard" },
  { href: "/inbox", label: "Inbox" },
];

// The frame of every tower page: one top bar and the wall poll the pages share. The page body
// fills what is left and scrolls inside its own panes; the window itself never scrolls.
export default function TowerLayout({ children }: { children: React.ReactNode }) {
  // Polls /api/wall every 2 s while the tab is visible. A failed poll keeps the last good wall.
  const wallState = usePoll<TowerWall>("/api/wall", 2_000, "wall");
  const { data: wall, error, updatedAt } = wallState;
  const pathname = usePathname();
  const stale = error !== null;

  return (
    <WallContext value={wallState}>
      <div className="flex h-[100dvh] min-w-[1280px] flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-6 border-b border-line bg-panel px-4">
          <div className="flex shrink-0 items-center gap-2">
            <span className="grid size-6 place-items-center rounded-full bg-accent-soft text-accent">
              <LuRadioTower size={13} aria-hidden />
            </span>
            <span className="text-sm font-semibold tracking-tight">Control Tower</span>
          </div>

          {/* The active tab sits on the bar's bottom border, like the tab strips inside the pages. */}
          <nav aria-label="Tower" className="flex h-full items-stretch gap-1">
            {nav.map(({ href, label }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`-mb-px flex items-center border-b-2 px-2.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
                    active ? "border-accent font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex min-w-0 items-center gap-4">
            <span className="flex shrink-0 items-center gap-2 text-xs">
              <span className="flex items-center gap-1.5 font-medium uppercase tracking-wide">
                {stale ? <span className="inline-flex size-2 rounded-full bg-warn" aria-hidden /> : <PulseDot tone="ok" />}
                <span className={stale ? "text-warn" : "text-ok"}>{stale ? "Stale" : "Live"}</span>
              </span>
              {wall && <span className="tabular text-fg-muted">{formatDay(wall.day)}</span>}
            </span>
            <AutonomySwitch mode={wall?.autonomy ?? null} />
            <TmsHealth health={wall?.tmsHealth ?? null} />
          </div>
        </header>

        {error !== null && (
          <div role="status" className="flex shrink-0 items-center gap-2 border-b border-line bg-risk-soft px-4 py-1.5 text-xs text-risk">
            <LuTriangleAlert size={14} aria-hidden />
            <span>{error}.</span>
            {updatedAt !== null && (
              <span className="text-fg-muted">
                Showing data from <span className="tabular">{formatClock(updatedAt, true)}</span>
              </span>
            )}
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </WallContext>
  );
}
