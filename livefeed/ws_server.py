"""Servidor WebSocket que difunde eventos JSON a todos los clientes conectados.

Sin autenticación (feed público, igual que el resto del sitio). Solo empuja
datos — no procesa mensajes entrantes del cliente más allá de ping/pong
(gestionado por la librería websockets).

También responde peticiones HTTP normales GET /packet/<id> en el mismo
puerto (vía process_request, interceptando antes del handshake de
WebSocket) — es lo que consulta live.html para resolver un enlace
compartido ?packet=<id> aunque el paquete ya no esté en memoria.
"""

from __future__ import annotations

import asyncio
import http
import json
import logging
from typing import Callable

import websockets

log = logging.getLogger("livefeed.ws_server")


class WsBroadcaster:
    def __init__(self, get_packet_fn: Callable[[int], dict | None] | None = None):
        self._clients: set = set()
        self._get_packet_fn = get_packet_fn

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
        route = path.split("?", 1)[0]
        if not route.startswith("/packet/"):
            return None

        headers = [("Content-Type", "application/json")]
        if self._get_packet_fn is None:
            return (http.HTTPStatus.NOT_FOUND, headers, b'{"error":"no disponible"}')

        raw_id = route[len("/packet/"):].strip("/")
        try:
            packet_id = int(raw_id)
        except ValueError:
            return (http.HTTPStatus.BAD_REQUEST, headers, b'{"error":"id de paquete invalido"}')

        data = self._get_packet_fn(packet_id)
        if data is None:
            return (http.HTTPStatus.NOT_FOUND, headers, b'{"error":"no encontrado"}')
        return (http.HTTPStatus.OK, headers, json.dumps(data).encode())

    async def serve(self, host: str, port: int):
        return await websockets.serve(self.handler, host, port, process_request=self.process_request)
