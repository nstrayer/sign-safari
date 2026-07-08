// Route planner tab: network-style view of the street graph with every sign
// as a node, plus greedy + 2-opt routing along real streets.
//
// Data comes from data/network.json (built by scripts/build_network.py):
//   nodes: [lon0, lat0, lon1, lat1, ...]
//   edges: [a, b, meters, ...] as node indices
//   signs: [{ id, addr, n }] where n indexes nodes
//
// The tab walks through a tiny wizard: pick a start (geolocation, address
// search, or tapping a sign), pick a distance or sign-count budget, get an
// optimized route drawn on the network plus a GPX export for watches.
//
// All routing runs client-side: Dijkstra over a CSR adjacency, a greedy
// nearest-unvisited walk from the seed until the budget runs out, then
// 2-opt to untangle the visiting order.

import { dataUrl } from "./data";
import { el } from "./dom";
import type { LonLat, NetworkData, NetworkSign, PhotonResponse } from "./types";
import type { Store } from "./store";

const COLORS = {
  street: "#c9cdd4",
  connector: "#e4e2d8",
  unseen: "#e8704a",
  seen: "#43a860",
  route: "#2f3061",
  seed: "#ffb43b",
};

const MIN_PER_KM = 12; // casual walking pace
const DEG_M = 111320; // meters per degree of latitude (and cos-corrected lon)
const INTRO_KEY = "sg2026.routeIntro";
const PHOTON_URL = "https://photon.komoot.io/api/";
const AREA = { lat: 42.2808, lon: -83.743, bbox: "-84.25,42.0,-83.35,42.55" };

// ---------- Graph ----------

interface Graph {
  nodeCount: number;
  edgeCount: number;
  kx: number;
  xs: Float64Array;
  ys: Float64Array;
  off: Int32Array;
  adj: Int32Array;
  wt: Float32Array;
  edges: number[];
  signs: NetworkSign[];
}

function buildGraph(raw: NetworkData): Graph {
  const nodeCount = raw.nodes.length / 2;
  const edgeCount = raw.edges.length / 3;

  // World coords: equirectangular, lon squished by cos(mid latitude) so
  // shapes and the pinch-zoom aspect look right.
  let latMin = Infinity, latMax = -Infinity;
  for (let i = 0; i < nodeCount; i++) {
    const lat = raw.nodes[i * 2 + 1];
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  }
  const kx = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
  const xs = new Float64Array(nodeCount);
  const ys = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    xs[i] = raw.nodes[i * 2] * kx;
    ys[i] = raw.nodes[i * 2 + 1];
  }

  // CSR adjacency (undirected: each edge appears in both directions).
  const deg = new Int32Array(nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    deg[raw.edges[e * 3]]++;
    deg[raw.edges[e * 3 + 1]]++;
  }
  const off = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) off[i + 1] = off[i] + deg[i];
  const adj = new Int32Array(edgeCount * 2);
  const wt = new Float32Array(edgeCount * 2);
  const cur = off.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const a = raw.edges[e * 3], b = raw.edges[e * 3 + 1], w = raw.edges[e * 3 + 2];
    adj[cur[a]] = b; wt[cur[a]++] = w;
    adj[cur[b]] = a; wt[cur[b]++] = w;
  }

  return { nodeCount, edgeCount, kx, xs, ys, off, adj, wt, edges: raw.edges, signs: raw.signs };
}

// ---------- Dijkstra ----------

interface MinHeap {
  readonly size: number;
  push(key: number, node: number): void;
  pop(): number;
  peekKey(): number;
}

function makeHeap(cap: number): MinHeap {
  let keys = new Float32Array(cap);
  let nodes = new Int32Array(cap);
  let size = 0;
  return {
    get size() { return size; },
    push(key, node) {
      if (size === keys.length) {
        const k2 = new Float32Array(size * 2), n2 = new Int32Array(size * 2);
        k2.set(keys); n2.set(nodes); keys = k2; nodes = n2;
      }
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (keys[p] <= key) break;
        keys[i] = keys[p]; nodes[i] = nodes[p]; i = p;
      }
      keys[i] = key; nodes[i] = node;
    },
    pop() {
      const top = nodes[0];
      const key = keys[--size], node = nodes[size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= size) break;
        const c = l + 1 < size && keys[l + 1] < keys[l] ? l + 1 : l;
        if (keys[c] >= key) break;
        keys[i] = keys[c]; nodes[i] = nodes[c]; i = c;
      }
      keys[i] = key; nodes[i] = node;
      return top;
    },
    peekKey: () => keys[0],
  };
}

