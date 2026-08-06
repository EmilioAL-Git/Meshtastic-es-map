#!/usr/bin/env python3
"""
Tests del servicio livefeed (unittest). Requiere las dependencias de
livefeed/requirements.txt (paho-mqtt, protobuf, websockets) — se ejecuta en
su propio job de CI, separado del de collector (que sigue siendo stdlib-only).

Uso: python3 -m unittest discover -s tests -p "test_livefeed.py" -v
"""
import json
import sys
import unittest
from pathlib import Path

_LIVEFEED_DIR = Path(__file__).resolve().parent.parent / "livefeed"
sys.path.insert(0, str(_LIVEFEED_DIR))
sys.path.insert(0, str(_LIVEFEED_DIR / "proto"))

from meshtastic import mqtt_pb2, portnums_pb2  # noqa: E402

import correlator  # noqa: E402
import mqtt_source  # noqa: E402


def make_envelope(*, gateway_id="!11111111", packet_id=42, from_id=0xAABBCCDD,
                   to_id=0xFFFFFFFF, hop_limit=3, hop_start=3, channel=0,
                   relay_node=None, portnum=None, rx_time=1_700_000_000,
                   encrypted=False):
    env = mqtt_pb2.ServiceEnvelope()
    env.gateway_id = gateway_id
    env.channel_id = "LongFast"
    env.packet.id = packet_id
    setattr(env.packet, "from", from_id)
    env.packet.to = to_id
    env.packet.hop_limit = hop_limit
    env.packet.hop_start = hop_start
    env.packet.channel = channel
    env.packet.rx_time = rx_time
    if relay_node is not None:
        env.packet.relay_node = relay_node
    if encrypted:
        env.packet.encrypted = b"\x01\x02\x03"
    else:
        env.packet.decoded.portnum = portnum or portnums_pb2.PortNum.TEXT_MESSAGE_APP
        env.packet.decoded.payload = b"contenido secreto del mensaje"
    return env.SerializeToString()


class DecodeServiceEnvelopeTests(unittest.TestCase):
    def test_decodes_routing_metadata(self):
        event = mqtt_source.decode_service_envelope(make_envelope())
        self.assertEqual(event["packet_id"], 42)
        self.assertEqual(event["from"], "!aabbccdd")
        self.assertEqual(event["to"], "!ffffffff")
        self.assertEqual(event["hop_limit"], 3)
        self.assertEqual(event["hop_start"], 3)
        self.assertEqual(event["gateway_id"], "!11111111")
        self.assertEqual(event["portnum"], "TEXT_MESSAGE_APP")

    def test_never_exposes_message_payload(self):
        """Guarda de regresión de privacidad: el payload nunca debe aparecer."""
        event = mqtt_source.decode_service_envelope(make_envelope())
        serialized = json.dumps(event)
        self.assertNotIn("contenido secreto", serialized)
        self.assertNotIn("payload", event)

    def test_encrypted_packet_reports_portnum_unknown(self):
        event = mqtt_source.decode_service_envelope(make_envelope(encrypted=True))
        self.assertEqual(event["portnum"], "ENCRYPTED")

    def test_relay_node_present(self):
        event = mqtt_source.decode_service_envelope(make_envelope(relay_node=0x11))
        self.assertEqual(event["relay_node"], "!00000011")

    def test_relay_node_absent(self):
        event = mqtt_source.decode_service_envelope(make_envelope())
        self.assertIsNone(event["relay_node"])

    def test_garbage_payload_returns_none(self):
        self.assertIsNone(mqtt_source.decode_service_envelope(b"no es protobuf valido"))

    def test_packet_without_id_returns_none(self):
        env = mqtt_pb2.ServiceEnvelope()
        env.gateway_id = "!11111111"
        self.assertIsNone(mqtt_source.decode_service_envelope(env.SerializeToString()))


class CorrelatorTests(unittest.TestCase):
    def setUp(self):
        self.clock = 0.0
        self.corr = correlator.Correlator(window_s=45, now_fn=lambda: self.clock)

    def _event(self, **overrides):
        base = {
            "packet_id": 42, "from": "!aabbccdd", "to": "!ffffffff",
            "hop_limit": 3, "hop_start": 3, "channel": 0,
            "portnum": "TEXT_MESSAGE_APP", "gateway_id": "!11111111",
            "rx_time": 1_700_000_000, "relay_node": None,
        }
        base.update(overrides)
        return base

    def test_first_sighting_emits_new_and_stage(self):
        out = self.corr.ingest(self._event())
        types = [e["type"] for e in out]
        self.assertEqual(types, ["packet_new", "packet_stage"])
        self.assertEqual(out[1]["stages"][0]["gateway_ids"], ["!11111111"])

    def test_second_gateway_same_hop_limit_merges_into_one_stage(self):
        self.corr.ingest(self._event(gateway_id="!11111111"))
        out = self.corr.ingest(self._event(gateway_id="!22222222"))
        stage_event = out[-1]
        self.assertEqual(len(stage_event["stages"]), 1)
        self.assertEqual(
            sorted(stage_event["stages"][0]["gateway_ids"]),
            ["!11111111", "!22222222"],
        )

    def test_stages_ordered_by_hop_limit_descending(self):
        self.corr.ingest(self._event(hop_limit=3, gateway_id="!11111111"))
        out = self.corr.ingest(self._event(hop_limit=1, gateway_id="!22222222"))
        hops = [s["hop_limit"] for s in out[-1]["stages"]]
        self.assertEqual(hops, [3, 1])

    def test_duplicate_sighting_emits_nothing(self):
        self.corr.ingest(self._event())
        out = self.corr.ingest(self._event())  # mismo gateway, mismo hop_limit
        self.assertEqual(out, [])

    def test_relay_node_preferred_over_gateway_heuristic(self):
        out = self.corr.ingest(self._event(relay_node=None))
        self.assertEqual(out[0]["path_confidence"], "gateway_heuristic")
        out2 = self.corr.ingest(self._event(hop_limit=2, gateway_id="!22222222", relay_node="!00000011"))
        self.assertEqual(out2[-1]["path_confidence"], "relay_node")

    def test_expiry_removes_old_packets_and_emits_expired(self):
        self.corr.ingest(self._event())
        self.clock = 100.0  # más que window_s=45
        expired = self.corr.expire()
        self.assertEqual(expired, [{"type": "packet_expired", "packet_id": 42}])
        self.assertEqual(len(self.corr), 0)

    def test_expiry_keeps_recent_packets(self):
        self.corr.ingest(self._event())
        self.clock = 10.0
        self.assertEqual(self.corr.expire(), [])
        self.assertEqual(len(self.corr), 1)

    def test_events_are_json_serializable(self):
        out = self.corr.ingest(self._event())
        for event in out:
            json.dumps(event)  # no debe lanzar


if __name__ == "__main__":
    unittest.main()
