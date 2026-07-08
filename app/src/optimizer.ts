// Pure route-optimization core: street-graph construction plus the routing
// passes, with no DOM or browser dependencies.
//
// Data comes from data/network.json (built by scripts/build_network.py):
//   nodes: [lon0, lat0, lon1, lat1, ...]
//   edges: [a, b, meters, ...] as node indices
//   signs: [{ id, addr, n }] where n indexes nodes
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

import type { NetworkData, NetworkSign } from "./types";

export const MIN_PER_KM = 12; // casual walking pace
// Access stubs at or under this read as "visible from the street" and cost
// nothing; longer ones (paths into parks etc.) charge the round trip.
export const STUB_FREE_M = 50;
export const DEG_M = 111320; // meters per degree of latitude (and cos-corrected lon)

// ---------- Graph ----------

export interface Graph {
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

export function buildGraph(raw: NetworkData): Graph {
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

export interface DijkstraResult {
  dist: Float32Array;
  prev: Int32Array;
}

export function dijkstra(graph: Graph, src: number): DijkstraResult {
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

export type Shortest = (src: number) => DijkstraResult;

// LRU cache of full Dijkstra results keyed by source node. The cap needs
// headroom for the largest routes: an 80-stop build touches ~80 sources
// during 2-opt and leg assembly, and thrashing means recomputing them.
export function makeDijkstraCache(graph: Graph, cap = 128): Shortest {
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

export type RowFor = (node: number) => Float32Array;

// Per-build cache of "distance from node X to every sign's snap node" rows.
// Pure road distance: any stub charge rides in graph.stubExtra instead.
export function makeRows(graph: Graph, shortest: Shortest): RowFor {
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

export interface BuildOpts {
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
export function greedyExtend(graph: Graph, rowFor: RowFor, seedNode: number, stopSigns: number[], spentMeters: number, { maxMeters, maxCount, excluded, loop }: BuildOpts): number {
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
export function routeTotals(graph: Graph, rowFor: RowFor, seedNode: number, stopSigns: number[], loop: boolean): { pathMeters: number; totalMeters: number } {
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

export interface Candidate {
  stopSigns: number[];
  pathMeters: number;
  totalMeters: number;
}

// Multi-start: greedy is myopic about its opening move, so run it once for
// each of the k nearest viable first signs and let the results race.
// Duplicates (openers that converge to the same route) are dropped.
export function buildCandidates(graph: Graph, rowFor: RowFor, seedNode: number, opts: BuildOpts, k = 4): Candidate[] {
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
export function* twoOptSteps(graph: Graph, rowFor: RowFor, seedNode: number, stopSigns: number[], loop: boolean): Generator<{ pass: number; saved: number }> {
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
export function legsForOrder(graph: Graph, shortest: Shortest, seedNode: number, stopSigns: number[], loop: boolean): number[][] {
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
export function sweepOnRoute(graph: Graph, shortest: Shortest, seedNode: number, stopSigns: number[], excluded: Set<number>, loop: boolean): number {
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
export function wiggleExtend(graph: Graph, rowFor: RowFor, seedNode: number, stopSigns: number[], { maxMeters, maxCount, excluded, loop }: BuildOpts, slackMeters: number): number {
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
