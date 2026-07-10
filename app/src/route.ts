// Route planner: network-style view of the street graph with every routeable
// lawn sign and business-code location as a node, plus greedy + 2-opt routing
// along real streets.
//
// Data comes from data/network.json (built by scripts/build_network.py):
//   nodes: [lon0, lat0, lon1, lat1, ...]
//   edges: [a, b, meters, ...] as node indices
//   stops: [{ id, addr, kind, n }] where n indexes nodes
//
// The tab walks through a tiny wizard: pick a start (geolocation, address
// search, or tapping a stop), pick a distance or stop-count budget, get an
// optimized route drawn on the network plus a GPX export for watches.
//
// All routing runs client-side via the pure algorithm core in ./optimizer;
// this module owns the DOM: canvas rendering, the wizard, and walkthrough
// mode.

import maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";
import { dataUrl } from "./data";
import { el, svgEl } from "./dom";
import { createGeocoder } from "./geocoder";
import { restoreStopIndices } from "./route-share";
import {
  MIN_PER_KM,
  DEG_M,
  buildGraph,
  makeDijkstraCache,
  makeRows,
  greedyExtend,
  routeTotals,
  buildCandidates,
  twoOptSteps,
  legsForOrder,
  sweepOnRoute,
  wiggleExtend,
  edgeCoordinates,
  pathCoordinates,
  pathMeters,
} from "./optimizer";
import type { Graph, Shortest } from "./optimizer";
import type { LonLat, NetworkData, NetworkStop } from "./types";
import type { DistanceUnit, Store } from "./store";

const COLORS = {
  street: "#c9cdd4",
  connector: "#e4e2d8",
  unseen: "#e8704a",
  seen: "#43a860",
  biz: "#5bc2f0",
  route: "#2f3061",
  seed: "#ffb43b",
};

const ROUTE_BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
const ROUTE_BASEMAP_FALLBACK_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

/** Screen-space route-stop dots on the route canvas (see draw()). */
const STOP_DOT = {
  minRadiusPx: 2.5,
  maxRadiusPx: 7,
  /** radius = view.scale / radiusScaleDivisor, clamped to [min, max] px */
  radiusScaleDivisor: 2400,
  minAlpha: 0.3,
  alphaRange: 0.7,
  /** Alpha ramp starts once scale exceeds fitScale × this factor. */
  alphaZoomStart: 2.5,
  /** fitScale multiples over which alpha ramps from minAlpha to 1. */
  alphaZoomSpan: 4,
} as const;

/** Derived route-stop render values for a given view scale. */
function computeStopDotMetrics(scale: number, fitScale: number): { radiusPx: number; alpha: number } {
  const zoomRatio = scale / fitScale;
  const radiusPx = Math.max(
    STOP_DOT.minRadiusPx,
    Math.min(STOP_DOT.maxRadiusPx, scale / STOP_DOT.radiusScaleDivisor),
  );
  const alphaProgress = Math.max(0, zoomRatio - STOP_DOT.alphaZoomStart) / STOP_DOT.alphaZoomSpan;
  const alpha = Math.min(1, STOP_DOT.minAlpha + STOP_DOT.alphaRange * alphaProgress);
  return { radiusPx, alpha };
}

/** Meters in one mile (international). */
const M_PER_MI = 1609.344;

/** Distance-budget slider range in the active display unit. */
const DISTANCE_SLIDER = {
  km: { min: 0.5, max: 15, step: 0.5, def: 3 },
  mi: { min: 0.5, max: 10, step: 0.5, def: 2 },
} as const;

// ---------- Walkthrough helpers ----------

/**
 * Format a meter distance for display in the preferred unit.
 * Short legs stay in meters/feet; longer ones use km/mi.
 *
 * @param m - Distance in meters
 * @param unit - Preferred large-distance unit
 * @returns Human-readable distance string
 *
 * @example
 * fmtMeters(120, 'km') // "120 m"
 * fmtMeters(3200, 'mi') // "2.0 mi"
 */
