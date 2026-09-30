"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { type ExpressionSpecification, type GeoJSONSource, Map as MapLibreMap, type MapLayerMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import { colors, contiguousUs, fallbackStyle, maxBounds, quietBasemap, styleUrl } from "@/components/lane-map";
import { stateCentroids } from "@/lib/geo";

export type StateCount = { state: string; count: number };

// MapLibre cannot parse oklch: ok is the lane map's green; warn is the sRGB of the --warn token.
const toneColors = { ok: colors.ok, warn: "#ef720d" };

type StateProperties = { state: string; count: number; radius: number; selected: boolean };

const minRadius = 5;
const maxRadius = 16;

function features(counts: StateCount[], selected: string | null): GeoJSON.FeatureCollection<GeoJSON.Point, StateProperties> {
  const max = Math.max(1, ...counts.map((row) => row.count));
  const placed = counts.flatMap(({ state, count }) => {
    const at = stateCentroids[state];
    if (!at || count <= 0) return [];
    // Area, not radius, grows with the count, so a state with twice the carriers does not read as four times.
    const radius = minRadius + (maxRadius - minRadius) * Math.sqrt(count / max);
    return [{ type: "Feature" as const, properties: { state, count, radius, selected: state === selected }, geometry: { type: "Point" as const, coordinates: at } }];
  });
  // The selected state is drawn last so its ring sits on top.
  placed.sort((a, b) => Number(a.properties.selected) - Number(b.properties.selected));
  return { type: "FeatureCollection", features: placed };
}

const isSelected: ExpressionSpecification = ["get", "selected"];

// One circle per state sized by its count; a click picks the state. The base map is the dashboard's.
export function StateMap({
  counts,
  selected,
  onSelect,
  tone,
  label,
  unit,
}: {
  counts: StateCount[];
  selected: string | null;
  onSelect: (state: string) => void;
  tone: keyof typeof toneColors;
  // Names the map for screen readers.
  label: string;
  // What the count counts, for the hover title ("carrier").
  unit: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const data = useMemo(() => features(counts, selected), [counts, selected]);
  // The latest props, read by the map's own events without recreating it.
  const dataRef = useRef(data);
  const onSelectRef = useRef(onSelect);
  const unitRef = useRef(unit);

  useEffect(() => {
    dataRef.current = data;
    onSelectRef.current = onSelect;
    unitRef.current = unit;
    (mapRef.current?.getSource("states") as GeoJSONSource | undefined)?.setData(data);
  }, [data, onSelect, unit]);

  useEffect(() => {
    if (!container.current) return;
    const color = toneColors[tone];
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
      // The map sits in a scrolling page; the wheel scrolls the page, not the map.
      scrollZoom: false,
      attributionControl: { compact: true },
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    mapRef.current = map;
    map.once("load", () => {
      map.getContainer().querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    });

    let styleLoaded = false;
    let fallback = false;
    // Each style (tiles or fallback) starts empty, so the circles are added on every style load.
    map.on("style.load", () => {
      styleLoaded = true;
      quietBasemap(map);
      map.addSource("states", { type: "geojson", data: dataRef.current });
      map.addLayer({
        id: "state-circles",
        type: "circle",
        source: "states",
        paint: {
          "circle-radius": ["get", "radius"],
          "circle-color": color,
          "circle-opacity": ["case", isSelected, 0.95, 0.7],
          "circle-stroke-color": ["case", isSelected, colors.panel, color],
          "circle-stroke-width": ["case", isSelected, 3, 1],
        },
      });
      // The ring around the selected state, outside the white gap.
      map.addLayer({
        id: "state-selected",
        type: "circle",
        source: "states",
        filter: ["==", isSelected, true],
        paint: {
          "circle-radius": ["+", ["get", "radius"], 3],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": color,
          "circle-stroke-width": 2,
        },
      });
    });
    map.on("error", (event) => {
      if (styleLoaded || fallback) return;
      fallback = true;
      console.warn("Map style failed to load, drawing states on a plain background", event.error);
      map.setStyle(fallbackStyle, { diff: false });
    });

    const canvas = map.getCanvas();
    map.on("mousemove", "state-circles", (event: MapLayerMouseEvent) => {
      const properties = event.features?.[0]?.properties as StateProperties | undefined;
      canvas.style.cursor = "pointer";
      canvas.title = properties ? `${properties.state}: ${properties.count} ${properties.count === 1 ? unitRef.current : `${unitRef.current}s`}` : "";
    });
    map.on("mouseleave", "state-circles", () => {
      canvas.style.cursor = "";
      canvas.title = "";
    });
    map.on("click", "state-circles", (event: MapLayerMouseEvent) => {
      const state = (event.features?.[0]?.properties as StateProperties | undefined)?.state;
      if (state) onSelectRef.current(state);
    });

    // The side panel can settle after the map is created, so each size change refits the country.
    const element = container.current;
    let sizing = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(sizing);
      sizing = requestAnimationFrame(() => {
        if (element.clientWidth === 0 || element.clientHeight === 0) return;
        map.resize();
        map.fitBounds(contiguousUs, { padding: 8, duration: 0 });
      });
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(sizing);
      map.remove();
      mapRef.current = null;
    };
  }, [tone]);

  return <div ref={container} role="region" aria-label={label} className="h-full w-full" />;
}
