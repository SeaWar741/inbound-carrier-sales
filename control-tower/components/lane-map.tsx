"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import {
  type ExpressionSpecification,
  type GeoJSONSource,
  LngLatBounds,
  type LngLatBoundsLike,
  Map as MapLibreMap,
  type MapMouseEvent,
  Marker,
  Popup,
  setWorkerUrl,
  type StyleSpecification,
} from "maplibre-gl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { LuArrowRight, LuBuilding2, LuCalendarClock, LuCircleCheck, LuClock, LuContainer, LuDollarSign, LuMinus, LuPlus, LuScan, LuTruck } from "react-icons/lu";
import { tripLabels, tripTones } from "@/components/dashboard/kpi-tiles";
import type { TripStatus } from "@/lib/contracts";
import { formatDateTime, formatUsd } from "@/lib/format";
import { arcPoints, dashFrames, type LngLat, placeZip, pointOnArc, splitArc } from "@/lib/geo";

export type LaneMapLoad = {
  id: string;
  originZip: string;
  destinationZip: string;
  // Share of the trip covered, 0 at pickup and 1 at delivery.
  progress: number;
  status: TripStatus;
  label: string;
  // Popover details; the mini map leaves them out.
  loadId?: string;
  origin?: string;
  destination?: string;
  carrier?: string;
  etaAt?: string;
  rate?: number;
  equipment?: string;
};

// MapLibre cannot parse oklch, so these are the sRGB equivalents of the globals.css tokens.
const colors = {
  panel: "#ffffff", // --panel
  panelRaised: "#f4f5f6", // --panel-raised
  fgMuted: "#6a6f78", // --fg-muted
  fgFaint: "#9a9da3", // --fg-faint
  accent: "#0285ff", // --accent
  ok: "#199a4d", // --ok
};

const styleUrl = "https://tiles.openfreemap.org/styles/positron";

// Used when the tile style cannot load, so the lanes still draw on a plain ground.
const fallbackStyle: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": colors.panelRaised } }],
};

// Positron layers that only add noise at country scale: street names, shields, POIs, rail.
const hiddenBaseLayers = [
  "waterway_line_label",
  "water_name_line_label",
  "highway-name-path",
  "highway-name-minor",
  "highway-name-major",
  "highway-shield-non-us",
  "highway-shield-us-interstate",
  "road_shield_us",
  "airport",
  "aeroway-area",
  "label_other",
  "label_village",
  "railway",
  "railway_dashline",
];

const contiguousUs: LngLatBoundsLike = [
  [-125, 24],
  [-66.5, 49.5],
];
// Loose enough that a short container can still show the whole country.
const maxBounds: LngLatBoundsLike = [
  [-140, 15],
  [-50, 58],
];

// The remaining leg of a trip flows toward the destination: one frame every 80 ms, about a second
// per dash.
const flowDash = { dash: 2.5, gap: 2 };
const flowFrames = dashFrames(flowDash.dash, flowDash.gap, 12);
const flowFrameMs = 80;
const glideMs = 900;
const easeMs = 600;

type Placed = LaneMapLoad & { from: LngLat; to: LngLat; truck: LngLat; selected: boolean; dim: boolean };

function place(loads: LaneMapLoad[], selectedId: string | null): Placed[] {
  const placed: Placed[] = [];
  const hasSelection = loads.some((load) => load.id === selectedId);
  for (const load of loads) {
    const from = placeZip(load.originZip);
    const to = placeZip(load.destinationZip);
    if (!from || !to) continue;
    const selected = load.id === selectedId;
    placed.push({ ...load, from, to, truck: pointOnArc(from, to, load.progress), selected, dim: hasSelection && !selected });
  }
  // The selected load is drawn last so it sits on top.
  return placed.sort((a, b) => Number(a.selected) - Number(b.selected));
}

type LaneProperties = { id: string; selected: boolean; dim: boolean; status: TripStatus; part?: "full" | "traveled" | "remaining"; end?: "origin" | "destination" };
type Collection = GeoJSON.FeatureCollection<GeoJSON.Geometry, LaneProperties>;

