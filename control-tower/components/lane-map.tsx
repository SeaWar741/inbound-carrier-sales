"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { type ExpressionSpecification, type GeoJSONSource, LngLatBounds, type LngLatBoundsLike, Map as MapLibreMap, type MapLayerMouseEvent, Popup, setWorkerUrl, type StyleSpecification } from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { arcPoints, type LngLat, placeZip, pointOnArc } from "@/lib/geo";

export type LaneMapLoad = {
  id: string;
  originZip: string;
  destinationZip: string;
  // Share of the trip covered, 0 at pickup and 1 at delivery.
  progress: number;
  status: "upcoming" | "in_transit" | "arrived";
  label: string;
};

// MapLibre cannot parse oklch, so these are the sRGB equivalents of the globals.css tokens.
const colors = {
  panel: "#ffffff", // --panel
  panelRaised: "#f4f5f6", // --panel-raised
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

const contiguousUs: LngLatBoundsLike = [
  [-125, 24],
  [-66.5, 49.5],
];
// Loose enough that a short container can still show the whole country.
const maxBounds: LngLatBoundsLike = [
  [-140, 15],
  [-50, 58],
];

type Placed = LaneMapLoad & { from: LngLat; to: LngLat; selected: boolean };

function place(loads: LaneMapLoad[], selectedId: string | null): Placed[] {
  const placed: Placed[] = [];
  for (const load of loads) {
    const from = placeZip(load.originZip);
    const to = placeZip(load.destinationZip);
    if (from && to) placed.push({ ...load, from, to, selected: load.id === selectedId });
  }
  // The selected load is drawn last so it sits on top.
  return placed.sort((a, b) => Number(a.selected) - Number(b.selected));
}

type Collection = GeoJSON.FeatureCollection<GeoJSON.Geometry, { id: string; label: string; selected: boolean; status: string; end?: "origin" | "destination" }>;

function collections(placed: Placed[]): { arcs: Collection; points: Collection } {
  const arcs: Collection = { type: "FeatureCollection", features: [] };
  const points: Collection = { type: "FeatureCollection", features: [] };
  for (const load of placed) {
    const properties = { id: load.id, label: load.label, selected: load.selected, status: load.status };
    arcs.features.push({ type: "Feature", properties, geometry: { type: "LineString", coordinates: arcPoints(load.from, load.to) } });
    points.features.push(
      { type: "Feature", properties: { ...properties, end: "origin" }, geometry: { type: "Point", coordinates: load.from } },
      { type: "Feature", properties: { ...properties, end: "destination" }, geometry: { type: "Point", coordinates: load.to } },
    );
  }
  return { arcs, points };
}

function trucks(placed: Placed[]): Collection {
  return {
    type: "FeatureCollection",
    features: placed.map((load) => ({
      type: "Feature",
      properties: { id: load.id, label: load.label, selected: load.selected, status: load.status },
      geometry: { type: "Point", coordinates: pointOnArc(load.from, load.to, load.progress) },
    })),
  };
}

// Turbopack rewrites MapLibre's own worker lookup to a hashed, wrong asset, so the worker and the
// shared chunk it imports are copied to public/maplibre by `npm run copy-worker` (predev, prebuild).
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

const clickable = ["lane-arcs", "lane-ends", "lane-trucks"];

function addLayers(map: MapLibreMap) {
  const empty: Collection = { type: "FeatureCollection", features: [] };
  map.addSource("lane-arcs", { type: "geojson", data: empty });
  map.addSource("lane-ends", { type: "geojson", data: empty });
  map.addSource("lane-trucks", { type: "geojson", data: empty });
  const selected: ExpressionSpecification = ["get", "selected"];
  map.addLayer({
    id: "lane-arcs",
    type: "line",
    source: "lane-arcs",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", selected, colors.accent, colors.fgFaint],
      "line-width": ["case", selected, 3, 1.5],
      "line-opacity": ["case", selected, 1, 0.7],
    },
  });
  map.addLayer({
    id: "lane-ends",
    type: "circle",
    source: "lane-ends",
    paint: {
      "circle-radius": ["case", selected, 5, 3.5],
      // Origin filled, destination hollow, as on the lane text.
      "circle-color": ["case", ["==", ["get", "end"], "origin"], ["case", selected, colors.accent, colors.fgFaint], colors.panel],
      "circle-stroke-color": ["case", selected, colors.accent, colors.fgFaint],
      "circle-stroke-width": ["case", ["==", ["get", "end"], "origin"], 0, ["case", selected, 2, 1.5]],
    },
  });
  map.addLayer({
    id: "lane-trucks",
    type: "circle",
    source: "lane-trucks",
    paint: {
      "circle-radius": ["case", selected, 7, 5],
      "circle-color": ["match", ["get", "status"], "in_transit", colors.accent, "arrived", colors.ok, colors.fgFaint],
      "circle-stroke-color": colors.panel,
      "circle-stroke-width": 2,
    },
  });
}

