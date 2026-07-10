"""Builds app/public/data/network.json (copied into docs/data/ by the Vite
build): the city-wide walking street network with every routeable lawn sign
and business-code location snapped in as its own node, consumed by the app's
route planner tab.

Intersections are nodes and street segments are edges (lengths in meters,
from OpenStreetMap). Each routeable location's nearest street edge is split at
the point on the road closest to it, a "snap" node is inserted there, and the
location hangs off it as a leaf node via a short access edge. Shortest paths
between locations therefore follow real streets.

Usage: .venv/bin/python scripts/build_network.py
Downloads OSM data via osmnx on first run (cached in ./cache).

Output format (arrays kept flat and compact for the browser):
  nodes: [lon0, lat0, lon1, lat1, ...]
  edges: [a0, b0, meters0, a1, b1, meters1, ...]  (node indices)
  edgeGeometryOffsets: numeric-value offsets into edgeGeometryDeltas,
                       one per edge + 1
  edgeGeometryDeltas: signed lon/lat microdegree deltas for intermediate
                      geometry vertices, accumulated from an edge's a node
  stops: [{"id": ..., "addr": ..., "kind": "sign"|"biz",
           "n": node_index}, ...]
"""

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import networkx as nx
import osmnx as ox
from shapely.geometry import LineString, Point
from shapely.ops import substring

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "public" / "data" / "network.json"
PAD = 0.003  # degrees (~300 m) of network beyond the outermost kept locations
MICRODEGREES = 1_000_000

# A handful of locations sit far outside town (toward Detroit / Belleville);
# a bbox over all of them pulls in a 766k-node network. Clamp to the Ann
# Arbor + Ypsilanti core and route only the locations inside it.
CORE = {"lon_min": -83.87, "lon_max": -83.60, "lat_min": 42.19, "lat_max": 42.34}

# Real streets and paths only: separately-mapped sidewalks, crossings, and
# service ways (driveways, parking aisles) triple the graph without adding
# routes people would describe differently than "walk along X street".
# Overpass treats a negated regex on a missing key as a match, so plain
# streets without a footway tag pass the second clause.
OSM_FILTER = (
    '["highway"~"primary|secondary|tertiary|unclassified|residential|'
    'living_street|pedestrian|footway|path|steps|cycleway|track"]'
    '["footway"!~"sidewalk|crossing"]["area"!="yes"]["access"!~"private"]'
)


def orient_line(line, start, end):
    """Return ``line`` in start-to-end order without changing its shape."""
    coords = list(line.coords)
    if len(coords) < 2:
        return LineString([start, end])

    def squared_distance(a, b):
        return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2

    forward = squared_distance(coords[0], start) + squared_distance(coords[-1], end)
    backward = squared_distance(coords[-1], start) + squared_distance(coords[0], end)
    if backward < forward:
        coords.reverse()
    return LineString(coords)


def edge_line(streets, u, v, k):
    """The u-to-v street geometry, falling back to a straight line."""
    data = streets.edges[u, v, k]
    start = (streets.nodes[u]["x"], streets.nodes[u]["y"])
    end = (streets.nodes[v]["x"], streets.nodes[v]["y"])
    if "geometry" in data:
        return orient_line(data["geometry"], start, end)
    return LineString([start, end])


def split_line_at_fractions(line, fractions):
    """Split an oriented line at normalized fractions, retaining every bend.

    ``shapely.ops.substring`` preserves source vertices between the split
    points, unlike reconnecting a snap node with a straight segment. It
    returns a Point for a zero-length fragment, which is represented here as
    a two-coordinate LineString so callers can keep one geometry per edge.
    """
    bounds = [0.0, *fractions, 1.0]
    pieces = []
    for start, end in zip(bounds, bounds[1:]):
        piece = substring(line, start, end, normalized=True)
        if isinstance(piece, Point):
            coord = tuple(piece.coords[0])
            piece = LineString([coord, coord])
        pieces.append(piece)
    return pieces


def split_edge_at_fractions(line, fractions, length_m):
    """Return shape fragments with portions of the existing OSM edge weight.

    ``length_m`` is OSMnx's road length and remains the routing authority;
    geometry is deliberately not remeasured here. The fractions partition the
    original weight exactly before the existing JSON rounding step.
    """
    bounds = [0.0, *fractions, 1.0]
    pieces = split_line_at_fractions(line, fractions)
    return [
        (piece, (end - start) * length_m)
        for piece, start, end in zip(pieces, bounds, bounds[1:])
    ]


def rounded_microdegrees(value):
    """Match the six-decimal coordinate precision serialized in ``nodes``."""
    return int(round(round(value, 6) * MICRODEGREES))


def encode_edge_geometry(line, start, end):
    """Encode an edge's intermediate shape coordinates as signed deltas.

    The browser starts from the serialized, rounded ``a`` node and appends
    the serialized ``b`` node itself. Consequently the endpoint coordinates
    must not appear here: direct connectors and straight street edges have an
    empty span, while curved lines contribute only ``coords[1:-1]``.
    """
    if line is None:
        return []
    coords = list(orient_line(line, start, end).coords)
    if len(coords) <= 2:
        return []

    prev_lon = rounded_microdegrees(start[0])
    prev_lat = rounded_microdegrees(start[1])
    deltas = []
    for lon, lat, *_ in coords[1:-1]:
        current_lon = rounded_microdegrees(lon)
        current_lat = rounded_microdegrees(lat)
        deltas += [current_lon - prev_lon, current_lat - prev_lat]
        prev_lon, prev_lat = current_lon, current_lat
    return deltas


