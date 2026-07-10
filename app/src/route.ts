// Itinerary route planner. The DOM layer owns selection, drawing, sharing,
// GPX, and walking guidance; constrained optimization stays pure in optimizer.

import maplibregl from "maplibre-gl";
import type { Map as MapLibreMap } from "maplibre-gl";
import { dataUrl } from "./data";
import { el, svgEl } from "./dom";
import { createGeocoder } from "./geocoder";
import {
  decodeSharedRoute,
  encodeSharedRoute,
  restoreSavedWalk,
  restoreSharedRoute,
  SHARE_ROUTE_LIMIT,
  type RestoredSharedRoute,
  type SerializedAnchor,
  type SharedRouteV2,
} from "./route-share";
import {
  DEG_M,
  MIN_PER_KM,
  buildGraph,
  edgeCoordinates,
  optimizeConstrainedRoute,
  pathCoordinates,
  pathMeters,
  type FeasibleConstrainedRoute,
  type Graph,
  type RouteAnchor,
  type RouteVisit,
} from "./optimizer";
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
  necessary: "#8b8fe0",
};
const ROUTE_BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
const ROUTE_BASEMAP_FALLBACK_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const M_PER_MI = 1609.344;
const DISTANCE_SLIDER = {
  km: { min: 0.5, max: 15, step: 0.5, def: 3 },
  mi: { min: 0.5, max: 10, step: 0.5, def: 2 },
} as const;

function fmtMeters(m: number, unit: DistanceUnit): string {
  if (unit === "mi") {
    if (m < 500) return `${Math.max(10, Math.round(m * 3.28084 / 10) * 10)} ft`;
    return `${(m / M_PER_MI).toFixed(1)} mi`;
  }
  return m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}

function fmtRouteDistance(m: number, unit: DistanceUnit): string {
  return unit === "mi" ? `${(m / M_PER_MI).toFixed(1)} mi` : `${(m / 1000).toFixed(1)} km`;
}

function stopKindLabel(stop: NetworkStop): string {
  return stop.kind === "biz" ? "Business code" : "Lawn sign";
}

function compassDir(dx: number, dy: number): string {
  const names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return names[Math.round(((deg + 360) % 360) / 45) % 8];
}

type ActiveRoute = FeasibleConstrainedRoute & { shown?: number };
type AddrItem =
  | { label: string; sub?: string; stopIndex: number; coords?: undefined }
  | { label: string; sub?: string; stopIndex?: undefined; coords: LonLat };
type EditTarget = { kind: "start" } | { kind: "finish" } | { kind: "add" } | { kind: "necessary"; index: number };

export interface RoutePlanner {
  load(): Promise<void>;
  show(): void;
  hide(): void;
}

