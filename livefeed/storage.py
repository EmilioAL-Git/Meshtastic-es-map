"""
Persistencia de paquetes vistos por livefeed, en SQLite.

Permite que un enlace compartido a un paquete concreto (?packet=<id>)
siga funcionando más allá de la ventana de correlación en memoria de
Correlator (LIVE_CORRELATION_WINDOW_S, segundos) — aquí se guardan
durante LIVEFEED_RETENTION_DAYS (días). Solo metadatos de enrutamiento,
salvo el texto de TEXT_MESSAGE_APP cuando es descifrable (ver
mqtt_source.py) — es la única excepción, acotada a ese portnum.

La clave primaria es (packet_id, from_id), no solo packet_id — ver el
docstring de correlator.py: packet_id es un entero de 32 bits que cada
nodo genera por su cuenta, el firmware no garantiza que sea único en toda
la malla. Con retención de varios días y tráfico EU_868 real, dos nodos
distintos generando por azar el mismo packet_id no es un caso raro
(paradoja del cumpleaños). Usar solo packet_id como PK mezclaría/
sobrescribiría paquetes de nodos distintos que coincidieron por casualidad.
"""

from __future__ import annotations

import json
import sqlite3
import time

_PACKETS_SCHEMA = """
    CREATE TABLE packets (
        packet_id INTEGER NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT,
        hop_start INTEGER,
        channel INTEGER,
        portnum TEXT,
        text TEXT,
        path_confidence TEXT,
        stages_json TEXT NOT NULL DEFAULT '[]',
        first_seen REAL NOT NULL,
        last_seen REAL NOT NULL,
        PRIMARY KEY (packet_id, from_id)
    )
"""


def _migrate_composite_key(conn: sqlite3.Connection) -> None:
    """Esquemas de antes de este cambio tenían packet_id como PK única.
    Reconstruye la tabla con la PK compuesta (packet_id, from_id) si hace
    falta; no-op en bases de datos nuevas o ya migradas."""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='packets'"
    ).fetchone()
    if row is None or row[0] is None or "PRIMARY KEY (packet_id, from_id)" in row[0]:
        return
    try:
        conn.execute("ALTER TABLE packets ADD COLUMN text TEXT")
    except sqlite3.OperationalError:
        pass  # ya existe (migración de "text" ya aplicada)
    conn.execute("ALTER TABLE packets RENAME TO packets_old")
    conn.execute(_PACKETS_SCHEMA)
    conn.execute(
        """
        INSERT OR IGNORE INTO packets
            (packet_id, from_id, to_id, hop_start, channel, portnum, text, path_confidence, stages_json, first_seen, last_seen)
        SELECT packet_id, from_id, to_id, hop_start, channel, portnum, text, path_confidence, stages_json, first_seen, last_seen
        FROM packets_old
        WHERE from_id IS NOT NULL
        """
    )
    conn.execute("DROP TABLE packets_old")
    conn.commit()


def init_db(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    _migrate_composite_key(conn)
    conn.execute(_PACKETS_SCHEMA.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"))
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
                (packet_id, from_id, to_id, hop_start, channel, portnum, text, path_confidence, stages_json, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
            ON CONFLICT(packet_id, from_id) DO UPDATE SET
                to_id = excluded.to_id,
                hop_start = excluded.hop_start,
                channel = excluded.channel,
                portnum = excluded.portnum,
                text = excluded.text,
                path_confidence = excluded.path_confidence,
                last_seen = excluded.last_seen
            """,
            (
                event["packet_id"], event["from"], event["to"], event["hop_start"],
                event["channel"], event["portnum"], event.get("text"), event["path_confidence"], now, now,
            ),
        )
    elif event["type"] == "packet_stage":
        conn.execute(
            "UPDATE packets SET stages_json = ?, path_confidence = ?, last_seen = ? WHERE packet_id = ? AND from_id = ?",
            (json.dumps(event["stages"]), event["path_confidence"], now, event["packet_id"], event["from"]),
        )
    else:
        return
    conn.commit()


def get_packet(conn: sqlite3.Connection, packet_id: int, from_id: str | None = None) -> dict | None:
    if from_id is not None:
        row = conn.execute(
            "SELECT packet_id, from_id, to_id, hop_start, channel, portnum, path_confidence, stages_json, text "
            "FROM packets WHERE packet_id = ? AND from_id = ?",
            (packet_id, from_id),
        ).fetchone()
    else:
        # Compatibilidad con enlaces compartidos antiguos (sin "from" en la
        # URL): si packet_id no colisiona, resuelve igual; si colisiona,
        # se queda con el visto más recientemente en vez de fallar.
        row = conn.execute(
            "SELECT packet_id, from_id, to_id, hop_start, channel, portnum, path_confidence, stages_json, text "
            "FROM packets WHERE packet_id = ? ORDER BY last_seen DESC LIMIT 1",
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
        "text": row[8],
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


def list_range(conn: sqlite3.Connection, since: float, until: float, limit: int = 20000) -> list[dict]:
    """Paquetes vistos en un rango de tiempo, con sus etapas — para
    reproducir la línea de tiempo. Ordenados por primera vez visto."""
    rows = conn.execute(
        """
        SELECT packet_id, from_id, to_id, hop_start, channel, portnum, path_confidence, stages_json, first_seen, text
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
            "stages": json.loads(row[7]), "first_seen": row[8], "text": row[9],
        }
        for row in rows
    ]


def purge_old(conn: sqlite3.Connection, retention_days: float) -> int:
    cutoff = time.time() - retention_days * 86400
    cur = conn.execute("DELETE FROM packets WHERE last_seen < ?", (cutoff,))
    conn.commit()
    return cur.rowcount
