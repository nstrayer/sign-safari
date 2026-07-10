// Pure route-optimization core: street-graph construction plus constrained
// itinerary planning, with no DOM or browser dependencies.
//
// Data comes from data/network.json (built by scripts/build_network.py):
//   nodes: [lon0, lat0, lon1, lat1, ...]
//   edges: [a, b, meters, ...] as node indices
//   edgeGeometryOffsets / edgeGeometryDeltas: optional compact road shapes
//   stops: [{ id, addr, kind, n }] where n indexes nodes
//
// All routing runs client-side. Dijkstra supplies shortest paths between the
// immutable Start -> Necessary stops -> Finish anchors. Optional code
// locations are then inserted into individual anchor gaps while the complete
// itinerary remains within its hard distance cap.
//
// Stops are measured at their street snap node: a location is seen from
// the road, so the access stub isn't real walking (unless it's long -
// see STUB_FREE_M).

import type { LonLat, NetworkData, NetworkStop } from "./types";

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
  nodes: number[];
  edges: number[];
  /** Edge index by unordered endpoint pair; parallel edges use the lightest. */
  edgeByPair: Map<string, number>;
  /** Optional compact intermediate road geometry, parallel to `edges`. */
  edgeGeometryOffsets?: number[];
  edgeGeometryDeltas?: number[];
  stops: NetworkStop[];
  snap: Int32Array; // per stop: the street node its access stub hangs from
  stubExtra: Float32Array; // per stop: round-trip stub charge, 0 when short
}

function edgePairKey(a: number, b: number): string {
  return a <= b ? `${a}:${b}` : `${b}:${a}`;
}

/** Returns the serialized edge between two nodes, independent of direction. */
export function edgeIndex(graph: Graph, from: number, to: number): number | undefined {
  return graph.edgeByPair.get(edgePairKey(from, to));
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
  const edgeByPair = new Map<string, number>();
  const cur = off.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const a = raw.edges[e * 3], b = raw.edges[e * 3 + 1], w = raw.edges[e * 3 + 2];
    adj[cur[a]] = b; wt[cur[a]++] = w;
    adj[cur[b]] = a; wt[cur[b]++] = w;
    const key = edgePairKey(a, b);
    const existing = edgeByPair.get(key);
    // A node-only path cannot distinguish parallel edges. Match Dijkstra's
    // useful choice by retaining the lightest one (and the first on a tie).
    if (existing === undefined || w < raw.edges[existing * 3 + 2]) edgeByPair.set(key, e);
  }

  // Older network payloads have no geometry. Treat malformed optional data
  // the same way so a route remains usable as straight endpoint segments.
  const geometryIsValid = raw.edgeGeometryOffsets !== undefined &&
    raw.edgeGeometryDeltas !== undefined &&
    raw.edgeGeometryOffsets.length === edgeCount + 1 &&
    raw.edgeGeometryOffsets[0] === 0 &&
    raw.edgeGeometryOffsets[edgeCount] === raw.edgeGeometryDeltas.length;
  const edgeGeometryOffsets = geometryIsValid ? raw.edgeGeometryOffsets : undefined;
  const edgeGeometryDeltas = geometryIsValid ? raw.edgeGeometryDeltas : undefined;

  // Each routeable location hangs off the road as a leaf via one access
  // stub. Short stubs cost nothing; long stubs keep a round-trip charge so
  // far-off locations don't ride in for free.
  const snap = new Int32Array(raw.stops.length);
  const stubExtra = new Float32Array(raw.stops.length);
  for (let j = 0; j < raw.stops.length; j++) {
    const n = raw.stops[j].n;
    if (off[n + 1] - off[n] === 1) {
      snap[j] = adj[off[n]];
      const stub = wt[off[n]];
      if (stub > STUB_FREE_M) stubExtra[j] = stub * 2;
    } else {
      snap[j] = n; // not a simple leaf; measure at the location itself
    }
  }

  return {
    nodeCount, edgeCount, kx, x0, y0, xs, ys, off, adj, wt,
    nodes: raw.nodes, edges: raw.edges, edgeByPair,
    edgeGeometryOffsets, edgeGeometryDeltas,
    stops: raw.stops, snap, stubExtra,
  };
}

// ---------- Road geometry ----------

function nodeCoordinates(graph: Graph, node: number): LonLat {
  return [graph.nodes[node * 2], graph.nodes[node * 2 + 1]];
}

/**
 * Decode one traversed edge into geographic coordinates. Shapes are stored
 * in serialized edge direction, so callers can traverse either way. With no
 * sidecar (or an empty span), this returns the two endpoint coordinates.
 */
