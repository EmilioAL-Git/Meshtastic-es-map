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

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes  # noqa: E402
from meshtastic import mesh_pb2, mqtt_pb2, portnums_pb2  # noqa: E402

import correlator  # noqa: E402
import mqtt_source  # noqa: E402


def encrypt_with_default_key(packet_id: int, from_id: int, plaintext: bytes) -> bytes:
    """Cifra como lo haría el firmware en un canal sin PSK propia (AES-CTR
    simétrico: la misma operación sirve para cifrar y descifrar en los tests)."""
    nonce = (
        packet_id.to_bytes(4, "little") + b"\x00" * 4
        + from_id.to_bytes(4, "little") + b"\x00" * 4
    )
    encryptor = Cipher(algorithms.AES(mqtt_source.DEFAULT_CHANNEL_KEY), modes.CTR(nonce)).encryptor()
    return encryptor.update(plaintext) + encryptor.finalize()


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

    def test_decoded_text_message_shows_text(self):
        """Única excepción a la privacidad, pedida explícitamente: el texto
        de un TEXT_MESSAGE_APP legible (no cifrado, o descifrable con la PSK
        por defecto) se expone en el campo "text"."""
        event = mqtt_source.decode_service_envelope(make_envelope())
        self.assertEqual(event["text"], "contenido secreto del mensaje")

    def test_non_text_portnum_never_exposes_text(self):
        """Cualquier portnum que no sea TEXT_MESSAGE_APP nunca lleva texto,
        aunque tengamos el payload delante (p.ej. POSITION_APP)."""
        event = mqtt_source.decode_service_envelope(
            make_envelope(portnum=portnums_pb2.PortNum.POSITION_APP)
        )
        self.assertEqual(event["portnum"], "POSITION_APP")
        self.assertIsNone(event["text"])

    def test_encrypted_packet_reports_portnum_unknown(self):
        # Ciphertext arbitrario que no descifra a un Data protobuf válido con
        # la PSK por defecto — simula un canal con PSK propia.
        event = mqtt_source.decode_service_envelope(make_envelope(encrypted=True))
        self.assertEqual(event["portnum"], "ENCRYPTED")

    def test_encrypted_default_psk_reveals_real_portnum(self):
        """Los canales sin PSK propia (LongFast, MediumFast...) usan una clave
        pública documentada — se puede recuperar el portnum real, no solo
        "ENCRYPTED", sin que eso implique leer canales privados de verdad."""
        data = mesh_pb2.Data()
        data.portnum = portnums_pb2.PortNum.POSITION_APP
        data.payload = b"posicion secreta de un nodo"
        packet_id, from_id = 555, 0xAABBCCDD
        ciphertext = encrypt_with_default_key(packet_id, from_id, data.SerializeToString())

        env = mqtt_pb2.ServiceEnvelope()
        env.gateway_id = "!11111111"
        env.packet.id = packet_id
        setattr(env.packet, "from", from_id)
        env.packet.to = 0xFFFFFFFF
        env.packet.hop_limit = 3
        env.packet.hop_start = 3
        env.packet.encrypted = ciphertext

        event = mqtt_source.decode_service_envelope(env.SerializeToString())
        self.assertEqual(event["portnum"], "POSITION_APP")

        # Guarda de regresión de privacidad: aunque se descifre para sacar el
        # portnum, el contenido no se expone salvo que sea TEXT_MESSAGE_APP.
        serialized = json.dumps(event)
        self.assertNotIn("posicion secreta", serialized)
        self.assertIsNone(event["text"])

    def test_encrypted_default_psk_text_message_shows_text(self):
        """Un TEXT_MESSAGE_APP en un canal sin PSK propia sí revela el texto
        — es la excepción explícitamente pedida, acotada a este portnum."""
        data = mesh_pb2.Data()
        data.portnum = portnums_pb2.PortNum.TEXT_MESSAGE_APP
        data.payload = "hola mesh España".encode("utf-8")
        packet_id, from_id = 777, 0xAABBCCDD
        ciphertext = encrypt_with_default_key(packet_id, from_id, data.SerializeToString())

        env = mqtt_pb2.ServiceEnvelope()
        env.gateway_id = "!11111111"
        env.packet.id = packet_id
        setattr(env.packet, "from", from_id)
        env.packet.to = 0xFFFFFFFF
        env.packet.hop_limit = 3
        env.packet.hop_start = 3
        env.packet.encrypted = ciphertext

        event = mqtt_source.decode_service_envelope(env.SerializeToString())
        self.assertEqual(event["portnum"], "TEXT_MESSAGE_APP")
        self.assertEqual(event["text"], "hola mesh España")

    def test_custom_psk_encrypted_never_exposes_text(self):
        # Ciphertext que no descifra a un Data válido con la PSK por defecto
        # (canal con PSK propia) — ni portnum real ni texto, como antes.
        event = mqtt_source.decode_service_envelope(make_envelope(encrypted=True))
        self.assertEqual(event["portnum"], "ENCRYPTED")
        self.assertIsNone(event["text"])

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

    def test_traceroute_decodes_route(self):
        """RouteDiscovery.route/route_back es metadato de enrutamiento (la
        lista de node_id que retransmitieron), no contenido — se decodifica
        siempre, igual que gateway_id o relay_node."""
        rd = mesh_pb2.RouteDiscovery()
        rd.route.extend([0x11111111, 0x22222222])
        rd.route_back.extend([0x33333333])

        env = mqtt_pb2.ServiceEnvelope()
        env.gateway_id = "!11111111"
        env.packet.id = 900
        setattr(env.packet, "from", 0xAABBCCDD)
        env.packet.to = 0xFFFFFFFF
        env.packet.hop_limit = 3
        env.packet.hop_start = 3
        env.packet.decoded.portnum = portnums_pb2.PortNum.TRACEROUTE_APP
        env.packet.decoded.payload = rd.SerializeToString()

        event = mqtt_source.decode_service_envelope(env.SerializeToString())
        self.assertEqual(event["portnum"], "TRACEROUTE_APP")
        self.assertEqual(event["route"], ["!11111111", "!22222222"])
        self.assertEqual(event["route_back"], ["!33333333"])
        self.assertIsNone(event["text"])  # sigue sin exponer contenido de mensaje

    def test_non_traceroute_never_has_route(self):
        event = mqtt_source.decode_service_envelope(
            make_envelope(portnum=portnums_pb2.PortNum.POSITION_APP)
        )
        self.assertEqual(event["route"], [])
        self.assertEqual(event["route_back"], [])

    def test_encrypted_default_psk_traceroute_decodes_route(self):
        """Igual que con TEXT_MESSAGE_APP: en un canal sin PSK propia se
        puede descifrar con la clave pública y recuperar la ruta real."""
        rd = mesh_pb2.RouteDiscovery()
        rd.route_back.extend([0x44444444, 0x55555555])
        data = mesh_pb2.Data()
        data.portnum = portnums_pb2.PortNum.TRACEROUTE_APP
        data.payload = rd.SerializeToString()
        packet_id, from_id = 901, 0xAABBCCDD
        ciphertext = encrypt_with_default_key(packet_id, from_id, data.SerializeToString())

        env = mqtt_pb2.ServiceEnvelope()
        env.gateway_id = "!11111111"
        env.packet.id = packet_id
        setattr(env.packet, "from", from_id)
        env.packet.to = 0xFFFFFFFF
        env.packet.hop_limit = 3
        env.packet.hop_start = 3
        env.packet.encrypted = ciphertext

        event = mqtt_source.decode_service_envelope(env.SerializeToString())
        self.assertEqual(event["portnum"], "TRACEROUTE_APP")
        self.assertEqual(event["route_back"], ["!44444444", "!55555555"])


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
        self.assertEqual(expired, [{"type": "packet_expired", "packet_id": 42, "from": "!aabbccdd"}])
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

    def test_same_packet_id_different_from_are_independent_packets(self):
        """packet_id no es único en toda la malla — cada nodo lo genera por
        su cuenta (32 bits). Dos nodos distintos pueden coincidir por azar;
        la identidad real es (packet_id, from), igual que usa el firmware
        para deduplicar/evitar bucles. Si se tratasen como el mismo paquete,
        sus etapas se mezclarían entre sí."""
        self.corr.ingest(self._event(packet_id=99, **{"from": "!aaaaaaaa"}, gateway_id="!11111111"))
        # Mismo packet_id, nodo origen distinto → debe generar su propio packet_new
        out_b = self.corr.ingest(self._event(packet_id=99, **{"from": "!bbbbbbbb"}, to="!ffffffff", gateway_id="!22222222"))
        types_b = [e["type"] for e in out_b]
        self.assertEqual(types_b, ["packet_new", "packet_stage"])
        self.assertEqual(len(self.corr), 2)  # dos PacketState independientes, no uno fusionado

        # Las etapas de cada uno no se contaminan entre sí
        out_a2 = self.corr.ingest(self._event(packet_id=99, **{"from": "!aaaaaaaa"}, hop_limit=1, gateway_id="!33333333"))
        stages_a = out_a2[-1]["stages"]
        self.assertEqual(len(stages_a), 2)  # hop_limit 3 y 1 del nodo !aaaaaaaa
        self.assertNotIn("!22222222", [gw for s in stages_a for gw in s["gateway_ids"]])

    def test_traceroute_path_confidence_beats_relay_node(self):
        """Un traceroute es más fiable que relay_node (que solo confirma un
        salto) — path_confidence debe reflejarlo aunque también haya
        relay_node en alguna etapa."""
        out = self.corr.ingest(self._event(relay_node="!00000011", route=["!aaaaaaaa"], route_back=[]))
        self.assertEqual(out[0]["path_confidence"], "traceroute")
        self.assertEqual(out[-1]["path_confidence"], "traceroute")

    def test_route_back_grows_across_sightings(self):
        """route_back de una respuesta de traceroute se completa salto a
        salto en sucesivas retransmisiones — nos quedamos con la más larga
        vista hasta ahora, nunca con una más corta que sustituya a una ya
        más completa."""
        out1 = self.corr.ingest(self._event(route_back=["!aaaaaaaa"]))
        self.assertEqual(out1[-1]["route_back"], ["!aaaaaaaa"])

        out2 = self.corr.ingest(self._event(gateway_id="!22222222", route_back=["!aaaaaaaa", "!bbbbbbbb"]))
        self.assertEqual(out2[-1]["route_back"], ["!aaaaaaaa", "!bbbbbbbb"])

        # Una sighting posterior con route_back más corta (p.ej. otro
        # gateway que solo vio el tramo inicial) no debe pisar la más larga.
        out3 = self.corr.ingest(self._event(gateway_id="!33333333", route_back=["!aaaaaaaa"]))
        self.assertEqual(out3[-1]["route_back"], ["!aaaaaaaa", "!bbbbbbbb"])

    def test_diverging_route_from_different_flood_copy_is_ignored(self):
        """En flooding puro dos copias del mismo packet_id+from pueden viajar
        por caminos físicos distintos. Si una sighting nueva es más larga
        pero NO extiende (mismo prefijo) la route que ya teníamos, es de otra
        copia — quedarse con ella cosería un camino que nunca ocurrió salto a
        salto de verdad, así que se ignora y se conserva la que ya era
        consistente."""
        out1 = self.corr.ingest(self._event(route=["!aaaaaaaa", "!bbbbbbbb"]))
        self.assertEqual(out1[-1]["route"], ["!aaaaaaaa", "!bbbbbbbb"])

        # Más larga, pero diverge en la segunda posición: otra copia de flood.
        out2 = self.corr.ingest(self._event(
            gateway_id="!22222222", hop_limit=1, route=["!aaaaaaaa", "!cccccccc", "!dddddddd"],
        ))
        self.assertEqual(out2[-1]["route"], ["!aaaaaaaa", "!bbbbbbbb"])

        # Una extensión real (mismo prefijo, más larga) sí se acepta.
        out3 = self.corr.ingest(self._event(
            gateway_id="!33333333", hop_limit=0, route=["!aaaaaaaa", "!bbbbbbbb", "!eeeeeeee"],
        ))
        self.assertEqual(out3[-1]["route"], ["!aaaaaaaa", "!bbbbbbbb", "!eeeeeeee"])


if __name__ == "__main__":
    unittest.main()
