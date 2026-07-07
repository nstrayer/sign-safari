// Map setup: basemap, heatmap/circle cross-fade, biz + badge layers, tap handling.

import maplibregl from "maplibre-gl";
import type {
  ExpressionSpecification,
  FilterSpecification,
  Map as MapLibreMap,
  MapGeoJSONFeature,
  PointLike,
} from "maplibre-gl";
import type { Kind, LonLat, SignCollection, SignProps, TappedFeature } from "./types";

const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
// Swap in if OpenFreeMap is ever down:
const CARTO_FALLBACK_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

const COLORS = {
  unseen: "#e8704a",
  seen: "#43a860",
  biz: "#5bc2f0",
  badge: "#ffb43b",
};

// Heatmap fades out / circles fade in across this zoom band.
const FADE_START = 13.5;
const FADE_END = 15;

interface SignMapOptions {
  container: string;
  onFeatureTap: (feature: TappedFeature) => void;
  onMapTap: () => void;
}

export interface SignMap {
  map: MapLibreMap;
  onLoad(fn: () => void): void;
  addLayers(data: { signs: SignCollection; biz: SignCollection; badges: SignCollection }): void;
  setSeen(id: string, isSeen: boolean): void;
  applySeen(ids: string[]): void;
  setHideSeen(hide: boolean, seenIds: string[]): void;
  setLayerVisible(layerId: string, visible: boolean): void;
  flyTo(coords: LonLat, zoom?: number): void;
}

// The one loosely-typed edge of MapLibre: rendered features come back with
// untyped properties and a broad geometry union, but every tappable layer is
// one of our own point sources, so the narrowing here is a formality.
function toTapped(f: MapGeoJSONFeature): TappedFeature {
  const props = f.properties as SignProps;
  const kind: Kind = f.layer.id === "biz-pts" ? "biz" : f.layer.id === "badge-pts" ? "badge" : "sign";
  if (f.geometry.type !== "Point") throw new Error(`Non-point feature in ${f.layer.id}`);
  return { id: props.id, kind, props, coords: f.geometry.coordinates as LonLat };
}

export function createSignMap({ container, onFeatureTap, onMapTap }: SignMapOptions): SignMap {
  const map = new maplibregl.Map({
    container,
    style: OPENFREEMAP_STYLE,
    center: [-83.743, 42.278],
    zoom: 12,
    maxBounds: [[-84.25, 42.0], [-83.35, 42.55]],
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    }),
    "top-right"
  );

  let styleFailedOver = false;
  map.on("error", (e) => {
    // Fall back to CARTO if the OpenFreeMap style itself fails to load.
    if (!styleFailedOver && !map.isStyleLoaded() && e.error && /style/i.test(String(e.error.message))) {
      styleFailedOver = true;
      map.setStyle(CARTO_FALLBACK_STYLE);
    }
  });

  const seenExpr: ExpressionSpecification = ["boolean", ["feature-state", "seen"], false];

  function addLayers({ signs, biz, badges }: { signs: SignCollection; biz: SignCollection; badges: SignCollection }): void {
    map.addSource("signs", { type: "geojson", data: signs, promoteId: "id" });
    map.addSource("biz", { type: "geojson", data: biz, promoteId: "id" });
    map.addSource("badges", { type: "geojson", data: badges, promoteId: "id" });

    map.addLayer({
      id: "signs-heat",
      type: "heatmap",
      source: "signs",
      maxzoom: FADE_END,
      paint: {
        "heatmap-weight": 1,
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 15, 2.2],
        "heatmap-radius": ["interpolate", ["exponential", 1.5], ["zoom"], 10, 9, 13, 22, 15, 40],
        "heatmap-color": [
          "interpolate", ["linear"], ["heatmap-density"],
          0, "rgba(255, 209, 102, 0)",
          0.2, "#ffd166",
          0.45, "#ffb43b",
          0.7, "#e8704a",
          1, "#d62246",
        ],
        "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], FADE_START, 0.85, FADE_END, 0],
      },
    });

    map.addLayer({
      id: "signs-pts",
      type: "circle",
      source: "signs",
      minzoom: 13,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 4, 17, 11],
        "circle-color": ["case", seenExpr, COLORS.seen, COLORS.unseen],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], FADE_START, 0, FADE_END, 1],
        "circle-stroke-opacity": ["interpolate", ["linear"], ["zoom"], FADE_START, 0, FADE_END, 1],
      },
    });

    map.addLayer({
      id: "biz-pts",
      type: "circle",
      source: "biz",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4.5, 17, 12],
        "circle-color": ["case", seenExpr, COLORS.seen, COLORS.biz],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });

    map.addLayer({
      id: "badge-pts",
      type: "circle",
      source: "badges",
      layout: { visibility: "none" },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 5, 17, 12],
        "circle-color": COLORS.badge,
        "circle-stroke-color": "#2f3061",
        "circle-stroke-width": 2,
      },
    });

    // Soften the basemap so it reads as bespoke: teal-tinted water, calmer labels.
    for (const layer of map.getStyle().layers) {
      if (layer.id.includes("water") && layer.type === "fill") {
        try { map.setPaintProperty(layer.id, "fill-color", "#cfe6ec"); } catch {}
      }
    }

    const tappable = ["signs-pts", "biz-pts", "badge-pts"];

    map.on("click", (e) => {
      const pad = 8;
      const box: [PointLike, PointLike] = [
        [e.point.x - pad, e.point.y - pad],
        [e.point.x + pad, e.point.y + pad],
      ];
      const hits = map.queryRenderedFeatures(box, { layers: tappable });
      if (hits.length) {
        onFeatureTap(toTapped(hits[0]));
      } else {
        onMapTap();
      }
    });

    for (const layerId of tappable) {
      map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
    }
  }

  function sourceFor(id: string): string {
    return id.startsWith("biz-") ? "biz" : "signs";
  }

  return {
    map,
    onLoad(fn) { map.on("load", fn); },
    addLayers,
    setSeen(id, isSeen) {
      map.setFeatureState({ source: sourceFor(id), id }, { seen: isSeen });
    },
    applySeen(ids) {
      for (const id of ids) this.setSeen(id, true);
    },
    // feature-state can't drive filters, so hide-seen uses a literal id list.
    setHideSeen(hide, seenIds) {
      const homeIds = seenIds.filter((id) => !id.startsWith("biz-"));
      const bizIds = seenIds.filter((id) => id.startsWith("biz-"));
      const filterFor = (ids: string[]): FilterSpecification | undefined =>
        hide && ids.length ? ["!", ["in", ["get", "id"], ["literal", ids]]] : undefined;
      map.setFilter("signs-pts", filterFor(homeIds));
      map.setFilter("signs-heat", filterFor(homeIds));
      map.setFilter("biz-pts", filterFor(bizIds));
    },
    setLayerVisible(layerId, visible) {
      map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    },
    flyTo(coords, zoom = 16.5) {
      map.flyTo({ center: coords, zoom, essential: true });
    },
  };
}