function line(properties: LaneProperties, coordinates: LngLat[]): GeoJSON.Feature<GeoJSON.Geometry, LaneProperties> {
  return { type: "Feature", properties, geometry: { type: "LineString", coordinates } };
}

function collections(placed: Placed[]): { arcs: Collection; points: Collection } {
  const arcs: Collection = { type: "FeatureCollection", features: [] };
  const points: Collection = { type: "FeatureCollection", features: [] };
  for (const load of placed) {
    const properties = { id: load.id, selected: load.selected, dim: load.dim, status: load.status };
    arcs.features.push(line({ ...properties, part: "full" }, arcPoints(load.from, load.to)));
    if (load.status === "in_transit") {
      const [traveled, remaining] = splitArc(load.from, load.to, load.progress);
      if (traveled.length > 1) arcs.features.push(line({ ...properties, part: "traveled" }, traveled));
      if (remaining.length > 1) arcs.features.push(line({ ...properties, part: "remaining" }, remaining));
    }
    points.features.push(
      { type: "Feature", properties: { ...properties, end: "origin" }, geometry: { type: "Point", coordinates: load.from } },
      { type: "Feature", properties: { ...properties, end: "destination" }, geometry: { type: "Point", coordinates: load.to } },
    );
  }
  return { arcs, points };
}

// Turbopack rewrites MapLibre's own worker lookup to a hashed, wrong asset, so the worker and the
// shared chunk it imports are copied to public/maplibre by `npm run copy-worker` (predev, prebuild).
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

const selected: ExpressionSpecification = ["get", "selected"];
const hovered: ExpressionSpecification = ["boolean", ["feature-state", "hover"], false];
const dimmed: ExpressionSpecification = ["get", "dim"];

// A paint value that is strongest when selected, raised on hover, faded when another lane is selected.
function emphasis(base: number, whenSelected: number, whenHovered: number, whenDimmed: number): ExpressionSpecification {
  return ["case", selected, whenSelected, hovered, whenHovered, dimmed, whenDimmed, base];
}

const statusColor: ExpressionSpecification = ["match", ["get", "status"], "in_transit", colors.accent, "arrived", colors.ok, colors.fgFaint];

