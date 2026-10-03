"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LuInbox, LuLayoutDashboard, LuRadar, LuRadioTower, LuTriangleAlert, LuUsers } from "react-icons/lu";
import { AutonomySwitch } from "@/components/autonomy-switch";
import { PulseDot } from "@/components/pulse-dot";
import { TmsHealth } from "@/components/tms-health";
import type { TowerWall } from "@/lib/contracts";
import { formatClock, formatDay } from "@/lib/format";
import { usePoll } from "@/lib/use-poll";
import { WallContext } from "@/lib/use-wall";

const nav = [
  { href: "/", label: "Dashboard", icon: LuLayoutDashboard },
  { href: "/inbox", label: "Inbox", icon: LuInbox },
  { href: "/carriers", label: "Carriers", icon: LuUsers },
  { href: "/demand", label: "Demand", icon: LuRadar },
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
      <div className="flex h-[100dvh] flex-col overflow-hidden md:min-w-[1280px]">
        <header className="flex h-12 shrink-0 items-center gap-6 border-b border-line bg-panel px-4 max-md:gap-3 max-md:px-3">
          <div className="flex shrink-0 items-center gap-2">
            <span className="grid size-6 place-items-center rounded-full bg-accent-soft text-accent">
              <LuRadioTower size={13} aria-hidden />
            </span>
            <span className="text-sm font-semibold tracking-tight max-md:hidden">Control Tower</span>
          </div>

          {/* The active tab sits on the bar's bottom border, like the tab strips inside the pages. */}
          <nav aria-label="Tower" className="flex h-full items-stretch gap-1 max-md:hidden">
            {nav.map(({ href, label, icon: Icon }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`-mb-px flex items-center gap-1.5 border-b-2 px-2.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
                    active ? "border-accent font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg"
                  }`}
                >
                  <Icon size={15} className={active ? "text-accent" : undefined} aria-hidden />
                  {label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex min-w-0 items-center gap-4 max-md:gap-2.5">
            <span className="flex shrink-0 items-center gap-2 text-xs">
              <span className="flex items-center gap-1.5 font-medium uppercase tracking-wide">
                {stale ? <span className="inline-flex size-2 rounded-full bg-warn" aria-hidden /> : <PulseDot tone="ok" />}
                <span className={stale ? "text-warn" : "text-ok"}>{stale ? "Stale" : "Live"}</span>
              </span>
              {wall && <span className="tabular text-fg-muted max-md:hidden">{formatDay(wall.day)}</span>}
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

        {/* On a phone the nav moves to a bottom tab bar, in thumb reach. */}
        <nav aria-label="Tower" className="flex shrink-0 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] md:hidden">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset ${
                  active ? "font-medium text-accent" : "text-fg-muted"
                }`}
              >
                <Icon size={20} aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </WallContext>
  );
}
