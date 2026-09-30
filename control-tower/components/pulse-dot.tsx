"use client";

import { motion, useReducedMotion } from "motion/react";

const toneClass = { accent: "bg-accent", ok: "bg-ok" } as const;

// A dot with a ring that pulses outward; the ring is dropped for reduced motion.
// With a label it is announced as an image, otherwise it is decoration next to visible text.
export function PulseDot({ tone, label }: { tone: keyof typeof toneClass; label?: string }) {
  const reduce = useReducedMotion();
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <span className="relative inline-flex size-2" {...a11y}>
      {!reduce && (
        <motion.span
          className={`absolute inset-0 rounded-full ${toneClass[tone]}`}
          animate={{ scale: [1, 2.2], opacity: [0.6, 0] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <span className={`relative inline-flex size-2 rounded-full ${toneClass[tone]}`} />
    </span>
  );
}
