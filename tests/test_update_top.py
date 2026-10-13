#!/usr/bin/env python3
"""
Tests de update-top.py (BD cíclica de paquetes y detección de issues).
Solo stdlib. El script tiene guion en el nombre, así que se importa con importlib.

Uso: python3 -m unittest discover -s tests -v
"""
import importlib.util
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

_PATH = Path(__file__).resolve().parent.parent / "collector" / "update-top.py"
_spec = importlib.util.spec_from_file_location("update_top", _PATH)
ut = importlib.util.module_from_spec(_spec)
sys.modules["update_top"] = ut
_spec.loader.exec_module(ut)


def _us(seconds_ago=0):
    return int((time.time() - seconds_ago) * 1_000_000)


class ParsingTests(unittest.TestCase):
    def test_telemetry_subtype(self):
        self.assertEqual(ut.telemetry_subtype("device_metrics { battery_level: 80 }"), "device")
        self.assertEqual(ut.telemetry_subtype("environment_metrics { temperature: 20 }"), "environment")
        self.assertEqual(ut.telemetry_subtype("power_metrics { ch1_voltage: 5 }"), "power")
        self.assertEqual(ut.telemetry_subtype("otra cosa"), "other")
        self.assertEqual(ut.telemetry_subtype(None), "other")

    def test_parse_position_missing_fields(self):
        self.assertEqual(ut.parse_position(None), (None, None))
        self.assertEqual(ut.parse_position("latitude_i: 415422579"), (None, None))

    def test_haversine_zero_and_symmetry(self):
        self.assertAlmostEqual(ut.haversine_m(40.0, -3.0, 40.0, -3.0), 0.0)
        a = ut.haversine_m(40.4, -3.7, 41.4, 2.2)
        b = ut.haversine_m(41.4, 2.2, 40.4, -3.7)
        self.assertAlmostEqual(a, b)
        self.assertTrue(500_000 < a < 560_000)  # Madrid–Barcelona ≈ 505 km


class PacketWindowTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_db, self._old_fetch = ut.TOPNODOS_DB_PATH, ut.fetch_json
        ut.TOPNODOS_DB_PATH = os.path.join(self._tmp.name, "topnodos.db")
        ut.init_db()

    def tearDown(self):
        ut.TOPNODOS_DB_PATH, ut.fetch_json = self._old_db, self._old_fetch
        self._tmp.cleanup()

    def _fake_api(self, packets):
        calls = []

        def fake(url):
            calls.append(url)
            return {"packets": packets}
        ut.fetch_json = fake
        return calls

    def test_sync_stores_packets_and_cursor(self):
        node = 123
        pkts = [
            {"id": 1, "from_node_id": node, "portnum": 3, "to_node_id": 1, "payload": "p", "import_time_us": _us(100)},
            {"id": 2, "from_node_id": node, "portnum": 3, "to_node_id": 1, "payload": "p", "import_time_us": _us(50)},
            {"id": 3, "from_node_id": 999, "portnum": 3, "to_node_id": 1, "payload": "x", "import_time_us": _us(10)},
        ]
        self._fake_api(pkts)
        ut._sync_packets(node)
        got = ut._read_packets_window(node)
        self.assertEqual(sorted(p["id"] for p in got), [1, 2])  # el ajeno se filtra

    def test_second_sync_uses_cursor(self):
        node = 7
        t1 = _us(100)
        self._fake_api([{"id": 1, "from_node_id": node, "portnum": 3, "to_node_id": 1, "payload": "", "import_time_us": t1}])
        ut._sync_packets(node)
        calls = self._fake_api([])
        ut._sync_packets(node)
        self.assertIn(f"since={t1 + 1}", calls[0])

    def test_old_packets_are_purged(self):
        node = 9
        old = _us(25 * 3600)
        conn = ut._db()
        conn.execute(
            "INSERT INTO packets (node_id, packet_id, portnum, to_node_id, payload, import_time_us) VALUES (?,?,?,?,?,?)",
            (node, 1, 3, 1, "", old),
        )
        conn.commit()
        conn.close()
        self._fake_api([])
        ut._sync_packets(node)
        conn = ut._db()
        n = conn.execute("SELECT COUNT(*) FROM packets WHERE node_id=?", (node,)).fetchone()[0]
        conn.close()
        self.assertEqual(n, 0)

    def test_analyze_node_survives_sync_failure(self):
        node = 5
        conn = ut._db()
        conn.execute(
            "INSERT INTO packets (node_id, packet_id, portnum, to_node_id, payload, import_time_us) VALUES (?,?,?,?,?,?)",
            (node, 1, 3, 1, "latitude_i: 415422579 longitude_i: -37000000", _us(60)),
        )
        conn.commit()
        conn.close()

        def boom(url):
            raise OSError("red caída")
        ut.fetch_json = boom
        # No debe lanzar: analiza con lo que ya hay en la BD local.
        ut.analyze_node(node)
        self.assertEqual(len(ut._read_packets_window(node)), 1)


class DetectIssuesTests(unittest.TestCase):
    def test_no_packets_no_issues(self):
        self.assertEqual(ut.detect_issues({}), [])

    def test_range_test_is_critical(self):
        issues = ut.detect_issues({"packets": {"range_test": 500}})
        self.assertTrue(any(i["key"] == "range_test" and i["severity"] == "critical" for i in issues))


if __name__ == "__main__":
    unittest.main()
