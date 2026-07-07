"""Builds docs/data/network.json: the city-wide walking street network with
every lawn sign snapped in as its own node, consumed by the app's route
planner tab.

Intersections are nodes and street segments are edges (lengths in meters,
from OpenStreetMap). Each sign's nearest street edge is split at the point
on the road closest to the sign, a "snap" node is inserted there, and the
sign hangs off it as a leaf node via a short access edge. Shortest paths
between signs therefore follow real streets.

Usage: .venv/bin/python scripts/build_network.py
Downloads OSM data via osmnx on first run (cached in ./cache).

Output format (arrays kept flat and compact for the browser):
  nodes: [lon0, lat0, lon1, lat1, ...]
  edges: [a0, b0, meters0, a1, b1, meters1, ...]  (node indices)
  signs: [{"id": ..., "addr": ..., "n": node_index}, ...]
"""

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import networkx as nx
import osmnx as ox
from shapely.geometry import LineString, Point

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "network.json"
PAD = 0.003  # degrees (~300 m) of network beyond the outermost kept signs

# A handful of signs sit far outside town (toward Detroit / Belleville); a
# bbox over all of them pulls in a 766k-node network. Clamp to the Ann
# Arbor + Ypsilanti core and route only the signs inside it.
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


def edge_line(streets, u, v, k):
    """The street edge's geometry, falling back to a straight line."""
    data = streets.edges[u, v, k]
    if "geometry" in data:
        return data["geometry"]
    return LineString([
        (streets.nodes[u]["x"], streets.nodes[u]["y"]),
        (streets.nodes[v]["x"], streets.nodes[v]["y"]),
    ])


def main():
    signs_fc = json.loads((ROOT / "docs" / "data" / "signs.json").read_text())
    all_feats = signs_fc["features"]
    feats = [
        f for f in all_feats
        if CORE["lon_min"] <= f["geometry"]["coordinates"][0] <= CORE["lon_max"]
        and CORE["lat_min"] <= f["geometry"]["coordinates"][1] <= CORE["lat_max"]
    ]
    lons = [f["geometry"]["coordinates"][0] for f in feats]
    lats = [f["geometry"]["coordinates"][1] for f in feats]
    print(f"{len(feats)} signs in the core area ({len(all_feats) - len(feats)} "
          f"outside it skipped); downloading network (first run is slow)...")
    streets = ox.graph_from_bbox(
        (min(lons) - PAD, min(lats) - PAD, max(lons) + PAD, max(lats) + PAD),
        custom_filter=OSM_FILTER,
    )
    print(f"street graph: {len(streets.nodes)} nodes, {len(streets.edges)} edges")

    G = nx.Graph(streets.to_undirected())
    nx.set_node_attributes(G, "intersection", "node_type")

    print("snapping signs to street edges...")
    edge_hits = ox.distance.nearest_edges(
        streets, X=lons, Y=lats
    )
    signs_on_edge = defaultdict(list)
    for feature, (u, v, k) in zip(feats, edge_hits):
        signs_on_edge[tuple(sorted((u, v)))].append((u, v, k, feature))

    for group in signs_on_edge.values():
        u, v, k, _ = group[0]  # one reference orientation for positions
        line = edge_line(streets, u, v, k)
        length_m = streets.edges[u, v, k]["length"]
        positions = sorted(
            ((line.project(Point(f["geometry"]["coordinates"]), normalized=True), f)
             for _, _, _, f in group),
            key=lambda pair: pair[0],
        )

        G.remove_edge(u, v)
        prev_node, prev_frac = u, 0.0
        for frac, feature in positions:
            lon, lat = feature["geometry"]["coordinates"]
            snap = line.interpolate(frac, normalized=True)
            sign_id = f"sign-{feature['properties']['id']}"
            snap_id = f"snap-{feature['properties']['id']}"
            G.add_node(snap_id, node_type="snap", x=snap.x, y=snap.y)
            G.add_edge(prev_node, snap_id, length=(frac - prev_frac) * length_m)
            G.add_node(sign_id, node_type="sign", x=lon, y=lat,
                       sign_props=feature["properties"])
            G.add_edge(sign_id, snap_id,
                       length=ox.distance.great_circle(lat, lon, snap.y, snap.x))
            prev_node, prev_frac = snap_id, frac
        G.add_edge(prev_node, v, length=(1.0 - prev_frac) * length_m)

    # Routing needs every sign reachable from every other; keep only the
    # component holding the most signs (tiny disconnected fragments happen
    # at the bbox border).
    components = list(nx.connected_components(G))
    keep = max(components,
               key=lambda c: sum(G.nodes[n]["node_type"] == "sign" for n in c))
    dropped_signs = sum(
        G.nodes[n]["node_type"] == "sign" for c in components if c is not keep for n in c
    )
    G = G.subgraph(keep).copy()
    if dropped_signs:
        print(f"warning: dropped {dropped_signs} signs in disconnected fragments")

    index = {n: i for i, n in enumerate(G.nodes)}
    nodes = []
    for n, d in G.nodes(data=True):
        nodes += [round(d["x"], 6), round(d["y"], 6)]
    edges = []
    for a, b, d in G.edges(data=True):
        edges += [index[a], index[b], round(d["length"])]
    signs_out = [
        {"id": d["sign_props"]["id"], "addr": d["sign_props"]["addr"], "n": index[n]}
        for n, d in G.nodes(data=True) if d["node_type"] == "sign"
    ]

    payload = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "nodes": nodes,
        "edges": edges,
        "signs": signs_out,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"network.json: {len(nodes) // 2} nodes, {len(edges) // 3} edges, "
          f"{len(signs_out)} signs, {OUT.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