interface DijkstraResult {
  dist: Float32Array;
  prev: Int32Array;
}

function dijkstra(graph: Graph, src: number): DijkstraResult {
  const { nodeCount, off, adj, wt } = graph;
  const dist = new Float32Array(nodeCount).fill(Infinity);
  const prev = new Int32Array(nodeCount).fill(-1);
  const heap = makeHeap(1024);
  dist[src] = 0;
  heap.push(0, src);
  while (heap.size) {
    const key = heap.peekKey();
    const u = heap.pop();
    if (key > dist[u]) continue; // stale entry
    for (let i = off[u]; i < off[u + 1]; i++) {
      const v = adj[i];
      const nd = dist[u] + wt[i];
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        heap.push(nd, v);
      }
    }
  }
  return { dist, prev };
}

type Shortest = (src: number) => DijkstraResult;

// LRU cache of full Dijkstra results keyed by source node. The cap needs
// headroom for the largest routes: an 80-stop build touches ~80 sources
// during 2-opt and leg assembly, and thrashing means recomputing them.
function makeDijkstraCache(graph: Graph, cap = 128): Shortest {
  const cache = new Map<number, DijkstraResult>();
  return (src) => {
    if (cache.has(src)) {
      const hit = cache.get(src)!; // has() checked above
      cache.delete(src);
      cache.set(src, hit);
      return hit;
    }
    const result = dijkstra(graph, src);
    cache.set(src, result);
    if (cache.size > cap) cache.delete(cache.keys().next().value!); // size > cap, so a key exists
    return result;
  };
}

// ---------- Routing ----------

// The seed is any node on the network (a sign's node, or the node nearest a
// geolocation/address). A sign sitting exactly at the seed is simply the
// first greedy pick at 0 m. With `loop`, the route returns to the seed and
// the budget covers the leg home.
//
// The build is split into pieces so the UI can narrate and animate it:
// greedy draft first, then a 2-opt generator that yields after every
// accepted improvement.

type RowFor = (node: number) => Float32Array;

// Per-build cache of "distance from node X to every sign" rows.
function makeRows(graph: Graph, shortest: Shortest): RowFor {
  const rows = new Map<number, Float32Array>();
  return (node) => {
    if (!rows.has(node)) {
      const { dist } = shortest(node);
      const row = new Float32Array(graph.signs.length);
      for (let j = 0; j < graph.signs.length; j++) row[j] = dist[graph.signs[j].n];
      rows.set(node, row);
    }
    return rows.get(node)!; // set just above when missing
  };
}

interface BuildOpts {
  maxMeters: number;
  maxCount: number;
  excluded: Set<number>;
  loop: boolean;
}

// Greedy: extend an existing stop order (possibly empty) by repeatedly
// walking to the nearest sign that still fits the budget (including, for
// loops, the return leg home; the undirected graph makes the seed's own
// row double as "distance home"). Mutates stopSigns; also used to refill
// budget freed up by 2-opt.
function greedyExtend(graph: Graph, rowFor: RowFor, seedNode: number, stopSigns: number[], spentMeters: number, { maxMeters, maxCount, excluded, loop }: BuildOpts): number {
  const { signs } = graph;
  const homeRow = rowFor(seedNode);
  const used = new Set(stopSigns);
  const todo = new Set<number>();
  for (let i = 0; i < signs.length; i++) {
    if (!excluded.has(i) && !used.has(i)) todo.add(i);
  }

  let total = spentMeters;
  let cursor = stopSigns.length ? signs[stopSigns[stopSigns.length - 1]].n : seedNode;
  let added = 0;
  while (todo.size && stopSigns.length < maxCount) {
    const row = rowFor(cursor);
    let best = -1, bestD = Infinity;
    for (const c of todo) {
      if (row[c] >= bestD) continue;
      if (total + row[c] + (loop ? homeRow[c] : 0) > maxMeters) continue;
      bestD = row[c];
      best = c;
    }
    if (best < 0 || !isFinite(bestD)) break;
    stopSigns.push(best);
    todo.delete(best);
    total += bestD;
    added++;
    cursor = signs[best].n;
  }
  return added;
}

