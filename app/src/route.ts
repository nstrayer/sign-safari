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
// 2-opt to untangle the visiting order, a sweep that pulls in signs the
// path already walks past, and a stretch pass that runs slightly over
// budget when a short detour buys more signs.
//
// Signs are measured at their street snap node: a lawn sign is seen from
// the road, so the access stub isn't real walking (unless it's long -
// see STUB_FREE_M).

import { dataUrl } from "./data";
import { el } from "./dom";
import { createGeocoder } from "./geocoder";
import type { LonLat, NetworkData, NetworkSign } from "./types";
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
// Access stubs at or under this read as "visible from the street" and cost
// nothing; longer ones (paths into parks etc.) charge the round trip.
const STUB_FREE_M = 50;
const DEG_M = 111320; // meters per degree of latitude (and cos-corrected lon)

// ---------- Graph ----------

interface Graph {
  nodeCount: number;
  edgeCount: number;
  kx: number;
  x0: number; // world-coord center offsets; see buildGraph
  y0: number;
  xs: Float64Array;
  ys: Float64Array;
  off: Int32Array;
  adj: Int32Array;
  wt: Float32Array;
  edges: number[];
  signs: NetworkSign[];
  snap: Int32Array; // per sign: the street node its access stub hangs from
  stubExtra: Float32Array; // per sign: round-trip stub charge, 0 when short
}