export function createRoutePlanner({ store, showToast }: { store: Store; showToast: (msg: string) => void }): RoutePlanner {
  const els = {
    view: el("routeView"), basemap: el("routeBasemap"), canvas: el<HTMLCanvasElement>("routeCanvas"),
    hint: el("routeHint"), drawer: el("routeDrawer"), drawerBar: el("drawerBar"), drawerTitle: el("drawerTitle"),
    loading: el("routeLoading"), stepIntro: el("stepIntro"), stepStart: el("stepStart"), stepPlan: el("stepPlan"),
    stepWalk: el("stepWalk"), introGo: el("introGo"), useLocation: el<HTMLButtonElement>("useLocation"),
    seedLabel: el("seedLabel"),
    changeStart: el("changeStart"), necessaryStops: el("necessaryStops"), noNecessary: el("noNecessary"),
    addNecessary: el("addNecessary"), finishLabel: el("finishLabel"), changeFinish: el("changeFinish"),
    finishAtStart: el("finishAtStart"), itinerarySearch: el("itinerarySearch"),
    itinerarySearchTitle: el("itinerarySearchTitle"), itinerarySearchCancel: el("itinerarySearchCancel"),
    itineraryInput: el<HTMLInputElement>("itineraryInput"), itineraryResults: el("itineraryResults"),
    slider: el<HTMLInputElement>("budgetSlider"), budgetLabel: el<HTMLButtonElement>("budgetLabel"),
    skipSeen: el<HTMLInputElement>("skipSeen"), fullSpeed: el<HTMLInputElement>("fullSpeed"),
    createRoute: el<HTMLButtonElement>("createRoute"), createRouteIcon: svgEl("createRouteIcon"),
    createRouteLabel: el("createRouteLabel"), summary: el("routeSummary"), actions: el("routeActions"),
    exportGpx: el("exportGpx"), shareRoute: el<HTMLButtonElement>("shareRoute"),
    stopsToggle: el<HTMLButtonElement>("stopsToggle"), stops: el("routeStops"),
    walkStart: el<HTMLButtonElement>("walkStart"), walkProgress: el("walkProgress"), walkAddr: el("walkAddr"),
    walkDist: el("walkDist"), walkActions: el("walkActions"), walkDone: el<HTMLButtonElement>("walkDone"),
    walkSkip: el<HTMLButtonElement>("walkSkip"), walkCodeEntry: el("walkCodeEntry"),
    walkCodeInput: el<HTMLInputElement>("walkCodeInput"), walkCodeSave: el<HTMLButtonElement>("walkCodeSave"),
    walkCodeSkip: el<HTMLButtonElement>("walkCodeSkip"), walkEnd: el<HTMLButtonElement>("walkEnd"),
  };
  const ctx2d = els.canvas.getContext("2d");
  if (!ctx2d) throw new Error("no 2d context");
  const ctx = ctx2d;

  let graph: Graph | null = null;
  let streetsPath: Path2D | null = null;
  let connectorsPath: Path2D | null = null;
  let loadPromise: Promise<void> | null = null;
  let basemap: MapLibreMap | null = null;
  let basemapFailedOver = false;
  const view = { cx: 0, cy: 0, scale: 1, fitScale: 1 };
  let start: RouteAnchor | null = null;
  let necessary: RouteAnchor[] = [];
  let finish: RouteAnchor | null = null;
  let finishFollowsStart = true;
  let editTarget: EditTarget | null = null;
  let route: ActiveRoute | null = null;
  let routePath: Path2D | null = null;
  let distanceUnit: DistanceUnit = store.settings().distanceUnit;
  let needsDraw = false;
  let buildGen = 0;

  let walk: { at: number } | null = null;
  let enteringCode = false;
  let walkLegPath: Path2D | null = null;
  let herePos: { x: number; y: number } | null = null;
  let geoWatch: number | null = null;
  let wakeLock: WakeLockSentinel | null = null;

  function setDrawer(open: boolean): void {
    els.drawer.classList.toggle("open", open);
    els.drawerBar.setAttribute("aria-expanded", String(open));
  }
  const drawerOpen = () => els.drawer.classList.contains("open");
  els.drawerBar.addEventListener("click", () => setDrawer(!drawerOpen()));
  els.drawerBar.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setDrawer(!drawerOpen());
  });
  let barTouchY: number | null = null;
  els.drawerBar.addEventListener("touchstart", (event) => { barTouchY = event.touches[0].clientY; }, { passive: true });
  els.drawerBar.addEventListener("touchend", (event) => {
    if (barTouchY === null) return;
    const dy = event.changedTouches[0].clientY - barTouchY;
    barTouchY = null;
    if (dy > 30) setDrawer(false);
    else if (dy < -30) setDrawer(true);
  }, { passive: true });

  function setStep(step: "intro" | "start" | "plan" | "walk"): void {
    els.stepIntro.hidden = step !== "intro";
    els.stepStart.hidden = step !== "start";
    els.stepPlan.hidden = step !== "plan";
    els.stepWalk.hidden = step !== "walk";
    els.hint.hidden = step === "intro";
    if (step === "intro") els.drawerTitle.textContent = "Plan a route";
    if (step === "start") {
      els.drawerTitle.textContent = "Where are you starting?";
      els.hint.textContent = "You can also tap a routeable code location";
      if (!start) openItinerarySearch({ kind: "start" });
    }
    if (step === "plan" && start) els.hint.textContent = `Starting at ${start.label}`;
    if (step === "intro" || step === "walk") closeItinerarySearch();
    if (step !== "plan" || !route) setDrawer(true);
  }

  function currentStep(): "intro" | "start" | "plan" | "walk" {
    if (!els.stepIntro.hidden) return "intro";
    if (!els.stepStart.hidden) return "start";
    if (!els.stepWalk.hidden) return "walk";
    return "plan";
  }

  function invalidateRoute(): void {
    buildGen++;
    route = null;
    routePath = null;
    els.summary.hidden = true;
    els.actions.hidden = true;
    els.walkStart.hidden = true;
    els.stops.hidden = true;
    setBuilding(false);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    scheduleDraw();
  }

  function setStart(anchor: RouteAnchor): void {
    start = anchor;
    if (finishFollowsStart || !finish) finish = { ...anchor };
    store.setRouteIntroSeen();
    invalidateRoute();
    renderItineraryEditor();
    closeItinerarySearch();
    setStep("plan");
    els.drawerTitle.textContent = "Set your itinerary, then create";
  }

  els.introGo.addEventListener("click", () => {
    store.setRouteIntroSeen();
    setStep("start");
  });
  els.changeStart.addEventListener("click", () => openItinerarySearch({ kind: "start" }));

  function load(): Promise<void> {
    if (!loadPromise) {
      loadPromise = fetch(dataUrl("network.json"))
        .then((response) => {
          if (!response.ok) throw new Error(`network.json: ${response.status}`);
          return response.json() as Promise<NetworkData>;
        })
        .then((raw) => {
          graph = buildGraph(raw);
          const stopNodes = new Set(graph.stops.map((stop) => stop.n));
          streetsPath = new Path2D();
          connectorsPath = new Path2D();
          for (let edge = 0; edge < graph.edgeCount; edge++) {
            const a = graph.edges[edge * 3], b = graph.edges[edge * 3 + 1];
            appendCoordinates(stopNodes.has(a) || stopNodes.has(b) ? connectorsPath : streetsPath, graph, edgeCoordinates(graph, a, b), true);
          }
          els.loading.hidden = true;
          fitToStops();
          scheduleDraw();
          applySharedRoute();
        })
        .catch((error) => {
          console.error(error);
          els.loading.textContent = "Couldn't load the street network. Check your connection and refresh.";
        });
    }
    return loadPromise;
  }

  function fitToStops(): void {
    if (!graph) return;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const stop of graph.stops) {
      const x = graph.xs[stop.n], y = graph.ys[stop.n];
      xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    const width = els.canvas.clientWidth || innerWidth, height = els.canvas.clientHeight || innerHeight;
    view.cx = (xMin + xMax) / 2; view.cy = (yMin + yMax) / 2;
    view.fitScale = 0.92 * Math.min(width / (xMax - xMin), height / (yMax - yMin));
    view.scale = view.fitScale;
    syncBasemap();
  }

  function fitToCoordinates(coordinates: LonLat[], maxZoom = 200): void {
    if (!graph || !coordinates.length) return;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [lon, lat] of coordinates) {
      const x = lon * graph.kx - graph.x0, y = lat - graph.y0;
      xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
    }
    const width = els.canvas.clientWidth, height = els.canvas.clientHeight;
    const wide = matchMedia("(min-width: 720px)").matches;
    const header = 136, availableWidth = wide ? width - 420 : width;
    const availableHeight = wide ? height - header - 24 : Math.max(height - header - els.drawer.offsetHeight - 16, 120);
    const spanX = Math.max(xMax - xMin, 1e-5), spanY = Math.max(yMax - yMin, 1e-5);
    view.scale = Math.min(0.85 * Math.min(availableWidth / spanX, availableHeight / spanY), view.fitScale * maxZoom);
    view.cx = (xMin + xMax) / 2 + (width / 2 - availableWidth / 2) / view.scale;
    view.cy = (yMin + yMax) / 2 + (header + availableHeight / 2 - height / 2) / view.scale;
    syncBasemap();
  }

  function ensureBasemap(): void {
    if (basemap) return;
    basemap = new maplibregl.Map({
      container: els.basemap, style: ROUTE_BASEMAP_STYLE, center: [-83.743, 42.278], zoom: 12,
      interactive: false, attributionControl: { compact: true },
    });
    basemap.on("error", (event) => {
      if (!basemap || basemapFailedOver || basemap.isStyleLoaded()) return;
      if (event.error && /style/i.test(String(event.error.message))) {
        basemapFailedOver = true;
        basemap.setStyle(ROUTE_BASEMAP_FALLBACK_STYLE);
      }
    });
  }

  function syncBasemap(): void {
    if (!graph || !basemap) return;
    const lat = view.cy + graph.y0, lon = (view.cx + graph.x0) / graph.kx;
    const zoom = Math.log2((view.scale * 360 * Math.cos(lat * Math.PI / 180)) / 512);
    basemap.jumpTo({ center: [lon, lat], zoom: Math.max(10, Math.min(19.7, zoom)), bearing: 0, pitch: 0 });
  }

  function resize(): void {
    const dpr = devicePixelRatio || 1, width = els.canvas.clientWidth, height = els.canvas.clientHeight;
    if (els.canvas.width !== width * dpr || els.canvas.height !== height * dpr) {
      els.canvas.width = width * dpr; els.canvas.height = height * dpr;
    }
    basemap?.resize(); syncBasemap(); scheduleDraw();
  }
  function toScreen(x: number, y: number): [number, number] {
    return [(x - view.cx) * view.scale + els.canvas.clientWidth / 2, (view.cy - y) * view.scale + els.canvas.clientHeight / 2];
  }
  function coordsToScreen(coords: LonLat): [number, number] {
    if (!graph) return [0, 0];
    return toScreen(coords[0] * graph.kx - graph.x0, coords[1] - graph.y0);
  }
  function scheduleDraw(): void {
    if (needsDraw) return;
    needsDraw = true;
    requestAnimationFrame(() => { needsDraw = false; draw(); });
  }
  function drawBadge(x: number, y: number, text: string, fill: string, textFill: string, radius = 10, ring?: string): void {
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = ring ?? "#fff"; ctx.lineWidth = ring ? 3.5 : 2; ctx.stroke();
    ctx.fillStyle = textFill; ctx.font = `700 ${Math.round(radius * 1.05)}px 'Nunito Sans', sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, x, y + 0.5);
  }

  function draw(): void {
    if (!graph || !streetsPath || els.view.hidden) return;
    const dpr = devicePixelRatio || 1, width = els.canvas.clientWidth, height = els.canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height); syncBasemap();
    ctx.save(); ctx.translate(width / 2, height / 2); ctx.scale(view.scale, -view.scale); ctx.translate(-view.cx, -view.cy);
    if (connectorsPath) {
      ctx.lineWidth = 0.8 / view.scale; ctx.strokeStyle = COLORS.connector;
      ctx.setLineDash([3 / view.scale, 3 / view.scale]); ctx.stroke(connectorsPath); ctx.setLineDash([]);
    }
    ctx.lineWidth = 1.1 / view.scale; ctx.strokeStyle = COLORS.street; ctx.stroke(streetsPath);
    if (routePath) {
      ctx.lineWidth = 4 / view.scale; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.strokeStyle = walk ? COLORS.unseen : COLORS.route;
      if (walk) ctx.globalAlpha = 0.38; ctx.stroke(routePath); ctx.globalAlpha = 1;
      if (walk && walkLegPath) { ctx.lineWidth = 5 / view.scale; ctx.strokeStyle = COLORS.unseen; ctx.stroke(walkLegPath); }
    }
    ctx.restore();

    const radius = Math.max(2.5, Math.min(7, view.scale / 2400));
    for (let index = 0; index < graph.stops.length; index++) {
      const stop = graph.stops[index], [x, y] = toScreen(graph.xs[stop.n], graph.ys[stop.n]);
      if (x < -20 || y < -20 || x > width + 20 || y > height + 20) continue;
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = store.isSeen(stop.id) ? COLORS.seen : stop.kind === "biz" ? COLORS.biz : COLORS.unseen;
      ctx.globalAlpha = view.scale / view.fitScale < 5 ? 0.42 : 1; ctx.fill(); ctx.globalAlpha = 1;
    }

    if (route) {
      const shown = route.shown ?? route.visits.length;
      let optionalNumber = 0;
      for (let index = 0; index < Math.min(shown, route.visits.length); index++) {
        const visit = route.visits[index], [x, y] = coordsToScreen(visit.anchor.coords);
        if (visit.role === "optional") optionalNumber++;
        const active = !!walk && index === walk.at + 1;
        const passed = !!walk && index <= walk.at;
        if (visit.role === "start") drawBadge(x, y, "S", COLORS.seed, COLORS.route);
        else if (visit.role === "finish") drawBadge(x, y, "F", active ? COLORS.unseen : COLORS.seed, "#fff", active ? 13 : 10);
        else if (visit.role === "necessary") drawBadge(x, y, "N", passed ? COLORS.seen : active ? COLORS.unseen : COLORS.necessary, "#fff", active ? 13 : 10, COLORS.seed);
        else drawBadge(x, y, String(optionalNumber), passed ? COLORS.seen : active ? COLORS.unseen : COLORS.route, "#fff", active ? 13 : 10);
      }
    } else if (start) {
      const [x, y] = coordsToScreen(start.coords); drawBadge(x, y, "S", COLORS.seed, COLORS.route);
    }
    if (walk && herePos) {
      const [x, y] = toScreen(herePos.x, herePos.y);
      ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.fillStyle = "rgba(91,194,240,0.25)"; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = "#5bc2f0"; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5; ctx.stroke();
    }
  }

  const pointers = new Map<number, { x: number; y: number }>();
  let moved = false;
  function zoomAt(x: number, y: number, factor: number): void {
    const next = Math.min(view.fitScale * 200, Math.max(view.fitScale * 0.7, view.scale * factor));
    factor = next / view.scale;
    view.cx += (x - els.canvas.clientWidth / 2) * (1 - 1 / factor) / view.scale;
    view.cy -= (y - els.canvas.clientHeight / 2) * (1 - 1 / factor) / view.scale;
    view.scale = next; syncBasemap(); scheduleDraw();
  }
  els.canvas.addEventListener("pointerdown", (event) => {
    els.canvas.setPointerCapture(event.pointerId); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); moved = false;
  });
  els.canvas.addEventListener("pointermove", (event) => {
    const pointer = pointers.get(event.pointerId); if (!pointer) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (pointers.size === 1) { view.cx -= dx / view.scale; view.cy += dy / view.scale; syncBasemap(); scheduleDraw(); }
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()], before = Math.hypot(a.x - b.x, a.y - b.y);
      pointer.x = event.clientX; pointer.y = event.clientY;
      const [a2, b2] = [...pointers.values()], after = Math.hypot(a2.x - b2.x, a2.y - b2.y), rect = els.canvas.getBoundingClientRect();
      zoomAt((a2.x + b2.x) / 2 - rect.left, (a2.y + b2.y) / 2 - rect.top, after / before); return;
    }
    pointer.x = event.clientX; pointer.y = event.clientY;
  });
  function pointerEnd(event: PointerEvent): void {
    pointers.delete(event.pointerId);
    if (!moved && graph) { const rect = els.canvas.getBoundingClientRect(); tap(event.clientX - rect.left, event.clientY - rect.top); }
  }
  els.canvas.addEventListener("pointerup", pointerEnd);
  els.canvas.addEventListener("pointercancel", (event) => pointers.delete(event.pointerId));
  els.canvas.addEventListener("wheel", (event) => {
    event.preventDefault(); const rect = els.canvas.getBoundingClientRect();
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.pow(1.0015, -event.deltaY));
  }, { passive: false });

  function nodeCoords(node: number): LonLat {
    if (!graph) return [0, 0];
    return [graph.nodes[node * 2], graph.nodes[node * 2 + 1]];
  }
  function stopCoords(index: number): LonLat {
    if (!graph) return [0, 0];
    return nodeCoords(graph.stops[index].n);
  }
  function anchorForStop(index: number): RouteAnchor {
    if (!graph) throw new Error("graph not loaded");
    const stop = graph.stops[index];
    return { node: graph.snap[index], label: stop.addr, coords: stopCoords(index), codeStopIndex: index };
  }
  function nearestNode(coords: LonLat): { node: number; meters: number } {
    if (!graph) return { node: 0, meters: Infinity };
    const x = coords[0] * graph.kx - graph.x0, y = coords[1] - graph.y0;
    let best = 0, bestDistance = Infinity;
    for (let node = 0; node < graph.nodeCount; node++) {
      const distance = (graph.xs[node] - x) ** 2 + (graph.ys[node] - y) ** 2;
      if (distance < bestDistance) { best = node; bestDistance = distance; }
    }
    return { node: best, meters: Math.sqrt(bestDistance) * DEG_M };
  }
  function anchorFromCoords(coords: LonLat, label: string): RouteAnchor | null {
    const attached = nearestNode(coords);
    if (attached.meters > 2000) {
      showToast("That place cannot be attached to the mapped walking network. Choose a closer location.");
      return null;
    }
    return { node: attached.node, label, coords };
  }

  function applyEditedAnchor(anchor: RouteAnchor): void {
    if (!editTarget) { setStart(anchor); return; }
    if (editTarget.kind === "start") setStart(anchor);
    else if (editTarget.kind === "finish") { finish = anchor; finishFollowsStart = false; invalidateRoute(); renderItineraryEditor(); }
    else if (editTarget.kind === "add") { necessary.push(anchor); invalidateRoute(); renderItineraryEditor(); }
    else { necessary[editTarget.index] = anchor; invalidateRoute(); renderItineraryEditor(); }
    closeItinerarySearch();
  }

  function tap(x: number, y: number): void {
    if (!graph || walk) return;
    let best = -1, bestDistance = 22 ** 2;
    for (let index = 0; index < graph.stops.length; index++) {
      const [stopX, stopY] = toScreen(graph.xs[graph.stops[index].n], graph.ys[graph.stops[index].n]);
      const distance = (stopX - x) ** 2 + (stopY - y) ** 2;
      if (distance < bestDistance) { best = index; bestDistance = distance; }
    }
    if (best < 0) return;
    const anchor = anchorForStop(best);
    if (currentStep() === "start" && !start) setStart(anchor);
    else if (editTarget) applyEditedAnchor(anchor);
  }

  function localAddrMatches(query: string): AddrItem[] {
    if (!graph) return [];
    const normalized = query.toLowerCase(), items: AddrItem[] = [];
    for (let index = 0; index < graph.stops.length; index++) {
      const stop = graph.stops[index];
      if (stop.addr.toLowerCase().includes(normalized)) {
        items.push({ label: stop.addr, sub: stopKindLabel(stop), stopIndex: index });
        if (items.length >= 4) break;
      }
    }
    return items;
  }

  function setupLocationSearch(input: HTMLInputElement, results: HTMLElement, onPick: (anchor: RouteAnchor) => void): void {
    const geocoder = createGeocoder({ limit: 4, currentQuery: () => input.value.trim(), dedupeNameInSub: true });
    function render(items: AddrItem[]): void {
      results.innerHTML = "";
      for (const item of items) {
        const row = document.createElement("li");
        row.className = "cursor-pointer rounded-lg px-2.5 py-2 font-body text-[13.5px] leading-[1.3] font-bold hover:bg-[#f2f3fa]";
        row.textContent = item.label;
        if (item.sub) { const sub = document.createElement("span"); sub.className = "block text-[12px] font-normal text-[#6b6d8f]"; sub.textContent = item.sub; row.appendChild(sub); }
        row.addEventListener("click", () => {
          const anchor = item.stopIndex !== undefined ? anchorForStop(item.stopIndex) : anchorFromCoords(item.coords, item.label);
          if (!anchor) return;
          results.hidden = true; input.value = ""; onPick(anchor);
        });
        results.appendChild(row);
      }
      results.hidden = items.length === 0;
    }
    input.addEventListener("input", () => {
      const query = input.value.trim(); geocoder.cancel();
      if (query.length < 2 || !graph) { results.hidden = true; return; }
      const local = localAddrMatches(query); render(local);
      if (query.length >= 3) geocoder.query(query, (places) => render([...local, ...places]));
    });
  }
  setupLocationSearch(els.itineraryInput, els.itineraryResults, applyEditedAnchor);

  els.useLocation.addEventListener("click", () => {
    if (!navigator.geolocation) { showToast("This browser can't share your location."); return; }
    els.useLocation.disabled = true; els.useLocation.textContent = "Locating...";
    const done = () => { els.useLocation.disabled = false; els.useLocation.textContent = "Use my location"; };
    navigator.geolocation.getCurrentPosition((position) => {
      done(); const anchor = anchorFromCoords([position.coords.longitude, position.coords.latitude], "your location"); if (anchor) setStart(anchor);
    }, () => { done(); showToast("Couldn't get your location — try the address box."); }, { enableHighAccuracy: true, timeout: 10000 });
  });

  function openItinerarySearch(target: EditTarget): void {
    editTarget = target;
    const title = target.kind === "start" ? start ? "Change Start" : "Choose Start" : target.kind === "finish" ? "Choose Finish" : target.kind === "add" ? "Add necessary stop" : "Change necessary stop";
    els.itinerarySearchTitle.textContent = title;
    els.itinerarySearchCancel.hidden = target.kind === "start" && !start;
    els.itinerarySearch.hidden = false; els.itineraryInput.value = ""; els.itineraryResults.hidden = true;
    els.itineraryInput.focus();
  }
  function closeItinerarySearch(): void {
    editTarget = null; els.itinerarySearch.hidden = true; els.itinerarySearchCancel.hidden = false; els.itineraryInput.value = ""; els.itineraryResults.hidden = true;
  }
  els.itinerarySearchCancel.addEventListener("click", closeItinerarySearch);
  els.addNecessary.addEventListener("click", () => openItinerarySearch({ kind: "add" }));
  els.changeFinish.addEventListener("click", () => openItinerarySearch({ kind: "finish" }));
  els.finishAtStart.addEventListener("click", () => {
    if (!start) return; finish = { ...start }; finishFollowsStart = true; invalidateRoute(); renderItineraryEditor();
  });

  function renderItineraryEditor(): void {
    els.seedLabel.textContent = start?.label ?? "";
    els.finishLabel.textContent = finishFollowsStart ? `Back to ${start?.label ?? "Start"}` : finish?.label ?? "";
    els.finishAtStart.hidden = finishFollowsStart;
    els.necessaryStops.innerHTML = "";
    els.noNecessary.hidden = necessary.length > 0;
    necessary.forEach((anchor, index) => {
      const row = document.createElement("li");
      row.className = "flex items-center gap-1.5 rounded-lg bg-white px-2 py-1.5 text-[13px] font-bold text-ink";
      const label = document.createElement("button"); label.className = "min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent p-0 text-left"; label.textContent = `${index + 1}. ${anchor.label}`;
      label.addEventListener("click", () => openItinerarySearch({ kind: "necessary", index }));
      const up = document.createElement("button"), down = document.createElement("button"), remove = document.createElement("button");
      for (const button of [up, down, remove]) button.className = "cursor-pointer border-0 bg-transparent px-1 py-0.5 font-bold text-peri disabled:cursor-default disabled:opacity-30";
      up.textContent = "↑"; up.title = "Move up"; up.disabled = index === 0;
      down.textContent = "↓"; down.title = "Move down"; down.disabled = index === necessary.length - 1;
      remove.textContent = "×"; remove.title = "Remove";
      up.addEventListener("click", () => { [necessary[index - 1], necessary[index]] = [necessary[index], necessary[index - 1]]; invalidateRoute(); renderItineraryEditor(); });
      down.addEventListener("click", () => { [necessary[index], necessary[index + 1]] = [necessary[index + 1], necessary[index]]; invalidateRoute(); renderItineraryEditor(); });
      remove.addEventListener("click", () => { necessary.splice(index, 1); invalidateRoute(); renderItineraryEditor(); });
      row.append(label, up, down, remove); els.necessaryStops.appendChild(row);
    });
  }

  function budgetMeters(): number { return +els.slider.value * (distanceUnit === "mi" ? M_PER_MI : 1000); }
  function snapDistanceBudget(value: number): number {
    const config = DISTANCE_SLIDER[distanceUnit];
    return Math.min(config.max, Math.max(config.min, Math.round(value / config.step) * config.step));
  }
  function sliderConfig(): void {
    const config = DISTANCE_SLIDER[distanceUnit];
    Object.assign(els.slider, { min: config.min, max: config.max, step: config.step });
  }
  function refreshBudgetLabel(): void {
    const text = `${(+els.slider.value).toFixed(1)} ${distanceUnit}`; els.budgetLabel.textContent = text;
    const unitWord = distanceUnit === "km" ? "kilometers" : "miles";
    els.budgetLabel.setAttribute("aria-label", `Maximum walk ${text.replace(distanceUnit, unitWord)}. Tap to switch units.`);
  }
  function toggleDistanceUnit(): void {
    const meters = budgetMeters(); distanceUnit = distanceUnit === "km" ? "mi" : "km"; store.setSetting("distanceUnit", distanceUnit); sliderConfig();
    els.slider.value = String(snapDistanceBudget(distanceUnit === "mi" ? meters / M_PER_MI : meters / 1000)); refreshBudgetLabel(); invalidateRoute();
  }
  els.slider.addEventListener("input", () => { refreshBudgetLabel(); invalidateRoute(); });
  els.budgetLabel.addEventListener("click", toggleDistanceUnit);
  els.skipSeen.addEventListener("change", invalidateRoute);
  store.onSeenChange(() => {
    if (route && els.skipSeen.checked && !walk) invalidateRoute();
    else scheduleDraw();
  });
  store.onSettingsChange((settings) => {
    if (settings.distanceUnit === distanceUnit) return;
    distanceUnit = settings.distanceUnit; sliderConfig(); refreshBudgetLabel();
    if (route) renderResult(); if (walk) updateWalkCard();
  });

  function compactNodePath(nodes: number[]): number[] { return nodes.filter((node, index) => index === 0 || node !== nodes[index - 1]); }
  function expandedPathCoordinates(g: Graph, nodes: number[]): LonLat[] {
    return pathCoordinates(g, compactNodePath(nodes)).filter(([lon, lat], index, all) => index === 0 || lon !== all[index - 1][0] || lat !== all[index - 1][1]);
  }
  function appendCoordinates(path: Path2D, g: Graph, coordinates: LonLat[], startSubpath: boolean): void {
    let hasPoint = false, lastLon = NaN, lastLat = NaN;
    for (const [lon, lat] of coordinates) {
      if (hasPoint && lon === lastLon && lat === lastLat) continue;
      lastLon = lon; lastLat = lat; const x = lon * g.kx - g.x0, y = lat - g.y0;
      if (!hasPoint) { hasPoint = true; if (startSubpath) path.moveTo(x, y); } else path.lineTo(x, y);
    }
  }
  function pathFromNodes(nodes: number[]): Path2D {
    const path = new Path2D(); if (graph) appendCoordinates(path, graph, expandedPathCoordinates(graph, nodes), true); return path;
  }
  function setStatus(text: string): void { els.summary.hidden = false; els.summary.textContent = text; els.drawerTitle.textContent = text; }
  const CREATE_PRIMARY = "cursor-pointer appearance-none inline-flex w-full items-center justify-center gap-2 rounded-full border-0 bg-coral px-4 py-3 font-display text-[15px] leading-[1.2] font-bold text-white disabled:opacity-60";
  const CREATE_SECONDARY = "cursor-pointer appearance-none inline-flex w-full items-center justify-center gap-2 rounded-full border-[2.5px] border-navy bg-white px-4 py-2.5 font-display text-[15px] leading-[1.2] font-bold text-navy active:bg-navy active:text-white disabled:opacity-60";
  function setCreateRouteUi(kind: "create" | "creating" | "recreate"): void {
    const secondary = kind === "recreate"; els.createRoute.className = secondary ? CREATE_SECONDARY : CREATE_PRIMARY;
    if (secondary) els.createRouteIcon.removeAttribute("hidden"); else els.createRouteIcon.setAttribute("hidden", "");
    els.createRouteLabel.textContent = kind === "creating" ? "Creating..." : secondary ? "Recreate route" : "Create route";
  }
  function setBuilding(on: boolean): void {
    els.summary.classList.toggle("building", on); els.drawerTitle.classList.toggle("building", on); els.createRoute.disabled = on;
    setCreateRouteUi(on ? "creating" : route ? "recreate" : "create");
  }

  els.createRoute.addEventListener("click", rebuild);
  function rebuild(): void {
    if (!start || !finish || !graph) return;
    const generation = ++buildGen; setBuilding(true); setStatus("Checking the required itinerary...");
    els.actions.hidden = true; els.walkStart.hidden = true; els.stops.hidden = true;
    setTimeout(() => runBuild(generation), 30);
  }
  async function runBuild(generation: number): Promise<void> {
    if (generation !== buildGen || !start || !finish || !graph) return;
    const excluded = new Set<number>();
    if (els.skipSeen.checked) graph.stops.forEach((stop, index) => { if (store.isSeen(stop.id)) excluded.add(index); });
    const result = optimizeConstrainedRoute(graph, { start, necessary: [...necessary], finish, maxMeters: budgetMeters(), excluded });
    if (generation !== buildGen) return;
    if (result.status === "infeasible") {
      route = null; routePath = null; setBuilding(false);
      setStatus(isFinite(result.minimumMeters)
        ? `Required trip needs at least ${fmtRouteDistance(result.minimumMeters, distanceUnit)} — raise the maximum or change the itinerary.`
        : "Those required places are not connected by the mapped walking network.");
      scheduleDraw(); return;
    }
    route = { ...result, shown: 1 }; routePath = pathFromNodes(route.pathNodes);
    setStatus(result.optionalByGap.flat().length ? "Adding code locations without moving your errands..." : "The required trip fits — no extra code detour fits.");
    fitToCoordinates(expandedPathCoordinates(graph, route.pathNodes)); scheduleDraw();
    const delay = els.fullSpeed.checked ? 18 : 90;
    for (let shown = 2; shown <= route.visits.length; shown++) {
      if (generation !== buildGen || !route) return;
      route.shown = shown; scheduleDraw(); await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (!route) return; route.shown = undefined; setBuilding(false); renderResult(); scheduleDraw();
  }

  function setStopsOpen(open: boolean): void {
    els.stops.hidden = !open; els.stopsToggle.setAttribute("aria-expanded", String(open));
    const count = route ? route.visits.length : 0; els.stopsToggle.textContent = open ? "Hide itinerary" : `Show ${count} places`;
  }
  els.stopsToggle.addEventListener("click", () => setStopsOpen(els.stops.hidden));
  function roleLabel(visit: RouteVisit): string {
    if (visit.role === "start") return "Start";
    if (visit.role === "finish") return "Finish";
    if (visit.role === "necessary") return visit.codeStopIndex === undefined ? "Necessary stop" : "Necessary code location";
    return visit.codeStopIndex !== undefined && graph ? stopKindLabel(graph.stops[visit.codeStopIndex]) : "Code location";
  }
  function renderResult(): void {
    if (!route || !graph) return;
    const km = route.totalMeters / 1000, optionalCount = route.optionalByGap.flat().length;
    setStatus(`${route.codeLocationCount} code location${route.codeLocationCount === 1 ? "" : "s"} · ${necessary.length} necessary · ${fmtRouteDistance(route.totalMeters, distanceUnit)} · ~${Math.round(km * MIN_PER_KM)} min`);
    if (!optionalCount) els.hint.textContent = necessary.length ? "Required itinerary only — no optional code detour fits" : "No optional code detour fits this distance";
    els.actions.hidden = false; els.walkStart.hidden = false; setCreateRouteUi("recreate"); els.stops.innerHTML = "";
    route.visits.forEach((visit) => {
      const row = document.createElement("li"); row.textContent = visit.anchor.label;
      row.classList.add(`stop-${visit.role}`);
      const type = document.createElement("span"); type.className = "block text-[11px] font-bold tracking-[0.45px] text-peri uppercase"; type.textContent = roleLabel(visit); row.appendChild(type);
      if (visit.codeStopIndex !== undefined && store.isSeen(graph!.stops[visit.codeStopIndex].id)) row.classList.add("stop-seen");
      row.addEventListener("click", () => {
        const x = visit.anchor.coords[0] * graph!.kx - graph!.x0, y = visit.anchor.coords[1] - graph!.y0;
        view.cx = x; view.cy = y; view.scale = Math.max(view.scale, view.fitScale * 12); syncBasemap(); scheduleDraw();
      });
      els.stops.appendChild(row);
    });
    setStopsOpen(matchMedia("(min-width: 720px)").matches);
  }

  function xmlEscape(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  els.exportGpx.addEventListener("click", () => {
    if (!route || !graph) return;
    const distance = fmtRouteDistance(route.totalMeters, distanceUnit), name = `Sign Safari — ${route.codeLocationCount} codes, ${distance}`;
    const waypoints = route.visits.map((visit, index) => `  <wpt lat="${visit.anchor.coords[1].toFixed(6)}" lon="${visit.anchor.coords[0].toFixed(6)}"><name>${index + 1}. ${xmlEscape(roleLabel(visit))}: ${xmlEscape(visit.anchor.label)}</name></wpt>`);
    const trackpoints = expandedPathCoordinates(graph, route.pathNodes).map(([lon, lat]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`);
    const gpx = ['<?xml version="1.0" encoding="UTF-8"?>', '<gpx version="1.1" creator="Sign Safari" xmlns="http://www.topografix.com/GPX/1/1">', `  <metadata><name>${xmlEscape(name)}</name></metadata>`, ...waypoints, "  <trk>", `    <name>${xmlEscape(name)}</name>`, "    <trkseg>", ...trackpoints, "    </trkseg>", "  </trk>", "</gpx>", ""].join("\n");
    const blob = new Blob([gpx], { type: "application/gpx+xml" }), link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = `sign-safari-${route.codeLocationCount}-codes.gpx`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    showToast("GPX saved — import it as a course/route on your watch.");
  });

  function serializeAnchor(anchor: RouteAnchor): SerializedAnchor {
    return { label: anchor.label, coords: anchor.coords, ...(anchor.codeStopIndex !== undefined && graph ? { codeId: graph.stops[anchor.codeStopIndex].id } : {}) };
  }
  function routeParams(): URLSearchParams | null {
    if (!route || !graph || !start || !finish || route.codeLocationCount > SHARE_ROUTE_LIMIT) return null;
    const payload: SharedRouteV2 = {
      v: 2, start: serializeAnchor(start), necessary: necessary.map(serializeAnchor), finish: serializeAnchor(finish),
      optionalByGap: route.optionalByGap.map((gap) => gap.map((index) => graph!.stops[index].id)),
    };
    return encodeSharedRoute(payload);
  }
  function shareUrl(): string | null { const params = routeParams(); return params && `${location.origin}${location.pathname}#${params.toString()}`; }
  els.shareRoute.addEventListener("click", async () => {
    const url = shareUrl(); if (!url) { showToast("This route is too big to fit in a link."); return; }
    if (navigator.share) {
      try { await navigator.share({ title: "Sign Safari route", url }); return; }
      catch (error) { if (error instanceof Error && error.name === "AbortError") return; }
    }
    try { await navigator.clipboard.writeText(url); showToast("Route link copied — send it to a friend!"); }
    catch { showToast("Couldn't copy the link."); }
  });

  function applyRestoredRoute(restored: RestoredSharedRoute): void {
    if (!graph) return;
    ({ start, necessary, finish, finishFollowsStart } = restored);
    route = restored.route;
    routePath = pathFromNodes(route.pathNodes);
    store.setRouteIntroSeen(); setBuilding(false); setStep("plan"); renderItineraryEditor(); renderResult();
    fitToCoordinates(expandedPathCoordinates(graph, route.pathNodes)); scheduleDraw();
    const notices: string[] = [];
    if (restored.lostRequiredCodeLabels.length) notices.push(
      `${restored.lostRequiredCodeLabels.join(", ")} ${restored.lostRequiredCodeLabels.length === 1 ? "is" : "are"} no longer a code location, but remain${restored.lostRequiredCodeLabels.length === 1 ? "s" : ""} in the itinerary.`,
    );
    if (restored.missingOptional) notices.push(
      `${restored.missingOptional} optional code location${restored.missingOptional === 1 ? "" : "s"} no longer exist${restored.missingOptional === 1 ? "s" : ""}.`,
    );
    if (notices.length) showToast(notices.join(" "));
  }
  function restoreRoute(params: URLSearchParams): boolean {
    if (!graph) return false;
    const decoded = decodeSharedRoute(params); if (!decoded) return false;
    const restored = restoreSharedRoute(graph, decoded);
    if (!restored) { showToast("A required place from that route cannot be attached to the current walking network."); return false; }
    applyRestoredRoute(restored);
    return true;
  }
  function applySharedRoute(): void {
    const params = new URLSearchParams(location.hash.slice(1));
    if (decodeSharedRoute(params)) restoreRoute(params); else restoreWalk();
  }

  function updateWalkCard(): void {
    if (!walk || !route || !graph) return;
    const visit = route.visits[walk.at + 1], leg = route.legs[walk.at]; if (!visit || !leg) return;
    let remaining = 0; for (let index = walk.at; index < route.legs.length; index++) remaining += pathMeters(graph, compactNodePath(route.legs[index]));
    els.walkProgress.textContent = `${visit.role === "finish" ? "Last leg" : `Place ${walk.at + 1} of ${route.visits.length - 1}`} · ${fmtMeters(remaining, distanceUnit)} to go`;
    els.walkAddr.textContent = `${roleLabel(visit)} · ${visit.anchor.label}`;
    if (herePos) {
      const targetX = visit.anchor.coords[0] * graph.kx - graph.x0, targetY = visit.anchor.coords[1] - graph.y0;
      const dx = (targetX - herePos.x) * DEG_M, dy = (targetY - herePos.y) * DEG_M;
      els.walkDist.textContent = `${fmtMeters(Math.hypot(dx, dy), distanceUnit)} away — head ${compassDir(dx, dy)}`;
    } else els.walkDist.textContent = `about ${fmtMeters(pathMeters(graph, compactNodePath(leg)), distanceUnit)} along the route`;
    els.walkActions.hidden = enteringCode; els.walkCodeEntry.hidden = !enteringCode;
    if (enteringCode) {
      els.walkProgress.textContent = `${roleLabel(visit)} reached`; els.walkDist.textContent = "Save the code word now, or skip it and keep walking.";
      els.drawerTitle.textContent = `Add the code — ${visit.anchor.label}`; els.hint.textContent = els.drawerTitle.textContent; return;
    }
    const hasCode = visit.codeStopIndex !== undefined;
    els.walkDone.textContent = hasCode ? "Found it!" : visit.role === "finish" ? "Finish walk" : "Arrived — continue";
    els.walkSkip.hidden = !hasCode;
    els.drawerTitle.textContent = `${roleLabel(visit)} — ${visit.anchor.label}`; els.hint.textContent = els.drawerTitle.textContent;
  }
  function focusWalkLeg(): void {
    if (!walk || !route || !graph) return; const leg = route.legs[walk.at]; walkLegPath = pathFromNodes(leg); fitToCoordinates(expandedPathCoordinates(graph, leg), 60);
  }
  function enterWalk(at: number): void {
    if (!route || at < 0 || at >= route.legs.length) { clearWalkSave(); return; }
    walk = { at }; enteringCode = false; setStep("walk"); setDrawer(true); saveWalk(); startGeoWatch(); void requestWakeLock(); focusWalkLeg(); updateWalkCard(); scheduleDraw();
  }
  function beginCodeEntry(): void {
    if (!walk || !route || !graph) return; const visit = route.visits[walk.at + 1]; if (visit.codeStopIndex === undefined) { advanceWalk(); return; }
    const stop = graph.stops[visit.codeStopIndex]; if (!store.isSeen(stop.id)) store.toggle(stop.id);
    enteringCode = true; els.walkCodeInput.value = store.getCode(stop.id); updateWalkCard(); els.walkCodeInput.focus(); scheduleDraw();
  }
  function finishCodeEntry(saveCode: boolean): void {
    if (!walk || !route || !graph || !enteringCode) return; const visit = route.visits[walk.at + 1];
    if (saveCode && visit.codeStopIndex !== undefined) store.setCode(graph.stops[visit.codeStopIndex].id, els.walkCodeInput.value);
    enteringCode = false; els.walkCodeInput.value = ""; advanceWalk();
  }
  function advanceWalk(): void {
    if (!walk || !route) return; walk.at++;
    if (walk.at >= route.legs.length) { const count = route.codeLocationCount; endWalk(); showToast(`Walk complete — ${count} code location${count === 1 ? "" : "s"}!`); return; }
    saveWalk(); focusWalkLeg(); updateWalkCard(); scheduleDraw();
  }
  function endWalk(): void {
    if (geoWatch !== null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
    wakeLock?.release().catch(() => {}); wakeLock = null; walk = null; enteringCode = false; els.walkCodeEntry.hidden = true; els.walkActions.hidden = false;
    walkLegPath = null; herePos = null; clearWalkSave(); setStep("plan"); if (route && graph) { renderResult(); fitToCoordinates(expandedPathCoordinates(graph, route.pathNodes)); } scheduleDraw();
  }
  function startGeoWatch(): void {
    if (geoWatch !== null || !navigator.geolocation) return;
    geoWatch = navigator.geolocation.watchPosition((position) => {
      if (!graph) return; herePos = { x: position.coords.longitude * graph.kx - graph.x0, y: position.coords.latitude - graph.y0 }; if (walk) updateWalkCard(); scheduleDraw();
    }, () => {}, { enableHighAccuracy: true });
  }
  async function requestWakeLock(): Promise<void> { try { wakeLock = await navigator.wakeLock.request("screen"); } catch {} }
  document.addEventListener("visibilitychange", () => { if (walk && document.visibilityState === "visible") void requestWakeLock(); });
  function saveWalk(): void { if (!walk) return; const params = routeParams(); if (params) store.saveWalk({ q: params.toString(), at: walk.at }); }
  function clearWalkSave(): void { store.clearSavedWalk(); }
  function restoreWalk(): void {
    const saved = store.savedWalk(); if (!saved || !graph) return;
    const restored = restoreSavedWalk(graph, saved.q, saved.at);
    if (!restored) { clearWalkSave(); return; }
    applyRestoredRoute(restored); enterWalk(restored.at);
  }
  els.walkStart.addEventListener("click", () => enterWalk(0));
  els.walkDone.addEventListener("click", () => beginCodeEntry());
  els.walkSkip.addEventListener("click", advanceWalk);
  els.walkCodeSave.addEventListener("click", () => finishCodeEntry(true));
  els.walkCodeSkip.addEventListener("click", () => finishCodeEntry(false));
  els.walkCodeInput.addEventListener("keydown", (event) => { if (event.key === "Enter") finishCodeEntry(true); });
  els.walkEnd.addEventListener("click", endWalk);

  new ResizeObserver(resize).observe(els.canvas);
  sliderConfig(); els.slider.value = String(DISTANCE_SLIDER[distanceUnit].def); refreshBudgetLabel();
  setStep(store.routeIntroSeen() ? "start" : "intro");

  return {
    load,
    show() { els.view.hidden = false; ensureBasemap(); basemap?.resize(); syncBasemap(); load().then(() => { resize(); scheduleDraw(); }); },
    hide() { els.view.hidden = true; },
  };
}
