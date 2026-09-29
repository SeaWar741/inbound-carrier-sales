"use client";

import { Robot, UserFocus } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { AutonomyMode } from "@/lib/contracts";

const options: { mode: AutonomyMode; label: string; hint: string }[] = [
  { mode: "human", label: "Human in the loop", hint: "A rep confirms every hold before it books" },
  { mode: "autonomous", label: "Autonomous", hint: "The agent books the load as soon as the carrier agrees" },
];

// One switch for every new call. The wall is the source of truth; the pending choice shows until it catches up.
export function AutonomySwitch({ mode }: { mode: AutonomyMode | null }) {
  const [pending, setPending] = useState<AutonomyMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = pending !== null && pending !== mode ? pending : mode;

  // The wall now carries the chosen mode, so the local choice is no longer needed.
  useEffect(() => {
    if (pending !== null && mode === pending) setPending(null);
  }, [mode, pending]);

  async function choose(next: AutonomyMode) {
    if (next === shown) return;
    setPending(next);
    setError(null);
    const res = await fetch("/api/settings/autonomy", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: next }),
    }).catch(() => null);
    if (!res?.ok) {
      setError("Not saved");
      setPending(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div role="radiogroup" aria-label="Booking mode" className="flex rounded-full border border-line-strong bg-bg p-0.5">
        {options.map((option) => {
          const active = shown === option.mode;
          const Icon = option.mode === "human" ? UserFocus : Robot;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={active}
              title={option.hint}
              disabled={mode === null}
              onClick={() => void choose(option.mode)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 ${
                active ? (option.mode === "autonomous" ? "bg-accent text-white" : "bg-panel-raised text-fg") : "text-fg-muted hover:text-fg"
              }`}
            >
              <Icon size={13} weight={active ? "bold" : "regular"} />
              {option.label}
            </button>
          );
        })}
      </div>
      {error && <span className="text-xs text-risk">{error}</span>}
    </div>
  );
}
