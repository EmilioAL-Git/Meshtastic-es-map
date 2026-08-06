#!/usr/bin/env python3
"""
meshtastic-es-map-livefeed
=================
Se suscribe al broker MQTT de Meshtastic, decodifica los ServiceEnvelope
(protobuf) y difunde por WebSocket los eventos de paquetes vistos por la
malla, correlando el mismo packet_id entre varios gateways para aproximar
el camino real. Solo metadatos de enrutamiento — nunca el contenido de los
mensajes.

Uso:
    python livefeed.py
"""

import asyncio
import logging
import os

from correlator import Correlator
from mqtt_source import MqttSource
from ws_server import WsBroadcaster

MQTT_HOST = os.environ.get("MQTT_BROKER_HOST", "")
MQTT_PORT = int(os.environ.get("MQTT_BROKER_PORT", 8883))
MQTT_USERNAME = os.environ.get("MQTT_USERNAME") or None
MQTT_PASSWORD = os.environ.get("MQTT_PASSWORD") or None
MQTT_TLS = os.environ.get("MQTT_TLS", "true").lower() == "true"
MQTT_TOPICS = [t.strip() for t in os.environ.get("MQTT_TOPICS", "").split(",") if t.strip()]
LIVE_WS_HOST = os.environ.get("LIVE_WS_HOST", "0.0.0.0")
LIVE_WS_PORT = int(os.environ.get("LIVE_WS_PORT", 8765))
LIVE_CORRELATION_WINDOW_S = float(os.environ.get("LIVE_CORRELATION_WINDOW_S", 45))
EXPIRE_CHECK_INTERVAL_S = 5

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("livefeed")


async def consume_queue(queue: asyncio.Queue, correlator: Correlator, broadcaster: WsBroadcaster):
    while True:
        event = await queue.get()
        for ws_event in correlator.ingest(event):
            await broadcaster.broadcast(ws_event)


async def expire_loop(correlator: Correlator, broadcaster: WsBroadcaster):
    while True:
        await asyncio.sleep(EXPIRE_CHECK_INTERVAL_S)
        for ws_event in correlator.expire():
            await broadcaster.broadcast(ws_event)


async def main():
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    correlator = Correlator(window_s=LIVE_CORRELATION_WINDOW_S)
    broadcaster = WsBroadcaster()

    # El servidor WebSocket arranca siempre, aunque el MQTT esté sin
    # configurar — así nginx no da 502 y el frontend puede conectar (solo
    # que no llegarán paquetes hasta que se configure MQTT_BROKER_HOST).
    log.info("Servidor WebSocket en %s:%s", LIVE_WS_HOST, LIVE_WS_PORT)
    await broadcaster.serve(LIVE_WS_HOST, LIVE_WS_PORT)

    if not MQTT_HOST or not MQTT_TOPICS:
        log.warning(
            "MQTT_BROKER_HOST o MQTT_TOPICS no están configurados. Feed en vivo desactivado (sin datos)."
        )
        await asyncio.Event().wait()
        return

    source = MqttSource(
        host=MQTT_HOST,
        port=MQTT_PORT,
        username=MQTT_USERNAME,
        password=MQTT_PASSWORD,
        tls=MQTT_TLS,
        topics=MQTT_TOPICS,
        queue=queue,
        loop=loop,
    )
    source.start()

    try:
        await asyncio.gather(
            consume_queue(queue, correlator, broadcaster),
            expire_loop(correlator, broadcaster),
        )
    finally:
        source.stop()


if __name__ == "__main__":
    asyncio.run(main())
