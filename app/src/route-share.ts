import type { LonLat, NetworkStop } from "./types";
import {
  DEG_M,
  materializeConstrainedRoute,
  type FeasibleConstrainedRoute,
  type Graph,
  type RouteAnchor,
} from "./optimizer";

export const SHARE_ROUTE_LIMIT = 200;

export interface SerializedAnchor {
  label: string;
  coords: LonLat;
  codeId?: string;
}

export interface SharedRouteV2 {
  v: 2;
  start: SerializedAnchor;
  necessary: SerializedAnchor[];
  finish: SerializedAnchor;
  /** Stable code-location IDs grouped between consecutive hard anchors. */
  optionalByGap: string[][];
}

export interface LegacySharedRoute {
  v: 1;
  start: string;
  stopIds: string[];
  loop: boolean;
}

export type DecodedSharedRoute = SharedRouteV2 | LegacySharedRoute;

export interface DecodedSavedWalk {
  route: DecodedSharedRoute;
  /** Zero-based leg/next-visit index. */
  at: number;
}

function isCoords(value: unknown): value is LonLat {
  return Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "number" && isFinite(part));
}

function isSerializedAnchor(value: unknown): value is SerializedAnchor {
  if (!value || typeof value !== "object") return false;
  const anchor = value as Partial<SerializedAnchor>;
  return typeof anchor.label === "string" && isCoords(anchor.coords) &&
    (anchor.codeId === undefined || typeof anchor.codeId === "string");
}

function isSharedRouteV2(value: unknown): value is SharedRouteV2 {
  if (!value || typeof value !== "object") return false;
  const route = value as Partial<SharedRouteV2>;
  return route.v === 2 && isSerializedAnchor(route.start) && isSerializedAnchor(route.finish) &&
    Array.isArray(route.necessary) && route.necessary.every(isSerializedAnchor) &&
    Array.isArray(route.optionalByGap) &&
    route.optionalByGap.length === route.necessary.length + 1 &&
    route.optionalByGap.every((gap) => Array.isArray(gap) && gap.every((id) => typeof id === "string"));
}

/** Encode the v2 payload as URLSearchParams suitable for a link hash or walk save. */
export function encodeSharedRoute(route: SharedRouteV2): URLSearchParams {
  const params = new URLSearchParams();
  params.set("v", "2");
  params.set("d", JSON.stringify(route));
  return params;
}

