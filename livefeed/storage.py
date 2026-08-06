"""
Persistencia de paquetes vistos por livefeed, en SQLite.

Permite que un enlace compartido a un paquete concreto (?packet=<id>)
siga funcionando más allá de la ventana de correlación en memoria de
Correlator (LIVE_CORRELATION_WINDOW_S, segundos) — aquí se guardan
durante LIVEFEED_RETENTION_DAYS (días). Solo metadatos de enrutamiento,
igual que el resto del pipeline — nunca contenido de mensajes.
"""

from __future__ import annotations

import json
import sqlite3
import time


def init_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS packets (
            packet_id INTEGER PRIMARY KEY,
            from_id TEXT,
            to_id TEXT,
            hop_start INTEGER,
            channel INTEGER,
            portnum TEXT,
            path_confidence TEXT,
            stages_json TEXT NOT NULL DEFAULT '[]',
            first_seen REAL NOT NULL,
            last_seen REAL NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_packets_last_seen ON packets(last_seen)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_packets_first_seen ON packets(first_seen)")
    conn.commit()
    return conn


def record_event(conn: sqlite3.Connection, event: dict) -> None:
    now = time.time()
    if event["type"] == "packet_new":
        conn.execute(
            """
            INSERT INTO packets
                (packet_id, from_id, to_id, hop_start, channel, portnum, path_confidence, stages_json, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
            ON CONFLICT(packet_id) DO UPDATE SET
                from_id = excluded.from_id,
                to_id = excluded.to_id,
                hop_start = excluded.hop_start,
                channel = excluded.channel,
                portnum = excluded.portnum,
                path_confidence = excluded.path_confidence,
                last_seen = excluded.last_seen
            """,
            (
                event["packet_id"], event["from"], event["to"], event["hop_start"],
                event["channel"], event["portnum"], event["path_confidence"], now, now,
            ),
        )
    elif event["type"] == "packet_stage":
        conn.execute(
            "UPDATE packets SET stages_json = ?, path_confidence = ?, last_seen = ? WHERE packet_id = ?",
            (json.dumps(event["stages"]), event["path_confidence"], now, event["packet_id"]),
        )
    else:
        return
    conn.commit()


def get_packet(conn: sqlite3.Connection, packet_id: int) -> dict | None:
    row = conn.execute(
        "SELECT packet_id, from_id, to_id, hop_start, channel, portnum, path_confidence, stages_json "
        "FROM packets WHERE packet_id = ?",
        (packet_id,),
    ).fetchone()
    if row is None:
        return None
    return {
        "packet_id": row[0],
        "from": row[1],
        "to": row[2],
        "hop_start": row[3],
        "channel": row[4],
        "portnum": row[5],
        "path_confidence": row[6],
        "stages": json.loads(row[7]),
    }


def activity_buckets(conn: sqlite3.Connection, since: float, until: float, bucket_s: int) -> list[dict]:
    """Recuento de paquetes por bucket de tiempo, para el histograma de la
    línea de tiempo — agrupa por first_seen (cuándo se vio el paquete por
    primera vez, no la última actividad)."""
    rows = conn.execute(
        """
        SELECT CAST(first_seen / ? AS INTEGER) * ? AS bucket, COUNT(*)
        FROM packets
        WHERE first_seen >= ? AND first_seen <= ?
        GROUP BY bucket
        ORDER BY bucket
        """,
        (bucket_s, bucket_s, since, until),
    ).fetchall()
    return [{"t": row[0], "count": row[1]} for row in rows]


def list_range(conn: sqlite3.Connection, since: float, until: float, limit: int = 1000) -> list[dict]:
    """Paquetes vistos en un rango de tiempo, con sus etapas — para
    reproducir la línea de tiempo. Ordenados por primera vez visto."""
    rows = conn.execute(
        """
        SELECT packet_id, from_id, to_id, hop_start, channel, portnum, path_confidence, stages_json, first_seen
        FROM packets
        WHERE first_seen >= ? AND first_seen <= ?
        ORDER BY first_seen ASC
        LIMIT ?
        """,
        (since, until, limit),
    ).fetchall()
    return [
        {
            "packet_id": row[0], "from": row[1], "to": row[2], "hop_start": row[3],
            "channel": row[4], "portnum": row[5], "path_confidence": row[6],
            "stages": json.loads(row[7]), "first_seen": row[8],
        }
        for row in rows
    ]


def purge_old(conn: sqlite3.Connection, retention_days: float) -> int:
    cutoff = time.time() - retention_days * 86400
    cur = conn.execute("DELETE FROM packets WHERE last_seen < ?", (cutoff,))
    conn.commit()
    return cur.rowcount
