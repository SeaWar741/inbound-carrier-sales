"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LuInbox, LuLayoutDashboard, LuRadioTower, LuTriangleAlert } from "react-icons/lu";
import { AutonomySwitch } from "@/components/autonomy-switch";
import { PulseDot } from "@/components/pulse-dot";
import { TmsHealth } from "@/components/tms-health";
import { formatClock, formatDay } from "@/lib/format";
import { useWall, WallContext } from "@/lib/use-wall";

const nav = [
  { href: "/", label: "Dashboard", Icon: LuLayoutDashboard },
  { href: "/inbox", label: "Inbox", Icon: LuInbox },
];

// The frame of every tower page: sidebar, header and the wall poll the pages share. The page body
// fills what is left and scrolls inside its own panes; the window itself never scrolls.
export default function TowerLayout({ children }: { children: React.ReactNode }) {
  const wallState = useWall();
  const { wall, error, updatedAt } = wallState;
  const pathname = usePathname();
  const stale = error !== null;

  return (
    <WallContext value={wallState}>
      <div className="flex h-[100dvh] min-w-[1280px] overflow-hidden">
        <nav aria-label="Tower" className="flex w-56 shrink-0 flex-col gap-6 border-r border-line bg-panel px-3 py-4">
          <div className="flex items-center gap-2.5 px-2">
            <span className="grid size-7 place-items-center rounded-full bg-accent-soft text-accent">
              <LuRadioTower size={14} />
            </span>
            <span className="text-sm font-semibold tracking-tight">Control Tower</span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {nav.map(({ href, label, Icon }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-2.5 rounded-[var(--radius-panel)] px-2 py-1.5 text-sm transition focus-visible:outline-2 focus-visible:outline-accent ${
                      active ? "bg-panel-raised font-medium text-fg" : "text-fg-muted hover:bg-panel-raised hover:text-fg"
                    }`}
                  >
                    <Icon size={16} className={active ? "text-accent" : "text-fg-faint"} aria-hidden />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex min-w-0 shrink-0 items-center gap-6 border-b border-line bg-panel px-4 py-2.5">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
                {stale ? <span className="inline-flex size-2 rounded-full bg-warn" aria-hidden /> : <PulseDot tone="ok" />}
                <span className={stale ? "text-warn" : "text-ok"}>{stale ? "Stale" : "Live"}</span>
              </span>
              {wall && <span className="tabular text-xs text-fg-muted">{formatDay(wall.day)}</span>}
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-4">
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
      </div>
    </WallContext>
  );
}
