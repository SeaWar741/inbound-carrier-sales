"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { TowerWall } from "@/lib/contracts";
import { formatUsd } from "@/lib/format";

type Counters = TowerWall["counters"];

// A number that rolls up when it changes, so a new booking is noticed without reading every cell.
function Rolling({ value, className }: { value: string; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <span className={`relative inline-flex overflow-hidden ${className ?? ""}`}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={value}
          initial={reduce ? { opacity: 0 } : { y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { y: "-100%", opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.28, ease: [0.2, 0.8, 0.2, 1] }}
          className="tabular inline-block"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function Counter({ label, value, tone }: { label: string; value: string; tone?: "ok" }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-4 first:pl-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">{label}</dt>
      <dd className={`text-base font-medium leading-tight ${tone === "ok" ? "text-ok" : "text-fg"}`}>
        <Rolling value={value} />
      </dd>
    </div>
  );
}

export function DayCounters({ counters }: { counters: Counters | null }) {
  const show = (value: string) => (counters === null ? "-" : value);
  return (
    <section aria-label="Today's counters" aria-live="polite">
      <dl className="flex items-center divide-x divide-line">
        <Counter label="Calls" value={show(String(counters?.calls ?? 0))} />
        <Counter label="Booked" value={show(String(counters?.booked ?? 0))} />
        <Counter label="Blocked" value={show(String(counters?.blocked ?? 0))} />
        <Counter label="$ generated" value={show(formatUsd(counters?.dollarsGenerated ?? 0))} />
        <Counter label="Margin saved" value={show(formatUsd(counters?.marginSaved ?? 0))} tone="ok" />
      </dl>
    </section>
  );
}
