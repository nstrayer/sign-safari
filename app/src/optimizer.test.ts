// Tests for the pure route-optimization core, exercised through its public
// interface with a small synthetic street network.
//
// The network mirrors the raw shape of data/network.json (see the header of
// optimizer.ts): a straight street A-B-C-D with 100 m blocks, and signs
// hanging off the street as leaf nodes via access stubs:
//
//   A(0) --100-- B(1) --100-- C(2) --100-- D(3)
//                 |            |    \       |
//                 10           80    5      10
//                 |            |      \     |
//               sign0(4)    sign1(5) sign3(7) sign2(6)
//
// sign1's 80 m stub is over STUB_FREE_M, so it carries a 160 m round-trip
// charge; the others are visible from the street and cost nothing.

import { describe, expect, it } from "vitest";
import {
  STUB_FREE_M,
  buildGraph,
  dijkstra,
  edgeCoordinates,
  edgeIndex,
  makeDijkstraCache,
  pathCoordinates,
  pathMeters,
  optimizeConstrainedRoute,
} from "./optimizer";
import type { Graph, RouteAnchor } from "./optimizer";
import type { NetworkData } from "./types";

const SEED = 0; // street node A

function makeNetwork(): NetworkData {
  return {
    generated: "test",
    // [lon, lat] pairs; positions only matter for world coords, not routing.
    nodes: [
      0.0, 0.0, // 0: A
      0.001, 0.0, // 1: B
      0.002, 0.0, // 2: C
      0.003, 0.0, // 3: D
      0.001, 0.0001, // 4: leaf off B (sign0)
      0.002, 0.0007, // 5: leaf off C (sign1)
      0.003, 0.0001, // 6: leaf off D (sign2)
      0.002, -0.0001, // 7: leaf off C (sign3)
    ],
    // [a, b, meters] triples.
    edges: [
      0, 1, 100,
      1, 2, 100,
      2, 3, 100,
      1, 4, 10,
      2, 5, 80,
      3, 6, 10,
      2, 7, 5,
    ],
    stops: [
      { id: "s0", addr: "1 B St", kind: "sign", n: 4 },
      { id: "s1", addr: "2 C St", kind: "sign", n: 5 },
      { id: "biz-2", addr: "Corner Cafe", kind: "biz", n: 6 },
      { id: "s3", addr: "4 C St", kind: "sign", n: 7 },
    ],
  };
}

function makeGeometryNetwork(): NetworkData {
  return {
    generated: "geometry-test",
    nodes: [
      0, 0, // 0
      0.003, 0, // 1
      0.004, 0, // 2
    ],
    edges: [
      0, 1, 100, // curved edge
      1, 2, 200, // deliberately straight edge (empty span)
      2, 2, 25, // loop with a visible shape
    ],
    // Values are offsets into flat lon/lat delta pairs, not vertex counts.
    edgeGeometryOffsets: [0, 4, 4, 8],
    edgeGeometryDeltas: [
      1000, 1000, // 0,0 -> .001,.001
      1000, 0, // .001,.001 -> .002,.001
      1000, 1000, // .004,0 -> .005,.001
      -1000, 1000, // .005,.001 -> .004,.002
    ],
    stops: [],
  };
}

function setup(): { graph: Graph } {
  return { graph: buildGraph(makeNetwork()) };
}