export function edgeCoordinates(graph: Graph, from: number, to: number): LonLat[] {
  const e = edgeIndex(graph, from, to);
  if (e === undefined) return [nodeCoordinates(graph, from), nodeCoordinates(graph, to)];

  const a = graph.edges[e * 3];
  const b = graph.edges[e * 3 + 1];
  const coordinates: LonLat[] = [nodeCoordinates(graph, a)];
  const offsets = graph.edgeGeometryOffsets;
  const deltas = graph.edgeGeometryDeltas;
  if (offsets && deltas) {
    const start = offsets[e];
    const end = offsets[e + 1];
    if (Number.isInteger(start) && Number.isInteger(end) &&
        start >= 0 && end >= start && end <= deltas.length && (end - start) % 2 === 0) {
      // The sidecar omits endpoints. Deltas accumulate from `a` in integer
      // microdegrees so each encoded vertex remains compact and exact.
      let lonMicro = Math.round(graph.nodes[a * 2] * 1_000_000);
      let latMicro = Math.round(graph.nodes[a * 2 + 1] * 1_000_000);
      for (let i = start; i < end; i += 2) {
        lonMicro += deltas[i];
        latMicro += deltas[i + 1];
        coordinates.push([lonMicro / 1_000_000, latMicro / 1_000_000]);
      }
    }
  }
  coordinates.push(nodeCoordinates(graph, b));

  // A self-loop has the same endpoint either way; keep its serialized shape
  // rather than reversing it so its intermediate road geometry stays visible.
  return a === from && b === to ? coordinates : coordinates.reverse();
}

/** Expand a street-node path into a continuous lon/lat polyline. */
export function pathCoordinates(graph: Graph, nodes: number[]): LonLat[] {
  if (!nodes.length) return [];
  const coordinates = [nodeCoordinates(graph, nodes[0])];
  for (let i = 1; i < nodes.length; i++) {
    const edge = edgeCoordinates(graph, nodes[i - 1], nodes[i]);
    coordinates.push(...edge.slice(1));
  }
  return coordinates;
}

