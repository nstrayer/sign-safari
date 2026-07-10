import { describe, expect, it } from "vitest";
import {
  decodeSharedRoute,
  decodeSavedWalk,
  encodeSharedRoute,
  resolveSerializedAnchor,
  restoreOptionalByGap,
  restoreSavedWalk,
  restoreStopIndices,
} from "./route-share";
import { buildGraph } from "./optimizer";
import type { NetworkData, NetworkStop } from "./types";

const stops: NetworkStop[] = [
  { id: "101", addr: "1 Lawn Sign Ln", kind: "sign", n: 1 },
  { id: "biz-202", addr: "Corner Cafe", kind: "biz", n: 2 },
  { id: "303", addr: "3 Lawn Sign Ln", kind: "sign", n: 3 },
];

function makeWalkNetwork(): NetworkData {
  return {
    generated: "walk-restore-test",
    nodes: [0, 0, 0.001, 0, 0.002, 0, 0.003, 0],
    edges: [0, 1, 100, 1, 2, 100, 2, 3, 100],
    stops,
  };
}

describe("restoreStopIndices", () => {
  it("restores a shared route containing a business-code stop", () => {
    expect(restoreStopIndices(stops, ["101", "biz-202", "303"])).toEqual({
      stopIndices: [0, 1, 2],
      missing: 0,
    });
  });

  it("keeps available business stops when a shared location no longer exists", () => {
    expect(restoreStopIndices(stops, ["missing", "biz-202"])).toEqual({
      stopIndices: [1],
      missing: 1,
    });
  });
});

describe("versioned shared routes", () => {
  it("round-trips ordered anchors, labels, finish, and optional gap groups", () => {
    const route = {
      v: 2 as const,
      start: { label: "Home", coords: [-83.7, 42.2] as [number, number] },
      necessary: [
        { label: "People's Food Co-op", coords: [-83.71, 42.21] as [number, number], codeId: "biz-202" },
      ],
      finish: { label: "Library", coords: [-83.72, 42.22] as [number, number] },
      optionalByGap: [["101"], ["303"]],
    };

    expect(decodeSharedRoute(encodeSharedRoute(route))).toEqual(route);
  });

  it("decodes old links as round trips with no necessary stops", () => {
    expect(decodeSharedRoute(new URLSearchParams("r=101.biz-202&s=-83.70000%2C42.20000&l=1"))).toEqual({
      v: 1,
      start: "-83.70000,42.20000",
      stopIds: ["101", "biz-202"],
      loop: true,
    });
  });

  it("restores optional IDs by gap while reporting locations removed by a refresh", () => {
    expect(restoreOptionalByGap(stops, [["101", "missing"], ["biz-202"]])).toEqual({
      optionalByGap: [[0], [1]],
      missing: 1,
    });
  });

  it("falls back to saved coordinates when a required code ID disappeared", () => {
    expect(resolveSerializedAnchor(
      stops,
      { label: "Old code stop", coords: [-83.7, 42.2], codeId: "missing" },
      (index) => [index, index + 0.5],
    )).toEqual({
      label: "Old code stop",
      coords: [-83.7, 42.2],
      lostCode: true,
    });
  });

  it("restores an unfinished v2 walk at its current visit index", () => {
    const route = {
      v: 2 as const,
      start: { label: "Home", coords: [-83.7, 42.2] as [number, number] },
      necessary: [{ label: "Errand", coords: [-83.71, 42.21] as [number, number] }],
      finish: { label: "Home", coords: [-83.7, 42.2] as [number, number] },
      optionalByGap: [["101"], ["biz-202"]],
    };

    expect(decodeSavedWalk(encodeSharedRoute(route).toString(), 2)).toEqual({ route, at: 2 });
  });

  it("restores an unfinished legacy walk and rejects an invalid visit index", () => {
    const q = "r=101.biz-202&s=-83.70000%2C42.20000&l=0";
    expect(decodeSavedWalk(q, 1)).toEqual({
      route: { v: 1, start: "-83.70000,42.20000", stopIds: ["101", "biz-202"], loop: false },
      at: 1,
    });
    expect(decodeSavedWalk(q, -1)).toBeNull();
  });

  it("reconstructs a v2 itinerary and resumes at the saved visit", () => {
    const graph = buildGraph(makeWalkNetwork());
    const route = {
      v: 2 as const,
      start: { label: "Home", coords: [0, 0] as [number, number] },
      necessary: [{ label: "Corner Cafe", coords: [0.002, 0] as [number, number], codeId: "biz-202" }],
      finish: { label: "Library", coords: [0.003, 0] as [number, number] },
      optionalByGap: [["101"], ["303"]],
    };

    const restored = restoreSavedWalk(graph, encodeSharedRoute(route).toString(), 2);
    expect(restored?.at).toBe(2);
    expect(restored?.route.visits.map((visit) => visit.role)).toEqual([
      "start", "optional", "necessary", "optional", "finish",
    ]);
    expect(restored?.route.visits[restored.at + 1].role).toBe("optional");
  });

  it("reconstructs a legacy saved walk as a round trip", () => {
    const graph = buildGraph(makeWalkNetwork());
    const restored = restoreSavedWalk(graph, "r=101.biz-202&s=0%2C0&l=0", 1);

    expect(restored?.at).toBe(1);
    expect(restored?.necessary).toEqual([]);
    expect(restored?.finish.coords).toEqual(restored?.start.coords);
    expect(restored?.route.visits.at(-1)?.role).toBe("finish");
  });

  it("keeps all locations from a valid 100-stop legacy save", () => {
    const graph = buildGraph(makeWalkNetwork());
    const ids = [...Array.from({ length: 99 }, (_, index) => `missing-${index}`), "101"];
    const restored = restoreSavedWalk(graph, `r=${ids.join(".")}&s=0%2C0&l=1`, 0);

    expect(restored?.optionalByGap).toEqual([[0]]);
    expect(restored?.missingOptional).toBe(99);
  });
});
