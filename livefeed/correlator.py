"""
Correlación de paquetes MQTT de Meshtastic por packet_id.

Lógica pura, sin I/O: recibe diccionarios de eventos ya saneados (ver
mqtt_source.py) y produce los eventos JSON-safe que se difunden por
WebSocket. Se testea sin broker ni red (ver tests/test_livefeed.py).

Cada nodo con uplink MQTT reenvía el mismo packet_id con su propio
gateway_id a medida que el paquete salta por la malla. Agrupamos las
"sightings" del mismo packet_id por hop_limit (cada hop_limit distinto es
una etapa de retransmisión, ya que decrementa en cada salto) para aproximar
el camino real. Si alguna sighting trae relay_node (firmware reciente, nodo
real que retransmitió), se prioriza sobre esta heurística.

IMPORTANTE: packet_id es un entero de 32 bits que cada nodo genera por su
cuenta — el firmware NO garantiza que sea único en toda la malla, solo evita
repetirlo consigo mismo a corto plazo. La pareja (packet_id, from_node) es
la que el propio firmware usa para deduplicar/evitar bucles, así que es la
que usamos aquí como identidad real de un paquete — con tráfico EU_868 y
varios días de retención, dos nodos distintos generando por azar el mismo
packet_id no es tan raro (paradoja del cumpleaños: con ~350k paquetes en 7
días, ~14-15 colisiones esperadas). Usar solo packet_id mezclaría paquetes
de nodos distintos que compartieron número por casualidad.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field


def format_node_id(value: int | None) -> str | None:
    if value is None:
        return None
    return f"!{value & 0xFFFFFFFF:08x}"


@dataclass
class StageInfo:
    hop_limit: int
    gateway_ids: set[str] = field(default_factory=set)
    rx_time: float | None = None
    relay_node: str | None = None

    def to_dict(self) -> dict:
        return {
            "hop_limit": self.hop_limit,
            "gateway_ids": sorted(self.gateway_ids),
            "rx_time": self.rx_time,
            "relay_node": self.relay_node,
        }


@dataclass
class PacketState:
    packet_id: int
    first_seen: float
    from_id: str | None
    to_id: str | None
    hop_start: int | None
    channel: int | None
    portnum: str | None
    text: str | None = None
    route: list[str] = field(default_factory=list)
    route_back: list[str] = field(default_factory=list)
    stages: dict[int, StageInfo] = field(default_factory=dict)

    @property
    def path_confidence(self) -> str:
        # Un traceroute trae la ruta real, registrada por el propio
        # firmware salto a salto — más fiable que relay_node (que solo
        # confirma UN salto) o la heurística de gateways.
        if self.route or self.route_back:
            return "traceroute"
        if any(s.relay_node for s in self.stages.values()):
            return "relay_node"
        return "gateway_heuristic"

    def ordered_stages(self) -> list[StageInfo]:
        # hop_limit descendente = orden cronológico desde el origen
        return sorted(self.stages.values(), key=lambda s: s.hop_limit, reverse=True)

    def stage_event(self) -> dict:
        return {
            "type": "packet_stage",
            "packet_id": self.packet_id,
            "from": self.from_id,
            "path_confidence": self.path_confidence,
            "stages": [s.to_dict() for s in self.ordered_stages()],
            "route": self.route,
            "route_back": self.route_back,
        }

    def new_event(self) -> dict:
        return {
            "type": "packet_new",
            "packet_id": self.packet_id,
            "from": self.from_id,
            "to": self.to_id,
            "hop_start": self.hop_start,
            "channel": self.channel,
            "portnum": self.portnum,
            "text": self.text,
            "route": self.route,
            "route_back": self.route_back,
            "path_confidence": self.path_confidence,
        }


class Correlator:
    """Mantiene el estado en memoria de los paquetes vistos recientemente."""

    def __init__(self, window_s: float = 45.0, now_fn=time.monotonic):
        self.window_s = window_s
        self._now = now_fn
        # Clave (packet_id, from_id), no solo packet_id — ver docstring del
        # módulo: packet_id no es globalmente único en la malla.
        self._packets: dict[tuple[int, str | None], PacketState] = {}

    def ingest(self, event: dict) -> list[dict]:
        """Procesa una sighting saneada de mqtt_source.py.

        Devuelve la lista de eventos WS a difundir (puede estar vacía si la
        sighting es un duplicado exacto sin información nueva).
        """
        packet_id = event["packet_id"]
        hop_limit = event["hop_limit"]
        gateway_id = event["gateway_id"]
        from_id = event.get("from")
        key = (packet_id, from_id)

        out: list[dict] = []
        state = self._packets.get(key)
        if state is None:
            state = PacketState(
                packet_id=packet_id,
                first_seen=self._now(),
                from_id=from_id,
                to_id=event.get("to"),
                hop_start=event.get("hop_start"),
                channel=event.get("channel"),
                portnum=event.get("portnum"),
                text=event.get("text"),
                route=event.get("route") or [],
                route_back=event.get("route_back") or [],
            )
            self._packets[key] = state
            out.append(state.new_event())

        # route/route_back de un traceroute se van completando salto a
        # salto en sucesivas retransmisiones del mismo paquete_id+from —
        # cada sighting nueva puede traer una lista más larga que la
        # anterior; nos quedamos con la más completa vista hasta ahora.
        #
        # OJO: en flooding puro (sin ruta fija), dos copias del mismo
        # packet_id+from pueden viajar por caminos físicos distintos y
        # llegarnos por MQTT en cualquier orden. Si la sighting nueva no es
        # una extensión literal (mismo prefijo) de lo que ya teníamos, no es
        # "más completa" — es de una copia distinta, y sustituirla a ciegas
        # cose un camino Frankenstein que no corresponde a ningún salto real
        # (visto con traceroutes que en el mapa daban saltos imposibles).
        route_changed = False
        new_route = event.get("route") or []
        if len(new_route) > len(state.route) and new_route[:len(state.route)] == state.route:
            state.route = new_route
            route_changed = True
        new_route_back = event.get("route_back") or []
        if len(new_route_back) > len(state.route_back) and new_route_back[:len(state.route_back)] == state.route_back:
            state.route_back = new_route_back
            route_changed = True

        stage = state.stages.get(hop_limit)
        if stage is None:
            stage = StageInfo(hop_limit=hop_limit)
            state.stages[hop_limit] = stage

        changed = gateway_id not in stage.gateway_ids
        if gateway_id is not None:
            stage.gateway_ids.add(gateway_id)
        if stage.rx_time is None or (event.get("rx_time") or 0) < stage.rx_time:
            if event.get("rx_time"):
                changed = changed or stage.rx_time != event["rx_time"]
                stage.rx_time = event["rx_time"]
        relay_node = event.get("relay_node")
        if relay_node and stage.relay_node != relay_node:
            stage.relay_node = relay_node
            changed = True

        if changed or route_changed:
            out.append(state.stage_event())

        return out

    def expire(self) -> list[dict]:
        """Elimina paquetes más viejos que window_s. Devuelve eventos packet_expired."""
        now = self._now()
        expired = [
            (key, state) for key, state in self._packets.items()
            if now - state.first_seen > self.window_s
        ]
        for key, _ in expired:
            del self._packets[key]
        return [
            {"type": "packet_expired", "packet_id": state.packet_id, "from": state.from_id}
            for _, state in expired
        ]

    def __len__(self) -> int:
        return len(self._packets)
