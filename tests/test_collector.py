#!/usr/bin/env python3
"""
Tests del collector — solo stdlib (unittest), coherente con que el
collector tampoco tiene dependencias externas.

Uso: python3 -m unittest discover -s tests -v
     (o simplemente: python3 tests/test_collector.py)
"""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "collector"))
import collector  # noqa: E402


class DecodeCoordTests(unittest.TestCase):
    def test_x1e7_integer(self):
        # Caso real de la API: 415422579 → 41.5422579
        self.assertAlmostEqual(collector._decode_coord(415422579), 41.5422579)

    def test_negative_x1e7(self):
        self.assertAlmostEqual(collector._decode_coord(-37000000), -3.7)

    def test_already_decimal_degrees(self):
        self.assertAlmostEqual(collector._decode_coord(41.5), 41.5)

    def test_out_of_range_returns_none(self):
        # ni como grados ni como x1e7 cabe en -180..180
        self.assertIsNone(collector._decode_coord(99999999999))

    def test_none_input(self):
        self.assertIsNone(collector._decode_coord(None))


class ToUnixSecondsTests(unittest.TestCase):
    def test_seconds_passthrough(self):
        self.assertEqual(collector._to_unix_seconds(1700000000), 1700000000)

    def test_milliseconds_converted(self):
        self.assertEqual(collector._to_unix_seconds(1700000000000), 1700000000)

    def test_microseconds_converted(self):
        self.assertEqual(collector._to_unix_seconds(1700000000000000), 1700000000)

    def test_none_input(self):
        self.assertIsNone(collector._to_unix_seconds(None))

    def test_non_numeric_returns_none(self):
        self.assertIsNone(collector._to_unix_seconds("no-timestamp"))


class CachePathTests(unittest.TestCase):
    def test_sanitizes_query_string_characters(self):
        # Antes de esta semana, "?" y "=" pasaban tal cual al nombre de fichero
        url = "https://meshview.meshtastic.es/api/edges?type=neighbor"
        path = collector._cache_path(url)
        self.assertNotIn("?", path.name)
        self.assertNotIn("=", path.name)
        self.assertTrue(path.name.startswith("cache_"))
        self.assertTrue(path.name.endswith(".json"))

    def test_distinct_urls_produce_distinct_paths(self):
        a = collector._cache_path("https://x/api/edges?type=neighbor")
        b = collector._cache_path("https://x/api/edges?type=traceroute")
        self.assertNotEqual(a, b)


class ParseNodesTests(unittest.TestCase):
    def test_unwraps_nodes_key_and_decodes_coords(self):
        raw = {"nodes": [{
            "node_id": "!aabbccdd", "short_name": "ABC", "long_name": "A B C",
            "hw_model": "TBEAM", "role": "CLIENT",
            "last_lat": 415422579, "last_long": -37000000,
            "is_mqtt_gateway": True, "last_seen_us": 1700000000000000,
        }]}
        nodes = collector.parse_nodes(raw)
        self.assertEqual(len(nodes), 1)
        n = nodes[0]
        self.assertEqual(n["node_id"], "!aabbccdd")
        self.assertAlmostEqual(n["latitude"], 41.5422579)
        self.assertAlmostEqual(n["longitude"], -3.7)
        self.assertEqual(n["is_mqtt_gateway"], 1)
        self.assertEqual(n["last_seen"], 1700000000)

    def test_null_island_discarded(self):
        raw = {"nodes": [{"node_id": "!x", "last_lat": 0, "last_long": 0}]}
        n = collector.parse_nodes(raw)[0]
        self.assertIsNone(n["latitude"])
        self.assertIsNone(n["longitude"])

    def test_node_without_id_is_skipped(self):
        raw = {"nodes": [{"short_name": "sin id"}]}
        self.assertEqual(collector.parse_nodes(raw), [])

    def test_nested_telemetry_is_read(self):
        raw = {"nodes": [{
            "node_id": "!1", "device_metrics": {"battery_level": 87, "voltage": 4.01},
        }]}
        n = collector.parse_nodes(raw)[0]
        self.assertEqual(n["battery_level"], 87)
        self.assertAlmostEqual(n["voltage"], 4.01)


class ParseEdgesTests(unittest.TestCase):
    def test_int_node_ids_converted_to_hex(self):
        raw = {"edges": [{"from": 42115050, "to": 42115051, "snr": 5.5}]}
        e = collector.parse_edges(raw)[0]
        self.assertEqual(e["from_node"], "!02829fea")
        self.assertEqual(e["to_node"], "!02829feb")

    def test_missing_from_or_to_is_skipped(self):
        raw = {"edges": [{"from": None, "to": 1}]}
        self.assertEqual(collector.parse_edges(raw), [])


