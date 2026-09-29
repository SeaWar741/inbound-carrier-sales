"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import type { TowerCall } from "@/lib/contracts";
import { formatClock } from "@/lib/format";

type CallEvent = TowerCall["events"][number];

const toolLabels: Record<string, string> = {
  verify_carrier: "Verify carrier",
  send_otp: "Send code",
  check_otp: "Check code",
  search_loads: "Search loads",
  evaluate_offer: "Evaluate offer",
  create_hold: "Hold load",
  request_human: "Ask for a human",
};

export function humanizeTool(tool: string): string {
  const known = toolLabels[tool];
  if (known) return known;
  const words = tool.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// "ok" is the only clean answer; a refusal that ends the call is red, anything else needs a look.
function toneOf(event: CallEvent): { dot: string; label: string } {
  if (event.status === null || event.status === "ok") return { dot: "bg-ok", label: "ok" };
  if (event.status === "not_eligible") return { dot: "bg-risk", label: event.status };
  return { dot: "bg-warn", label: event.status };
}

const glow = "0 0 0 3px rgb(79 140 255 / 0.45)";
const noGlow = "0 0 0 0px rgb(79 140 255 / 0)";

export function ActivityChips({ events }: { events: TowerCall["events"] }) {
  const reduce = useReducedMotion();
  const strip = useRef<HTMLOListElement>(null);
  const newest = events.at(-1);

  // Keep the newest tool call in view as the strip grows past the column width.
  useEffect(() => {
    const node = strip.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [newest?.createdAt]);

  if (events.length === 0) {
    return <p className="text-xs text-fg-faint">No tool calls yet</p>;
  }

  return (
    <ol ref={strip} aria-label="Agent activity" className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]">
      {/* Chips present on first render are history; only ones that arrive afterwards flash the accent. */}
      <AnimatePresence initial={false}>
        {events.map((event) => {
          const tone = toneOf(event);
          return (
            <motion.li
              key={`${event.tool}-${event.createdAt}`}
              initial={reduce ? false : { opacity: 0, y: 4, boxShadow: glow }}
              animate={{ opacity: 1, y: 0, boxShadow: noGlow }}
              transition={{ duration: 0.25, boxShadow: { duration: 1.6, ease: "easeOut" } }}
              title={[event.summary, formatClock(event.createdAt, true)].filter(Boolean).join(" at ")}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-panel-raised px-2 py-0.5 text-[11px] leading-4 text-fg-muted"
            >
              <span role="img" className={`size-1.5 rounded-full ${tone.dot}`} aria-label={tone.label} />
              {humanizeTool(event.tool)}
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
