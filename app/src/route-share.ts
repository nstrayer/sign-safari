import type { NetworkStop } from "./types";

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
