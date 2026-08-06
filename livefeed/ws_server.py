"""Servidor WebSocket que difunde eventos JSON a todos los clientes conectados.

Sin autenticación (feed público, igual que el resto del sitio). Solo empuja
datos — no procesa mensajes entrantes del cliente más allá de ping/pong
(gestionado por la librería websockets).

También responde peticiones HTTP normales en el mismo puerto (vía
process_request, interceptando antes del handshake de WebSocket):

  GET /packet/<id>                        → un paquete guardado, por id
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
from typing import Callable
from urllib.parse import parse_qs, urlsplit

import websockets

log = logging.getLogger("livefeed.ws_server")

JSON_HEADERS = [("Content-Type", "application/json")]


class WsBroadcaster:
    def __init__(
        self,
        get_packet_fn: Callable[[int], dict | None] | None = None,
        activity_fn: Callable[[float, float, int], list] | None = None,
        timeline_fn: Callable[[float, float], list] | None = None,
    ):
        self._clients: set = set()
        self._get_packet_fn = get_packet_fn
        self._activity_fn = activity_fn
        self._timeline_fn = timeline_fn

    async def handler(self, websocket):
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
        results = await asyncio.gather(
            *(client.send(message) for client in list(self._clients)),
            return_exceptions=True,
        )
        for client, result in zip(list(self._clients), results):
            if isinstance(result, Exception):
                self._clients.discard(client)

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
            return self._handle_packet(route)
        if route == "/activity":
            return self._handle_activity(params)
        if route == "/timeline":
            return self._handle_timeline(params)
        return None

    def _handle_packet(self, route: str):
        if self._get_packet_fn is None:
            return (http.HTTPStatus.NOT_FOUND, JSON_HEADERS, b'{"error":"no disponible"}')
        raw_id = route[len("/packet/"):].strip("/")
        try:
            packet_id = int(raw_id)
        except ValueError:
            return (http.HTTPStatus.BAD_REQUEST, JSON_HEADERS, b'{"error":"id de paquete invalido"}')
        data = self._get_packet_fn(packet_id)
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
        return await websockets.serve(self.handler, host, port, process_request=self.process_request)


def _parse_range_params(params: dict, *, default_bucket: int) -> tuple[float, float, int]:
    import time

    now = time.time()
    try:
        since = float(params.get("since", [now - 3600])[0])
        until = float(params.get("until", [now])[0])
        bucket = int(params.get("bucket", [default_bucket])[0])
    except (TypeError, ValueError):
        raise ValueError('{"error":"parametros invalidos"}')
    if bucket < 1:
        bucket = default_bucket
    if until < since:
        since, until = until, since
    return since, until, bucket
