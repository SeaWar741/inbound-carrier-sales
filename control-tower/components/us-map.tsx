"use client";

import { geoAlbersUsa, geoPath } from "d3-geo";
import { motion, useReducedMotion } from "motion/react";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import statesTopology from "us-atlas/states-10m.json";
import type { WallLane } from "@/lib/contracts";
import zip3Centroids from "@/lib/zip3-centroids.json";

// A 16:10 canvas; the SVG scales to the column through its viewBox.
const width = 960;
const height = 600;
const projection = geoAlbersUsa().scale(1070).translate([width / 2, height / 2]);

const topology = statesTopology as unknown as Topology<{ states: GeometryCollection }>;
const statesPath = geoPath(projection)(mesh(topology, topology.objects.states)) ?? "";
const nationPath = geoPath(projection)(feature(topology, topology.objects.states)) ?? "";

// [longitude, latitude] per 3-digit ZIP prefix, from scripts/build-zip3.ts.
const centroids: Record<string, number[] | undefined> = zip3Centroids;

type Point = [number, number];

// Placed by the 3-digit ZIP prefix; unknown prefixes and places outside the projection are skipped.
function place(zip: string | undefined): Point | null {
  const [lon, lat] = (zip ? centroids[zip.slice(0, 3)] : undefined) ?? [];
  if (lon === undefined || lat === undefined) return null;
  return projection([lon, lat]) ?? null;
}

// A quadratic curve bowed to the left of travel, higher for longer hauls.
function arcPath([x1, y1]: Point, [x2, y2]: Point): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const bow = 0.22;
  const cx = (x1 + x2) / 2 + dy * bow;
  const cy = (y1 + y2) / 2 - dx * bow;
  return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

export type MapArc = { loadId: string; lane: WallLane | null; current: boolean };

function Arc({ arc, live }: { arc: MapArc; live: boolean }) {
  const reduce = useReducedMotion();
  const from = place(arc.lane?.origin.zip);
  const to = place(arc.lane?.destination.zip);
  if (!from || !to) return null;
  const stroke = arc.current ? "var(--accent)" : "var(--fg-faint)";
  return (
    <g>
      <motion.path
        d={arcPath(from, to)}
        fill="none"
        stroke={stroke}
        strokeWidth={arc.current ? 2.5 : 1.5}
        strokeLinecap="round"
        opacity={arc.current ? 1 : 0.7}
        initial={reduce ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.1, ease: "easeInOut" }}
      />
      {/* The carrier is empty at the origin, so it pulses while the call is live. */}
      {arc.current && live && !reduce && (
        <motion.circle
          cx={from[0]}
          cy={from[1]}
          r={6}
          fill="var(--accent)"
          initial={{ scale: 1, opacity: 0.5 }}
          animate={{ scale: [1, 2.6], opacity: [0.5, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <circle cx={from[0]} cy={from[1]} r={arc.current ? 5 : 3.5} fill={stroke} />
      <circle
        cx={to[0]}
        cy={to[1]}
        r={arc.current ? 5 : 3.5}
        fill="var(--panel)"
        stroke={stroke}
        strokeWidth={arc.current ? 2 : 1.5}
      />
    </g>
  );
}

export function UsMap({
  arcs,
  live,
  otherOrigins,
  label,
}: {
  // The selected call's offered loads, one arc each.
  arcs: MapArc[];
  live: boolean;
  // Origin zips of the other live calls' current loads.
  otherOrigins: string[];
  label: string;
}) {
  const others = otherOrigins.map(place).filter((point): point is Point => point !== null);
  // The current arc is drawn last so it sits on top.
  const ordered = [...arcs].sort((a, b) => Number(a.current) - Number(b.current));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="block h-auto w-full">
      <path d={nationPath} fill="var(--panel-raised)" stroke="none" />
      <path d={statesPath} fill="none" stroke="var(--line-strong)" strokeWidth={0.8} strokeLinejoin="round" />
      {others.map(([x, y], index) => (
        <circle key={`${index}-${x}-${y}`} cx={x} cy={y} r={3} fill="var(--fg-faint)" opacity={0.55} />
      ))}
      {ordered.map((arc) => (
        <Arc key={arc.loadId} arc={arc} live={live} />
      ))}
    </svg>
  );
}