function addLayers(map: MapLibreMap) {
  const empty: Collection = { type: "FeatureCollection", features: [] };
  // Every piece of a lane shares its load id, so hovering the lane raises all of them together.
  map.addSource("lane-arcs", { type: "geojson", data: empty, promoteId: "id" });
  map.addSource("lane-ends", { type: "geojson", data: empty });
  const onTop: ExpressionSpecification = ["case", selected, 1, 0];
  const sortOnTop = { "line-sort-key": onTop };
  const part = (name: string, status: TripStatus): ExpressionSpecification => ["all", ["==", ["get", "part"], name], ["==", ["get", "status"], status]];

  map.addLayer({
    id: "lane-casing",
    type: "line",
    source: "lane-arcs",
    filter: part("full", "in_transit"),
    layout: { "line-cap": "round", "line-join": "round", ...sortOnTop },
    paint: {
      "line-color": colors.accent,
      "line-width": emphasis(7, 11, 9, 7),
      "line-blur": 2,
      "line-opacity": emphasis(0.12, 0.2, 0.18, 0.05),
    },
  });
  map.addLayer({
    id: "lane-upcoming",
    type: "line",
    source: "lane-arcs",
    filter: part("full", "upcoming"),
    layout: { "line-cap": "butt", "line-join": "round", ...sortOnTop },
    paint: {
      "line-color": ["case", selected, colors.fgMuted, hovered, colors.fgMuted, colors.fgFaint],
      "line-width": emphasis(1.5, 2.5, 2, 1.5),
      "line-dasharray": [2, 2],
      "line-opacity": emphasis(0.9, 1, 1, 0.35),
    },
  });
  map.addLayer({
    id: "lane-arrived",
    type: "line",
    source: "lane-arcs",
    filter: part("full", "arrived"),
    layout: { "line-cap": "round", "line-join": "round", ...sortOnTop },
    paint: {
      "line-color": colors.ok,
      "line-width": emphasis(1.5, 2.5, 2, 1.5),
      "line-opacity": emphasis(0.45, 1, 0.8, 0.2),
    },
  });
  map.addLayer({
    id: "lane-remaining",
    type: "line",
    source: "lane-arcs",
    filter: ["==", ["get", "part"], "remaining"],
    layout: { "line-cap": "butt", "line-join": "round", ...sortOnTop },
    paint: {
      "line-color": colors.accent,
      "line-width": emphasis(2, 3, 2.5, 2),
      "line-dasharray": [flowDash.dash, flowDash.gap],
      "line-opacity": emphasis(0.75, 1, 1, 0.3),
    },
  });
  map.addLayer({
    id: "lane-traveled",
    type: "line",
    source: "lane-arcs",
    filter: ["==", ["get", "part"], "traveled"],
    layout: { "line-cap": "round", "line-join": "round", ...sortOnTop },
    paint: {
      "line-color": colors.accent,
      "line-width": emphasis(2.25, 3.5, 3, 2.25),
      "line-opacity": emphasis(1, 1, 1, 0.35),
    },
  });
  // Invisible and wide, so a thin lane is easy to hover and click.
  map.addLayer({
    id: "lane-hit",
    type: "line",
    source: "lane-arcs",
    filter: ["==", ["get", "part"], "full"],
    paint: { "line-color": colors.accent, "line-width": 14, "line-opacity": 0 },
  });
  map.addLayer({
    id: "lane-ends",
    type: "circle",
    source: "lane-ends",
    paint: {
      "circle-radius": ["case", selected, 4.5, 3],
      // Origin filled, destination a ring, as on the lane text.
      "circle-color": ["case", ["==", ["get", "end"], "origin"], statusColor, colors.panel],
      "circle-stroke-color": statusColor,
      "circle-stroke-width": ["case", ["==", ["get", "end"], "origin"], 0, ["case", selected, 2, 1.5]],
      "circle-opacity": ["case", dimmed, 0.4, 1],
      "circle-stroke-opacity": ["case", dimmed, 0.4, 1],
    },
  });
}

// Quiets the positron basemap so the lanes carry the color: drop the noise, soften labels, and
// bring state lines in at country scale as faint dashes.
function quietBasemap(map: MapLibreMap) {
  for (const id of hiddenBaseLayers) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  for (const id of ["label_city", "label_city_capital", "label_town", "label_state"]) {
    if (!map.getLayer(id)) continue;
    map.setPaintProperty(id, "text-color", colors.fgMuted);
    map.setPaintProperty(id, "icon-opacity", 0.35);
  }
  if (map.getLayer("boundary_3")) {
    map.setLayerZoomRange("boundary_3", 3, 24);
    map.setPaintProperty("boundary_3", "line-color", "#d5d8dc");
  }
}