describe("buildGraph", () => {
  it("keeps business-code locations as routeable stops", () => {
    const { graph } = setup();
    expect(graph.stops[2]).toMatchObject({ id: "biz-2", kind: "biz" });
    expect(graph.snap[2]).toBe(3);
  });

  it("snaps leaf signs to their street node", () => {
    const { graph } = setup();
    expect([...graph.snap]).toEqual([1, 2, 3, 2]);
  });

  it("charges the round trip only for stubs over STUB_FREE_M", () => {
    const { graph } = setup();
    // sign1's stub is 80 m > STUB_FREE_M, so it costs 160 m both ways.
    expect(80).toBeGreaterThan(STUB_FREE_M);
    expect([...graph.stubExtra]).toEqual([0, 160, 0, 0]);
  });

  it("keeps routing identical when optional geometry is present", () => {
    const plain = buildGraph(makeNetwork());
    const shapedRaw = makeNetwork();
    shapedRaw.edgeGeometryOffsets = [0, 4, 4, 4, 4, 4, 4, 4];
    shapedRaw.edgeGeometryDeltas = [500, 100, 500, -100];
    const shaped = buildGraph(shapedRaw);

    expect([...dijkstra(shaped, SEED).dist]).toEqual([...dijkstra(plain, SEED).dist]);

    expect(optimizeConstrainedRoute(shaped, {
      start: anchor(shaped, 0, "Start"),
      necessary: [],
      finish: anchor(shaped, 3, "Finish"),
      maxMeters: 300,
      excluded: new Set(shaped.stops.map((_, index) => index)),
    })).toEqual(optimizeConstrainedRoute(plain, {
      start: anchor(plain, 0, "Start"),
      necessary: [],
      finish: anchor(plain, 3, "Finish"),
      maxMeters: 300,
      excluded: new Set(plain.stops.map((_, index) => index)),
    }));
  });
});

describe("road geometry", () => {
  it("looks up an edge by either endpoint order and decodes its direction", () => {
    const graph = buildGraph(makeGeometryNetwork());
    expect(edgeIndex(graph, 0, 1)).toBe(0);
    expect(edgeIndex(graph, 1, 0)).toBe(0);
    expect(edgeCoordinates(graph, 0, 1)).toEqual([
      [0, 0], [0.001, 0.001], [0.002, 0.001], [0.003, 0],
    ]);
    expect(edgeCoordinates(graph, 1, 0)).toEqual([
      [0.003, 0], [0.002, 0.001], [0.001, 0.001], [0, 0],
    ]);
  });

  it("falls back to endpoints for an edge with no intermediate geometry", () => {
    const graph = buildGraph(makeGeometryNetwork());
    expect(edgeCoordinates(graph, 1, 2)).toEqual([[0.003, 0], [0.004, 0]]);

    const oldGraph = buildGraph(makeNetwork());
    expect(edgeCoordinates(oldGraph, 0, 1)).toEqual([[0, 0], [0.001, 0]]);
  });

  it("retains a self-loop's intermediate geometry", () => {
    const graph = buildGraph(makeGeometryNetwork());
    expect(edgeCoordinates(graph, 2, 2)).toEqual([
      [0.004, 0], [0.005, 0.001], [0.004, 0.002], [0.004, 0],
    ]);
  });

  it("expands paths and sums stored edge meters rather than coordinate chords", () => {
    const graph = buildGraph(makeGeometryNetwork());
    expect(pathCoordinates(graph, [0, 1, 2])).toEqual([
      [0, 0], [0.001, 0.001], [0.002, 0.001], [0.003, 0], [0.004, 0],
    ]);
    expect(pathMeters(graph, [0, 1, 2])).toBe(300);
    expect(pathMeters(graph, [2, 1, 0])).toBe(300);
    expect(pathMeters(graph, [2, 2])).toBe(25);
  });
});

describe("dijkstra", () => {
  it("computes exact distances on the line street", () => {
    const { graph } = setup();
    const { dist } = dijkstra(graph, SEED);
    expect([...dist]).toEqual([0, 100, 200, 300, 110, 280, 310, 205]);
  });

  it("records prev pointers that walk back the shortest path", () => {
    const { graph } = setup();
    const { prev } = dijkstra(graph, SEED);
    const path: number[] = [];
    for (let v = 6; v !== -1; v = prev[v]) path.push(v);
    expect(path.reverse()).toEqual([0, 1, 2, 3, 6]);
  });

  it("is served identically through the LRU cache", () => {
    const { graph } = setup();
    const shortest = makeDijkstraCache(graph);
    const first = shortest(SEED);
    expect([...first.dist]).toEqual([...dijkstra(graph, SEED).dist]);
    expect(shortest(SEED)).toBe(first); // cached result reused
  });
});

