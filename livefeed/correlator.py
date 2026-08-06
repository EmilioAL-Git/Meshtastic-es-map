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
    stages: dict[int, StageInfo] = field(default_factory=dict)

    @property
    def path_confidence(self) -> str:
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
            "path_confidence": self.path_confidence,
            "stages": [s.to_dict() for s in self.ordered_stages()],
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
            "path_confidence": self.path_confidence,
        }


class Correlator:
    """Mantiene el estado en memoria de los paquetes vistos recientemente."""

    def __init__(self, window_s: float = 45.0, now_fn=time.monotonic):
        self.window_s = window_s
        self._now = now_fn
        self._packets: dict[int, PacketState] = {}

    def ingest(self, event: dict) -> list[dict]:
        """Procesa una sighting saneada de mqtt_source.py.

        Devuelve la lista de eventos WS a difundir (puede estar vacía si la
        sighting es un duplicado exacto sin información nueva).
        """
        packet_id = event["packet_id"]
        hop_limit = event["hop_limit"]
        gateway_id = event["gateway_id"]

        out: list[dict] = []
        state = self._packets.get(packet_id)
        if state is None:
            state = PacketState(
                packet_id=packet_id,
                first_seen=self._now(),
                from_id=event.get("from"),
                to_id=event.get("to"),
                hop_start=event.get("hop_start"),
                channel=event.get("channel"),
                portnum=event.get("portnum"),
                text=event.get("text"),
            )
            self._packets[packet_id] = state
            out.append(state.new_event())

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

        if changed:
            out.append(state.stage_event())

        return out

    def expire(self) -> list[dict]:
        """Elimina paquetes más viejos que window_s. Devuelve eventos packet_expired."""
        now = self._now()
        expired_ids = [
            pid for pid, state in self._packets.items()
            if now - state.first_seen > self.window_s
        ]
        for pid in expired_ids:
            del self._packets[pid]
        return [{"type": "packet_expired", "packet_id": pid} for pid in expired_ids]

    def __len__(self) -> int:
        return len(self._packets)
