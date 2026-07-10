// Map setup: basemap, heatmap/circle cross-fade, biz + badge layers, tap handling.

import maplibregl from "maplibre-gl";
import type {
  ExpressionSpecification,
  Map as MapLibreMap,
  MapGeoJSONFeature,
  PointLike,
} from "maplibre-gl";
import { isBizId, isMySignId } from "./ids";
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
  onAddSignTap: () => void;
}

export interface SignMap {
  map: MapLibreMap;
  onLoad(fn: () => void): void;
  addLayers(data: { signs: SignCollection; biz: SignCollection; badges: SignCollection }): void;
  setMySigns(signs: { id: string; coords: LonLat }[]): void;
  setSeen(id: string, isSeen: boolean): void;
  applySeen(ids: string[]): void;
  setHeatmapVisible(visible: boolean): void;
  flyTo(coords: LonLat, zoom?: number): void;
  /** True if coords fall inside the map's panning bounds. */
  inBounds(coords: LonLat): boolean;
  center(): LonLat;
  showPin(coords: LonLat): void;
  pinPosition(): LonLat;
  hidePin(): void;
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

// "+pin" button that sits with the other top-right map controls.
class AddSignControl implements maplibregl.IControl {
  private container?: HTMLElement;
  constructor(private onTap: () => void) {}
  onAdd(): HTMLElement {
    this.container = document.createElement("div");
    this.container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = "Add a missing sign";
    btn.setAttribute("aria-label", "Add a missing sign");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" style="display:block;margin:auto" aria-hidden="true">' +
      '<path d="M12 21.5S5.5 15.6 5.5 10.5a6.5 6.5 0 1 1 13 0c0 5.1-6.5 11-6.5 11z" fill="none" stroke="#333" stroke-width="2"/>' +
      '<path d="M12 7.5v6M9 10.5h6" fill="none" stroke="#333" stroke-width="2" stroke-linecap="round"/></svg>';
    btn.addEventListener("click", () => this.onTap());
    this.container.appendChild(btn);
    return this.container;
  }
  onRemove(): void {
    this.container?.remove();
  }
}

const MAX_BOUNDS: [LonLat, LonLat] = [[-84.25, 42.0], [-83.35, 42.55]];

export function createSignMap({ container, onFeatureTap, onMapTap, onAddSignTap }: SignMapOptions): SignMap {
  const map = new maplibregl.Map({
    container,
    style: OPENFREEMAP_STYLE,
    center: [-83.743, 42.278],
    zoom: 12,
    maxBounds: MAX_BOUNDS,
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
  map.addControl(new AddSignControl(onAddSignTap), "top-right");

  let pin: maplibregl.Marker | undefined;

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
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 5, 17, 12],
        "circle-color": COLORS.badge,
        "circle-stroke-color": "#2f3061",
        "circle-stroke-width": 2,
      },
    });

    // Signs the user placed themselves: navy stroke marks them as unofficial.
    map.addSource("mine", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "id" });
    map.addLayer({
      id: "my-pts",
      type: "circle",
      source: "mine",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4.5, 17, 12],
        "circle-color": ["case", seenExpr, COLORS.seen, COLORS.unseen],
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

    const tappable = ["signs-pts", "biz-pts", "badge-pts", "my-pts"];

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
    return isBizId(id) ? "biz" : isMySignId(id) ? "mine" : "signs";
  }

  return {
    map,
    onLoad(fn) { map.on("load", fn); },
    addLayers,
    setSeen(id, isSeen) {
      map.setFeatureState({ source: sourceFor(id), id }, { seen: isSeen });
    },
    applySeen(ids) {
      for (const id of ids) {
        map.setFeatureState({ source: sourceFor(id), id }, { seen: true });
      }
    },
    setHeatmapVisible(visible) {
      map.setLayoutProperty("signs-heat", "visibility", visible ? "visible" : "none");
    },
    setMySigns(signs) {
      // Before addLayers has run (style still loading) there is nothing to
      // update, and setFeatureState would throw; onLoad syncs again anyway.
      const src = map.getSource<maplibregl.GeoJSONSource>("mine");
      if (!src) return;
      src.setData({
        type: "FeatureCollection",
        features: signs.map(({ id, coords }) => ({
          type: "Feature",
          id,
          geometry: { type: "Point", coordinates: coords },
          properties: { id },
        })),
      });
      for (const { id } of signs) this.setSeen(id, true);
    },
    flyTo(coords, zoom = 16.5) {
      map.flyTo({ center: coords, zoom, essential: true });
    },
    inBounds([lon, lat]) {
      const [[w, s], [e, n]] = MAX_BOUNDS;
      return lon >= w && lon <= e && lat >= s && lat <= n;
    },
    center() {
      const c = map.getCenter();
      return [c.lng, c.lat];
    },
    showPin(coords) {
      pin ??= new maplibregl.Marker({ draggable: true, color: COLORS.unseen });
      pin.setLngLat(coords).addTo(map);
    },
    pinPosition() {
      if (!pin) throw new Error("No pin shown");
      const p = pin.getLngLat();
      return [p.lng, p.lat];
    },
    hidePin() {
      pin?.remove();
    },
  };
}
