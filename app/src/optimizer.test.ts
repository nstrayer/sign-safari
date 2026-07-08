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
  buildCandidates,
  dijkstra,
  greedyExtend,
  legsForOrder,
  makeDijkstraCache,
  makeRows,
  routeTotals,
  sweepOnRoute,
  twoOptSteps,
  wiggleExtend,
} from "./optimizer";
import type { BuildOpts, Graph, RowFor } from "./optimizer";
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
    signs: [
      { id: "s0", addr: "1 B St", n: 4 },
      { id: "s1", addr: "2 C St", n: 5 },
      { id: "s2", addr: "3 D St", n: 6 },
      { id: "s3", addr: "4 C St", n: 7 },
    ],
  };
}

function setup(): { graph: Graph; rowFor: RowFor } {
  const graph = buildGraph(makeNetwork());
  return { graph, rowFor: makeRows(graph, makeDijkstraCache(graph)) };
}

function opts(over: Partial<BuildOpts> = {}): BuildOpts {
  return { maxMeters: Infinity, maxCount: Infinity, excluded: new Set(), loop: false, ...over };
}

describe("buildGraph", () => {
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

describe("routeTotals", () => {
  it("sums legs at snap nodes plus stub charges", () => {
    const { graph, rowFor } = setup();
    // seed->B (100) + B->C (100 + 160 stub) + C->D (100)
    const { pathMeters, totalMeters } = routeTotals(graph, rowFor, SEED, [0, 1, 2], false);
    expect(pathMeters).toBe(460);
    expect(totalMeters).toBe(460);
  });

  it("adds the leg home when looping", () => {
    const { graph, rowFor } = setup();
    const { pathMeters, totalMeters } = routeTotals(graph, rowFor, SEED, [0, 1, 2], true);
    expect(pathMeters).toBe(460);
    expect(totalMeters).toBe(760); // + 300 back from D
  });
});

describe("greedyExtend", () => {
  it("collects nearest signs first and respects the distance budget", () => {
    const { graph, rowFor } = setup();
    const stops: number[] = [];
    // sign0 (100) then sign3 (100 more); every next pick would push past 250.
    const added = greedyExtend(graph, rowFor, SEED, stops, 0, opts({ maxMeters: 250 }));
    expect(added).toBe(2);
    expect(stops).toEqual([0, 3]);
    expect(routeTotals(graph, rowFor, SEED, stops, false).totalMeters).toBeLessThanOrEqual(250);
  });

  it("budgets the return leg home when looping", () => {
    const { graph, rowFor } = setup();
    const stops: number[] = [];
    // sign0: 100 out + 100 home = 200 fits; anything more would not.
    greedyExtend(graph, rowFor, SEED, stops, 0, opts({ maxMeters: 220, loop: true }));
    expect(stops).toEqual([0]);
    expect(routeTotals(graph, rowFor, SEED, stops, true).totalMeters).toBeLessThanOrEqual(220);
  });

  it("respects maxCount and never repeats a stop", () => {
    const { graph, rowFor } = setup();
    const stops: number[] = [];
    const added = greedyExtend(graph, rowFor, SEED, stops, 0, opts({ maxCount: 2 }));
    expect(added).toBe(2);
    expect(new Set(stops).size).toBe(stops.length);
  });
});

describe("buildCandidates", () => {
  it("returns deduped candidates that all fit the budget", () => {
    const { graph, rowFor } = setup();
    const o = opts({ maxMeters: 800 });
    const candidates = buildCandidates(graph, rowFor, SEED, o);
    expect(candidates.length).toBeGreaterThan(0);
    const keys = candidates.map((c) => c.stopSigns.join(","));
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of candidates) {
      expect(new Set(c.stopSigns).size).toBe(c.stopSigns.length);
      expect(c.totalMeters).toBeLessThanOrEqual(o.maxMeters);
      expect(c.totalMeters).toBe(routeTotals(graph, rowFor, SEED, c.stopSigns, false).totalMeters);
    }
  });

  it("is deterministic", () => {
    const { graph, rowFor } = setup();
    const a = buildCandidates(graph, rowFor, SEED, opts({ maxMeters: 800 }));
    const b = buildCandidates(graph, rowFor, SEED, opts({ maxMeters: 800 }));
    expect(a).toEqual(b);
  });
});

describe("twoOptSteps", () => {
  it("only ever shortens the route and keeps the same stops", () => {
    const { graph, rowFor } = setup();
    const stops = [2, 0, 1]; // deliberately tangled: out, back, out again
    const before = [...stops];
    let total = routeTotals(graph, rowFor, SEED, stops, false).totalMeters;
    const start = total;
    for (const step of twoOptSteps(graph, rowFor, SEED, stops, false)) {
      const next = routeTotals(graph, rowFor, SEED, stops, false).totalMeters;
      expect(next).toBeLessThan(total);
      expect(step.saved).toBeGreaterThan(0);
      total = next;
    }
    expect(total).toBeLessThan(start); // this tangle is untangleable
    expect([...stops].sort()).toEqual([...before].sort());
  });

  it("accounts for the leg home when looping", () => {
    const { graph, rowFor } = setup();
    const stops = [2, 0, 3];
    let total = routeTotals(graph, rowFor, SEED, stops, true).totalMeters;
    for (const _ of twoOptSteps(graph, rowFor, SEED, stops, true)) {
      const next = routeTotals(graph, rowFor, SEED, stops, true).totalMeters;
      expect(next).toBeLessThanOrEqual(total);
      total = next;
    }
  });
});

describe("legsForOrder", () => {
  it("emits one contiguous leg per stop, chained end to start", () => {
    const { graph } = setup();
    const shortest = makeDijkstraCache(graph);
    const legs = legsForOrder(graph, shortest, SEED, [0, 2], true);
    expect(legs).toEqual([
      [0, 1], // seed A -> sign0's snap B
      [1, 2, 3], // B -> sign2's snap D
      [3, 2, 1, 0], // loop home
    ]);
  });
});

describe("sweepOnRoute", () => {
  it("splices in free signs the path already passes, in walk order", () => {
    const { graph, rowFor } = setup();
    const shortest = makeDijkstraCache(graph);
    const stops = [2]; // walk A -> D straight past B and C
    const before = routeTotals(graph, rowFor, SEED, stops, false).totalMeters;
    const swept = sweepOnRoute(graph, shortest, SEED, stops, new Set(), false);
    // sign0 (at B) and sign3 (at C) ride along; sign1's stub charge keeps it out.
    expect(swept).toBe(2);
    expect(stops).toEqual([0, 3, 2]);
    expect(new Set(stops).size).toBe(stops.length);
    // Swept signs are free: the totals don't move.
    expect(routeTotals(graph, rowFor, SEED, stops, false).totalMeters).toBe(before);
  });

  it("skips excluded signs", () => {
    const { graph } = setup();
    const shortest = makeDijkstraCache(graph);
    const stops = [2];
    const swept = sweepOnRoute(graph, shortest, SEED, stops, new Set([0]), false);
    expect(swept).toBe(1);
    expect(stops).toEqual([3, 2]);
  });
});

describe("wiggleExtend", () => {
  it("inserts cheap detours but never runs past budget plus slack", () => {
    const { graph, rowFor } = setup();
    const stops = [0]; // 100 m so far
    const o = opts({ maxMeters: 300 });
    const added = wiggleExtend(graph, rowFor, SEED, stops, o, 50);
    // sign3 (100 m) then sign2 (100 m more) tack onto the tail for a 300 m
    // total; sign1's 260 m detour would blow the 350 m cap.
    expect(added).toBe(2);
    expect(stops).toEqual([0, 3, 2]);
    expect(new Set(stops).size).toBe(stops.length);
    const { totalMeters } = routeTotals(graph, rowFor, SEED, stops, false);
    expect(totalMeters).toBeLessThanOrEqual(o.maxMeters + 50);
  });

  it("adds nothing when even the slack cannot cover a detour", () => {
    const { graph, rowFor } = setup();
    const stops = [0];
    const added = wiggleExtend(graph, rowFor, SEED, stops, opts({ maxMeters: 120 }), 10);
    expect(added).toBe(0);
    expect(stops).toEqual([0]);
  });
});
