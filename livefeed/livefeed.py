#!/usr/bin/env python3
"""
meshtastic-es-map-livefeed
=================
Se suscribe al broker MQTT de Meshtastic, decodifica los ServiceEnvelope
(protobuf) y difunde por WebSocket los eventos de paquetes vistos por la
malla, correlando el mismo packet_id entre varios gateways para aproximar
el camino real. Solo metadatos de enrutamiento — nunca el contenido de los
mensajes. Los paquetes se guardan también en SQLite (LIVEFEED_DB_PATH)
durante LIVEFEED_RETENTION_DAYS, para que un enlace compartido a un
paquete concreto (?packet=<id>) siga funcionando más allá de la ventana
de correlación en memoria.

Uso:
    python livefeed.py
"""

import asyncio
import logging
import os

import storage
from correlator import Correlator
from mqtt_source import MqttSource
from ws_server import WsBroadcaster

MQTT_HOST = os.environ.get("MQTT_BROKER_HOST", "")
MQTT_PORT = int(os.environ.get("MQTT_BROKER_PORT", 8883))
MQTT_USERNAME = os.environ.get("MQTT_USERNAME") or None
MQTT_PASSWORD = os.environ.get("MQTT_PASSWORD") or None
MQTT_CLIENT_ID = os.environ.get("MQTT_CLIENT_ID") or None
MQTT_TLS = os.environ.get("MQTT_TLS", "true").lower() == "true"
MQTT_TOPICS = [t.strip() for t in os.environ.get("MQTT_TOPICS", "").split(",") if t.strip()]
LIVE_WS_HOST = os.environ.get("LIVE_WS_HOST", "0.0.0.0")
LIVE_WS_PORT = int(os.environ.get("LIVE_WS_PORT", 8765))
LIVE_CORRELATION_WINDOW_S = float(os.environ.get("LIVE_CORRELATION_WINDOW_S", 45))
LIVEFEED_DB_PATH = os.environ.get("LIVEFEED_DB_PATH", "/data/livefeed.db")
LIVEFEED_RETENTION_DAYS = float(os.environ.get("LIVEFEED_RETENTION_DAYS", 7))
EXPIRE_CHECK_INTERVAL_S = 5
PURGE_INTERVAL_S = 3600  # cada hora

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("livefeed")


async def consume_queue(queue: asyncio.Queue, correlator: Correlator, broadcaster: WsBroadcaster, db_conn):
    while True:
        event = await queue.get()
        for ws_event in correlator.ingest(event):
            await broadcaster.broadcast(ws_event)
            storage.record_event(db_conn, ws_event)


async def expire_loop(correlator: Correlator, broadcaster: WsBroadcaster):
    while True:
        await asyncio.sleep(EXPIRE_CHECK_INTERVAL_S)
        for ws_event in correlator.expire():
            await broadcaster.broadcast(ws_event)


async def purge_loop(db_conn):
    while True:
        await asyncio.sleep(PURGE_INTERVAL_S)
        removed = storage.purge_old(db_conn, LIVEFEED_RETENTION_DAYS)
        if removed:
            log.info("Purgados %d paquetes con más de %s días", removed, LIVEFEED_RETENTION_DAYS)


async def main():
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    correlator = Correlator(window_s=LIVE_CORRELATION_WINDOW_S)
    db_conn = storage.init_db(LIVEFEED_DB_PATH)
    broadcaster = WsBroadcaster(
        get_packet_fn=lambda pid: storage.get_packet(db_conn, pid),
        activity_fn=lambda since, until, bucket: storage.activity_buckets(db_conn, since, until, bucket),
        timeline_fn=lambda since, until: storage.list_range(db_conn, since, until),
    )

    # El servidor WebSocket (y el endpoint HTTP GET /packet/<id> que
    # resuelve enlaces compartidos) arranca siempre, aunque el MQTT esté
    # sin configurar — así nginx no da 502 y el frontend puede conectar
    # (solo que no llegarán paquetes nuevos hasta configurar MQTT_BROKER_HOST).
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
        client_id=MQTT_CLIENT_ID,
        queue=queue,
        loop=loop,
    )
    source.start()

    try:
        await asyncio.gather(
            consume_queue(queue, correlator, broadcaster, db_conn),
            expire_loop(correlator, broadcaster),
            purge_loop(db_conn),
        )
    finally:
        source.stop()


if __name__ == "__main__":
    asyncio.run(main())