def route_features(signs_fc, businesses_fc):
    """Return core-area lawn signs and business-code locations with route kinds."""
    selected = []
    for kind, collection in (("sign", signs_fc), ("biz", businesses_fc)):
        for feature in collection["features"]:
            lon, lat = feature["geometry"]["coordinates"]
            if CORE["lon_min"] <= lon <= CORE["lon_max"] and CORE["lat_min"] <= lat <= CORE["lat_max"]:
                selected.append((kind, feature))
    return selected


def serialize_route_stops(graph, index):
    """Serialize typed routeable locations from the split street graph."""
    return [
        {"id": data["stop_props"]["id"], "addr": data["stop_props"]["addr"],
         "kind": data["stop_kind"], "n": index[node]}
        for node, data in graph.nodes(data=True) if data["node_type"] == "stop"
    ]


def main():
    signs_fc = json.loads((ROOT / "app" / "public" / "data" / "signs.json").read_text())
    businesses_fc = json.loads((ROOT / "app" / "public" / "data" / "biz.json").read_text())
    route_feats = route_features(signs_fc, businesses_fc)
    lons = [feature["geometry"]["coordinates"][0] for _, feature in route_feats]
    lats = [feature["geometry"]["coordinates"][1] for _, feature in route_feats]
    print(f"{len(route_feats)} route locations in the core area "
          f"({len(signs_fc['features']) + len(businesses_fc['features']) - len(route_feats)} "
          f"outside it skipped); downloading network (first run is slow)...")
    streets = ox.graph_from_bbox(
        (min(lons) - PAD, min(lats) - PAD, max(lons) + PAD, max(lats) + PAD),
        custom_filter=OSM_FILTER,
    )
    print(f"street graph: {len(streets.nodes)} nodes, {len(streets.edges)} edges")

    G = nx.Graph(streets.to_undirected())
    nx.set_node_attributes(G, "intersection", "node_type")

    print("snapping route locations to street edges...")
    edge_hits = ox.distance.nearest_edges(
        streets, X=lons, Y=lats
    )
    stops_on_edge = defaultdict(list)
    for (kind, feature), (u, v, k) in zip(route_feats, edge_hits):
        stops_on_edge[tuple(sorted((u, v)))].append((u, v, k, kind, feature))

    for group in stops_on_edge.values():
        u, v, k, _, _ = group[0]  # one reference orientation for positions
        line = edge_line(streets, u, v, k)
        length_m = streets.edges[u, v, k]["length"]
        positions = sorted(
            ((line.project(Point(feature["geometry"]["coordinates"]), normalized=True), kind, feature)
             for _, _, _, kind, feature in group),
            key=lambda pair: pair[0],
        )

        G.remove_edge(u, v)
        prev_node = u
        pieces = split_edge_at_fractions(
            line, [frac for frac, _, _ in positions], length_m
        )
        for (frac, kind, feature), (piece, segment_length) in zip(positions, pieces):
            lon, lat = feature["geometry"]["coordinates"]
            snap = line.interpolate(frac, normalized=True)
            stop_id = f"stop-{kind}-{feature['properties']['id']}"
            snap_id = f"snap-{kind}-{feature['properties']['id']}"
            G.add_node(snap_id, node_type="snap", x=snap.x, y=snap.y)
            G.add_edge(prev_node, snap_id, length=segment_length, geometry=piece)
            G.add_node(stop_id, node_type="stop", x=lon, y=lat,
                       stop_kind=kind, stop_props=feature["properties"])
            G.add_edge(stop_id, snap_id,
                       length=ox.distance.great_circle(lat, lon, snap.y, snap.x))
            prev_node = snap_id
        final_piece, final_length = pieces[-1]
        G.add_edge(prev_node, v, length=final_length, geometry=final_piece)

    # Routing needs every stop reachable from every other; keep only the
    # component holding the most route stops (tiny disconnected fragments happen
    # at the bbox border).
    components = list(nx.connected_components(G))
    keep = max(components,
               key=lambda c: sum(G.nodes[n]["node_type"] == "stop" for n in c))
    dropped_stops = sum(
        G.nodes[n]["node_type"] == "stop" for c in components if c is not keep for n in c
    )
    G = G.subgraph(keep).copy()
    if dropped_stops:
        print(f"warning: dropped {dropped_stops} route locations in disconnected fragments")

    index = {n: i for i, n in enumerate(G.nodes)}
    nodes = []
    for n, d in G.nodes(data=True):
        nodes += [round(d["x"], 6), round(d["y"], 6)]
    edges = []
    edge_geometry_offsets = [0]
    edge_geometry_deltas = []
    for a, b, d in G.edges(data=True):
        edges += [index[a], index[b], round(d["length"])]
        start = (G.nodes[a]["x"], G.nodes[a]["y"])
        end = (G.nodes[b]["x"], G.nodes[b]["y"])
        edge_geometry_deltas.extend(encode_edge_geometry(d.get("geometry"), start, end))
        edge_geometry_offsets.append(len(edge_geometry_deltas))
    stops_out = serialize_route_stops(G, index)

    payload = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "nodes": nodes,
        "edges": edges,
        "edgeGeometryOffsets": edge_geometry_offsets,
        "edgeGeometryDeltas": edge_geometry_deltas,
        "stops": stops_out,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"network.json: {len(nodes) // 2} nodes, {len(edges) // 3} edges, "
          f"{len(stops_out)} route locations, {OUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
