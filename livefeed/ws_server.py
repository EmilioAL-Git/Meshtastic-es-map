"""Servidor WebSocket que difunde eventos JSON a todos los clientes conectados.

Sin autenticación (feed público, igual que el resto del sitio). Solo empuja
datos — no procesa mensajes entrantes del cliente más allá de ping/pong
(gestionado por la librería websockets).
"""

from __future__ import annotations

import asyncio
import json
import logging

import websockets

log = logging.getLogger("livefeed.ws_server")


class WsBroadcaster:
    def __init__(self):
        self._clients: set = set()

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

    async def serve(self, host: str, port: int):
        return await websockets.serve(self.handler, host, port)