function laneBounds(loads: Placed[]): LngLatBounds {
  const bounds = new LngLatBounds();
  // The arc bows off the straight line, so its midpoint joins the bounds too.
  for (const load of loads) bounds.extend(load.from).extend(load.to).extend(pointOnArc(load.from, load.to, 0.5));
  return bounds;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Below this width the map is a thumbnail: no legend or controls over it.
const chromeMinWidth = 360;

function hasChrome(map: MapLibreMap, overview: boolean): boolean {
  return overview && map.getContainer().clientWidth >= chromeMinWidth;
}

// Scaled to the container, so a thumbnail a hundred pixels tall still frames the whole lane; the
// floor keeps a truck pill at either end on screen. With chrome, room for the legend (top left)
// and the controls (top right).
function framePadding(map: MapLibreMap, overview: boolean) {
  const { clientWidth, clientHeight } = map.getContainer();
  const edge = Math.round(Math.min(40, Math.max(12, Math.min(clientWidth, clientHeight) * 0.12)));
  return hasChrome(map, overview) ? { top: 72, right: 56, bottom: edge, left: edge } : edge;
}

function fit(map: MapLibreMap, placed: Placed[], overview: boolean, animate = false) {
  const duration = animate && !prefersReducedMotion() ? easeMs : 0;
  if (placed.length === 0) {
    map.fitBounds(contiguousUs, { padding: framePadding(map, false), duration });
    return;
  }
  map.fitBounds(laneBounds(placed), { padding: framePadding(map, overview), maxZoom: 6, duration });
}

// Removing a React root while React is committing warns, so the unmount waits a task.
function unmountLater(root: Root) {
  setTimeout(() => root.unmount(), 0);
}

type TruckMarker = { marker: Marker; element: HTMLDivElement; root: Root; glide: ReturnType<typeof setTimeout> | null };

function truckState(element: HTMLElement, load: Placed) {
  element.dataset.status = load.status;
  element.dataset.selected = String(load.selected);
  element.dataset.dim = String(load.dim);
  // The icon faces east; westbound trucks mirror it, never turn it upside down.
  element.dataset.west = String(load.to[0] < load.from[0]);
  element.style.zIndex = load.selected ? "3" : load.status === "in_transit" ? "2" : "1";
  element.setAttribute("aria-label", load.label);
  element.setAttribute("aria-pressed", String(load.selected));
}

function Detail({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-fg-muted">
      <span className="shrink-0 text-fg-faint" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

function LanePopover({ load }: { load: LaneMapLoad }) {
  const percent = Math.round(Math.min(1, Math.max(0, load.progress)) * 100);
  return (
    <div className="w-64 text-xs text-fg">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="tabular text-fg-muted">{load.loadId ?? load.id}</span>
        <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${tripTones[load.status].pill}`}>{tripLabels[load.status]}</span>
      </div>
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        {load.origin && load.destination ? (
          <div className="mb-0.5 flex min-w-0 items-center gap-1 text-sm font-medium">
            <span className="truncate">{load.origin}</span>
            <LuArrowRight size={12} className="shrink-0 text-fg-faint" aria-label="to" />
            <span className="truncate">{load.destination}</span>
          </div>
        ) : (
          <div className="mb-0.5 text-sm font-medium">{load.label}</div>
        )}
        {load.carrier && <Detail icon={<LuBuilding2 size={13} />}>{load.carrier}</Detail>}
        {load.etaAt && (
          <Detail icon={<LuClock size={13} />}>
            ETA <span className="tabular">{formatDateTime(load.etaAt)}</span>
          </Detail>
        )}
        {(load.rate !== undefined || load.equipment) && (
          <div className="flex items-center gap-4">
            {load.rate !== undefined && (
              <Detail icon={<LuDollarSign size={13} />}>
                <span className="tabular text-fg">{formatUsd(load.rate)}</span>
              </Detail>
            )}
            {load.equipment && <Detail icon={<LuContainer size={13} />}>{load.equipment}</Detail>}
          </div>
        )}
      </div>
      {load.status === "in_transit" && (
        <div className="flex items-center gap-2 border-t border-line px-3 py-2">
          <div
            className="h-1 flex-1 overflow-hidden rounded-full bg-panel-raised"
            role="progressbar"
            aria-label="Trip progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
          </div>
          <span className="tabular shrink-0 text-fg-muted">{percent}%</span>
        </div>
      )}
    </div>
  );
}

const legendRows: { status: TripStatus; icon: ReactNode; tone: string }[] = [
  { status: "in_transit", icon: <LuTruck size={13} />, tone: "text-accent" },
  { status: "upcoming", icon: <LuCalendarClock size={13} />, tone: "text-fg-faint" },
  { status: "arrived", icon: <LuCircleCheck size={13} />, tone: "text-ok" },
];

function Legend({ loads }: { loads: LaneMapLoad[] }) {
  return (
    <ul aria-label="Map legend" className="pointer-events-auto absolute top-2 left-2 z-10 flex flex-col gap-1 rounded-[var(--radius-panel)] border border-line bg-panel px-2.5 py-2 text-xs">
      {legendRows.map(({ status, icon, tone }) => (
        <li key={status} className="flex items-center gap-2 text-fg-muted">
          <span className={tone} aria-hidden>
            {icon}
          </span>
          {tripLabels[status]}
          <span className="tabular ml-auto pl-3 text-fg">{loads.filter((load) => load.status === status).length}</span>
        </li>
      ))}
    </ul>
  );
}

const controlButton =
  "grid size-7 place-items-center text-fg-muted transition-colors hover:bg-panel-raised hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

function Controls({ onZoomIn, onZoomOut, onFit }: { onZoomIn: () => void; onZoomOut: () => void; onFit: () => void }) {
  return (
    <div className="absolute top-2 right-2 z-10 flex flex-col gap-1.5">
      <div className="flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-panel">
        <button type="button" onClick={onZoomIn} aria-label="Zoom in" title="Zoom in" className={controlButton}>
          <LuPlus size={14} />
        </button>
        <button type="button" onClick={onZoomOut} aria-label="Zoom out" title="Zoom out" className={controlButton}>
          <LuMinus size={14} />
        </button>
      </div>
      <button
        type="button"
        onClick={onFit}
        aria-label="Fit all lanes"
        title="Fit all"
        className={`${controlButton} rounded-[var(--radius-panel)] border border-line bg-panel`}
      >
        <LuScan size={14} />
      </button>
    </div>
  );
}

export function LaneMap({
  loads,
  selectedId,
  onSelect,
  overview = false,
}: {
  loads: LaneMapLoad[];
  selectedId: string | null;
  onSelect?: (id: string) => void;
  // The dashboard map: legend, zoom and fit controls, popovers, and easing to the selected lane.
  overview?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // The latest props, read by the map's own events (style load, click) without recreating it.
  const placedRef = useRef<Placed[]>([]);
  const onSelectRef = useRef(onSelect);
  const overviewRef = useRef(overview);
  const fittedKey = useRef<string | null>(null);
  const markers = useRef(new Map<string, TruckMarker>());
  const popupRef = useRef<{ popup: Popup; root: Root; id: string | null } | null>(null);
  // The id last picked on the map itself; the camera stays put for those.
  const mapPick = useRef<string | null>(null);
  const [wide, setWide] = useState(false);

  const placed = useMemo(() => place(loads, selectedId), [loads, selectedId]);
  const loadsKey = placed.map((load) => load.id).sort().join(",");
  const loadsKeyRef = useRef(loadsKey);

  useEffect(() => {
    onSelectRef.current = onSelect;
    overviewRef.current = overview;
  }, [onSelect, overview]);

  useEffect(() => {
    if (!container.current) return;
    const map = new MapLibreMap({
      container: container.current,
      style: styleUrl,
      bounds: contiguousUs,
      maxBounds,
      renderWorldCopies: false,
      dragRotate: false,
      touchPitch: false,
      pitchWithRotate: false,
      maxPitch: 0,
      attributionControl: { compact: true },
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    mapRef.current = map;

    let styleLoaded = false;
    let fallback = false;

    const popupContent = document.createElement("div");
    const popup = new Popup({ closeButton: false, closeOnClick: false, offset: 18, maxWidth: "none", className: "lane-popup" }).setDOMContent(popupContent);
    popupRef.current = { popup, root: createRoot(popupContent), id: null };

    // Each style (tiles or fallback) starts empty, so our layers are added on every style load.
    map.on("style.load", () => {
      styleLoaded = true;
      quietBasemap(map);
      addLayers(map);
      draw(map, placedRef.current);
      fit(map, placedRef.current, overviewRef.current);
      fittedKey.current = loadsKeyRef.current;
    });
    map.on("error", (event) => {
      if (styleLoaded || fallback) return;
      fallback = true;
      console.warn("Map style failed to load, drawing lanes on a plain background", event.error);
      map.setStyle(fallbackStyle, { diff: false });
    });

    // Hovering a lane raises it; the hit layer is wide so thin lanes are easy to catch.
    let hoveredId: string | null = null;
    const setHover = (id: string | null) => {
      if (id === hoveredId || !map.getSource("lane-arcs")) return;
      if (hoveredId) map.setFeatureState({ source: "lane-arcs", id: hoveredId }, { hover: false });
      if (id) map.setFeatureState({ source: "lane-arcs", id }, { hover: true });
      hoveredId = id;
      map.getCanvas().style.cursor = id && onSelectRef.current ? "pointer" : "";
    };
    map.on("mousemove", "lane-hit", (event) => setHover((event.features?.[0]?.id as string | undefined) ?? null));
    map.on("mouseleave", "lane-hit", () => setHover(null));

    // Truck markers sit in the canvas container, so their clicks reach here too.
    const onClick = (event: MapMouseEvent) => {
      if (!onSelectRef.current) return;
      const truck = (event.originalEvent.target as HTMLElement | null)?.closest<HTMLElement>("[data-lane-id]");
      const hit = map.getLayer("lane-hit") ? map.queryRenderedFeatures(event.point, { layers: ["lane-hit"] })[0] : undefined;
      const id = truck?.dataset.laneId ?? (hit?.properties as LaneProperties | undefined)?.id;
      if (!id) {
        closePopup();
        return;
      }
      mapPick.current = id;
      openPopup(id, true);
      onSelectRef.current(id);
    };
    map.on("click", onClick);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePopup();
    };
    container.current.addEventListener("keydown", onKey);
    const element = container.current;

    // The container can settle after the map is created (a sidebar laying out, a window resize),
    // so each size change resizes the canvas and refits without animation, once per frame.
    let sizing = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(sizing);
      sizing = requestAnimationFrame(() => {
        if (element.clientWidth === 0 || element.clientHeight === 0) return;
        map.resize();
        fit(map, placedRef.current, overviewRef.current);
        setWide(element.clientWidth >= chromeMinWidth);
      });
    });
    observer.observe(element);

    // The dashes of in-transit lanes flow toward the destination; still under reduced motion.
    let frame = 0;
    const flow = setInterval(() => {
      if (document.hidden || !map.getLayer("lane-remaining") || !placedRef.current.some((load) => load.status === "in_transit")) return;
      if (prefersReducedMotion()) {
        if (frame !== 0) map.setPaintProperty("lane-remaining", "line-dasharray", [flowDash.dash, flowDash.gap]);
        frame = 0;
        return;
      }
      frame = (frame + 1) % flowFrames.length;
      map.setPaintProperty("lane-remaining", "line-dasharray", flowFrames[frame]);
    }, flowFrameMs);

    const truckMarkers = markers.current;
    return () => {
      clearInterval(flow);
      observer.disconnect();
      cancelAnimationFrame(sizing);
      element.removeEventListener("keydown", onKey);
      for (const truck of truckMarkers.values()) {
        if (truck.glide) clearTimeout(truck.glide);
        truck.marker.remove();
        unmountLater(truck.root);
      }
      truckMarkers.clear();
      if (popupRef.current) {
        popupRef.current.popup.remove();
        unmountLater(popupRef.current.root);
        popupRef.current = null;
      }
      map.remove();
      mapRef.current = null;
      fittedKey.current = null;
    };
  }, []);

  function closePopup() {
    const current = popupRef.current;
    if (!current) return;
    current.popup.remove();
    current.id = null;
  }

  // Renders the card synchronously so the popup measures its real size when it is placed.
  // Only called from map events and animation frames, never while React is committing.
  function openPopup(id: string, replay: boolean) {
    const map = mapRef.current;
    const current = popupRef.current;
    const load = placedRef.current.find((candidate) => candidate.id === id);
    if (!map || !current || !overviewRef.current || !load) return;
    flushSync(() => current.root.render(<LanePopover load={load} />));
    current.id = id;
    // Re-adding replays the entrance, which marks a new selection.
    if (replay || !current.popup.isOpen()) current.popup.setLngLat(load.truck).addTo(map);
    else current.popup.setLngLat(load.truck);
  }

  useEffect(() => {
    placedRef.current = placed;
    loadsKeyRef.current = loadsKey;
    const map = mapRef.current;
    if (!map) return;
    syncMarkers(map, placed);
    const current = popupRef.current;
    if (current?.id) {
      const load = placed.find((candidate) => candidate.id === current.id);
      if (load) {
        current.root.render(<LanePopover load={load} />);
        current.popup.setLngLat(load.truck);
      } else closePopup();
    }
    if (!map.getSource("lane-arcs")) return;
    draw(map, placed);
    // Refit only when the set of loads changes, not on every progress tick.
    if (fittedKey.current !== loadsKey) {
      fittedKey.current = loadsKey;
      fit(map, placed, overview);
    }
  }, [placed, loadsKey, overview]);

  // A pick from the list eases the camera to that lane and opens its card.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !overview) return;
    if (selectedId === null) {
      closePopup();
      return;
    }
    if (mapPick.current === selectedId) return;
    mapPick.current = null;
    const load = placedRef.current.find((candidate) => candidate.id === selectedId);
    if (!load) return;
    map.fitBounds(laneBounds([load]), { padding: framePadding(map, true), maxZoom: 6, duration: prefersReducedMotion() ? 0 : easeMs });
    const opening = requestAnimationFrame(() => openPopup(selectedId, true));
    return () => cancelAnimationFrame(opening);
  }, [selectedId, overview]);

  function syncMarkers(map: MapLibreMap, loads: Placed[]) {
    const seen = new Set<string>();
    const reduced = prefersReducedMotion();
    for (const load of loads) {
      seen.add(load.id);
      const existing = markers.current.get(load.id);
      if (existing) {
        truckState(existing.element, load);
        const at = existing.marker.getLngLat();
        if (at.lng === load.truck[0] && at.lat === load.truck[1]) continue;
        // A short transform transition while the poll moves the truck, so it glides to its new spot.
        // It is lifted afterwards so panning and zooming stay locked to the map.
        if (!reduced) {
          existing.element.classList.add("is-gliding");
          if (existing.glide) clearTimeout(existing.glide);
          existing.glide = setTimeout(() => {
            existing.element.classList.remove("is-gliding");
            existing.glide = null;
          }, glideMs);
        }
        existing.marker.setLngLat(load.truck);
        continue;
      }
      const element = document.createElement("div");
      element.className = "lane-truck";
      element.dataset.laneId = load.id;
      if (onSelectRef.current) {
        element.dataset.interactive = "true";
        element.tabIndex = 0;
        element.setAttribute("role", "button");
        element.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          mapPick.current = load.id;
          openPopup(load.id, true);
          onSelectRef.current?.(load.id);
        });
      }
      element.addEventListener("mouseenter", () => map.getSource("lane-arcs") && map.setFeatureState({ source: "lane-arcs", id: load.id }, { hover: true }));
      element.addEventListener("mouseleave", () => map.getSource("lane-arcs") && map.setFeatureState({ source: "lane-arcs", id: load.id }, { hover: false }));
      truckState(element, load);
      const root = createRoot(element);
      root.render(
        <span className="lane-truck__pill">
          <LuTruck aria-hidden />
        </span>,
      );
      const marker = new Marker({ element, anchor: "center" }).setLngLat(load.truck).addTo(map);
      markers.current.set(load.id, { marker, element, root, glide: null });
    }
    for (const [id, truck] of markers.current) {
      if (seen.has(id)) continue;
      if (truck.glide) clearTimeout(truck.glide);
      truck.marker.remove();
      unmountLater(truck.root);
      markers.current.delete(id);
    }
  }

  const reducedDuration = () => (prefersReducedMotion() ? 0 : 250);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" />
      {overview && wide && (
        <>
          <Legend loads={loads} />
          <Controls
            onZoomIn={() => mapRef.current?.zoomIn({ duration: reducedDuration() })}
            onZoomOut={() => mapRef.current?.zoomOut({ duration: reducedDuration() })}
            onFit={() => mapRef.current && fit(mapRef.current, placedRef.current, true, true)}
          />
        </>
      )}
    </div>
  );
}

function draw(map: MapLibreMap, placed: Placed[]) {
  const { arcs, points } = collections(placed);
  map.getSource<GeoJSONSource>("lane-arcs")?.setData(arcs);
  map.getSource<GeoJSONSource>("lane-ends")?.setData(points);
}
