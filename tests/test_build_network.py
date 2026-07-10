"""Synthetic geometry coverage for the network payload builder."""

import unittest

import networkx as nx
from shapely.geometry import LineString

from scripts.build_network import (
    encode_edge_geometry,
    route_features,
    serialize_route_stops,
    rounded_microdegrees,
    split_edge_at_fractions,
)


class SplitStreetGeometryTest(unittest.TestCase):
    def test_curved_edge_keeps_bends_and_osm_weight_when_signs_split_it(self):
        # The signs land before the first and after the second bend, so the
        # middle fragment must retain both original OSM vertices.
        road = LineString([(0, 0), (1, 1), (2, 1), (3, 0)])
        pieces = split_edge_at_fractions(road, [0.25, 0.75], length_m=1234.5)

        self.assertEqual(len(pieces), 3)
        self.assertEqual(list(pieces[1][0].coords)[1:-1], [(1.0, 1.0), (2.0, 1.0)])
        for (left, _), (right, _) in zip(pieces, pieces[1:]):
            self.assertEqual(left.coords[-1], right.coords[0])
        self.assertAlmostEqual(sum(weight for _, weight in pieces), 1234.5)

        middle = pieces[1][0]
        deltas = encode_edge_geometry(middle, middle.coords[0], middle.coords[-1])
        self.assertEqual(len(deltas), 4)  # two intermediate lon/lat pairs only

        lon = rounded_microdegrees(middle.coords[0][0])
        lat = rounded_microdegrees(middle.coords[0][1])
        decoded = []
        for dlon, dlat in zip(deltas[::2], deltas[1::2]):
            lon += dlon
            lat += dlat
            decoded.append((lon, lat))
        self.assertEqual(decoded, [(1_000_000, 1_000_000), (2_000_000, 1_000_000)])
        self.assertEqual(
            encode_edge_geometry(LineString([(0, 0), (3, 0)]), (0, 0), (3, 0)), []
        )


class RouteFeatureSelectionTest(unittest.TestCase):
    def test_keeps_core_lawn_signs_and_business_code_locations_as_typed_stops(self):
        signs = {
            "features": [
                {"geometry": {"coordinates": [-83.74, 42.28]}, "properties": {"id": "sign-1"}},
                {"geometry": {"coordinates": [-83.58, 42.28]}, "properties": {"id": "outside"}},
            ]
        }
        businesses = {
            "features": [
                {"geometry": {"coordinates": [-83.75, 42.27]}, "properties": {"id": "biz-1"}},
            ]
        }

        selected = route_features(signs, businesses)

        self.assertEqual(
            [(kind, feature["properties"]["id"]) for kind, feature in selected],
            [("sign", "sign-1"), ("biz", "biz-1")],
        )

    def test_serializes_stop_kind_with_each_routeable_location(self):
        graph = nx.Graph()
        graph.add_node(
            "lawn",
            node_type="stop",
            stop_kind="sign",
            stop_props={"id": "sign-1", "addr": "1 Lawn Sign Ln"},
        )
        graph.add_node(
            "business",
            node_type="stop",
            stop_kind="biz",
            stop_props={"id": "biz-2", "addr": "Corner Cafe"},
        )
        graph.add_node("intersection", node_type="intersection")

        stops = serialize_route_stops(graph, {"lawn": 4, "business": 7, "intersection": 9})

        self.assertEqual(
            stops,
            [
                {"id": "sign-1", "addr": "1 Lawn Sign Ln", "kind": "sign", "n": 4},
                {"id": "biz-2", "addr": "Corner Cafe", "kind": "biz", "n": 7},
            ],
        )


if __name__ == "__main__":
    unittest.main()
