import { describe, expect, it } from "vitest";
import { restoreStopIndices } from "./route-share";
import type { NetworkStop } from "./types";

const stops: NetworkStop[] = [
  { id: "101", addr: "1 Lawn Sign Ln", kind: "sign", n: 1 },
  { id: "biz-202", addr: "Corner Cafe", kind: "biz", n: 2 },
  { id: "303", addr: "3 Lawn Sign Ln", kind: "sign", n: 3 },
];

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