function fit(map: MapLibreMap, placed: Placed[]) {
  if (placed.length === 0) {
    map.fitBounds(contiguousUs, { padding: 16, animate: false });
    return;
  }
  const bounds = new LngLatBounds();
  for (const load of placed) {
    // The arc bows off the straight line, so its midpoint joins the bounds too.
    bounds.extend(load.from).extend(load.to).extend(pointOnArc(load.from, load.to, 0.5));
  }
  map.fitBounds(bounds, { padding: 40, maxZoom: 6, animate: false });
}

export function LaneMap({
  loads,
  selectedId,
  onSelect,
}: {
  loads: LaneMapLoad[];
  selectedId: string | null;
  onSelect?: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // The latest props, read by the map's own events (style load, click) without recreating it.
  const placedRef = useRef<Placed[]>([]);
  const onSelectRef = useRef(onSelect);
  const fittedKey = useRef<string | null>(null);

  const placed = useMemo(() => place(loads, selectedId), [loads, selectedId]);
  const loadsKey = placed.map((load) => load.id).sort().join(",");
  const loadsKeyRef = useRef(loadsKey);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

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
    const popup = new Popup({ closeButton: false, offset: 10 });

    // Each style (tiles or fallback) starts empty, so our layers are added on every style load.
    map.on("style.load", () => {
      styleLoaded = true;
      addLayers(map);
      draw(map, placedRef.current);
      fit(map, placedRef.current);
      fittedKey.current = loadsKeyRef.current;
    });
    map.on("error", (event) => {
      if (styleLoaded || fallback) return;
      fallback = true;
      console.warn("Map style failed to load, drawing lanes on a plain background", event.error);
      map.setStyle(fallbackStyle, { diff: false });
    });

    const onClick = (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const { id, label } = feature.properties as { id: string; label: string };
      popup.setLngLat(event.lngLat).setText(label).addTo(map);
      onSelectRef.current?.(id);
    };
    const pointer = () => (map.getCanvas().style.cursor = "pointer");
    const arrow = () => (map.getCanvas().style.cursor = "");
    for (const layer of clickable) {
      map.on("click", layer, onClick);
      map.on("mouseenter", layer, pointer);
      map.on("mouseleave", layer, arrow);
    }

    return () => {
      popup.remove();
      map.remove();
      mapRef.current = null;
      fittedKey.current = null;
    };
  }, []);

  useEffect(() => {
    placedRef.current = placed;
    loadsKeyRef.current = loadsKey;
    const map = mapRef.current;
    if (!map?.getSource("lane-arcs")) return;
    draw(map, placed);
    // Refit only when the set of loads changes, not on every progress tick.
    if (fittedKey.current !== loadsKey) {
      fittedKey.current = loadsKey;
      fit(map, placed);
    }
  }, [placed, loadsKey]);

  return <div ref={container} className="h-full w-full" />;
}

function draw(map: MapLibreMap, placed: Placed[]) {
  const { arcs, points } = collections(placed);
  map.getSource<GeoJSONSource>("lane-arcs")?.setData(arcs);
  map.getSource<GeoJSONSource>("lane-ends")?.setData(points);
  map.getSource<GeoJSONSource>("lane-trucks")?.setData(trucks(placed));
}
