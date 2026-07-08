// Shared Photon (komoot.io) geocoder used by the map tab's search and the
// route planner's address box. Owns the endpoint, the Ann Arbor area bias,
// the debounce/abort/stale-response discipline, and place-label assembly.

import type { LonLat, PhotonResponse } from "./types";

const PHOTON_URL = "https://photon.komoot.io/api/";
const AREA = { lat: 42.2808, lon: -83.743, bbox: "-84.25,42.0,-83.35,42.55" };
const DEBOUNCE_MS = 300;

/** A geocoded hit, labeled and ready to show in a results list. */
export interface GeocodedPlace {
  label: string;
  sub: string;
  coords: LonLat;
}

interface GeocoderOptions {
  limit: number;
  /** Live trimmed input value; a response landing after it changed is dropped. */
  currentQuery: () => string;
  /** Applied to both sides of the stale comparison (default: exact match). */
  normalize?: (s: string) => string;
  /** Omit the street from the sub line when it already names the place. */
  dedupeNameInSub?: boolean;
  /** Fall back to the state name when the sub line would be empty. */
  stateFallback?: boolean;
}

export interface Geocoder {
  /** Debounced lookup: fires after a pause, superseding any pending or in-flight query. */
  query(q: string, onResults: (places: GeocodedPlace[]) => void): void;
  /** Drop any pending timer and abort the in-flight request. */
  cancel(): void;
}

export function createGeocoder({ limit, currentQuery, normalize, dedupeNameInSub, stateFallback }: GeocoderOptions): Geocoder {
  let abort: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function toPlace(f: NonNullable<PhotonResponse["features"]>[number]): GeocodedPlace {
    const p = f.properties;
    const street = p.street && p.housenumber ? `${p.housenumber} ${p.street}` : p.street;
    const parts = [dedupeNameInSub && street === p.name ? null : street, p.city ?? p.district];
    let sub = parts.filter(Boolean).join(", ");
    if (!sub && stateFallback) sub = p.state ?? "";
    return {
      label: p.name ?? street ?? "Unknown place",
      sub,
      coords: f.geometry.coordinates,
    };
  }

  async function run(q: string, onResults: (places: GeocodedPlace[]) => void): Promise<void> {
    abort?.abort();
    abort = new AbortController();
    const url = `${PHOTON_URL}?q=${encodeURIComponent(q)}&lat=${AREA.lat}&lon=${AREA.lon}&bbox=${AREA.bbox}&limit=${limit}`;
    try {
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) return;
      const data = (await res.json()) as PhotonResponse;
      const live = normalize ? normalize(currentQuery()) : currentQuery();
      const asked = normalize ? normalize(q) : q;
      if (live !== asked) return; // stale
      onResults((data.features ?? []).map(toPlace));
    } catch (e) {
      if (!(e instanceof Error) || e.name !== "AbortError") console.warn("Photon search failed", e);
    }
  }

  function query(q: string, onResults: (places: GeocodedPlace[]) => void): void {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { void run(q, onResults); }, DEBOUNCE_MS);
  }

  function cancel(): void {
    clearTimeout(debounceTimer);
    abort?.abort();
  }

  return { query, cancel };
}