function buildGraph(raw: NetworkData): Graph {
  const nodeCount = raw.nodes.length / 2;
  const edgeCount = raw.edges.length / 3;

  // World coords: equirectangular, lon squished by cos(mid latitude) so
  // shapes and the pinch-zoom aspect look right. Centered near 0 because
  // canvas rasterizers transform points in float32: raw lon*kx (~ -62)
  // leaves so little mantissa that strokes vanish entirely at deep zoom.
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (let i = 0; i < nodeCount; i++) {
    const lon = raw.nodes[i * 2], lat = raw.nodes[i * 2 + 1];
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  }
  const kx = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
  const x0 = ((lonMin + lonMax) / 2) * kx;
  const y0 = (latMin + latMax) / 2;
  const xs = new Float64Array(nodeCount);
  const ys = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    xs[i] = raw.nodes[i * 2] * kx - x0;
    ys[i] = raw.nodes[i * 2 + 1] - y0;
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

  // Each sign hangs off the road as a leaf via one access stub. Route math
  // measures signs at the stub's street end (the snap node): you see a lawn
  // sign from the street, so short stubs cost nothing. Long stubs keep a
  // round-trip charge so far-off signs don't ride in for free.
  const snap = new Int32Array(raw.signs.length);
  const stubExtra = new Float32Array(raw.signs.length);
  for (let j = 0; j < raw.signs.length; j++) {
    const n = raw.signs[j].n;
    if (off[n + 1] - off[n] === 1) {
      snap[j] = adj[off[n]];
      const stub = wt[off[n]];
      if (stub > STUB_FREE_M) stubExtra[j] = stub * 2;
    } else {
      snap[j] = n; // not a simple leaf; measure at the sign itself
    }
  }

  return { nodeCount, edgeCount, kx, x0, y0, xs, ys, off, adj, wt, edges: raw.edges, signs: raw.signs, snap, stubExtra };
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

// Per-build cache of "distance from node X to every sign's snap node" rows.
// Pure road distance: any stub charge rides in graph.stubExtra instead.
function makeRows(graph: Graph, shortest: Shortest): RowFor {
  const rows = new Map<number, Float32Array>();
  return (node) => {
    if (!rows.has(node)) {
      const { dist } = shortest(node);
      const row = new Float32Array(graph.signs.length);
      for (let j = 0; j < graph.signs.length; j++) row[j] = dist[graph.snap[j]];
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
  const { signs, snap, stubExtra } = graph;
  const homeRow = rowFor(seedNode);
  const used = new Set(stopSigns);
  const todo = new Set<number>();
  for (let i = 0; i < signs.length; i++) {
    if (!excluded.has(i) && !used.has(i)) todo.add(i);
  }

  let total = spentMeters;
  let cursor = stopSigns.length ? snap[stopSigns[stopSigns.length - 1]] : seedNode;
  let added = 0;
  while (todo.size && stopSigns.length < maxCount) {
    const row = rowFor(cursor);
    let best = -1, bestD = Infinity;
    for (const c of todo) {
      const cost = row[c] + stubExtra[c];
      if (cost >= bestD) continue;
      if (total + cost + (loop ? homeRow[c] : 0) > maxMeters) continue;
      bestD = cost;
      best = c;
    }
    if (best < 0 || !isFinite(bestD)) break;
    stopSigns.push(best);
    todo.delete(best);
    total += bestD;
    added++;
    cursor = snap[best];
  }
  return added;
}

// Path length of a stop order, with and without the loop leg home.
function routeTotals(graph: Graph, rowFor: RowFor, seedNode: number, stopSigns: number[], loop: boolean): { pathMeters: number; totalMeters: number } {
  const homeRow = rowFor(seedNode);
  let pathMeters = 0;
  let prevNode = seedNode;
  for (const si of stopSigns) {
    pathMeters += rowFor(prevNode)[si] + graph.stubExtra[si];
    prevNode = graph.snap[si];
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
    const d = homeRow[i] + graph.stubExtra[i];
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
// Stub charges don't move under reversal, so pure road rows suffice.
function* twoOptSteps(graph: Graph, rowFor: RowFor, seedNode: number, stopSigns: number[], loop: boolean): Generator<{ pass: number; saved: number }> {
  const { snap } = graph;
  const homeRow = rowFor(seedNode);
  const nodeOf = (p: number) => (p < 0 ? seedNode : snap[stopSigns[p]]);
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
  const targets = stopSigns.map((si) => graph.snap[si]);
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

// Signs whose snap node already lies on the walked path ride along free:
// splice each into the stop order at the point the route passes it.
// Mutates stopSigns; returns how many came aboard.
function sweepOnRoute(graph: Graph, shortest: Shortest, seedNode: number, stopSigns: number[], excluded: Set<number>, loop: boolean): number {
  const legs = legsForOrder(graph, shortest, seedNode, stopSigns, loop);
  // First place each path node appears, keyed as leg * 1e6 + position.
  const firstAt = new Map<number, number>();
  legs.forEach((leg, li) => leg.forEach((n, p) => {
    if (!firstAt.has(n)) firstAt.set(n, li * 1e6 + p);
  }));
  const used = new Set(stopSigns);
  const picks: [number, number][] = []; // [orderKey, sign]
  for (let c = 0; c < graph.signs.length; c++) {
    if (used.has(c) || excluded.has(c) || graph.stubExtra[c] > 0) continue;
    const key = firstAt.get(graph.snap[c]);
    if (key !== undefined) picks.push([key, c]);
  }
  if (!picks.length) return 0;
  picks.sort((a, b) => a[0] - b[0]);
  // Rebuild the order leg by leg; leg li ends at stop li, so its swept
  // signs slot in just before it (home-leg signs land after the last stop).
  const out: number[] = [];
  let pi = 0;
  for (let li = 0; li < legs.length; li++) {
    while (pi < picks.length && Math.floor(picks[pi][0] / 1e6) === li) out.push(picks[pi++][1]);
    if (li < stopSigns.length) out.push(stopSigns[li]);
  }
  stopSigns.length = 0;
  stopSigns.push(...out);
  return picks.length;
}

// Stretch pass: once the route has settled, keep inserting the leftover
// sign with the cheapest best-position detour, letting the total run up to
// slackMeters past the budget - a slightly longer walk that bags more
// signs. Mutates stopSigns; returns how many were added.
function wiggleExtend(graph: Graph, rowFor: RowFor, seedNode: number, stopSigns: number[], { maxMeters, maxCount, excluded, loop }: BuildOpts, slackMeters: number): number {
  const { signs, snap, stubExtra } = graph;
  const cap = maxMeters + slackMeters;
  let total = routeTotals(graph, rowFor, seedNode, stopSigns, loop).totalMeters;
  const used = new Set(stopSigns);
  let added = 0;
  while (stopSigns.length < maxCount) {
    // Route anchors in walk order: seed, each stop's snap node, and the
    // seed again when looping. Gap g sits between anchors g and g+1;
    // dist(anchor, stop k) is just that anchor's row at k.
    const anchors = [seedNode];
    for (const si of stopSigns) anchors.push(snap[si]);
    if (loop) anchors.push(seedNode);
    const rows = anchors.map((n) => rowFor(n));
    const gapLen = (g: number) =>
      g < stopSigns.length ? rows[g][stopSigns[g]] : rows[g + 1][stopSigns[g - 1]];

    let best = -1, bestGap = -1, bestDelta = Infinity;
    for (let c = 0; c < signs.length; c++) {
      if (used.has(c) || excluded.has(c)) continue;
      for (let g = 0; g < anchors.length - 1; g++) {
        const delta = rows[g][c] + rows[g + 1][c] - gapLen(g) + stubExtra[c];
        if (delta < bestDelta) { bestDelta = delta; bestGap = g; best = c; }
      }
      if (!loop) {
        // Open-ended route: tacking c onto the tail is also fair game.
        const delta = rows[rows.length - 1][c] + stubExtra[c];
        if (delta < bestDelta) { bestDelta = delta; bestGap = stopSigns.length; best = c; }
      }
    }
    if (best < 0 || !isFinite(bestDelta) || total + bestDelta > cap) break;
    stopSigns.splice(bestGap, 0, best);
    used.add(best);
    total += bestDelta;
    added++;
  }
  return added;
}

// ---------- Walkthrough helpers ----------

function fmtMeters(m: number): string {
  return m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}

// Coarse compass direction for a world-coord delta (x east, y north).
function compassDir(dx: number, dy: number): string {
  const names = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return names[Math.round(((deg + 360) % 360) / 45) % 8];
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
    shareRoute: el<HTMLButtonElement>("shareRoute"),
    stopsToggle: el<HTMLButtonElement>("stopsToggle"),
    stops: el("routeStops"),
    walkStart: el<HTMLButtonElement>("walkStart"),
    stepWalk: el("stepWalk"),
    walkProgress: el("walkProgress"),
    walkAddr: el("walkAddr"),
    walkDist: el("walkDist"),
    walkDone: el<HTMLButtonElement>("walkDone"),
    walkSkip: el<HTMLButtonElement>("walkSkip"),
    walkEnd: el<HTMLButtonElement>("walkEnd"),
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

  // Walkthrough mode: `at` indexes the next leg to walk (legs run one per
  // stop, plus the leg home when looping, matching legsForOrder).
  let walk: { at: number; legs: number[][] } | null = null;
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

  const STEP_TITLES: Record<"intro" | "start", string> = { intro: "Plan a sign run", start: "Where are you starting?" };

  function setStep(step: "intro" | "start" | "plan" | "walk") {
    els.stepIntro.hidden = step !== "intro";
    els.stepStart.hidden = step !== "start";
    els.stepPlan.hidden = step !== "plan";
    els.stepWalk.hidden = step !== "walk";
    els.hint.hidden = step === "intro";
    if (step === "start") els.hint.textContent = "You can also just tap a sign dot";
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

  function setSeed(next: Seed) {
    seed = next;
    els.seedLabel.textContent = seed.label;
    store.setRouteIntroSeen();
    setStep("plan");
    rebuild();
  }

  els.introGo.addEventListener("click", () => {
    store.setRouteIntroSeen();
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
          applySharedRoute();
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

  // Zoom to a set of path nodes, framed in the canvas area the card leaves
  // free. maxZoom (in multiples of the whole-map fit) keeps short walk legs
  // from filling the screen with a single featureless block.
  function fitToNodes(nodes: number[], maxZoom = 200) {
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
    view.scale = Math.min(0.85 * Math.min(availW / spanX, availH / spanY), view.fitScale * maxZoom);
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
      ctx.strokeStyle = COLORS.route;
      // Walking: the full route fades back so the current leg pops.
      if (walk) ctx.globalAlpha = 0.25;
      ctx.stroke(routePath);
      ctx.globalAlpha = 1;
      if (walk && walkLegPath) {
        ctx.lineWidth = 5 / view.scale;
        ctx.strokeStyle = COLORS.unseen;
        ctx.stroke(walkLegPath);
      }
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

    // Start anchor, unless the first stop sits exactly on it. On the walk's
    // leg home it becomes the target, so it grows and goes coral.
    if (seed) {
      const walkingHome = !!walk && !!route && walk.at === route.stopSigns.length;
      const firstStopNode = route?.stopSigns.length ? graph.signs[route.stopSigns[0]].n : -1;
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
      const count = route.shown ?? route.stopSigns.length;
      for (let i = 0; i < count; i++) {
        const s = graph.signs[route.stopSigns[i]];
        const [sx, sy] = toScreen(graph.xs[s.n], graph.ys[s.n]);
        if (walk) {
          // Passed stops: green if found, gray if skipped past.
          if (i < walk.at) drawBadge(sx, sy, String(i + 1), store.isSeen(s.id) ? COLORS.seen : "#9aa0b5", "#fff");
          else if (i === walk.at) drawBadge(sx, sy, String(i + 1), COLORS.unseen, "#fff", 13);
          else drawBadge(sx, sy, String(i + 1), COLORS.route, "#fff");
          continue;
        }
        const isStart = i === 0 && s.n === seed?.node;
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
    if (!graph || walk) return; // mid-walk taps must not re-seed the route
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
    // A rebuilt route supersedes any shared one; drop the stale link hash.
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    const gen = ++buildGen;
    race = null;
    setBuilding(true);
    setStatus("Measuring the streets nearby...");
    els.stops.hidden = true;
    els.actions.hidden = true;
    els.walkStart.hidden = true;
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

    // Signs the walk already passes ride along free.
    const swept = sweepOnRoute(g, short, seedNode, stopSigns, excluded, loop);
    if (swept) {
      refreshRoute();
      setStatus(`Scooping up ${swept} sign${swept > 1 ? "s" : ""} already on the way...`);
      scheduleDraw();
      await sleep(700);
      if (!alive()) return;
    }

    // Stretch: run a little over budget when short detours buy more signs.
    if (mode === "distance") {
      const slack = Math.min(opts.maxMeters * 0.1, 1000);
      const stretched = wiggleExtend(g, rowFor, seedNode, stopSigns, opts, slack);
      if (stretched) {
        // Quietly re-untangle, then grab anything the reshuffled path passes.
        const cleanup = twoOptSteps(g, rowFor, seedNode, stopSigns, loop);
        while (!cleanup.next().done) { /* drain */ }
        const bonus = sweepOnRoute(g, short, seedNode, stopSigns, excluded, loop);
        refreshRoute();
        const n = stretched + bonus;
        setStatus(`Stretching a bit for ${n} more sign${n > 1 ? "s" : ""}...`);
        scheduleDraw();
        await sleep(700);
        if (!alive()) return;
      }
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
    els.walkStart.hidden = false;
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
    const lonOf = (n: number) => ((g.xs[n] + g.x0) / g.kx).toFixed(6);
    const latOf = (n: number) => (g.ys[n] + g.y0).toFixed(6);
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

  // ---------- Share link ----------

  // The whole route rides in the URL hash: stop order as stable sign ids
  // (indices shift when network.json is rebuilt), the seed as a sign id or
  // rounded lon/lat, and the loop flag. The recipient sees this exact
  // route - no re-optimizing against their own seen list.
  const SHARE_LIMIT = 200;

  // Serialized route (also what walk progress saves via store.saveWalk).
  function routeParams(): URLSearchParams | null {
    if (!route || !graph || !seed || route.stopSigns.length > SHARE_LIMIT) return null;
    const g = graph, sd = seed;
    const params = new URLSearchParams();
    params.set("r", route.stopSigns.map((si) => g.signs[si].id).join("."));
    const seedSign = sd.isSign ? g.signs.find((s) => s.n === sd.node) : undefined;
    params.set("s", seedSign ? seedSign.id : `${((g.xs[sd.node] + g.x0) / g.kx).toFixed(5)},${(g.ys[sd.node] + g.y0).toFixed(5)}`);
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

    const byId = new Map(g.signs.map((s, i) => [s.id, i]));
    const stopSigns: number[] = [];
    let missing = 0;
    for (const id of r.split(".").slice(0, SHARE_LIMIT)) {
      const idx = byId.get(id);
      if (idx === undefined) missing++;
      else stopSigns.push(idx);
    }
    if (!stopSigns.length) {
      showToast("That shared route doesn't match the current sign data.");
      return false;
    }

    const sParam = params.get("s") ?? "";
    let next: Seed | null = null;
    if (sParam.includes(",")) {
      const [lon, lat] = sParam.split(",").map(Number);
      if (isFinite(lon) && isFinite(lat)) {
        const { node, meters } = nearestNode(lon, lat);
        if (meters <= 2000) next = { node, label: "shared start", isSign: false };
      }
    } else {
      const idx = byId.get(sParam);
      if (idx !== undefined) next = { node: g.signs[idx].n, label: g.signs[idx].addr, isSign: true };
    }
    if (!next) {
      const first = g.signs[stopSigns[0]];
      next = { node: first.n, label: first.addr, isSign: true };
    }

    buildGen++; // cancel any build in flight
    const loop = params.get("l") === "1";
    els.loopBack.checked = loop;
    seed = next;
    els.seedLabel.textContent = seed.label;
    store.setRouteIntroSeen();

    const rowFor = makeRows(g, short);
    const totals = routeTotals(g, rowFor, seed.node, stopSigns, loop);
    route = {
      stopSigns,
      totalMeters: totals.totalMeters,
      pathNodes: legsForOrder(g, short, seed.node, stopSigns, loop).flat(),
    };
    routePath = pathFromNodes(route.pathNodes);
    race = null;
    setBuilding(false);
    setStep("plan");
    renderResult();
    fitToNodes(route.pathNodes);
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
    let m = 0;
    for (let i = 1; i < leg.length; i++) {
      m += Math.hypot(graph.xs[leg[i]] - graph.xs[leg[i - 1]], graph.ys[leg[i]] - graph.ys[leg[i - 1]]);
    }
    return m * DEG_M;
  }

  function updateWalkCard() {
    if (!walk || !route || !graph || !seed) return;
    const n = route.stopSigns.length;
    const home = walk.at >= n; // the loop's leg back to the start
    const targetNode = home ? seed.node : graph.signs[route.stopSigns[walk.at]].n;
    const addr = home ? `Back to ${seed.label}` : graph.signs[route.stopSigns[walk.at]].addr;

    let remaining = 0;
    for (let i = walk.at; i < walk.legs.length; i++) remaining += legMeters(walk.legs[i]);
    els.walkProgress.textContent = `${home ? "Last leg" : `Stop ${walk.at + 1} of ${n}`} · ${fmtMeters(remaining)} to go`;
    els.walkAddr.textContent = addr;

    if (herePos) {
      const dx = (graph.xs[targetNode] - herePos.x) * DEG_M;
      const dy = (graph.ys[targetNode] - herePos.y) * DEG_M;
      els.walkDist.textContent = `${fmtMeters(Math.hypot(dx, dy))} away - head ${compassDir(dx, dy)}`;
    } else {
      els.walkDist.textContent = `about ${fmtMeters(legMeters(walk.legs[walk.at]))} along the route`;
    }

    els.walkDone.textContent = home ? "Made it!" : "Found it!";
    els.walkSkip.hidden = home;
    const title = home ? `Head back - ${addr}` : `Stop ${walk.at + 1}/${n} - ${addr}`;
    els.drawerTitle.textContent = title;
    els.hint.textContent = title;
  }

  function focusWalkLeg() {
    if (!walk) return;
    walkLegPath = pathFromNodes(walk.legs[walk.at]);
    fitToNodes(walk.legs[walk.at], 60);
  }

  function enterWalk(at: number) {
    if (!route || !graph || !shortest || !seed) return;
    const legs = legsForOrder(graph, shortest, seed.node, route.stopSigns, els.loopBack.checked);
    if (at < 0 || at >= legs.length) {
      clearWalkSave(); // a stale save (data refresh shrank the route)
      return;
    }
    walk = { at, legs };
    setStep("walk");
    setDrawer(true);
    saveWalk();
    startGeoWatch();
    void requestWakeLock();
    focusWalkLeg();
    updateWalkCard();
    scheduleDraw();
  }

  function advanceWalk(found: boolean) {
    if (!walk || !route || !graph) return;
    if (found && walk.at < route.stopSigns.length) {
      const id = graph.signs[route.stopSigns[walk.at]].id;
      if (!store.isSeen(id)) store.toggle(id);
    }
    walk.at++;
    if (walk.at >= walk.legs.length) {
      const n = route.stopSigns.length;
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
    walkLegPath = null;
    herePos = null;
    clearWalkSave();
    setStep("plan");
    if (route) {
      renderResult();
      fitToNodes(route.pathNodes);
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
  els.walkDone.addEventListener("click", () => advanceWalk(true));
  els.walkSkip.addEventListener("click", () => advanceWalk(false));
  els.walkEnd.addEventListener("click", endWalk);

  // ---------- Lifecycle ----------

  new ResizeObserver(resize).observe(els.canvas);
  sliderConfig();
  els.budgetLabel.textContent = budgetText();

  setStep(store.routeIntroSeen() ? "start" : "intro");

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