function fmtMeters(m: number, unit: DistanceUnit): string {
  if (unit === 'mi') {
    if (m < 500) return `${Math.max(10, Math.round(m * 3.28084 / 10) * 10)} ft`;
    return `${(m / M_PER_MI).toFixed(1)} mi`;
  }
  return m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * Format a large route distance (always km or mi, never m/ft).
 *
 * @param m - Distance in meters
 * @param unit - Preferred display unit
 * @returns e.g. "3.2 km" or "2.0 mi"
 */
function fmtRouteKm(m: number, unit: DistanceUnit): string {
  if (unit === 'mi') return `${(m / M_PER_MI).toFixed(1)} mi`;
  return `${(m / 1000).toFixed(1)} km`;
}

function stopKindLabel(stop: NetworkStop): string {
  return stop.kind === "biz" ? "Business code" : "Lawn sign";
}

// Coarse compass direction for a world-coord delta (x east, y north).
function compassDir(dx: number, dy: number): string {
  const names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return names[Math.round(((deg + 360) % 360) / 45) % 8];
}

// ---------- View ----------

type Seed = { node: number; label: string; isStop: boolean };
type ActiveRoute = { stopIndices: number[]; totalMeters: number; pathNodes: number[]; shown?: number };

// Address-search result rows: either a route-stop match or a geocoded place.
type AddrItem =
  | { label: string; sub?: string; stop: NetworkStop; coords?: undefined }
  | { label: string; sub?: string; stop?: undefined; coords: LonLat };

export interface RoutePlanner {
  load(): Promise<void>;
  show(): void;
  hide(): void;
}

export function createRoutePlanner({ store, showToast }: { store: Store; showToast: (msg: string) => void }): RoutePlanner {
  const els = {
    view: el("routeView"),
    basemap: el("routeBasemap"),
    canvas: el<HTMLCanvasElement>("routeCanvas"),
    hint: el("routeHint"),
    drawer: el("routeDrawer"),
    drawerBar: el("drawerBar"),
    drawerTitle: el("drawerTitle"),
    loading: el("routeLoading"),
    stepIntro: el("stepIntro"),
    stepStart: el("stepStart"),
    stepPlan: el("stepPlan"),
    introGo: el("introGo"),
    useLocation: el<HTMLButtonElement>("useLocation"),
    addrInput: el<HTMLInputElement>("addrInput"),
    addrResults: el("addrResults"),
    seedLabel: el("seedLabel"),
    changeStart: el("changeStart"),
    modeDistance: el("modeDistance"),
    modeCount: el("modeCount"),
    slider: el<HTMLInputElement>("budgetSlider"),
    budgetLabel: el<HTMLButtonElement>("budgetLabel"),
    skipSeen: el<HTMLInputElement>("skipSeen"),
    loopBack: el<HTMLInputElement>("loopBack"),
    fullSpeed: el<HTMLInputElement>("fullSpeed"),
    createRoute: el<HTMLButtonElement>("createRoute"),
    createRouteIcon: svgEl("createRouteIcon"),
    createRouteLabel: el("createRouteLabel"),
    summary: el("routeSummary"),
    actions: el("routeActions"),
    exportGpx: el("exportGpx"),
    shareRoute: el<HTMLButtonElement>("shareRoute"),
    stopsToggle: el<HTMLButtonElement>("stopsToggle"),
    stops: el("routeStops"),
    walkStart: el<HTMLButtonElement>("walkStart"),
    stepWalk: el("stepWalk"),
    walkProgress: el("walkProgress"),
    walkAddr: el("walkAddr"),
    walkDist: el("walkDist"),
    walkActions: el("walkActions"),
    walkDone: el<HTMLButtonElement>("walkDone"),
    walkSkip: el<HTMLButtonElement>("walkSkip"),
    walkCodeEntry: el("walkCodeEntry"),
    walkCodeInput: el<HTMLInputElement>("walkCodeInput"),
    walkCodeSave: el<HTMLButtonElement>("walkCodeSave"),
    walkCodeSkip: el<HTMLButtonElement>("walkCodeSkip"),
    walkEnd: el<HTMLButtonElement>("walkEnd"),
  };
  const ctx2d = els.canvas.getContext("2d");
  if (!ctx2d) throw new Error("no 2d context");
  const ctx = ctx2d; // non-null binding so closures below see it narrowed

  let graph: Graph | null = null;
  let shortest: Shortest | null = null;
  let streetsPath: Path2D | null = null; // Path2D in world coords
  let connectorsPath: Path2D | null = null; // location-access stubs, drawn fainter than roads
  let loadPromise: Promise<void> | null = null;
  let basemap: MapLibreMap | null = null;
  let basemapFailedOver = false;

  // View state: world center + pixels per world unit.
  const view = { cx: 0, cy: 0, scale: 1, fitScale: 1 };
  let seed: Seed | null = null; // { node, label, isStop }
  let route: ActiveRoute | null = null;
  let routePath: Path2D | null = null; // Path2D in world coords
  let race: { path: Path2D; color: string; alpha: number }[] | null = null; // [{ path, color, alpha }] while candidate routes race
  let mode: "distance" | "count" = "distance"; // or "count"
  /** Preferred large-distance unit; persisted via store settings. */
  let distanceUnit: DistanceUnit = store.settings().distanceUnit;
  let needsDraw = false;

  // Walkthrough mode: `at` indexes the next leg to walk (legs run one per
  // stop, plus the leg home when looping, matching legsForOrder).
  let walk: { at: number; legs: number[][] } | null = null;
  let enteringCode = false;
  let walkLegPath: Path2D | null = null; // current leg, drawn bold
  let herePos: { x: number; y: number } | null = null; // GPS fix in world coords
  let geoWatch: number | null = null;
  let wakeLock: WakeLockSentinel | null = null;

  // ---------- Drawer (mobile bottom sheet; inert as a docked card on wide) ----------

  function setDrawer(open: boolean) {
    els.drawer.classList.toggle("open", open);
    els.drawerBar.setAttribute("aria-expanded", String(open));
  }
  const drawerOpen = () => els.drawer.classList.contains("open");

  els.drawerBar.addEventListener("click", () => setDrawer(!drawerOpen()));
  els.drawerBar.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    setDrawer(!drawerOpen());
  });

  // Swipe up/down on the bar (same simple pattern as the detail sheet).
  let barTouchY: number | null = null;
  els.drawerBar.addEventListener("touchstart", (e) => { barTouchY = e.touches[0].clientY; }, { passive: true });
  els.drawerBar.addEventListener("touchend", (e) => {
    if (barTouchY === null) return;
    const dy = e.changedTouches[0].clientY - barTouchY;
    barTouchY = null;
    if (dy > 30) setDrawer(false);
    else if (dy < -30) setDrawer(true);
  }, { passive: true });

  // ---------- Wizard steps ----------

  const STEP_TITLES: Record<"intro" | "start", string> = { intro: "Plan a route", start: "Where are you starting?" };

  function setStep(step: "intro" | "start" | "plan" | "walk") {
    els.stepIntro.hidden = step !== "intro";
    els.stepStart.hidden = step !== "start";
    els.stepPlan.hidden = step !== "plan";
    els.stepWalk.hidden = step !== "walk";
    els.hint.hidden = step === "intro";
    if (step === "start") els.hint.textContent = "You can also just tap a route stop";
    if (step === "plan" && seed) els.hint.textContent = `Starting at ${seed.label}`;
    // Intro/start need their controls; the plan step manages the drawer
    // itself (rebuild collapses it so the build animation gets the map),
    // and the walk step keeps it open with its own title.
    if (step === "intro" || step === "start") {
      els.drawerTitle.textContent = STEP_TITLES[step];
      setDrawer(true);
    }
  }

  function currentStep() {
    if (!els.stepIntro.hidden) return "intro";
    if (!els.stepStart.hidden) return "start";
    if (!els.stepWalk.hidden) return "walk";
    return "plan";
  }

  /**
   * Enter the plan step with a new start. Settings stay editable; the user
   * taps Create route when ready (no auto-build).
   *
   * @param next - Starting node and label from map tap, GPS, or address search
   */
  function setSeed(next: Seed) {
    seed = next;
    els.seedLabel.textContent = seed.label;
    store.setRouteIntroSeen();
    // Drop any in-flight or previous route so the map matches the new start.
    buildGen++;
    route = null;
    routePath = null;
    race = null;
    setBuilding(false);
    els.summary.hidden = true;
    els.actions.hidden = true;
    els.walkStart.hidden = true;
    els.stops.hidden = true;
    els.createRoute.hidden = false;
    setCreateRouteUi("create");
    setStep("plan");
    els.drawerTitle.textContent = "Set your budget, then create";
    setDrawer(true);
    scheduleDraw();
  }

  els.introGo.addEventListener("click", () => {
    store.setRouteIntroSeen();
    setStep("start");
  });

  els.changeStart.addEventListener("click", () => {
    buildGen++;
    seed = null;
    route = null;
    routePath = null;
    race = null;
    setBuilding(false);
    setStep("start");
    scheduleDraw();
  });

  // ---------- Loading ----------

  function load(): Promise<void> {
    if (!loadPromise) {
      loadPromise = fetch(dataUrl("network.json"))
        .then((res) => {
          if (!res.ok) throw new Error(`network.json: ${res.status}`);
          return res.json() as Promise<NetworkData>;
        })
        .then((raw) => {
          graph = buildGraph(raw);
          shortest = makeDijkstraCache(graph);
          // Route-stop nodes are leaves hanging off the road network via short
          // access edges (see build_network.py); split those out so they
          // don't read as streets.
          const stopNodes = new Set(graph.stops.map((stop) => stop.n));
          streetsPath = new Path2D();
          connectorsPath = new Path2D();
          for (let e = 0; e < graph.edgeCount; e++) {
            const a = graph.edges[e * 3], b = graph.edges[e * 3 + 1];
            const path = stopNodes.has(a) || stopNodes.has(b) ? connectorsPath : streetsPath;
            appendCoordinates(path, graph, edgeCoordinates(graph, a, b), true);
          }
          els.loading.hidden = true;
          fitToStops();
          scheduleDraw();
          applySharedRoute();
        })
        .catch((err) => {
          console.error(err);
          els.loading.textContent = "Couldn't load the street network. Check your connection and refresh.";
        });
    }
    return loadPromise;
  }

  function fitToStops() {
    if (!graph) return;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const stop of graph.stops) {
      const x = graph.xs[stop.n], y = graph.ys[stop.n];
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const w = els.canvas.clientWidth || innerWidth;
    const h = els.canvas.clientHeight || innerHeight;
    view.cx = (xMin + xMax) / 2;
    view.cy = (yMin + yMax) / 2;
    view.fitScale = 0.92 * Math.min(w / (xMax - xMin), h / (yMax - yMin));
    view.scale = view.fitScale;
    syncBasemap();
  }

  // Zoom to a path's full road geometry, framed in the canvas area the card
  // leaves free. maxZoom (in multiples of the whole-map fit) keeps short walk
  // legs from filling the screen with a single featureless block.
  function fitToCoordinates(coordinates: LonLat[], maxZoom = 200) {
    if (!graph || !coordinates.length) return;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [lon, lat] of coordinates) {
      const x = lon * graph.kx - graph.x0;
      const y = lat - graph.y0;
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    // On phones the drawer collapses to its bar along the bottom; on wide
    // screens the card sits on the right. Frame the route in what's left.
    const wide = matchMedia("(min-width: 720px)").matches;
    const headerPx = 136; // title card incl. the view switch pill
    const availW = wide ? w - 420 : w;
    // The drawer stays open during builds now, so measure however much of
    // it is actually showing (collapsed bar or open controls).
    const drawerPx = els.drawer.offsetHeight;
    const availH = wide ? h - headerPx - 24 : Math.max(h - headerPx - drawerPx - 16, 120);
    const spanX = Math.max(xMax - xMin, 1e-5), spanY = Math.max(yMax - yMin, 1e-5);
    view.scale = Math.min(0.85 * Math.min(availW / spanX, availH / spanY), view.fitScale * maxZoom);
    view.cx = (xMin + xMax) / 2 + (w / 2 - availW / 2) / view.scale;
    view.cy = (yMin + yMax) / 2 + (headerPx + availH / 2 - h / 2) / view.scale;
    syncBasemap();
  }

  // ---------- Rendering ----------

  function ensureBasemap(): void {
    if (basemap) return;
    basemap = new maplibregl.Map({
      container: els.basemap,
      style: ROUTE_BASEMAP_STYLE,
      center: [-83.743, 42.278],
      zoom: 12,
      interactive: false,
      attributionControl: { compact: true },
    });
    basemap.on("error", (e) => {
      if (!basemap || basemapFailedOver || basemap.isStyleLoaded()) return;
      if (e.error && /style/i.test(String(e.error.message))) {
        basemapFailedOver = true;
        basemap.setStyle(ROUTE_BASEMAP_FALLBACK_STYLE);
      }
    });
  }

  function syncBasemap(): void {
    if (!graph || !basemap) return;
    const lat = view.cy + graph.y0;
    const lon = (view.cx + graph.x0) / graph.kx;
    const z = Math.log2((view.scale * 360 * Math.cos(lat * Math.PI / 180)) / 512);
    basemap.jumpTo({
      center: [lon, lat],
      zoom: Math.max(10, Math.min(19.7, z)),
      bearing: 0,
      pitch: 0,
    });
  }

  function resize() {
    const dpr = devicePixelRatio || 1;
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    if (els.canvas.width !== w * dpr || els.canvas.height !== h * dpr) {
      els.canvas.width = w * dpr;
      els.canvas.height = h * dpr;
    }
    basemap?.resize();
    syncBasemap();
    scheduleDraw();
  }

  function toScreen(x: number, y: number): [number, number] {
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    return [(x - view.cx) * view.scale + w / 2, (view.cy - y) * view.scale + h / 2];
  }

  function scheduleDraw() {
    if (needsDraw) return;
    needsDraw = true;
    requestAnimationFrame(() => {
      needsDraw = false;
      draw();
    });
  }

  function drawBadge(sx: number, sy: number, text: string, fill: string, textFill: string, r = 10) {
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = textFill;
    ctx.font = `700 ${Math.round(r * 1.1)}px 'Nunito Sans', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, sx, sy + 0.5);
  }

  function draw() {
    if (!graph || !streetsPath || els.view.hidden) return;
    const dpr = devicePixelRatio || 1;
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    syncBasemap();

    // Streets (and the route) stroke in world coordinates.
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(view.scale, -view.scale);
    ctx.translate(-view.cx, -view.cy);
    if (connectorsPath) {
      ctx.lineWidth = 0.8 / view.scale;
      ctx.strokeStyle = COLORS.connector;
      ctx.setLineDash([3 / view.scale, 3 / view.scale]);
      ctx.stroke(connectorsPath);
      ctx.setLineDash([]);
    }
    ctx.lineWidth = 1.1 / view.scale;
    ctx.strokeStyle = COLORS.street;
    ctx.stroke(streetsPath);
    if (routePath) {
      ctx.lineWidth = 4 / view.scale;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = walk ? COLORS.unseen : COLORS.route;
      // Walking: light coral so the rest of the path reads against gray streets.
      if (walk) ctx.globalAlpha = 0.38;
      ctx.stroke(routePath);
      ctx.globalAlpha = 1;
      if (walk && walkLegPath) {
        ctx.lineWidth = 5 / view.scale;
        ctx.strokeStyle = COLORS.unseen;
        ctx.stroke(walkLegPath);
      }
    }
    ctx.restore();

    // Route stops in screen space so dot sizes stay honest across zooms. Zoomed
    // out the dots pile up, so they go translucent and fill one by one -
    // overlaps stack into a rough density map - ramping back to solid
    // (and a batched single fill) as the view zooms in.
    const { radiusPx: r, alpha: dotAlpha } = computeStopDotMetrics(view.scale, view.fitScale);
    const unseenSignPts: number[] = [];
    const unseenBusinessPts: number[] = [];
    const seenPts: number[] = [];
    for (const stop of graph.stops) {
      const [sx, sy] = toScreen(graph.xs[stop.n], graph.ys[stop.n]);
      if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
      if (store.isSeen(stop.id)) seenPts.push(sx, sy);
      else if (stop.kind === "biz") unseenBusinessPts.push(sx, sy);
      else unseenSignPts.push(sx, sy);
    }
    const fillDots = (pts: number[], color: string) => {
      ctx.fillStyle = color;
      if (dotAlpha >= 1) {
        const dots = new Path2D();
        for (let i = 0; i < pts.length; i += 2) {
          dots.moveTo(pts[i] + r, pts[i + 1]);
          dots.arc(pts[i], pts[i + 1], r, 0, Math.PI * 2);
        }
        ctx.fill(dots);
      } else {
        ctx.globalAlpha = dotAlpha;
        for (let i = 0; i < pts.length; i += 2) {
          ctx.beginPath();
          ctx.arc(pts[i], pts[i + 1], r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    };
    fillDots(seenPts, COLORS.seen);
    fillDots(unseenBusinessPts, COLORS.biz);
    fillDots(unseenSignPts, COLORS.unseen);

    // Racing candidate routes go above the dots, dashed differently per
    // candidate so overlapping stretches stay tellable-apart.
    if (race) {
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(view.scale, -view.scale);
      ctx.translate(-view.cx, -view.cy);
      const dashes: number[][] = [[], [10, 7], [5, 5], [2.5, 6]];
      race.forEach((c, i) => {
        if (c.alpha < 0.02) return;
        ctx.globalAlpha = c.alpha;
        ctx.lineWidth = (3.4 - i * 0.4) / view.scale;
        ctx.setLineDash(dashes[i % 4].map((d) => d / view.scale));
        ctx.lineJoin = "round";
        ctx.strokeStyle = c.color;
        ctx.stroke(c.path);
      });
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Start anchor, unless the first stop sits exactly on it. On the walk's
    // leg home it becomes the target, so it grows and goes coral.
    if (seed) {
      const walkingHome = !!walk && !!route && walk.at === route.stopIndices.length;
      const firstStopNode = route?.stopIndices.length ? graph.stops[route.stopIndices[0]].n : -1;
      if (firstStopNode !== seed.node || walkingHome) {
        const [sx, sy] = toScreen(graph.xs[seed.node], graph.ys[seed.node]);
        if (walkingHome) drawBadge(sx, sy, "S", COLORS.unseen, "#fff", 13);
        else drawBadge(sx, sy, "S", COLORS.seed, COLORS.route);
      }
    }

    // Route stops: numbered, in visit order. During the build animation
    // `shown` limits badges to the stops collected so far. While walking,
    // done stops turn green and the current target grows and goes coral.
    if (route) {
      const count = route.shown ?? route.stopIndices.length;
      for (let i = 0; i < count; i++) {
        const stop = graph.stops[route.stopIndices[i]];
        const [sx, sy] = toScreen(graph.xs[stop.n], graph.ys[stop.n]);
        if (walk) {
          // Passed stops: green if found, gray if skipped past.
          if (i < walk.at) drawBadge(sx, sy, String(i + 1), store.isSeen(stop.id) ? COLORS.seen : "#9aa0b5", "#fff");
          else if (i === walk.at) drawBadge(sx, sy, String(i + 1), COLORS.unseen, "#fff", 13);
          else drawBadge(sx, sy, String(i + 1), COLORS.route, "#fff");
          continue;
        }
        const isStart = i === 0 && stop.n === seed?.node;
        drawBadge(sx, sy, String(i + 1), isStart ? COLORS.seed : COLORS.route, isStart ? COLORS.route : "#fff");
      }
    }

    // Live GPS fix while walking: a halo'd dot.
    if (walk && herePos) {
      const [sx, sy] = toScreen(herePos.x, herePos.y);
      ctx.beginPath();
      ctx.arc(sx, sy, 15, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(91, 194, 240, 0.25)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#5bc2f0";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  // ---------- Interaction: pan / zoom / tap ----------

  const pointers = new Map<number, { x: number; y: number }>();
  let moved = false;

  function zoomAt(px: number, py: number, factor: number) {
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    const next = Math.min(view.fitScale * 200, Math.max(view.fitScale * 0.7, view.scale * factor));
    factor = next / view.scale;
    // Keep the world point under (px, py) fixed.
    view.cx += (px - w / 2) * (1 - 1 / factor) / view.scale;
    view.cy -= (py - h / 2) * (1 - 1 / factor) / view.scale;
    view.scale = next;
    syncBasemap();
    scheduleDraw();
  }

  els.canvas.addEventListener("pointerdown", (e) => {
    els.canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
  });

  els.canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (pointers.size === 1) {
      view.cx -= dx / view.scale;
      view.cy += dy / view.scale;
      syncBasemap();
      scheduleDraw();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const before = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const [a2, b2] = [...pointers.values()];
      const after = Math.hypot(a2.x - b2.x, a2.y - b2.y);
      const rect = els.canvas.getBoundingClientRect();
      zoomAt((a2.x + b2.x) / 2 - rect.left, (a2.y + b2.y) / 2 - rect.top, after / before);
      return;
    }
    p.x = e.clientX; p.y = e.clientY;
  });

  function pointerEnd(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (!moved && graph) {
      const rect = els.canvas.getBoundingClientRect();
      tap(e.clientX - rect.left, e.clientY - rect.top);
    }
  }
  els.canvas.addEventListener("pointerup", pointerEnd);
  els.canvas.addEventListener("pointercancel", (e) => pointers.delete(e.pointerId));

  els.canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = els.canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.pow(1.0015, -e.deltaY));
  }, { passive: false });

  function tap(px: number, py: number) {
    if (!graph || walk) return; // mid-walk taps must not re-seed the route
    let best = -1, bestD = 22 * 22;
    for (let i = 0; i < graph.stops.length; i++) {
      const [sx, sy] = toScreen(graph.xs[graph.stops[i].n], graph.ys[graph.stops[i].n]);
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      const stop = graph.stops[best];
      setSeed({ node: stop.n, label: stop.addr, isStop: true });
    }
  }

  // ---------- Start step: geolocation + address search ----------

  // Nearest network node to a lon/lat, and roughly how far away it is.
  function nearestNode(lon: number, lat: number) {
    if (!graph) return { node: 0, meters: Infinity }; // unreachable pre-load guard
    const x = lon * graph.kx - graph.x0, y = lat - graph.y0;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < graph.nodeCount; i++) {
      const d = (graph.xs[i] - x) ** 2 + (graph.ys[i] - y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return { node: best, meters: Math.sqrt(bestD) * DEG_M };
  }

  function seedFromCoords(lon: number, lat: number, label: string) {
    const { node, meters } = nearestNode(lon, lat);
    if (meters > 2000) {
      showToast("That spot is outside the mapped street network.");
      return;
    }
    setSeed({ node, label, isStop: false });
  }

  els.useLocation.addEventListener("click", () => {
    if (!navigator.geolocation) {
      showToast("This browser can't share your location.");
      return;
    }
    els.useLocation.disabled = true;
    els.useLocation.textContent = "Locating...";
    const done = () => {
      els.useLocation.disabled = false;
      els.useLocation.textContent = "Use my location";
    };
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        done();
        seedFromCoords(pos.coords.longitude, pos.coords.latitude, "your location");
      },
      () => {
        done();
        showToast("Couldn't get your location - try the address box.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  // Address search: instant matches over route-stop addresses, Photon places
  // after a pause (same service and area bias as Explore search).
  const geocoder = createGeocoder({
    limit: 4,
    currentQuery: () => els.addrInput.value.trim(),
    dedupeNameInSub: true,
  });

  function renderAddrResults(items: AddrItem[]) {
    els.addrResults.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      li.className = "cursor-pointer rounded-lg px-2.5 py-2 font-body text-[13.5px] leading-[1.3] font-bold hover:bg-[#f2f3fa]";
      li.textContent = item.label;
      if (item.sub) {
        const sub = document.createElement("span");
        sub.className = "block text-[12px] font-normal text-[#6b6d8f]";
        sub.textContent = item.sub;
        li.appendChild(sub);
      }
      li.addEventListener("click", () => {
        els.addrResults.hidden = true;
        els.addrInput.value = "";
        if (item.stop) setSeed({ node: item.stop.n, label: item.stop.addr, isStop: true });
        else seedFromCoords(item.coords[0], item.coords[1], item.label);
      });
      els.addrResults.appendChild(li);
    }
    els.addrResults.hidden = items.length === 0;
  }

  function localAddrMatches(q: string): AddrItem[] {
    const nq = q.toLowerCase();
    const out: AddrItem[] = [];
    if (!graph) return out;
    for (const stop of graph.stops) {
      if (stop.addr.toLowerCase().includes(nq)) {
        out.push({ label: stop.addr, sub: stopKindLabel(stop), stop });
        if (out.length >= 4) break;
      }
    }
    return out;
  }

  els.addrInput.addEventListener("input", () => {
    const q = els.addrInput.value.trim();
    geocoder.cancel();
    if (q.length < 2 || !graph) {
      els.addrResults.hidden = true;
      return;
    }
    const locals = localAddrMatches(q);
    renderAddrResults(locals);
    if (q.length < 3) return;
    geocoder.query(q, (places) => renderAddrResults([...locals, ...places]));
  });

  // ---------- Budget controls ----------

  /**
   * Convert a distance-budget slider value into meters for the optimizer.
   *
   * @param value - Slider value in the active display unit
   * @returns Budget in meters
   */
  function budgetMeters(value: number): number {
    return distanceUnit === 'mi' ? value * M_PER_MI : value * 1000;
  }

  /**
   * Snap a display-unit distance onto the slider's step grid.
   *
   * @param value - Raw value in the active unit
   * @returns Value clamped to the slider range and rounded to step
   */
  function snapDistanceBudget(value: number): number {
    const cfg = DISTANCE_SLIDER[distanceUnit];
    const stepped = Math.round(value / cfg.step) * cfg.step;
    return Math.min(cfg.max, Math.max(cfg.min, stepped));
  }

  /**
   * Apply min/max/step for the current budget mode (and distance unit).
   * Does not rewrite the slider value.
   */
  function sliderConfig() {
    if (mode === "distance") {
      const cfg = DISTANCE_SLIDER[distanceUnit];
      Object.assign(els.slider, { min: cfg.min, max: cfg.max, step: cfg.step });
    } else {
      Object.assign(els.slider, { min: 5, max: 100, step: 5 });
      if (+els.slider.value < 5) els.slider.value = "20";
    }
  }

  /**
   * Label text for the budget control, including unit when in distance mode.
   *
   * @returns e.g. "3.0 km", "2.0 mi", or "20 stops"
   */
  function budgetText(): string {
    if (mode !== "distance") return `${els.slider.value} stops`;
    return `${(+els.slider.value).toFixed(1)} ${distanceUnit}`;
  }

  /**
   * Refresh the budget label and its accessibility name (unit toggle hint).
   */
  function refreshBudgetLabel(): void {
    const text = budgetText();
    els.budgetLabel.textContent = text;
    // Dotted underline signals the label is tappable only in distance mode.
    els.budgetLabel.classList.toggle('underline', mode === 'distance');
    if (mode === 'distance') {
      const unitWord = distanceUnit === 'km' ? 'kilometers' : 'miles';
      els.budgetLabel.setAttribute(
        'aria-label',
        `Route budget ${text.replace(distanceUnit, unitWord)}. Tap to switch units.`
      );
      els.budgetLabel.title = 'Tap to switch km / mi';
    } else {
      els.budgetLabel.setAttribute('aria-label', `Route budget ${text}`);
      els.budgetLabel.removeAttribute('title');
    }
  }

  /**
   * Switch between distance and stop-count budgets. Does not rebuild; the
   * user confirms with Create route.
   *
   * @param next - Budget mode to activate
   */
  function setMode(next: "distance" | "count") {
    mode = next;
    els.modeDistance.classList.toggle("is-active", mode === "distance");
    els.modeCount.classList.toggle("is-active", mode === "count");
    const keep = els.slider.value;
    sliderConfig();
    if (mode === "distance") {
      const cfg = DISTANCE_SLIDER[distanceUnit];
      if (!(+keep >= cfg.min && +keep <= cfg.max)) els.slider.value = String(cfg.def);
      else els.slider.value = String(snapDistanceBudget(+keep));
    }
    if (mode === "count" && !(+keep >= 5 && +keep <= 100)) els.slider.value = "20";
    refreshBudgetLabel();
  }

  /**
   * Toggle km ↔ mi, converting the current distance budget so the walk
   * length stays roughly the same. Preference is persisted in settings.
   */
  function toggleDistanceUnit(): void {
    if (mode !== "distance") return;
    const meters = budgetMeters(+els.slider.value);
    distanceUnit = distanceUnit === 'km' ? 'mi' : 'km';
    store.setSetting('distanceUnit', distanceUnit);
    sliderConfig();
    const next =
      distanceUnit === 'mi' ? meters / M_PER_MI : meters / 1000;
    els.slider.value = String(snapDistanceBudget(next));
    refreshBudgetLabel();
    // Keep an existing route summary in the new unit without rebuilding.
    if (route) renderResult();
    if (walk) updateWalkCard();
  }

  els.modeDistance.addEventListener("click", () => setMode("distance"));
  els.modeCount.addEventListener("click", () => setMode("count"));
  els.slider.addEventListener("input", () => { refreshBudgetLabel(); });
  els.budgetLabel.addEventListener("click", () => toggleDistanceUnit());
  els.createRoute.addEventListener("click", () => rebuild());
  store.onSeenChange(() => scheduleDraw());
  store.onSettingsChange((s) => {
    if (s.distanceUnit === distanceUnit) return;
    // External settings change (rare): adopt unit and re-label without
    // converting the slider — the other writer already chose the value.
    distanceUnit = s.distanceUnit;
    if (mode === "distance") sliderConfig();
    refreshBudgetLabel();
    if (route) renderResult();
    if (walk) updateWalkCard();
  });

  // ---------- Build + result ----------

  let buildGen = 0;

  /** Drop route-leg boundary repeats before expanding edge geometry. */
  function compactNodePath(nodes: number[]): number[] {
    return nodes.filter((n, i) => i === 0 || n !== nodes[i - 1]);
  }

  function compactCoordinates(coordinates: LonLat[]): LonLat[] {
    return coordinates.filter(([lon, lat], i) =>
      i === 0 || lon !== coordinates[i - 1][0] || lat !== coordinates[i - 1][1]
    );
  }

  function expandedPathCoordinates(g: Graph, nodes: number[]): LonLat[] {
    return compactCoordinates(pathCoordinates(g, compactNodePath(nodes)));
  }

  /**
   * Add lon/lat coordinates to a world-coordinate canvas path. Consecutive
   * duplicate coordinates are skipped, and continued legs omit their known
   * shared first point so joins do not turn into accidental self-loops.
   */
  function appendCoordinates(path: Path2D, g: Graph, coordinates: LonLat[], startSubpath: boolean) {
    let hasPoint = false;
    let lastLon = NaN;
    let lastLat = NaN;
    for (const [lon, lat] of coordinates) {
      if (hasPoint && lon === lastLon && lat === lastLat) continue;
      lastLon = lon;
      lastLat = lat;
      const x = lon * g.kx - g.x0;
      const y = lat - g.y0;
      if (!hasPoint) {
        hasPoint = true;
        if (startSubpath) path.moveTo(x, y);
        // A later leg starts where the prior one ended, so emitting its
        // first point would produce a redundant zero-length segment.
      } else {
        path.lineTo(x, y);
      }
    }
  }

  function pathFromNodes(nodes: number[]): Path2D {
    const p = new Path2D();
    if (!graph) return p;
    appendCoordinates(p, graph, expandedPathCoordinates(graph, nodes), true);
    return p;
  }

  // Status narration shows in the plan step's summary line (wide screens)
  // and doubles as the drawer bar title (phones, where the drawer is
  // usually collapsed while the build animates).
  function setStatus(text: string) {
    els.summary.hidden = false;
    els.summary.textContent = text;
    els.drawerTitle.textContent = text;
  }

  /** Primary coral fill (first create) vs navy outline (recreate). */
  const CREATE_PRIMARY =
    "cursor-pointer appearance-none inline-flex w-full items-center justify-center gap-2 rounded-full border-0 bg-coral px-4 py-3 font-display text-[15px] leading-[1.2] font-bold text-white disabled:opacity-60";
  const CREATE_SECONDARY =
    "cursor-pointer appearance-none inline-flex w-full items-center justify-center gap-2 rounded-full border-[2.5px] border-navy bg-white px-4 py-2.5 font-display text-[15px] leading-[1.2] font-bold text-navy active:bg-navy active:text-white disabled:opacity-60";

  /**
   * Set Create/Recreate label and primary vs secondary chrome.
   * Recreate uses outline styling so Walk with me stays the clear primary CTA.
   *
   * @param kind - Idle create, in-flight, or recreate-after-result
   */
  function setCreateRouteUi(kind: "create" | "creating" | "recreate"): void {
    const secondary = kind === "recreate";
    els.createRoute.className = secondary ? CREATE_SECONDARY : CREATE_PRIMARY;
    // SVGElement has no reliable .hidden IDL - toggle the attribute instead.
    if (secondary) els.createRouteIcon.removeAttribute("hidden");
    else els.createRouteIcon.setAttribute("hidden", "");
    els.createRouteLabel.textContent =
      kind === "creating" ? "Creating..." : kind === "recreate" ? "Recreate route" : "Create route";
  }

  /**
   * Toggle build-in-progress UI: spinner on the status line and a disabled
   * Create route button so settings can still be read but not re-fired.
   *
   * @param on - Whether a narrated build is running
   */
  function setBuilding(on: boolean) {
    els.summary.classList.toggle("building", on);
    els.drawerTitle.classList.toggle("building", on);
    els.createRoute.disabled = on;
    if (on) setCreateRouteUi("creating");
    else setCreateRouteUi(route ? "recreate" : "create");
  }

  function appendLeg(path: Path2D, leg: number[], isFirst: boolean) {
    if (!graph) return;
    appendCoordinates(path, graph, expandedPathCoordinates(graph, leg), isFirst);
  }

  /**
   * Start a narrated route build from the current seed and plan controls.
   * Called only from the Create route button (settings no longer auto-run).
   */
  function rebuild() {
    if (!seed || !graph) return;
    // A rebuilt route supersedes any shared one; drop the stale link hash.
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    const gen = ++buildGen;
    race = null;
    setBuilding(true);
    setStatus("Measuring the streets nearby...");
    els.stops.hidden = true;
    els.actions.hidden = true;
    els.walkStart.hidden = true;
    // The drawer stays open so the budget controls remain visible on phones;
    // Create is disabled while the animation runs.
    // Let the status paint before the synchronous Dijkstra work starts.
    setTimeout(() => runBuild(gen).catch(console.error), 30);
  }

  // Slow mode (default) stretches each narrated pause by this factor so the
  // race / untangle steps are easier to follow. Full speed uses 1×.
  const BUILD_SLOW_MULT = 1.5;

  // The narrated build: race a few greedy starts against each other, keep
  // the winner, watch 2-opt untangle it, then spend any budget the
  // optimizer freed up on extra stops.
  async function runBuild(gen: number) {
    const alive = () => gen === buildGen && !!seed && !!graph;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    /** Pause for `ms`, stretched in slow mode unless Full speed is checked. */
    const pause = (ms: number) =>
      sleep(Math.round(ms * (els.fullSpeed.checked ? 1 : BUILD_SLOW_MULT)));
    if (!alive()) return;
    // alive() just guaranteed these; re-check so TS narrows, and capture
    // non-null bindings for the closures below.
    if (!seed || !graph || !shortest) return;
    const g = graph, short = shortest, seedNode = seed.node;

    const excluded = new Set<number>();
    if (els.skipSeen.checked) {
      for (let i = 0; i < graph.stops.length; i++) {
        if (store.isSeen(graph.stops[i].id)) excluded.add(i);
      }
    }
    const loop = els.loopBack.checked;
    const opts = {
      maxMeters: mode === "distance" ? budgetMeters(+els.slider.value) : Infinity,
      maxCount: mode === "count" ? +els.slider.value : Infinity,
      excluded,
      loop,
    };
    const rowFor = makeRows(graph, shortest);
    const candidates = buildCandidates(graph, rowFor, seed.node, opts);
    if (!alive()) return;
    if (!candidates.length) {
      setBuilding(false);
      setStatus("No reachable stops fit that budget - loosen it or pick another start.");
      route = null;
      routePath = null;
      scheduleDraw();
      return;
    }

    // More stops wins; fewer meters breaks ties.
    let winnerIdx = 0;
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i], w = candidates[winnerIdx];
      if (c.stopIndices.length > w.stopIndices.length ||
          (c.stopIndices.length === w.stopIndices.length && c.totalMeters < w.totalMeters)) {
        winnerIdx = i;
      }
    }
    const candLegs = candidates.map((c) => legsForOrder(g, short, seedNode, c.stopIndices, loop));

    route = null;
    routePath = null;
    fitToCoordinates(expandedPathCoordinates(g, candLegs.flat(2)));
    scheduleDraw();

    if (candidates.length > 1) {
      // Phase 1: the race. All candidates snake outward together.
      const colors = ["#d62246", "#5bc2f0", "#ffb43b", "#8b8fe0"];
      race = candidates.map((c, i) => ({ path: new Path2D(), color: colors[i % colors.length], alpha: 0.85 }));
      const maxLegs = Math.max(...candLegs.map((l) => l.length));
      const delay = Math.min(150, Math.max(40, 1800 / maxLegs));
      for (let i = 0; i < maxLegs; i++) {
        candLegs.forEach((legs, ci) => {
          if (race && i < legs.length) appendLeg(race[ci].path, legs[i], i === 0);
        });
        setStatus(`Trying ${candidates.length} different starts...`);
        scheduleDraw();
        await pause(delay);
        if (!alive()) return;
      }

      // Phase 2: declare the winner, fade the rest.
      const w = candidates[winnerIdx];
      setStatus(`Route ${String.fromCharCode(65 + winnerIdx)} wins - ${w.stopIndices.length} stops, ${fmtRouteKm(w.totalMeters, distanceUnit)}`);
      await pause(500);
      if (!alive()) return;
      for (let step = 0; step < 8; step++) {
        race.forEach((c, i) => { if (i !== winnerIdx) c.alpha *= 0.62; });
        scheduleDraw();
        await pause(55);
        if (!alive()) return;
      }
      race = null;
      route = {
        stopIndices: candidates[winnerIdx].stopIndices,
        totalMeters: candidates[winnerIdx].totalMeters,
        pathNodes: candLegs[winnerIdx].flat(),
      };
      routePath = pathFromNodes(route.pathNodes);
      scheduleDraw();
      await pause(400);
      if (!alive()) return;
    } else {
      // Single viable start: reveal it leg by leg instead.
      const stopIndices = candidates[0].stopIndices;
      const legs = candLegs[0];
      route = { stopIndices, totalMeters: candidates[0].totalMeters, pathNodes: legs.flat(), shown: 0 };
      routePath = new Path2D();
      const revealDelay = Math.min(120, Math.max(30, 1500 / legs.length));
      for (let i = 0; i < legs.length; i++) {
        appendLeg(routePath, legs[i], i === 0);
        route.shown = Math.min(i + 1, stopIndices.length);
        setStatus(
          loop && i === legs.length - 1
            ? "...and back to the start"
            : `Collecting stops... ${i + 1} of ${stopIndices.length}`
        );
        scheduleDraw();
        await pause(revealDelay);
        if (!alive()) return;
      }
      route.shown = undefined;
    }

    // Phase 3+4, repeated: untangle with 2-opt, then spend whatever budget
    // the optimizer freed up on more stops, until neither helps.
    const stopIndices = route.stopIndices;
    const rt = route;
    const refreshRoute = () => {
      const totals = routeTotals(g, rowFor, seedNode, stopIndices, loop);
      rt.totalMeters = totals.totalMeters;
      rt.pathNodes = legsForOrder(g, short, seedNode, stopIndices, loop).flat();
      routePath = pathFromNodes(rt.pathNodes);
      return totals;
    };

    setStatus("Checking for crossings...");
    await pause(450);
    if (!alive()) return;

    for (let round = 1; round <= 3; round++) {
      let untangled = false;
      for (const step of twoOptSteps(graph, rowFor, seed.node, stopIndices, loop)) {
        untangled = true;
        refreshRoute();
        setStatus(`Untangling the route - pass ${step.pass}, saved ${fmtMeters(step.saved, distanceUnit)}`);
        scheduleDraw();
        await pause(90);
        if (!alive()) return;
      }
      if (round === 1 && !untangled) {
        setStatus("No crossings - clean route");
        scheduleDraw();
        await pause(500);
        if (!alive()) return;
      }

      if (mode !== "distance") break;
      const totals = refreshRoute();
      const added = greedyExtend(graph, rowFor, seed.node, stopIndices, totals.pathMeters, opts);
      if (!added) break;
      refreshRoute();
      setStatus(`Leftover budget - adding ${added} more stop${added > 1 ? "s" : ""}...`);
      scheduleDraw();
      await pause(700);
      if (!alive()) return;
    }

    // Stops the walk already passes ride along free.
    const swept = sweepOnRoute(g, short, seedNode, stopIndices, excluded, loop);
    if (swept) {
      refreshRoute();
      setStatus(`Scooping up ${swept} stop${swept > 1 ? "s" : ""} already on the way...`);
      scheduleDraw();
      await pause(700);
      if (!alive()) return;
    }

    // Stretch: run a little over budget when short detours buy more stops.
    if (mode === "distance") {
      const slack = Math.min(opts.maxMeters * 0.1, 1000);
      const stretched = wiggleExtend(g, rowFor, seedNode, stopIndices, opts, slack);
      if (stretched) {
        // Quietly re-untangle, then grab anything the reshuffled path passes.
        const cleanup = twoOptSteps(g, rowFor, seedNode, stopIndices, loop);
        while (!cleanup.next().done) { /* drain */ }
        const bonus = sweepOnRoute(g, short, seedNode, stopIndices, excluded, loop);
        refreshRoute();
        const n = stretched + bonus;
        setStatus(`Stretching a bit for ${n} more stop${n > 1 ? "s" : ""}...`);
        scheduleDraw();
        await pause(700);
        if (!alive()) return;
      }
    }

    refreshRoute();
    setBuilding(false);
    renderResult();
    fitToCoordinates(expandedPathCoordinates(g, route.pathNodes));
    scheduleDraw();
  }

  // The stops list folds away behind its toggle so the open drawer stays
  // short on phones; wide screens have room, so it starts open there.
  function setStopsOpen(open: boolean) {
    els.stops.hidden = !open;
    els.stopsToggle.setAttribute("aria-expanded", String(open));
    const n = route ? route.stopIndices.length : 0;
    els.stopsToggle.textContent = open ? "Hide stops" : `Show ${n} stop${n === 1 ? "" : "s"}`;
  }
  els.stopsToggle.addEventListener("click", () => setStopsOpen(els.stops.hidden));

  function renderResult() {
    if (!route || !graph || !seed) return;
    const g = graph;
    const km = route.totalMeters / 1000;
    setStatus(`${route.stopIndices.length} stops · ${fmtRouteKm(route.totalMeters, distanceUnit)} · ~${Math.round(km * MIN_PER_KM)} min`);
    els.createRoute.hidden = false;
    setCreateRouteUi("recreate");
    els.actions.hidden = false;
    els.walkStart.hidden = false;
    els.stops.innerHTML = "";
    if (!seed.isStop) {
      const li = document.createElement("li");
      li.className = "stop-start";
      li.textContent = `Start - ${seed.label}`;
      els.stops.appendChild(li);
    }
    for (const si of route.stopIndices) {
      const stop = graph.stops[si];
      const li = document.createElement("li");
      li.textContent = stop.addr;
      if (stop.kind === "biz") {
        const type = document.createElement("span");
        type.className = "block text-[11px] font-bold tracking-[0.45px] text-blue uppercase";
        type.textContent = "Business code";
        li.appendChild(type);
      }
      if (store.isSeen(stop.id)) li.classList.add("stop-seen");
      li.addEventListener("click", () => {
        view.cx = g.xs[stop.n];
        view.cy = g.ys[stop.n];
        view.scale = Math.max(view.scale, view.fitScale * 12);
        syncBasemap();
        scheduleDraw();
      });
      els.stops.appendChild(li);
    }
    if (els.loopBack.checked) {
      const li = document.createElement("li");
      li.className = "stop-start";
      li.textContent = `Finish - back at ${seed.label}`;
      els.stops.appendChild(li);
    }
    setStopsOpen(matchMedia("(min-width: 720px)").matches);
  }

  // ---------- GPX export ----------

  function xmlEscape(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  els.exportGpx.addEventListener("click", () => {
    if (!route || !graph) return;
    const g = graph;
    const lonOf = (n: number) => ((g.xs[n] + g.x0) / g.kx).toFixed(6);
    const latOf = (n: number) => (g.ys[n] + g.y0).toFixed(6);
    const dist = fmtRouteKm(route.totalMeters, distanceUnit);
    const name = `Sign Safari - ${route.stopIndices.length} stops, ${dist}`;

    const wpts = route.stopIndices.map((si, i) => {
      const stop = g.stops[si];
      return `  <wpt lat="${latOf(stop.n)}" lon="${lonOf(stop.n)}"><name>${i + 1}. ${xmlEscape(stop.addr)}</name></wpt>`;
    });
    const trkpts = expandedPathCoordinates(g, route.pathNodes).map(
      ([lon, lat]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`
    );
    const gpx = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Sign Safari" xmlns="http://www.topografix.com/GPX/1/1">',
      `  <metadata><name>${xmlEscape(name)}</name></metadata>`,
      ...wpts,
      "  <trk>",
      `    <name>${xmlEscape(name)}</name>`,
      "    <trkseg>",
      ...trkpts,
      "    </trkseg>",
      "  </trk>",
      "</gpx>",
      "",
    ].join("\n");

    const blob = new Blob([gpx], { type: "application/gpx+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sign-safari-${route.stopIndices.length}-stops.gpx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showToast("GPX saved - import it as a course/route on your watch.");
  });

  // ---------- Share link ----------

  // The whole route rides in the URL hash: stop order as stable location ids
  // (indices shift when network.json is rebuilt), the seed as a stop id or
  // rounded lon/lat, and the loop flag. The recipient sees this exact
  // route - no re-optimizing against their own seen list.
  const SHARE_LIMIT = 200;

  // Serialized route (also what walk progress saves via store.saveWalk).
  function routeParams(): URLSearchParams | null {
    if (!route || !graph || !seed || route.stopIndices.length > SHARE_LIMIT) return null;
    const g = graph, sd = seed;
    const params = new URLSearchParams();
    params.set("r", route.stopIndices.map((si) => g.stops[si].id).join("."));
    const seedStop = sd.isStop ? g.stops.find((s) => s.n === sd.node) : undefined;
    params.set("s", seedStop ? seedStop.id : `${((g.xs[sd.node] + g.x0) / g.kx).toFixed(5)},${(g.ys[sd.node] + g.y0).toFixed(5)}`);
    if (els.loopBack.checked) params.set("l", "1");
    return params;
  }

  function shareUrl(): string | null {
    const params = routeParams();
    return params && `${location.origin}${location.pathname}#${params.toString()}`;
  }

  els.shareRoute.addEventListener("click", async () => {
    const url = shareUrl();
    if (!url) {
      showToast("This route is too big to fit in a link.");
      return;
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: "Sign Safari route", url });
        return;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return;
        // fall through to the clipboard on NotAllowedError etc.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast("Route link copied - send it to a friend!");
    } catch {
      showToast("Couldn't copy the link.");
    }
  });

  // Rebuild a serialized route (shared link hash, or a saved walk) once the
  // graph is in. Stops whose ids vanished in a data refresh are dropped with
  // a heads-up. Returns whether a route landed.
  function restoreRoute(params: URLSearchParams): boolean {
    if (!graph || !shortest) return false;
    const g = graph, short = shortest;
    const r = params.get("r");
    if (!r) return false;

    const { stopIndices, missing } = restoreStopIndices(g.stops, r.split(".").slice(0, SHARE_LIMIT));
    const byId = new Map(g.stops.map((stop, index) => [stop.id, index]));
    if (!stopIndices.length) {
      showToast("That shared route doesn't match the current location data.");
      return false;
    }

    const sParam = params.get("s") ?? "";
    let next: Seed | null = null;
    if (sParam.includes(",")) {
      const [lon, lat] = sParam.split(",").map(Number);
      if (isFinite(lon) && isFinite(lat)) {
        const { node, meters } = nearestNode(lon, lat);
        if (meters <= 2000) next = { node, label: "shared start", isStop: false };
      }
    } else {
      const idx = byId.get(sParam);
      if (idx !== undefined) next = { node: g.stops[idx].n, label: g.stops[idx].addr, isStop: true };
    }
    if (!next) {
      const first = g.stops[stopIndices[0]];
      next = { node: first.n, label: first.addr, isStop: true };
    }

    buildGen++; // cancel any build in flight
    const loop = params.get("l") === "1";
    els.loopBack.checked = loop;
    seed = next;
    els.seedLabel.textContent = seed.label;
    store.setRouteIntroSeen();

    const rowFor = makeRows(g, short);
    const totals = routeTotals(g, rowFor, seed.node, stopIndices, loop);
    route = {
      stopIndices,
      totalMeters: totals.totalMeters,
      pathNodes: legsForOrder(g, short, seed.node, stopIndices, loop).flat(),
    };
    routePath = pathFromNodes(route.pathNodes);
    race = null;
    setBuilding(false);
    setStep("plan");
    renderResult();
    fitToCoordinates(expandedPathCoordinates(g, route.pathNodes));
    scheduleDraw();
    if (missing) showToast(`${missing} stop${missing > 1 ? "s" : ""} from that link no longer exist${missing > 1 ? "" : "s"}.`);
    return true;
  }

  // A shared link beats a saved walk; otherwise pick the walk back up.
  function applySharedRoute() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (params.has("r")) restoreRoute(params);
    else restoreWalk();
  }

  // ---------- Walkthrough mode ----------

  // "Walk with me": step the finished route leg by leg. The drawer becomes a
  // guide card (next stop, distance, Done/Skip), the map zooms to the current
  // leg, GPS shows where you are, and progress survives a reload via the walk save.

  function legMeters(leg: number[]): number {
    if (!graph) return 0;
    return pathMeters(graph, compactNodePath(leg));
  }

  function updateWalkCard() {
    if (!walk || !route || !graph || !seed) return;
    const n = route.stopIndices.length;
    const home = walk.at >= n; // the loop's leg back to the start
    const stop = home ? undefined : graph.stops[route.stopIndices[walk.at]];
    const targetNode = stop?.n ?? seed.node;
    const addr = stop?.addr ?? `Back to ${seed.label}`;

    let remaining = 0;
    for (let i = walk.at; i < walk.legs.length; i++) remaining += legMeters(walk.legs[i]);
    els.walkProgress.textContent = `${home ? "Last leg" : `Stop ${walk.at + 1} of ${n}`} · ${fmtMeters(remaining, distanceUnit)} to go`;
    els.walkAddr.textContent = stop ? `${stopKindLabel(stop)} · ${addr}` : addr;

    if (herePos) {
      const dx = (graph.xs[targetNode] - herePos.x) * DEG_M;
      const dy = (graph.ys[targetNode] - herePos.y) * DEG_M;
      els.walkDist.textContent = `${fmtMeters(Math.hypot(dx, dy), distanceUnit)} away - head ${compassDir(dx, dy)}`;
    } else {
      els.walkDist.textContent = `about ${fmtMeters(legMeters(walk.legs[walk.at]), distanceUnit)} along the route`;
    }

    els.walkActions.hidden = enteringCode;
    els.walkCodeEntry.hidden = !enteringCode;
    if (enteringCode) {
      const title = `Stop ${walk.at + 1}/${n} found - add its code`;
      els.walkProgress.textContent = `Stop ${walk.at + 1} of ${n} found`;
      els.walkDist.textContent = "Save the code word now, or skip it and keep walking.";
      els.drawerTitle.textContent = title;
      els.hint.textContent = title;
      return;
    }

    els.walkDone.textContent = home ? "Made it!" : "Found it!";
    els.walkSkip.hidden = home;
    const title = home ? `Head back - ${addr}` : `Stop ${walk.at + 1}/${n} - ${addr}`;
    els.drawerTitle.textContent = title;
    els.hint.textContent = title;
  }

  function focusWalkLeg() {
    if (!walk || !graph) return;
    walkLegPath = pathFromNodes(walk.legs[walk.at]);
    fitToCoordinates(expandedPathCoordinates(graph, walk.legs[walk.at]), 60);
  }

  function enterWalk(at: number) {
    if (!route || !graph || !shortest || !seed) return;
    const legs = legsForOrder(graph, shortest, seed.node, route.stopIndices, els.loopBack.checked);
    if (at < 0 || at >= legs.length) {
      clearWalkSave(); // a stale save (data refresh shrank the route)
      return;
    }
    walk = { at, legs };
    enteringCode = false;
    setStep("walk");
    setDrawer(true);
    saveWalk();
    startGeoWatch();
    void requestWakeLock();
    focusWalkLeg();
    updateWalkCard();
    scheduleDraw();
  }

  function beginCodeEntry() {
    if (!walk || !route || !graph) return;
    const stop = graph.stops[route.stopIndices[walk.at]];
    if (!store.isSeen(stop.id)) store.toggle(stop.id);
    enteringCode = true;
    els.walkCodeInput.value = store.getCode(stop.id);
    updateWalkCard();
    els.walkCodeInput.focus();
    scheduleDraw();
  }

  function finishCodeEntry(saveCode: boolean) {
    if (!walk || !route || !graph || !enteringCode) return;
    const stop = graph.stops[route.stopIndices[walk.at]];
    if (saveCode) store.setCode(stop.id, els.walkCodeInput.value);
    enteringCode = false;
    els.walkCodeInput.value = "";
    advanceWalk();
  }

  function advanceWalk() {
    if (!walk || !route || !graph) return;
    walk.at++;
    if (walk.at >= walk.legs.length) {
      const n = route.stopIndices.length;
      endWalk();
      showToast(`Walk complete - ${n} stop${n === 1 ? "" : "s"}!`);
      return;
    }
    saveWalk();
    focusWalkLeg();
    updateWalkCard();
    scheduleDraw();
  }

  function endWalk() {
    if (geoWatch !== null) {
      navigator.geolocation.clearWatch(geoWatch);
      geoWatch = null;
    }
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    walk = null;
    enteringCode = false;
    els.walkCodeEntry.hidden = true;
    els.walkActions.hidden = false;
    walkLegPath = null;
    herePos = null;
    clearWalkSave();
    setStep("plan");
    if (route && graph) {
      renderResult();
      fitToCoordinates(expandedPathCoordinates(graph, route.pathNodes));
    }
    scheduleDraw();
  }

  function startGeoWatch() {
    if (geoWatch !== null || !navigator.geolocation) return;
    geoWatch = navigator.geolocation.watchPosition(
      (pos) => {
        if (!graph) return;
        herePos = { x: pos.coords.longitude * graph.kx - graph.x0, y: pos.coords.latitude - graph.y0 };
        if (walk) updateWalkCard();
        scheduleDraw();
      },
      () => {}, // denied/unavailable: the card falls back to route distances
      { enableHighAccuracy: true }
    );
  }

  // Keep the screen on while guiding; re-request when the tab comes back
  // (the browser releases the lock on every hide).
  async function requestWakeLock() {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      // unsupported browser or battery saver; walking works fine without it
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (walk && document.visibilityState === "visible") void requestWakeLock();
  });

  function saveWalk() {
    if (!walk) return;
    const params = routeParams();
    if (!params) return; // oversized route: the walk works, it just won't survive a reload
    store.saveWalk({ q: params.toString(), at: walk.at });
  }

  function clearWalkSave() {
    store.clearSavedWalk();
  }

  function restoreWalk() {
    const saved = store.savedWalk();
    if (!saved) return;
    if (!restoreRoute(new URLSearchParams(saved.q))) {
      clearWalkSave();
      return;
    }
    enterWalk(saved.at);
  }

  els.walkStart.addEventListener("click", () => enterWalk(0));
  els.walkDone.addEventListener("click", () => {
    if (!walk || !route || walk.at >= route.stopIndices.length) {
      advanceWalk();
      return;
    }
    beginCodeEntry();
  });
  els.walkSkip.addEventListener("click", advanceWalk);
  els.walkCodeSave.addEventListener("click", () => finishCodeEntry(true));
  els.walkCodeSkip.addEventListener("click", () => finishCodeEntry(false));
  els.walkCodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finishCodeEntry(true);
  });
  els.walkEnd.addEventListener("click", endWalk);

  // ---------- Lifecycle ----------

  new ResizeObserver(resize).observe(els.canvas);
  sliderConfig();
  if (mode === "distance") {
    els.slider.value = String(DISTANCE_SLIDER[distanceUnit].def);
  }
  refreshBudgetLabel();

  setStep(store.routeIntroSeen() ? "start" : "intro");

  return {
    load,
    show() {
      els.view.hidden = false;
      ensureBasemap();
      basemap?.resize();
      syncBasemap();
      if (currentStep() === "start" && !seed) els.hint.textContent = "You can also just tap a route stop";
      load().then(() => {
        resize();
        scheduleDraw();
      });
    },
    hide() {
      els.view.hidden = true;
    },
  };
}
