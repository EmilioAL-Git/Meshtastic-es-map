"""
Cliente MQTT que decodifica paquetes ServiceEnvelope de Meshtastic y los
entrega, ya saneados, a un asyncio.Queue.

Importante (privacidad): esta función NUNCA lee ni reenvía
`packet.decoded.payload` (el contenido del mensaje). Solo se extraen
metadatos de enrutamiento. No añadir ese campo aquí sin revisar
tests/test_livefeed.py, que falla si aparece.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "proto"))

from google.protobuf.message import DecodeError  # noqa: E402
from meshtastic import mqtt_pb2, portnums_pb2  # noqa: E402

from correlator import format_node_id  # noqa: E402

log = logging.getLogger("livefeed.mqtt_source")


def decode_service_envelope(payload: bytes) -> dict | None:
    """Decodifica un ServiceEnvelope protobuf a un dict saneado.

    Devuelve None si el payload no es un ServiceEnvelope válido o no trae
    packet_id (paquetes de config/admin que no nos interesan).
    """
    envelope = mqtt_pb2.ServiceEnvelope()
    try:
        envelope.ParseFromString(payload)
    except DecodeError:
        return None

    packet = envelope.packet
    if not packet.id:
        return None

    variant = packet.WhichOneof("payload_variant")
    if variant == "decoded":
        try:
            portnum = portnums_pb2.PortNum.Name(packet.decoded.portnum)
        except ValueError:
            portnum = None
    elif variant == "encrypted":
        portnum = "ENCRYPTED"
    else:
        portnum = None

    rx_time = packet.rx_time or int(time.time())

    return {
        "packet_id": packet.id,
        "from": format_node_id(getattr(packet, "from")),
        "to": format_node_id(packet.to),
        "hop_limit": packet.hop_limit,
        "hop_start": packet.hop_start or None,
        "channel": packet.channel or None,
        "portnum": portnum,
        "gateway_id": envelope.gateway_id or None,
        "rx_time": rx_time,
        "relay_node": format_node_id(packet.relay_node) if packet.relay_node else None,
    }


class MqttSource:
    """Envuelve paho-mqtt y entrega eventos saneados a una asyncio.Queue."""

    def __init__(
        self,
        *,
        host: str,
        port: int,
        username: str | None,
        password: str | None,
        tls: bool,
        topic: str,
        queue: asyncio.Queue,
        loop: asyncio.AbstractEventLoop,
    ):
        import paho.mqtt.client as mqtt

        self._queue = queue
        self._loop = loop
        self._topic = topic

        self._client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        )
        if username:
            self._client.username_pw_set(username, password)
        if tls:
            self._client.tls_set()
        self._client.reconnect_delay_set(min_delay=1, max_delay=60)
        self._client.on_connect = self._on_connect
        self._client.on_disconnect = self._on_disconnect
        self._client.on_message = self._on_message

        self._host = host
        self._port = port

    def start(self) -> None:
        self._client.connect(self._host, self._port)
        self._client.loop_start()

    def stop(self) -> None:
        self._client.loop_stop()
        self._client.disconnect()

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code == 0 or getattr(reason_code, "value", 1) == 0:
            log.info("Conectado a MQTT %s:%s, suscribiendo a %s", self._host, self._port, self._topic)
            client.subscribe(self._topic)
        else:
            log.warning("Fallo de conexión MQTT: %s", reason_code)

    def _on_disconnect(self, client, userdata, disconnect_flags, reason_code, properties=None):
        log.warning("Desconectado de MQTT: %s", reason_code)

    def _on_message(self, client, userdata, msg):
        try:
            event = decode_service_envelope(msg.payload)
        except Exception:
            log.exception("Error decodificando mensaje de %s", msg.topic)
            return
        if event is None:
            return
        asyncio.run_coroutine_threadsafe(self._queue.put(event), self._loop)
