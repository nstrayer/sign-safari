// Shared shapes passed between modules. Outside data (fetched JSON, MapLibre
// feature properties, Photon responses) is cast to these exactly once at the
// boundary where it enters; everything past that point typechecks for real.

export type Kind = "sign" | "biz" | "badge";

export type LonLat = [number, number];

/** Point-feature properties as emitted by scripts/prepare_data.py. */
export interface SignProps {
  id: string; // "123", "biz-45", "badge-3"
  addr?: string; // signs + biz
  city?: string;
  zip?: string;
  reds?: number; // redemption count
  label?: string; // badges only
  image?: string; // badges only
}

export interface PointFeature {
  type: "Feature";
  id: number | string;
  geometry: { type: "Point"; coordinates: LonLat };
  properties: SignProps;
}

/** Shape of data/signs.json, data/biz.json, data/badges.json. */
export interface SignCollection {
  type: "FeatureCollection";
  generated: string;
  features: PointFeature[];
}

/** A tapped/selected feature, as passed between map, search, and the sheet. */
export interface TappedFeature {
  id: string;
  kind: Kind;
  props: SignProps;
  coords: LonLat;
}

/** Raw shape of data/network.json (see scripts/build_network.py). */
export interface NetworkData {
  generated: string;
  nodes: number[]; // [lon0, lat0, lon1, lat1, ...]
  edges: number[]; // [a, b, meters, ...] node-index triples
  /**
   * Optional compact road shapes, parallel to `edges`. Each edge's span in
   * `edgeGeometryDeltas` is [offsets[e], offsets[e + 1]); values are signed
   * microdegree lon/lat deltas for intermediate vertices only.
   */
  edgeGeometryOffsets?: number[];
  edgeGeometryDeltas?: number[];
  signs: NetworkSign[];
}

export interface NetworkSign {
  id: string;
  addr: string;
  n: number; // index into nodes
}

/** The fields we read from photon.komoot.io geocoder responses. */
export interface PhotonProperties {
  name?: string;
  street?: string;
  housenumber?: string;
  city?: string;
  district?: string;
  state?: string;
}

export interface PhotonResponse {
  features?: {
    properties: PhotonProperties;
    geometry: { coordinates: LonLat };
  }[];
}