class UpsertNodesTests(unittest.TestCase):
    def setUp(self):
        self.conn = collector.get_db(Path(":memory:"))

    def _node(self, **overrides):
        base = {
            "node_id": "!aaaaaaaa", "short_name": "A", "long_name": "Node A",
            "hardware": "TBEAM", "role": "CLIENT", "latitude": 40.0, "longitude": -3.0,
            "altitude": None, "battery_level": 90, "voltage": 4.0, "snr": 5.0,
            "rssi": -80, "channel_util": 1.0, "air_util_tx": 1.0, "firmware": "2.7.0",
            "channel": "LongFast", "is_mqtt_gateway": 0, "hops_away": 1,
            "last_seen": 1700000000, "first_seen": 1700000000,
        }
        base.update(overrides)
        return base

    def test_insert_then_update_preserves_position_when_new_is_null(self):
        collector.upsert_nodes(self.conn, [self._node()])
        # Segunda colección: la API no da posición esta vez (GPS sin fix)
        collector.upsert_nodes(self.conn, [self._node(latitude=None, longitude=None)])
        row = self.conn.execute(
            "SELECT latitude, longitude FROM nodes WHERE node_id = '!aaaaaaaa'"
        ).fetchone()
        self.assertAlmostEqual(row["latitude"], 40.0)
        self.assertAlmostEqual(row["longitude"], -3.0)

    def test_is_mqtt_gateway_always_overwritten(self):
        # A diferencia de posición/batería, is_mqtt_gateway no usa COALESCE:
        # si el nodo deja de ser gateway, debe reflejarse
        collector.upsert_nodes(self.conn, [self._node(is_mqtt_gateway=1)])
        collector.upsert_nodes(self.conn, [self._node(is_mqtt_gateway=0)])
        row = self.conn.execute(
            "SELECT is_mqtt_gateway FROM nodes WHERE node_id = '!aaaaaaaa'"
        ).fetchone()
        self.assertEqual(row["is_mqtt_gateway"], 0)


class UpsertEdgesTests(unittest.TestCase):
    def setUp(self):
        self.conn = collector.get_db(Path(":memory:"))

    def test_duplicate_pair_is_updated_not_duplicated(self):
        edges = [{"from_node": "!a", "to_node": "!b", "snr": 1.0,
                   "edge_type": "neighbor", "last_seen": 100}]
        collector.upsert_edges(self.conn, edges)
        edges[0]["last_seen"] = 200
        collector.upsert_edges(self.conn, edges)
        rows = self.conn.execute("SELECT last_seen FROM edges").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["last_seen"], 200)


class ExportJsonTests(unittest.TestCase):
    def setUp(self):
        self.conn = collector.get_db(Path(":memory:"))
        self.now = int(time.time())
        self._orig_retention = collector.RETENTION_DAYS
        collector.RETENTION_DAYS = 7

    def tearDown(self):
        collector.RETENTION_DAYS = self._orig_retention

    def _insert_node(self, node_id, lat, lon, last_seen, updated_at=None):
        self.conn.execute(
            "INSERT INTO nodes (node_id, latitude, longitude, last_seen, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (node_id, lat, lon, last_seen, updated_at or self.now),
        )
        self.conn.commit()

    def test_nodes_without_position_are_exported(self):
        self._insert_node("!nopos", None, None, self.now)

        out = Path(tempfile.mkdtemp())
        collector.export_json(self.conn, out)
        with open(out / "nodes.json") as f:
            nodes = json.load(f)["nodes"]
        self.assertEqual([n["node_id"] for n in nodes], ["!nopos"])

    def test_null_island_is_excluded(self):
        self._insert_node("!island", 0.0, 0.0, self.now)

        out = Path(tempfile.mkdtemp())
        collector.export_json(self.conn, out)
        with open(out / "nodes.json") as f:
            nodes = json.load(f)["nodes"]
        self.assertEqual(nodes, [])

    def test_purge_uses_updated_at_when_last_seen_is_null(self):
        old = self.now - 30 * 86400
        self._insert_node("!stale", 40.0, -3.0, None, updated_at=old)

        out = Path(tempfile.mkdtemp())
        collector.export_json(self.conn, out)
        remaining = [r["node_id"] for r in self.conn.execute("SELECT node_id FROM nodes")]
        self.assertNotIn("!stale", remaining)

    def test_edges_json_only_includes_nodes_present_in_both_sides(self):
        self._insert_node("!a", 40.0, -3.0, self.now)
        # !b no existe en nodes → el edge no debe aparecer en edges.json
        self.conn.execute(
            "INSERT INTO edges (from_node, to_node, edge_type, last_seen) VALUES (?,?,?,?)",
            ("!a", "!b", "neighbor", self.now),
        )
        self.conn.commit()

        out = Path(tempfile.mkdtemp())
        collector.export_json(self.conn, out)
        with open(out / "edges.json") as f:
            edges = json.load(f)["edges"]
        self.assertEqual(edges, [])

    def test_edges_with_integer_ids_are_migrated_and_matched(self):
        self._insert_node("!aaaaaaaa", 40.0, -3.0, self.now)
        self._insert_node("!dddddddd", 41.0, -2.0, self.now)
        self.conn.execute(
            "INSERT INTO edges (from_node, to_node, edge_type, last_seen) VALUES (?,?,?,?)",
            (str(int("aaaaaaaa", 16)), str(int("dddddddd", 16)), "neighbor", self.now),
        )
        self.conn.commit()

        out = Path(tempfile.mkdtemp())
        collector.export_json(self.conn, out)
        with open(out / "edges.json") as f:
            edges = json.load(f)["edges"]
        self.assertEqual(len(edges), 1)
        self.assertEqual(edges[0]["from_node"], "!aaaaaaaa")
        self.assertEqual(edges[0]["to_node"], "!dddddddd")


if __name__ == "__main__":
    unittest.main()