// Path length of a stop order, with and without the loop leg home.
function routeTotals(graph: Graph, rowFor: RowFor, seedNode: number, stopSigns: number[], loop: boolean): { pathMeters: number; totalMeters: number } {
  const homeRow = rowFor(seedNode);
  let pathMeters = 0;
  let prevNode = seedNode;
  for (const si of stopSigns) {
    pathMeters += rowFor(prevNode)[si];
    prevNode = graph.signs[si].n;
  }
  const home = loop && stopSigns.length ? homeRow[stopSigns[stopSigns.length - 1]] : 0;
  return { pathMeters, totalMeters: pathMeters + home };
}

interface Candidate {
  stopSigns: number[];
  pathMeters: number;
  totalMeters: number;
}

// Multi-start: greedy is myopic about its opening move, so run it once for
// each of the k nearest viable first signs and let the results race.
// Duplicates (openers that converge to the same route) are dropped.
function buildCandidates(graph: Graph, rowFor: RowFor, seedNode: number, opts: BuildOpts, k = 4): Candidate[] {
  const homeRow = rowFor(seedNode);
  const openers: [number, number][] = [];
  for (let i = 0; i < graph.signs.length; i++) {
    if (opts.excluded.has(i)) continue;
    const d = homeRow[i];
    if (!isFinite(d) || d + (opts.loop ? homeRow[i] : 0) > opts.maxMeters) continue;
    openers.push([d, i]);
  }
  openers.sort((a, b) => a[0] - b[0]);

  const dedupe = new Set<string>();
  const candidates: Candidate[] = [];
  for (const [d, first] of openers.slice(0, k)) {
    const stopSigns = [first];
    greedyExtend(graph, rowFor, seedNode, stopSigns, d, opts);
    const key = stopSigns.join(",");
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    candidates.push({ stopSigns, ...routeTotals(graph, rowFor, seedNode, stopSigns, opts.loop) });
  }
  return candidates;
}

// 2-opt with the seed as a fixed anchor: reverse segments while the path
// (plus the leg home, when looping) gets shorter. Mutates stopSigns and
// yields after each accepted reversal so the caller can animate it.
function* twoOptSteps(graph: Graph, rowFor: RowFor, seedNode: number, stopSigns: number[], loop: boolean): Generator<{ pass: number; saved: number }> {
  const { signs } = graph;
  const homeRow = rowFor(seedNode);
  const nodeOf = (p: number) => (p < 0 ? seedNode : signs[stopSigns[p]].n);
  const D = (p: number, signPos: number) => rowFor(nodeOf(p))[stopSigns[signPos]];
  let saved = 0;
  for (let pass = 1; pass <= 10; pass++) {
    let improved = false;
    for (let i = 0; i < stopSigns.length - 1; i++) {
      for (let j = i + 1; j < stopSigns.length; j++) {
        let delta = D(i - 1, j) - D(i - 1, i);
        if (j + 1 < stopSigns.length) delta += D(i, j + 1) - D(j, j + 1);
        else if (loop) delta += homeRow[stopSigns[i]] - homeRow[stopSigns[j]];
        if (delta < -0.01) {
          let lo = i, hi = j;
          while (lo < hi) { const t = stopSigns[lo]; stopSigns[lo++] = stopSigns[hi]; stopSigns[hi--] = t; }
          saved -= delta;
          improved = true;
          yield { pass, saved };
        }
      }
    }
    if (!improved) break;
  }
}

// Street-node path for the current stop order: one leg per stop, walking
// prev[] back from each leg's end, plus the leg home when looping.
function legsForOrder(graph: Graph, shortest: Shortest, seedNode: number, stopSigns: number[], loop: boolean): number[][] {
  const targets = stopSigns.map((si) => graph.signs[si].n);
  if (loop && stopSigns.length) targets.push(seedNode);
  const legs: number[][] = [];
  let from = seedNode;
  for (const to of targets) {
    const { prev } = shortest(from);
    const leg: number[] = [];
    for (let v = to; v !== -1; v = prev[v]) leg.push(v);
    leg.reverse();
    legs.push(leg);
    from = to;
  }
  return legs;
}

// ---------- View ----------

type Seed = { node: number; label: string; isSign: boolean };
type ActiveRoute = { stopSigns: number[]; totalMeters: number; pathNodes: number[]; shown?: number };

// Address-search result rows: either a sign match or a geocoded place.
type AddrItem =
  | { label: string; sub?: string; sign: NetworkSign; coords?: undefined }
  | { label: string; sub?: string; sign?: undefined; coords: LonLat };

export interface RoutePlanner {
  load(): Promise<void>;
  show(): void;
  hide(): void;
}