/** Decode v2 payloads and the original r/s/l route-link format. */
export function decodeSharedRoute(params: URLSearchParams): DecodedSharedRoute | null {
  if (params.get("v") === "2") {
    const data = params.get("d");
    if (!data) return null;
    try {
      const parsed: unknown = JSON.parse(data);
      return isSharedRouteV2(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  const route = params.get("r");
  if (!route) return null;
  return {
    v: 1,
    start: params.get("s") ?? "",
    stopIds: route.split(".").filter(Boolean),
    loop: params.get("l") === "1",
  };
}

/** Validate and decode the route plus current visit stored for an unfinished walk. */
export function decodeSavedWalk(q: string, at: number): DecodedSavedWalk | null {
  if (!Number.isInteger(at) || at < 0) return null;
  const route = decodeSharedRoute(new URLSearchParams(q));
  return route ? { route, at } : null;
}

export interface ResolvedSerializedAnchor {
  label: string;
  coords: LonLat;
  codeStopIndex?: number;
  lostCode?: true;
}

/** Resolve a required anchor's code identity, falling back to its saved place. */
export function resolveSerializedAnchor(
  stops: NetworkStop[],
  anchor: SerializedAnchor,
  stopCoords: (index: number) => LonLat,
): ResolvedSerializedAnchor {
  if (anchor.codeId !== undefined) {
    const codeStopIndex = stops.findIndex((stop) => stop.id === anchor.codeId);
    if (codeStopIndex >= 0) {
      return { label: anchor.label, coords: stopCoords(codeStopIndex), codeStopIndex };
    }
    return { label: anchor.label, coords: anchor.coords, lostCode: true };
  }
  return { label: anchor.label, coords: anchor.coords };
}

/** Resolve optional stable IDs independently in each required-anchor gap. */
export function restoreOptionalByGap(stops: NetworkStop[], idsByGap: readonly (readonly string[])[]): {
  optionalByGap: number[][];
  missing: number;
} {
  let missing = 0;
  const byId = new Map(stops.map((stop, index) => [stop.id, index]));
  const optionalByGap = idsByGap.map((ids) => ids.flatMap((id) => {
    const index = byId.get(id);
    if (index === undefined) {
      missing++;
      return [];
    }
    return [index];
  }));
  return { optionalByGap, missing };
}

/** Resolve stable shared-route location IDs against the current network data. */
export function restoreStopIndices(stops: NetworkStop[], ids: readonly string[]): {
  stopIndices: number[];
  missing: number;
} {
  const byId = new Map(stops.map((stop, index) => [stop.id, index]));
  const stopIndices: number[] = [];
  let missing = 0;
  for (const id of ids) {
    const index = byId.get(id);
    if (index === undefined) missing++;
    else stopIndices.push(index);
  }
  return { stopIndices, missing };
}

export interface RestoredSharedRoute {
  start: RouteAnchor;
  necessary: RouteAnchor[];
  finish: RouteAnchor;
  finishFollowsStart: boolean;
  optionalByGap: number[][];
  route: FeasibleConstrainedRoute;
  missingOptional: number;
  lostRequiredCodeLabels: string[];
}

function stopCoords(graph: Graph, index: number): LonLat {
  const node = graph.stops[index].n;
  return [graph.nodes[node * 2], graph.nodes[node * 2 + 1]];
}

function anchorForStop(graph: Graph, index: number): RouteAnchor {
  const stop = graph.stops[index];
  return { node: graph.snap[index], label: stop.addr, coords: stopCoords(graph, index), codeStopIndex: index };
}

function attachCoords(graph: Graph, coords: LonLat, label: string): RouteAnchor | null {
  const x = coords[0] * graph.kx - graph.x0, y = coords[1] - graph.y0;
  let node = 0, bestSquared = Infinity;
  for (let index = 0; index < graph.nodeCount; index++) {
    const squared = (graph.xs[index] - x) ** 2 + (graph.ys[index] - y) ** 2;
    if (squared < bestSquared) { node = index; bestSquared = squared; }
  }
  return Math.sqrt(bestSquared) * DEG_M <= 2000 ? { node, label, coords } : null;
}

/** Resolve and materialize a shared route against the current walking graph. */
export function restoreSharedRoute(graph: Graph, decoded: DecodedSharedRoute): RestoredSharedRoute | null {
  let start: RouteAnchor | null = null;
  let necessary: RouteAnchor[] = [];
  let finish: RouteAnchor | null = null;
  let finishFollowsStart = true;
  let optionalByGap: number[][];
  let missingOptional = 0;
  const lostRequiredCodeLabels: string[] = [];

  if (decoded.v === 2) {
    const attach = (serialized: SerializedAnchor): RouteAnchor | null => {
      const resolved = resolveSerializedAnchor(graph.stops, serialized, (index) => stopCoords(graph, index));
      if (resolved.codeStopIndex !== undefined) return anchorForStop(graph, resolved.codeStopIndex);
      const anchor = attachCoords(graph, resolved.coords, resolved.label);
      if (anchor && resolved.lostCode) lostRequiredCodeLabels.push(resolved.label);
      return anchor;
    };
    start = attach(decoded.start);
    finish = attach(decoded.finish);
    const attachedNecessary = decoded.necessary.map(attach);
    if (attachedNecessary.some((anchor) => !anchor)) return null;
    necessary = attachedNecessary as RouteAnchor[];
    finishFollowsStart = decoded.start.label === decoded.finish.label &&
      decoded.start.coords[0] === decoded.finish.coords[0] && decoded.start.coords[1] === decoded.finish.coords[1];
    ({ optionalByGap, missing: missingOptional } = restoreOptionalByGap(graph.stops, decoded.optionalByGap));
  } else {
    const restoredOptional = restoreStopIndices(graph.stops, decoded.stopIds.slice(0, SHARE_ROUTE_LIMIT));
    optionalByGap = [restoredOptional.stopIndices];
    missingOptional = restoredOptional.missing;
    const byId = new Map(graph.stops.map((stop, index) => [stop.id, index]));
    if (decoded.start.includes(",")) {
      const coords = decoded.start.split(",").map(Number) as LonLat;
      if (coords.every(isFinite)) start = attachCoords(graph, coords, "shared start");
    } else {
      const index = byId.get(decoded.start);
      if (index !== undefined) start = anchorForStop(graph, index);
    }
    if (!start && restoredOptional.stopIndices.length) start = anchorForStop(graph, restoredOptional.stopIndices[0]);
    if (start) finish = { ...start };
  }

  if (!start || !finish) return null;
  const route = materializeConstrainedRoute(graph, { start, necessary, finish }, optionalByGap);
  return route ? { start, necessary, finish, finishFollowsStart, optionalByGap: route.optionalByGap, route, missingOptional, lostRequiredCodeLabels } : null;
}

/** Restore an unfinished walk through route reconstruction and index validation. */
export function restoreSavedWalk(graph: Graph, q: string, at: number): (RestoredSharedRoute & { at: number }) | null {
  const saved = decodeSavedWalk(q, at);
  if (!saved) return null;
  const restored = restoreSharedRoute(graph, saved.route);
  return restored && saved.at < restored.route.legs.length ? { ...restored, at: saved.at } : null;
}
