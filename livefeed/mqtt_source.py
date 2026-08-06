"""
Cliente MQTT que decodifica paquetes ServiceEnvelope de Meshtastic y los
entrega, ya saneados, a un asyncio.Queue.

Privacidad: por defecto solo se extraen metadatos de enrutamiento — nunca
el contenido del mensaje. La única excepción, explícitamente pedida y
acotada, es TEXT_MESSAGE_APP: si el portnum decodificado (directamente, o
descifrado con la PSK pública por defecto — ver try_decrypt_default_channel)
es un mensaje de texto, se incluye su contenido en el campo "text". Un
canal con PSK propia sigue sin poder descifrarse, así que su texto nunca
se expone. Cualquier otro portnum (posición, telemetría...) nunca lleva
"text". Ver tests/test_livefeed.py para las garantías exactas.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "proto"))

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes  # noqa: E402
from google.protobuf.message import DecodeError  # noqa: E402
from meshtastic import mesh_pb2, mqtt_pb2, portnums_pb2  # noqa: E402

from correlator import format_node_id  # noqa: E402

log = logging.getLogger("livefeed.mqtt_source")

# PSK pública "por defecto" de Meshtastic (índice corto 1, lo que el cliente
# manda como psk="AQ=="). No es un secreto: es la clave de fábrica
# documentada que usan todos los canales sin PSK propia configurada
# (LongFast, MediumFast, ShortFast/SFNarrow...). Un canal con PSK propia
# simplemente no producirá un Data protobuf válido al "descifrar" con esta
# clave, y se sigue reportando como ENCRYPTED — ver try_decrypt_default_channel.
# Fuente: meshtastic/firmware, src/mesh/Channels.h (defaultpsk).
DEFAULT_CHANNEL_KEY = bytes([
    0xD4, 0xF1, 0xBB, 0x3A, 0x20, 0x29, 0x07, 0x59,
    0xF0, 0xBC, 0xFF, 0xAB, 0xCF, 0x4E, 0x69, 0x01,
])


def try_decrypt_default_channel(packet_id: int, from_node: int, ciphertext: bytes) -> "mesh_pb2.Data | None":
    """Intenta descifrar payload_variant=encrypted con la PSK por defecto.

    AES-128-CTR con nonce de 16 bytes = packet_id (LE, 4) + ceros (4) +
    from_node (LE, 4) + ceros (4) — igual que CryptoEngine::initNonce() del
    firmware. Solo se usa para recuperar el portnum real; el payload
    descifrado nunca se propaga fuera de esta función.
    """
    nonce = (
        packet_id.to_bytes(4, "little")
        + b"\x00\x00\x00\x00"
        + from_node.to_bytes(4, "little", signed=False)
        + b"\x00\x00\x00\x00"
    )
    decryptor = Cipher(algorithms.AES(DEFAULT_CHANNEL_KEY), modes.CTR(nonce)).decryptor()
    plaintext = decryptor.update(ciphertext) + decryptor.finalize()

    data = mesh_pb2.Data()
    try:
        data.ParseFromString(plaintext)
        portnums_pb2.PortNum.Name(data.portnum)  # valida que sea un enum conocido
    except (DecodeError, ValueError):
        return None  # probablemente un canal con PSK propia, no el por defecto
    return data


def _safe_text(payload: bytes) -> str | None:
    """Decodifica un payload de TEXT_MESSAGE_APP como UTF-8. None si no es
    texto válido (protege contra basura si el "descifrado" era en realidad
    un canal con PSK propia que coló un portnum por casualidad)."""
    try:
        text = payload.decode("utf-8").strip()
    except UnicodeDecodeError:
        return None
    return text or None


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
    text = None
    if variant == "decoded":
        try:
            portnum = portnums_pb2.PortNum.Name(packet.decoded.portnum)
        except ValueError:
            portnum = None
        if packet.decoded.portnum == portnums_pb2.PortNum.TEXT_MESSAGE_APP:
            text = _safe_text(packet.decoded.payload)
    elif variant == "encrypted":
        portnum = "ENCRYPTED"
        data = try_decrypt_default_channel(packet.id, getattr(packet, "from"), packet.encrypted)
        if data is not None:
            portnum = portnums_pb2.PortNum.Name(data.portnum)
            if data.portnum == portnums_pb2.PortNum.TEXT_MESSAGE_APP:
                text = _safe_text(data.payload)
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
        "text": text,
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
        topics: list[str],
        queue: asyncio.Queue,
        loop: asyncio.AbstractEventLoop,
        client_id: str | None = None,
    ):
        import paho.mqtt.client as mqtt

        self._queue = queue
        self._loop = loop
        self._topics = topics

        # Algunos brokers de Meshtastic restringen el client_id por ACL
        # (p.ej. debe coincidir con el usuario) — por defecto usamos el
        # username como client_id si no se especifica otro explícitamente.
        self._client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=client_id or username or "",
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
            log.info("Conectado a MQTT %s:%s, suscribiendo a %s", self._host, self._port, self._topics)
            for topic in self._topics:
                client.subscribe(topic)
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