export function createRoutePlanner({ store, showToast }: { store: Store; showToast: (msg: string) => void }): RoutePlanner {
  const els = {
    view: el("routeView"),
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
    budgetLabel: el("budgetLabel"),
    skipSeen: el<HTMLInputElement>("skipSeen"),
    loopBack: el<HTMLInputElement>("loopBack"),
    summary: el("routeSummary"),
    actions: el("routeActions"),
    exportGpx: el("exportGpx"),
    stopsToggle: el<HTMLButtonElement>("stopsToggle"),
    stops: el("routeStops"),
  };
  const ctx2d = els.canvas.getContext("2d");
  if (!ctx2d) throw new Error("no 2d context");
  const ctx = ctx2d; // non-null binding so closures below see it narrowed

  let graph: Graph | null = null;
  let shortest: Shortest | null = null;
  let streetsPath: Path2D | null = null; // Path2D in world coords
  let connectorsPath: Path2D | null = null; // sign-access stubs, drawn fainter than roads
  let loadPromise: Promise<void> | null = null;

  // View state: world center + pixels per world unit.
  const view = { cx: 0, cy: 0, scale: 1, fitScale: 1 };
  let seed: Seed | null = null; // { node, label, isSign }
  let route: ActiveRoute | null = null;
  let routePath: Path2D | null = null; // Path2D in world coords
  let race: { path: Path2D; color: string; alpha: number }[] | null = null; // [{ path, color, alpha }] while candidate routes race
  let mode: "distance" | "count" = "distance"; // or "count"
  let needsDraw = false;

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

  const STEP_TITLES: Record<"intro" | "start", string> = { intro: "Plan a sign run", start: "Where are you starting?" };

  function setStep(step: "intro" | "start" | "plan") {
    els.stepIntro.hidden = step !== "intro";
    els.stepStart.hidden = step !== "start";
    els.stepPlan.hidden = step !== "plan";
    els.hint.hidden = step === "intro";
    if (step === "start") els.hint.textContent = "You can also just tap a sign dot";
    if (step === "plan" && seed) els.hint.textContent = `Starting at ${seed.label}`;
    // Intro/start need their controls; the plan step manages the drawer
    // itself (rebuild collapses it so the build animation gets the map).
    if (step !== "plan") {
      els.drawerTitle.textContent = STEP_TITLES[step];
      setDrawer(true);
    }
  }

  function currentStep() {
    if (!els.stepIntro.hidden) return "intro";
    if (!els.stepStart.hidden) return "start";
    return "plan";
  }

  function setSeed(next: Seed) {
    seed = next;
    els.seedLabel.textContent = seed.label;
    try { localStorage.setItem(INTRO_KEY, "1"); } catch {}
    setStep("plan");
    rebuild();
  }

  els.introGo.addEventListener("click", () => {
    try { localStorage.setItem(INTRO_KEY, "1"); } catch {}
    setStep("start");
  });

  els.changeStart.addEventListener("click", () => {
    seed = null;
    route = null;
    routePath = null;
    race = null;
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
          // Sign nodes are leaves hanging off the road network via short
          // access edges (see build_network.py); split those out so they
          // don't read as streets.
          const signNodes = new Set(graph.signs.map((s) => s.n));
          streetsPath = new Path2D();
          connectorsPath = new Path2D();
          for (let e = 0; e < graph.edgeCount; e++) {
            const a = graph.edges[e * 3], b = graph.edges[e * 3 + 1];
            const path = signNodes.has(a) || signNodes.has(b) ? connectorsPath : streetsPath;
            path.moveTo(graph.xs[a], graph.ys[a]);
            path.lineTo(graph.xs[b], graph.ys[b]);
          }
          els.loading.hidden = true;
          fitToSigns();
          scheduleDraw();
        })
        .catch((err) => {
          console.error(err);
          els.loading.textContent = "Couldn't load the street network. Check your connection and refresh.";
        });
    }
    return loadPromise;
  }

  function fitToSigns() {
    if (!graph) return;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const s of graph.signs) {
      const x = graph.xs[s.n], y = graph.ys[s.n];
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    const w = els.canvas.clientWidth || innerWidth;
    const h = els.canvas.clientHeight || innerHeight;
    view.cx = (xMin + xMax) / 2;
    view.cy = (yMin + yMax) / 2;
    view.fitScale = 0.92 * Math.min(w / (xMax - xMin), h / (yMax - yMin));
    view.scale = view.fitScale;
  }

  // Zoom to a set of path nodes, framed in the canvas area the card leaves free.
  function fitToNodes(nodes: number[]) {
    if (!graph) return;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const n of nodes) {
      const x = graph.xs[n], y = graph.ys[n];
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
    view.scale = Math.min(0.85 * Math.min(availW / spanX, availH / spanY), view.fitScale * 200);
    view.cx = (xMin + xMax) / 2 + (w / 2 - availW / 2) / view.scale;
    view.cy = (yMin + yMax) / 2 + (headerPx + availH / 2 - h / 2) / view.scale;
  }

  // ---------- Rendering ----------

  function resize() {
    const dpr = devicePixelRatio || 1;
    const w = els.canvas.clientWidth, h = els.canvas.clientHeight;
    if (els.canvas.width !== w * dpr || els.canvas.height !== h * dpr) {
      els.canvas.width = w * dpr;
      els.canvas.height = h * dpr;
    }
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

  function drawBadge(sx: number, sy: number, text: string, fill: string, textFill: string) {
    ctx.beginPath();
    ctx.arc(sx, sy, 10, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = textFill;
    ctx.font = "700 11px 'Nunito Sans', sans-serif";
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

    // Streets (and the route) stroke in world coordinates.
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(view.scale, -view.scale);
    ctx.translate(-view.cx, -view.cy);
    if (connectorsPath) {
      ctx.lineWidth = 0.8 / view.scale;
      ctx.strokeStyle = COLORS.connector;
      ctx.stroke(connectorsPath);
    }
    ctx.lineWidth = 1.1 / view.scale;
    ctx.strokeStyle = COLORS.street;
    ctx.stroke(streetsPath);
    if (routePath) {
      ctx.lineWidth = 4 / view.scale;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = COLORS.route;
      ctx.stroke(routePath);
    }
    ctx.restore();

    // Signs in screen space so dot sizes stay honest across zooms. Zoomed
    // out the dots pile up, so they go translucent and fill one by one -
    // overlaps stack into a rough density map - ramping back to solid
    // (and a batched single fill) as the view zooms in.
    const r = Math.max(2.5, Math.min(9, view.scale / 1400));
    const dotAlpha = Math.min(1, 0.3 + 0.7 * Math.max(0, view.scale / view.fitScale - 1.2) / 4);
    const unseenPts: number[] = [];
    const seenPts: number[] = [];
    for (const s of graph.signs) {
      const [sx, sy] = toScreen(graph.xs[s.n], graph.ys[s.n]);
      if (sx < -20 || sy < -20 || sx > w + 20 || sy > h + 20) continue;
      (store.isSeen(s.id) ? seenPts : unseenPts).push(sx, sy);
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
    fillDots(unseenPts, COLORS.unseen);

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

    // Start anchor, unless the first stop sits exactly on it.
    if (seed) {
      const firstStopNode = route?.stopSigns.length ? graph.signs[route.stopSigns[0]].n : -1;
      if (firstStopNode !== seed.node) {
        const [sx, sy] = toScreen(graph.xs[seed.node], graph.ys[seed.node]);
        drawBadge(sx, sy, "S", COLORS.seed, COLORS.route);
      }
    }

    // Route stops: numbered, in visit order. During the build animation
    // `shown` limits badges to the stops collected so far.
    if (route) {
      const count = route.shown ?? route.stopSigns.length;
      for (let i = 0; i < count; i++) {
        const s = graph.signs[route.stopSigns[i]];
        const [sx, sy] = toScreen(graph.xs[s.n], graph.ys[s.n]);
        const isStart = i === 0 && s.n === seed?.node;
        drawBadge(sx, sy, String(i + 1), isStart ? COLORS.seed : COLORS.route, isStart ? COLORS.route : "#fff");
      }
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
    if (!graph) return;
    let best = -1, bestD = 22 * 22;
    for (let i = 0; i < graph.signs.length; i++) {
      const [sx, sy] = toScreen(graph.xs[graph.signs[i].n], graph.ys[graph.signs[i].n]);
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      const s = graph.signs[best];
      setSeed({ node: s.n, label: s.addr, isSign: true });
    }
  }

  // ---------- Start step: geolocation + address search ----------

  // Nearest network node to a lon/lat, and roughly how far away it is.
  function nearestNode(lon: number, lat: number) {
    if (!graph) return { node: 0, meters: Infinity }; // unreachable pre-load guard
    const x = lon * graph.kx, y = lat;
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
    setSeed({ node, label, isSign: false });
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

  // Address search: instant matches over sign addresses, Photon places after
  // a pause (same service and area bias as the map tab's search).
  let addrDebounce: ReturnType<typeof setTimeout> | null = null;
  let photonAbort: AbortController | null = null;

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
        if (item.sign) setSeed({ node: item.sign.n, label: item.sign.addr, isSign: true });
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
    for (const s of graph.signs) {
      if (s.addr.toLowerCase().includes(nq)) {
        out.push({ label: s.addr, sub: "sign", sign: s });
        if (out.length >= 4) break;
      }
    }
    return out;
  }

  els.addrInput.addEventListener("input", () => {
    const q = els.addrInput.value.trim();
    clearTimeout(addrDebounce ?? undefined);
    photonAbort?.abort();
    if (q.length < 2 || !graph) {
      els.addrResults.hidden = true;
      return;
    }
    const locals = localAddrMatches(q);
    renderAddrResults(locals);
    if (q.length < 3) return;
    addrDebounce = setTimeout(async () => {
      photonAbort = new AbortController();
      const url = `${PHOTON_URL}?q=${encodeURIComponent(q)}&lat=${AREA.lat}&lon=${AREA.lon}&bbox=${AREA.bbox}&limit=4`;
      try {
        const res = await fetch(url, { signal: photonAbort.signal });
        if (!res.ok) return;
        const data = (await res.json()) as PhotonResponse;
        if (els.addrInput.value.trim() !== q) return; // stale
        const places = (data.features ?? []).map((f) => {
          const p = f.properties;
          const street = p.street && p.housenumber ? `${p.housenumber} ${p.street}` : p.street;
          return {
            label: p.name ?? street ?? "Unknown place",
            sub: [street !== p.name ? street : null, p.city ?? p.district].filter(Boolean).join(", "),
            coords: f.geometry.coordinates,
          };
        });
        renderAddrResults([...locals, ...places]);
      } catch (e) {
        if (!(e instanceof Error) || e.name !== "AbortError") console.warn("Photon search failed", e);
      }
    }, 300);
  });

  // ---------- Budget controls ----------

  function sliderConfig() {
    if (mode === "distance") {
      Object.assign(els.slider, { min: 0.5, max: 15, step: 0.5 });
      if (+els.slider.value > 15) els.slider.value = "3";
    } else {
      Object.assign(els.slider, { min: 5, max: 100, step: 5 });
      if (+els.slider.value < 5) els.slider.value = "20";
    }
  }

  function budgetText() {
    return mode === "distance" ? `${(+els.slider.value).toFixed(1)} km` : `${els.slider.value} signs`;
  }

  function setMode(next: "distance" | "count") {
    mode = next;
    els.modeDistance.classList.toggle("is-active", mode === "distance");
    els.modeCount.classList.toggle("is-active", mode === "count");
    const keep = els.slider.value;
    sliderConfig();
    if (mode === "distance" && !(+keep >= 0.5 && +keep <= 15)) els.slider.value = "3";
    if (mode === "count" && !(+keep >= 5 && +keep <= 100)) els.slider.value = "20";
    els.budgetLabel.textContent = budgetText();
    rebuild();
  }

  els.modeDistance.addEventListener("click", () => setMode("distance"));
  els.modeCount.addEventListener("click", () => setMode("count"));
  els.slider.addEventListener("input", () => { els.budgetLabel.textContent = budgetText(); });
  els.slider.addEventListener("change", rebuild);
  els.skipSeen.addEventListener("change", rebuild);
  els.loopBack.addEventListener("change", rebuild);
  store.onSeenChange(() => scheduleDraw());

  // ---------- Build + result ----------

  let buildGen = 0;

  function pathFromNodes(nodes: number[]): Path2D {
    const p = new Path2D();
    if (!graph) return p;
    const g = graph;
    nodes.forEach((n, i) => {
      if (i === 0) p.moveTo(g.xs[n], g.ys[n]);
      else p.lineTo(g.xs[n], g.ys[n]);
    });
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

  function setBuilding(on: boolean) {
    els.summary.classList.toggle("building", on);
    els.drawerTitle.classList.toggle("building", on);
  }

  function appendLeg(path: Path2D, leg: number[], isFirst: boolean) {
    if (!graph) return;
    for (let k = 0; k < leg.length; k++) {
      const n = leg[k];
      if (isFirst && k === 0) path.moveTo(graph.xs[n], graph.ys[n]);
      else path.lineTo(graph.xs[n], graph.ys[n]);
    }
  }

  function rebuild() {
    if (!seed || !graph) return;
    const gen = ++buildGen;
    race = null;
    setBuilding(true);
    setStatus("Measuring the streets nearby...");
    els.stops.hidden = true;
    els.actions.hidden = true;
    // The drawer stays open so the budget controls remain tweakable on
    // phones; with the stops list hidden it is short enough that the build
    // animation still gets most of the map.
    // Let the status paint before the synchronous Dijkstra work starts.
    setTimeout(() => runBuild(gen).catch(console.error), 30);
  }

  // The narrated build: race a few greedy starts against each other, keep
  // the winner, watch 2-opt untangle it, then spend any budget the
  // optimizer freed up on extra signs.
  async function runBuild(gen: number) {
    const alive = () => gen === buildGen && !!seed && !!graph;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    if (!alive()) return;
    // alive() just guaranteed these; re-check so TS narrows, and capture
    // non-null bindings for the closures below.
    if (!seed || !graph || !shortest) return;
    const g = graph, short = shortest, seedNode = seed.node;

    const excluded = new Set<number>();
    if (els.skipSeen.checked) {
      for (let i = 0; i < graph.signs.length; i++) {
        if (store.isSeen(graph.signs[i].id)) excluded.add(i);
      }
    }
    const loop = els.loopBack.checked;
    const opts = {
      maxMeters: mode === "distance" ? +els.slider.value * 1000 : Infinity,
      maxCount: mode === "count" ? +els.slider.value : Infinity,
      excluded,
      loop,
    };
    const rowFor = makeRows(graph, shortest);
    const candidates = buildCandidates(graph, rowFor, seed.node, opts);
    if (!alive()) return;
    if (!candidates.length) {
      setBuilding(false);
      setStatus("No reachable signs fit that budget - loosen it or pick another start.");
      route = null;
      routePath = null;
      scheduleDraw();
      return;
    }

    // More signs wins; fewer meters breaks ties.
    let winnerIdx = 0;
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i], w = candidates[winnerIdx];
      if (c.stopSigns.length > w.stopSigns.length ||
          (c.stopSigns.length === w.stopSigns.length && c.totalMeters < w.totalMeters)) {
        winnerIdx = i;
      }
    }
    const candLegs = candidates.map((c) => legsForOrder(g, short, seedNode, c.stopSigns, loop));

    route = null;
    routePath = null;
    fitToNodes(candLegs.flat(2));
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
        await sleep(delay);
        if (!alive()) return;
      }

      // Phase 2: declare the winner, fade the rest.
      const w = candidates[winnerIdx];
      setStatus(`Route ${String.fromCharCode(65 + winnerIdx)} wins - ${w.stopSigns.length} signs, ${(w.totalMeters / 1000).toFixed(1)} km`);
      await sleep(500);
      if (!alive()) return;
      for (let step = 0; step < 8; step++) {
        race.forEach((c, i) => { if (i !== winnerIdx) c.alpha *= 0.62; });
        scheduleDraw();
        await sleep(55);
        if (!alive()) return;
      }
      race = null;
      route = {
        stopSigns: candidates[winnerIdx].stopSigns,
        totalMeters: candidates[winnerIdx].totalMeters,
        pathNodes: candLegs[winnerIdx].flat(),
      };
      routePath = pathFromNodes(route.pathNodes);
      scheduleDraw();
      await sleep(400);
      if (!alive()) return;
    } else {
      // Single viable start: reveal it leg by leg instead.
      const stopSigns = candidates[0].stopSigns;
      const legs = candLegs[0];
      route = { stopSigns, totalMeters: candidates[0].totalMeters, pathNodes: legs.flat(), shown: 0 };
      routePath = new Path2D();
      const revealDelay = Math.min(120, Math.max(30, 1500 / legs.length));
      for (let i = 0; i < legs.length; i++) {
        appendLeg(routePath, legs[i], i === 0);
        route.shown = Math.min(i + 1, stopSigns.length);
        setStatus(
          loop && i === legs.length - 1
            ? "...and back to the start"
            : `Collecting signs... ${i + 1} of ${stopSigns.length}`
        );
        scheduleDraw();
        await sleep(revealDelay);
        if (!alive()) return;
      }
      route.shown = undefined;
    }

    // Phase 3+4, repeated: untangle with 2-opt, then spend whatever budget
    // the optimizer freed up on more signs, until neither helps.
    const stopSigns = route.stopSigns;
    const rt = route;
    const refreshRoute = () => {
      const totals = routeTotals(g, rowFor, seedNode, stopSigns, loop);
      rt.totalMeters = totals.totalMeters;
      rt.pathNodes = legsForOrder(g, short, seedNode, stopSigns, loop).flat();
      routePath = pathFromNodes(rt.pathNodes);
      return totals;
    };

    setStatus("Checking for crossings...");
    await sleep(450);
    if (!alive()) return;

    for (let round = 1; round <= 3; round++) {
      let untangled = false;
      for (const step of twoOptSteps(graph, rowFor, seed.node, stopSigns, loop)) {
        untangled = true;
        refreshRoute();
        setStatus(`Untangling the route - pass ${step.pass}, saved ${Math.round(step.saved)} m`);
        scheduleDraw();
        await sleep(90);
        if (!alive()) return;
      }
      if (round === 1 && !untangled) {
        setStatus("No crossings - clean route");
        scheduleDraw();
        await sleep(500);
        if (!alive()) return;
      }

      if (mode !== "distance") break;
      const totals = refreshRoute();
      const added = greedyExtend(graph, rowFor, seed.node, stopSigns, totals.pathMeters, opts);
      if (!added) break;
      refreshRoute();
      setStatus(`Leftover budget - adding ${added} more sign${added > 1 ? "s" : ""}...`);
      scheduleDraw();
      await sleep(700);
      if (!alive()) return;
    }

    refreshRoute();
    setBuilding(false);
    renderResult();
    fitToNodes(route.pathNodes);
    scheduleDraw();
  }

  // The stops list folds away behind its toggle so the open drawer stays
  // short on phones; wide screens have room, so it starts open there.
  function setStopsOpen(open: boolean) {
    els.stops.hidden = !open;
    els.stopsToggle.setAttribute("aria-expanded", String(open));
    const n = route ? route.stopSigns.length : 0;
    els.stopsToggle.textContent = open ? "Hide stops" : `Show ${n} stop${n === 1 ? "" : "s"}`;
  }
  els.stopsToggle.addEventListener("click", () => setStopsOpen(els.stops.hidden));

  function renderResult() {
    if (!route || !graph || !seed) return;
    const g = graph;
    const km = route.totalMeters / 1000;
    setStatus(`${route.stopSigns.length} signs · ${km.toFixed(1)} km · ~${Math.round(km * MIN_PER_KM)} min`);
    els.actions.hidden = false;
    els.stops.innerHTML = "";
    if (!seed.isSign) {
      const li = document.createElement("li");
      li.className = "stop-start";
      li.textContent = `Start - ${seed.label}`;
      els.stops.appendChild(li);
    }
    for (const si of route.stopSigns) {
      const s = graph.signs[si];
      const li = document.createElement("li");
      li.textContent = s.addr;
      if (store.isSeen(s.id)) li.classList.add("stop-seen");
      li.addEventListener("click", () => {
        view.cx = g.xs[s.n];
        view.cy = g.ys[s.n];
        view.scale = Math.max(view.scale, view.fitScale * 12);
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
    const lonOf = (n: number) => (g.xs[n] / g.kx).toFixed(6);
    const latOf = (n: number) => g.ys[n].toFixed(6);
    const km = (route.totalMeters / 1000).toFixed(1);
    const name = `Sign Safari - ${route.stopSigns.length} signs, ${km} km`;

    const wpts = route.stopSigns.map((si, i) => {
      const s = g.signs[si];
      return `  <wpt lat="${latOf(s.n)}" lon="${lonOf(s.n)}"><name>${i + 1}. ${xmlEscape(s.addr)}</name></wpt>`;
    });
    const trkpts = route.pathNodes.map(
      (n) => `      <trkpt lat="${latOf(n)}" lon="${lonOf(n)}"/>`
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
    a.download = `sign-safari-${route.stopSigns.length}-signs.gpx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showToast("GPX saved - import it as a course/route on your watch.");
  });

  // ---------- Lifecycle ----------

  new ResizeObserver(resize).observe(els.canvas);
  sliderConfig();
  els.budgetLabel.textContent = budgetText();

  let introSeen = false;
  try { introSeen = localStorage.getItem(INTRO_KEY) === "1"; } catch {}
  setStep(introSeen ? "start" : "intro");

  return {
    load,
    show() {
      els.view.hidden = false;
      if (currentStep() === "start" && !seed) els.hint.textContent = "You can also just tap a sign dot";
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