function anchor(graph: Graph, node: number, label: string, codeStopIndex?: number): RouteAnchor {
  return {
    node,
    label,
    coords: [graph.nodes[node * 2], graph.nodes[node * 2 + 1]],
    codeStopIndex,
  };
}

describe("optimizeConstrainedRoute", () => {
  it("supports the default round trip and an explicit point-to-point finish", () => {
    const graph = buildGraph(makeNetwork());
    const excluded = new Set(graph.stops.map((_, index) => index));
    const roundTrip = optimizeConstrainedRoute(graph, {
      start: anchor(graph, 0, "Home"),
      necessary: [anchor(graph, 2, "Errand")],
      finish: anchor(graph, 0, "Home"),
      maxMeters: 400,
      excluded,
    });
    const pointToPoint = optimizeConstrainedRoute(graph, {
      start: anchor(graph, 0, "Start"),
      necessary: [],
      finish: anchor(graph, 3, "Finish"),
      maxMeters: 300,
      excluded,
    });

    expect(roundTrip.status === "feasible" && roundTrip.totalMeters).toBe(400);
    expect(pointToPoint.status === "feasible" && pointToPoint.visits.map((visit) => visit.role)).toEqual(["start", "finish"]);
    expect(pointToPoint.status === "feasible" && pointToPoint.totalMeters).toBe(300);
  });

  it("keeps necessary stops in entered order and reports the complete mandatory distance", () => {
    const graph = buildGraph(makeNetwork());
    const result = optimizeConstrainedRoute(graph, {
      start: anchor(graph, 0, "Start"),
      necessary: [anchor(graph, 3, "First errand"), anchor(graph, 1, "Second errand")],
      finish: anchor(graph, 2, "Finish"),
      maxMeters: 600,
      excluded: new Set(graph.stops.map((_, index) => index)),
    });

    expect(result.status).toBe("feasible");
    if (result.status !== "feasible") return;
    expect(result.visits.map((visit) => [visit.role, visit.anchor.label])).toEqual([
      ["start", "Start"],
      ["necessary", "First errand"],
      ["necessary", "Second errand"],
      ["finish", "Finish"],
    ]);
    expect(result.totalMeters).toBe(600);
  });

  it("returns the minimum required distance when the itinerary exceeds the cap", () => {
    const graph = buildGraph(makeNetwork());
    expect(optimizeConstrainedRoute(graph, {
      start: anchor(graph, 0, "Start"),
      necessary: [],
      finish: anchor(graph, 3, "Finish"),
      maxMeters: 299,
      excluded: new Set(),
    })).toEqual({ status: "infeasible", minimumMeters: 300 });
  });

  it("returns Infinity when a required anchor is disconnected", () => {
    const raw = makeNetwork();
    raw.nodes.push(0.01, 0.01);
    const graph = buildGraph(raw);
    expect(optimizeConstrainedRoute(graph, {
      start: anchor(graph, 0, "Start"),
      necessary: [],
      finish: anchor(graph, graph.nodeCount - 1, "Nowhere"),
      maxMeters: 10_000,
      excluded: new Set(),
    })).toEqual({ status: "infeasible", minimumMeters: Infinity });
  });

  it("inserts eligible code locations without crossing anchors or exceeding the global cap", () => {
    const graph = buildGraph(makeNetwork());
    const result = optimizeConstrainedRoute(graph, {
      start: anchor(graph, 0, "Start"),
      necessary: [anchor(graph, 2, "Errand")],
      finish: anchor(graph, 0, "Start"),
      maxMeters: 400,
      excluded: new Set([1]),
    });

    expect(result.status).toBe("feasible");
    if (result.status !== "feasible") return;
    const necessaryAt = result.visits.findIndex((visit) => visit.role === "necessary");
    expect(result.visits.slice(1, necessaryAt).every((visit) => visit.role === "optional")).toBe(true);
    expect(result.visits.slice(necessaryAt + 1, -1).every((visit) => visit.role === "optional")).toBe(true);
    expect(result.visits.filter((visit) => visit.role === "optional").map((visit) => visit.codeStopIndex)).not.toContain(1);
    expect(result.totalMeters).toBeLessThanOrEqual(400);
  });

  it("applies Skip seen only to optional candidates and breaks ties deterministically", () => {
    const graph = buildGraph(makeNetwork());
    const requiredSeenCode = anchor(graph, graph.snap[0], "Required seen code", 0);
    const request = {
      start: anchor(graph, 0, "Start"),
      necessary: [requiredSeenCode],
      finish: anchor(graph, 0, "Start"),
      maxMeters: 800,
      excluded: new Set([0, 2]),
    };

    const first = optimizeConstrainedRoute(graph, request);
    const second = optimizeConstrainedRoute(graph, request);
    expect(first).toEqual(second);
    expect(first.status).toBe("feasible");
    if (first.status !== "feasible") return;
    expect(first.visits.find((visit) => visit.role === "necessary")?.codeStopIndex).toBe(0);
    expect(first.visits.filter((visit) => visit.role === "optional").map((visit) => visit.codeStopIndex)).not.toContain(2);
    expect(first.totalMeters).toBeLessThanOrEqual(request.maxMeters);
  });

  it("represents a necessary code location once and keeps it trackable", () => {
    const graph = buildGraph(makeNetwork());
    const requiredCode = anchor(graph, graph.snap[0], "1 B St", 0);
    const result = optimizeConstrainedRoute(graph, {
      start: anchor(graph, 0, "Start"),
      necessary: [requiredCode],
      finish: anchor(graph, 0, "Start"),
      maxMeters: 200,
      excluded: new Set([1, 2, 3]),
    });

    expect(result.status).toBe("feasible");
    if (result.status !== "feasible") return;
    expect(result.visits.filter((visit) => visit.codeStopIndex === 0)).toHaveLength(1);
    expect(result.visits.find((visit) => visit.codeStopIndex === 0)?.role).toBe("necessary");
    expect(result.codeLocationCount).toBe(1);
  });

  it("includes a necessary code location's long access path in the hard minimum", () => {
    const graph = buildGraph(makeNetwork());
    const requiredCode = anchor(graph, graph.snap[1], "Long-access code", 1);

    expect(optimizeConstrainedRoute(graph, {
      start: anchor(graph, 0, "Start"),
      necessary: [requiredCode],
      finish: anchor(graph, 0, "Start"),
      maxMeters: 559,
      excluded: new Set(),
    })).toEqual({ status: "infeasible", minimumMeters: 560 });
  });

  it("does not count the Start anchor as a code location to visit", () => {
    const graph = buildGraph(makeNetwork());
    const result = optimizeConstrainedRoute(graph, {
      start: anchor(graph, graph.snap[0], "Start at a code", 0),
      necessary: [],
      finish: anchor(graph, 0, "Finish"),
      maxMeters: 100,
      excluded: new Set([1, 2, 3]),
    });

    expect(result.status).toBe("feasible");
    if (result.status !== "feasible") return;
    expect(result.codeLocationCount).toBe(0);
  });

  it("returns a valid required-only route when no optional code location fits", () => {
    const graph = buildGraph(makeNetwork());
    const result = optimizeConstrainedRoute(graph, {
      start: anchor(graph, 0, "Start"),
      necessary: [anchor(graph, 1, "Errand")],
      finish: anchor(graph, 0, "Start"),
      maxMeters: 200,
      excluded: new Set(graph.stops.map((_, index) => index)),
    });

    expect(result.status).toBe("feasible");
    if (result.status !== "feasible") return;
    expect(result.visits.map((visit) => visit.role)).toEqual(["start", "necessary", "finish"]);
    expect(result.optionalByGap).toEqual([[], []]);
    expect(result.totalMeters).toBe(200);
  });
});
