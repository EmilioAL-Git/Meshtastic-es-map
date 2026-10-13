"""Servidor WebSocket que difunde eventos JSON a todos los clientes conectados.

Sin autenticación (feed público, igual que el resto del sitio). Solo empuja
datos — no procesa mensajes entrantes del cliente más allá de ping/pong
(gestionado por la librería websockets).

También responde peticiones HTTP normales en el mismo puerto (vía
process_request, interceptando antes del handshake de WebSocket):

  GET /packet/<id>?from=<from_id>          → un paquete guardado, por
                                              (packet_id, from_id) — packet_id
                                              solo no es identidad suficiente,
                                              ver storage.py; "from" es
                                              opcional por compatibilidad con
                                              enlaces antiguos
  GET /activity?since=&until=&bucket=60    → recuento de paquetes por bucket,
                                              para el histograma de la línea de tiempo
  GET /timeline?since=&until=              → paquetes (con sus etapas) en ese
                                              rango, para reproducir la línea de tiempo
"""

from __future__ import annotations

import asyncio
import http
import json
import logging
import math
import time
from typing import Callable
from urllib.parse import parse_qs, urlsplit

import websockets

log = logging.getLogger("livefeed.ws_server")

JSON_HEADERS = [("Content-Type", "application/json")]

# Límites defensivos: el feed es público y sin autenticación.
MAX_CLIENTS = 500          # conexiones WS simultáneas
SEND_TIMEOUT_S = 5.0       # un cliente que tarda más en aceptar un mensaje se desconecta
MAX_RANGE_S = 7 * 86400    # rango máximo de /timeline y /activity
MAX_BUCKETS = 5000         # buckets máximos devueltos por /activity


class WsBroadcaster:
    def __init__(
        self,
        get_packet_fn: Callable[[int, str | None], dict | None] | None = None,
        activity_fn: Callable[[float, float, int], list] | None = None,
        timeline_fn: Callable[[float, float], list] | None = None,
    ):
        self._clients: set = set()
        self._get_packet_fn = get_packet_fn
        self._activity_fn = activity_fn
        self._timeline_fn = timeline_fn

    async def handler(self, websocket):
        if len(self._clients) >= MAX_CLIENTS:
            await websocket.close(code=1013, reason="demasiados clientes")
            return
        self._clients.add(websocket)
        log.info("Cliente conectado (%d activos)", len(self._clients))
        try:
            await websocket.wait_closed()
        finally:
            self._clients.discard(websocket)
            log.info("Cliente desconectado (%d activos)", len(self._clients))

    async def broadcast(self, event: dict) -> None:
        if not self._clients:
            return
        message = json.dumps(event)
        clients = list(self._clients)
        # Timeout por cliente: sin él, un cliente lento frena el broadcast
        # (y con él todo el pipeline) para todos los demás.
        results = await asyncio.gather(
            *(asyncio.wait_for(client.send(message), SEND_TIMEOUT_S) for client in clients),
            return_exceptions=True,
        )
        for client, result in zip(clients, results):
            if isinstance(result, BaseException):
                self._clients.discard(client)
                if isinstance(result, asyncio.TimeoutError):
                    asyncio.ensure_future(client.close(code=1008, reason="cliente lento"))

    async def process_request(self, path: str, request_headers):
        """Intercepta peticiones HTTP normales (no upgrade a WebSocket).

        Devolver None deja que la librería siga con el handshake de
        WebSocket normal; devolver (status, headers, body) responde
        directamente sin abrir una conexión WS.
        """
        parsed = urlsplit(path)
        route = parsed.path
        params = parse_qs(parsed.query)

        if route.startswith("/packet/"):
            return self._handle_packet(route, params)
        if route == "/activity":
            return self._handle_activity(params)
        if route == "/timeline":
            return self._handle_timeline(params)
        return None

    def _handle_packet(self, route: str, params: dict):
        if self._get_packet_fn is None:
            return (http.HTTPStatus.NOT_FOUND, JSON_HEADERS, b'{"error":"no disponible"}')
        raw_id = route[len("/packet/"):].strip("/")
        try:
            packet_id = int(raw_id)
        except ValueError:
            return (http.HTTPStatus.BAD_REQUEST, JSON_HEADERS, b'{"error":"id de paquete invalido"}')
        from_id = params.get("from", [None])[0]
        data = self._get_packet_fn(packet_id, from_id)
        if data is None:
            return (http.HTTPStatus.NOT_FOUND, JSON_HEADERS, b'{"error":"no encontrado"}')
        return (http.HTTPStatus.OK, JSON_HEADERS, json.dumps(data).encode())

    def _handle_activity(self, params: dict):
        if self._activity_fn is None:
            return (http.HTTPStatus.NOT_FOUND, JSON_HEADERS, b'{"error":"no disponible"}')
        try:
            since, until, bucket = _parse_range_params(params, default_bucket=60)
        except ValueError as e:
            return (http.HTTPStatus.BAD_REQUEST, JSON_HEADERS, str(e).encode())
        buckets = self._activity_fn(since, until, bucket)
        return (http.HTTPStatus.OK, JSON_HEADERS, json.dumps({"buckets": buckets}).encode())

    def _handle_timeline(self, params: dict):
        if self._timeline_fn is None:
            return (http.HTTPStatus.NOT_FOUND, JSON_HEADERS, b'{"error":"no disponible"}')
        try:
            since, until, _ = _parse_range_params(params, default_bucket=60)
        except ValueError as e:
            return (http.HTTPStatus.BAD_REQUEST, JSON_HEADERS, str(e).encode())
        packets = self._timeline_fn(since, until)
        return (http.HTTPStatus.OK, JSON_HEADERS, json.dumps({"packets": packets}).encode())

    async def serve(self, host: str, port: int):
        # max_size bajo: el servidor no espera mensajes entrantes del cliente.
        return await websockets.serve(
            self.handler, host, port, process_request=self.process_request, max_size=1024,
        )


def _parse_range_params(params: dict, *, default_bucket: int) -> tuple[float, float, int]:
    now = time.time()
    try:
        since = float(params.get("since", [now - 3600])[0])
        until = float(params.get("until", [now])[0])
        bucket = int(params.get("bucket", [default_bucket])[0])
    except (TypeError, ValueError):
        raise ValueError('{"error":"parametros invalidos"}')
    if bucket < 1:
        bucket = default_bucket
    if not (math.isfinite(since) and math.isfinite(until)):
        raise ValueError('{"error":"parametros invalidos"}')
    if until < since:
        since, until = until, since
    if until - since > MAX_RANGE_S:
        since = until - MAX_RANGE_S
    # Evita cientos de miles de buckets (p. ej. bucket=1 sobre 7 días).
    bucket = max(bucket, int((until - since) / MAX_BUCKETS) + 1)
    return since, until, bucket