/** Sum serialized OSM edge meters for a street-node path. */
export function pathMeters(graph: Graph, nodes: number[]): number {
  let meters = 0;
  for (let i = 1; i < nodes.length; i++) {
    const e = edgeIndex(graph, nodes[i - 1], nodes[i]);
    if (e !== undefined) meters += graph.edges[e * 3 + 2];
  }
  return meters;
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

// ---------- Constrained itinerary routing ----------

/** A required place attached to one node in the walking graph. */
export interface RouteAnchor {
  node: number;
  label: string;
  coords: LonLat;
  /** Present when the place is also one of graph.stops. */
  codeStopIndex?: number;
}

export interface ConstrainedRouteRequest {
  start: RouteAnchor;
  necessary: RouteAnchor[];
  finish: RouteAnchor;
  maxMeters: number;
  /** Optional code locations that may not be added (normally already seen). */
  excluded: ReadonlySet<number>;
}

export type RouteVisitRole = "start" | "necessary" | "optional" | "finish";

export interface RouteVisit {
  role: RouteVisitRole;
  anchor: RouteAnchor;
  codeStopIndex?: number;
  necessaryIndex?: number;
  gapIndex?: number;
}

export interface FeasibleConstrainedRoute {
  status: "feasible";
  visits: RouteVisit[];
  /** One street-node path for every visit after Start. */
  legs: number[][];
  pathNodes: number[];
  totalMeters: number;
  minimumMeters: number;
  /** Optional graph.stop indices in each hard-anchor gap. */
  optionalByGap: number[][];
  codeLocationCount: number;
}

export interface InfeasibleConstrainedRoute {
  status: "infeasible";
  /** Infinity means at least one pair of required anchors is disconnected. */
  minimumMeters: number;
}

export type ConstrainedRouteResult = FeasibleConstrainedRoute | InfeasibleConstrainedRoute;
export type ConstrainedRouteAnchors = Pick<ConstrainedRouteRequest, "start" | "necessary" | "finish">;

function shortestPath(shortest: Shortest, from: number, to: number): number[] {
  if (from === to) return [from];
  const { dist, prev } = shortest(from);
  if (!isFinite(dist[to])) return [];
  const path: number[] = [];
  for (let node = to; node !== -1; node = prev[node]) path.push(node);
  path.reverse();
  return path[0] === from ? path : [];
}

function materializeWithShortest(
  graph: Graph,
  anchors: ConstrainedRouteAnchors,
  optionalByGap: readonly (readonly number[])[],
  shortest: Shortest,
): FeasibleConstrainedRoute | null {
  if (optionalByGap.length !== anchors.necessary.length + 1) return null;
  const hard = [anchors.start, ...anchors.necessary, anchors.finish];
  const usedCodes = new Set(hard.flatMap((anchor) => anchor.codeStopIndex === undefined ? [] : [anchor.codeStopIndex]));
  const normalizedGaps = optionalByGap.map((gap) => gap.filter((stopIndex) => {
    if (stopIndex < 0 || stopIndex >= graph.stops.length || usedCodes.has(stopIndex)) return false;
    usedCodes.add(stopIndex);
    return true;
  }));

  const visits: RouteVisit[] = [{ role: "start", anchor: anchors.start, codeStopIndex: anchors.start.codeStopIndex }];
  for (let gap = 0; gap < normalizedGaps.length; gap++) {
    for (const stopIndex of normalizedGaps[gap]) {
      const stop = graph.stops[stopIndex];
      visits.push({
        role: "optional",
        gapIndex: gap,
        codeStopIndex: stopIndex,
        anchor: {
          node: graph.snap[stopIndex],
          label: stop.addr,
          coords: [graph.nodes[stop.n * 2], graph.nodes[stop.n * 2 + 1]],
          codeStopIndex: stopIndex,
        },
      });
    }
    if (gap < anchors.necessary.length) {
      const anchor = anchors.necessary[gap];
      visits.push({ role: "necessary", necessaryIndex: gap, anchor, codeStopIndex: anchor.codeStopIndex });
    } else {
      visits.push({ role: "finish", anchor: anchors.finish, codeStopIndex: anchors.finish.codeStopIndex });
    }
  }

  let minimumMeters = 0;
  for (let index = 1; index < hard.length; index++) {
    const meters = shortest(hard[index - 1].node).dist[hard[index].node];
    if (!isFinite(meters)) return null;
    const codeStopIndex = hard[index].codeStopIndex;
    minimumMeters += meters + (codeStopIndex === undefined ? 0 : graph.stubExtra[codeStopIndex]);
  }
  const legs: number[][] = [];
  let totalMeters = 0;
  for (let index = 1; index < visits.length; index++) {
    const visit = visits[index];
    const leg = shortestPath(shortest, visits[index - 1].anchor.node, visit.anchor.node);
    if (!leg.length) return null;
    legs.push(leg);
    totalMeters += shortest(visits[index - 1].anchor.node).dist[visit.anchor.node];
    if (visit.codeStopIndex !== undefined) totalMeters += graph.stubExtra[visit.codeStopIndex];
  }
  const codeLocationCount = new Set(
    visits.slice(1).flatMap((visit) => visit.codeStopIndex === undefined ? [] : [visit.codeStopIndex]),
  ).size;
  return {
    status: "feasible",
    visits,
    legs,
    pathNodes: legs.flat(),
    totalMeters,
    minimumMeters,
    optionalByGap: normalizedGaps,
    codeLocationCount,
  };
}

/** Rebuild a saved itinerary from its stable optional-stop gap groups. */
export function materializeConstrainedRoute(
  graph: Graph,
  anchors: ConstrainedRouteAnchors,
  optionalByGap: readonly (readonly number[])[],
): FeasibleConstrainedRoute | null {
  return materializeWithShortest(graph, anchors, optionalByGap, makeDijkstraCache(graph));
}

/**
 * Plan one route through immutable ordered anchors, spending only the
 * remaining global distance budget on code locations. The heuristic always
 * inserts the cheapest currently available detour; ties retain graph.stop
 * order so identical requests are deterministic.
 */
export function optimizeConstrainedRoute(graph: Graph, request: ConstrainedRouteRequest): ConstrainedRouteResult {
  const shortest = makeDijkstraCache(graph);
  const hard = [request.start, ...request.necessary, request.finish];
  let mandatoryExtras = 0;
  let minimumMeters = 0;
  for (let gap = 0; gap < hard.length - 1; gap++) {
    const meters = shortest(hard[gap].node).dist[hard[gap + 1].node];
    if (!isFinite(meters)) return { status: "infeasible", minimumMeters: Infinity };
    minimumMeters += meters;
    const codeStopIndex = hard[gap + 1].codeStopIndex;
    if (codeStopIndex !== undefined) mandatoryExtras += graph.stubExtra[codeStopIndex];
  }
  minimumMeters += mandatoryExtras;
  if (minimumMeters > request.maxMeters) return { status: "infeasible", minimumMeters };

  const optionalByGap = Array.from({ length: hard.length - 1 }, () => [] as number[]);
  const requiredCodes = new Set<number>();
  for (const anchor of hard) {
    if (anchor.codeStopIndex !== undefined) requiredCodes.add(anchor.codeStopIndex);
  }
  const used = new Set(requiredCodes);

  const routeNodeForStop = (stopIndex: number) => graph.snap[stopIndex];
  const gapNodes = (gap: number): number[] => [
    hard[gap].node,
    ...optionalByGap[gap].map(routeNodeForStop),
    hard[gap + 1].node,
  ];
  const gapMeters = (gap: number): number => {
    const nodes = gapNodes(gap);
    let total = 0;
    for (let i = 1; i < nodes.length; i++) total += shortest(nodes[i - 1]).dist[nodes[i]];
    for (const stopIndex of optionalByGap[gap]) total += graph.stubExtra[stopIndex];
    return total;
  };
  const totalMeters = () => optionalByGap.reduce((total, _, gap) => total + gapMeters(gap), mandatoryExtras);

  // Keep the endpoints of a gap fixed while reversing optional subsequences.
  function optimizeGap(gap: number): void {
    const order = optionalByGap[gap];
    for (let pass = 0; pass < 10; pass++) {
      let improved = false;
      for (let i = 0; i < order.length - 1; i++) {
        for (let j = i + 1; j < order.length; j++) {
          const before = i === 0 ? hard[gap].node : routeNodeForStop(order[i - 1]);
          const first = routeNodeForStop(order[i]);
          const last = routeNodeForStop(order[j]);
          const after = j === order.length - 1 ? hard[gap + 1].node : routeNodeForStop(order[j + 1]);
          const oldMeters = shortest(before).dist[first] + shortest(last).dist[after];
          const newMeters = shortest(before).dist[last] + shortest(first).dist[after];
          if (newMeters < oldMeters - 0.01) {
            const reversed = order.slice(i, j + 1).reverse();
            order.splice(i, reversed.length, ...reversed);
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
  }

  // Pull every eligible zero-detour stop already traversed by a gap into the
  // route in one pass. Besides matching the itinerary semantics, batching the
  // sweep avoids rescanning the full stop set once per free location.
  function sweepGap(gap: number): number {
    const existing = [...optionalByGap[gap]];
    const anchors = [hard[gap].node, ...existing.map(routeNodeForStop), hard[gap + 1].node];
    const byNode = new Map<number, number[]>();
    for (let stopIndex = 0; stopIndex < graph.stops.length; stopIndex++) {
      if (used.has(stopIndex) || request.excluded.has(stopIndex) || graph.stubExtra[stopIndex] > 0) continue;
      const node = routeNodeForStop(stopIndex);
      const atNode = byNode.get(node);
      if (atNode) atNode.push(stopIndex);
      else byNode.set(node, [stopIndex]);
    }

    const swept: number[] = [];
    let added = 0;
    for (let segment = 0; segment < anchors.length - 1; segment++) {
      for (const node of shortestPath(shortest, anchors[segment], anchors[segment + 1])) {
        for (const stopIndex of byNode.get(node) ?? []) {
          if (used.has(stopIndex)) continue;
          swept.push(stopIndex);
          used.add(stopIndex);
          added++;
        }
      }
      if (segment < existing.length) swept.push(existing[segment]);
    }
    optionalByGap[gap] = swept;
    return added;
  }

  let total = minimumMeters;
  for (let gap = 0; gap < optionalByGap.length; gap++) sweepGap(gap);
  for (;;) {
    let bestStop = -1;
    let bestGap = -1;
    let bestPosition = -1;
    let bestDelta = Infinity;

    // Stop index is the outer loop so equal-cost choices are stable.
    for (let stopIndex = 0; stopIndex < graph.stops.length; stopIndex++) {
      if (used.has(stopIndex) || request.excluded.has(stopIndex)) continue;
      const stopNode = routeNodeForStop(stopIndex);
      for (let gap = 0; gap < optionalByGap.length; gap++) {
        const nodes = gapNodes(gap);
        for (let position = 0; position < nodes.length - 1; position++) {
          const left = nodes[position], right = nodes[position + 1];
          const toStop = shortest(left).dist[stopNode];
          // The walking graph is undirected, so source the second distance at
          // the route anchor too. This keeps the Dijkstra cache proportional
          // to route visits rather than to every candidate code location.
          const fromStop = shortest(right).dist[stopNode];
          const direct = shortest(left).dist[right];
          if (!isFinite(toStop) || !isFinite(fromStop) || !isFinite(direct)) continue;
          const delta = Math.max(0, toStop + fromStop - direct + graph.stubExtra[stopIndex]);
          if (total + delta > request.maxMeters) continue;
          if (delta < bestDelta - 0.01) {
            bestStop = stopIndex;
            bestGap = gap;
            bestPosition = position;
            bestDelta = delta;
          }
        }
      }
    }

    if (bestStop < 0) break;
    optionalByGap[bestGap].splice(bestPosition, 0, bestStop);
    used.add(bestStop);
    optimizeGap(bestGap);
    sweepGap(bestGap);
    total = totalMeters();
  }

  return materializeWithShortest(graph, request, optionalByGap, shortest) ?? {
    status: "infeasible",
    minimumMeters: Infinity,
  };
}
