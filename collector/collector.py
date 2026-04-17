#!/usr/bin/env python3
"""
meshtastic-es-map-collector
=================
Lee la API de meshview.meshtastic.es cada X minutos
y guarda/actualiza nodos y edges en una SQLite local.

Uso:
    python collector.py                   # corre una vez y sale
    python collector.py --daemon          # bucle infinito cada INTERVAL minutos
    python collector.py --interval 10     # intervalo en minutos (default: 5)
"""

import argparse
import json
import logging
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import urllib.request
import urllib.error

# ─── Configuración ────────────────────────────────────────────────────────────

MESHVIEW_BASE   = os.environ.get("MESHVIEW_URL", "https://meshview.meshtastic.es")
DB_PATH         = Path(os.environ.get("DB_PATH", str(Path(__file__).parent.parent / "data" / "meshtastic-es-map.db")))
JSON_OUT        = Path(os.environ.get("JSON_OUT", str(Path(__file__).parent.parent / "web" / "data")))
INTERVAL_MIN    = int(os.environ.get("COLLECTOR_INTERVAL", 5))
RETENTION_DAYS  = int(os.environ.get("NODE_RETENTION_DAYS", 7))
MAP_AUTO_FIT    = os.environ.get("MAP_AUTO_FIT", "true").lower() == "true"
MAP_LAT         = float(os.environ.get("MAP_LAT", 40.2))
MAP_LNG         = float(os.environ.get("MAP_LNG", -3.7))
MAP_ZOOM        = int(os.environ.get("MAP_ZOOM", 8))
REQUEST_TIMEOUT = 20       # segundos

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("collector")


# ─── Base de datos ─────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    node_id         TEXT PRIMARY KEY,
    short_name      TEXT,
    long_name       TEXT,
    hardware        TEXT,
    role            TEXT,
    latitude        REAL,
    longitude       REAL,
    altitude        REAL,
    battery_level   INTEGER,
    voltage         REAL,
    snr             REAL,
    rssi            INTEGER,
    channel_util    REAL,
    air_util_tx     REAL,
    firmware        TEXT,
    channel         TEXT,
    is_mqtt_gateway INTEGER DEFAULT 0,
    hops_away       INTEGER,
    last_seen       INTEGER,   -- unix timestamp (segundos)
    first_seen      INTEGER,   -- unix timestamp primera vez que lo vimos
    updated_at      INTEGER    -- unix timestamp última actualización en nuestra BD
);

CREATE TABLE IF NOT EXISTS edges (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node       TEXT NOT NULL,
    to_node         TEXT NOT NULL,
    snr             REAL,
    edge_type       TEXT,      -- 'neighbor' | 'traceroute'
    last_seen       INTEGER,
    UNIQUE(from_node, to_node)
);

CREATE TABLE IF NOT EXISTS snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    collected_at    INTEGER NOT NULL,
    nodes_count     INTEGER,
    edges_count     INTEGER,
    active_nodes    INTEGER,
    source_url      TEXT
);

CREATE TABLE IF NOT EXISTS node_telemetry (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id       TEXT NOT NULL,
    collected_at  INTEGER NOT NULL,
    snr           REAL,
    rssi          INTEGER,
    battery_level INTEGER,
    voltage       REAL
);

CREATE INDEX IF NOT EXISTS idx_nodes_last_seen  ON nodes(last_seen);
CREATE INDEX IF NOT EXISTS idx_edges_from       ON edges(from_node);
CREATE INDEX IF NOT EXISTS idx_edges_to         ON edges(to_node);
CREATE INDEX IF NOT EXISTS idx_telemetry_node   ON node_telemetry(node_id, collected_at DESC);
"""


def get_db(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    # Migraciones para columnas añadidas después de la creación inicial
    for migration in [
        "ALTER TABLE nodes ADD COLUMN channel TEXT",
        "ALTER TABLE snapshots ADD COLUMN active_nodes INTEGER",
    ]:
        try:
            conn.execute(migration)
        except sqlite3.OperationalError:
            pass  # La columna ya existe
    conn.commit()
    return conn


# ─── Caché de respuestas meshview ─────────────────────────────────────────────

def _cache_path(url: str) -> Path:
    """Devuelve la ruta del fichero de caché para una URL."""
    safe = url.replace("://", "_").replace("/", "_").replace(".", "_")
    return DB_PATH.parent / f"cache_{safe}.json"

def save_cache(url: str, data) -> None:
    try:
        with open(_cache_path(url), "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception as e:
        log.warning(f"No se pudo guardar caché de {url}: {e}")

def load_cache(url: str):
    path = _cache_path(url)
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        log.info(f"  → Usando caché guardada para {url}")
        return data
    except Exception:
        return None


# ─── Fetch helpers ─────────────────────────────────────────────────────────────

def fetch_json(url: str, retries: int = 3, backoff: float = 5.0) -> dict | list | None:
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "meshtastic-es-map-collector/1.0", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw)
        except urllib.error.HTTPError as e:
            log.warning(f"HTTP {e.code} al pedir {url} (intento {attempt}/{retries})")
            if e.code < 500:
                break  # errores 4xx no se reintentan
        except urllib.error.URLError as e:
            log.warning(f"Error de red al pedir {url} (intento {attempt}/{retries}): {e.reason}")
        except json.JSONDecodeError as e:
            log.warning(f"JSON inválido desde {url}: {e}")
            break  # JSON inválido no se reintenta
        except Exception as e:
            log.warning(f"Error inesperado en {url} (intento {attempt}/{retries}): {e}")
        if attempt < retries:
            time.sleep(backoff * attempt)
    log.warning(f"Todos los intentos fallaron para {url} — usando caché si existe")
    return load_cache(url)


# ─── Normalización de datos ────────────────────────────────────────────────────

def parse_nodes(raw: list | dict) -> list[dict]:
    """
    Normaliza la respuesta de meshview a lista de dicts estándar.
    La API de meshview.meshtastic.es devuelve {"nodes": [...]}
    con coordenadas en last_lat/last_long como enteros (×1e7).
    """
    # Desenvuelve {"nodes": [...]} si viene así
    if isinstance(raw, dict):
        if "nodes" in raw:
            items = raw["nodes"]
        else:
            items = list(raw.values())
    else:
        items = raw

    nodes = []
    for n in items:
        if not isinstance(n, dict):
            continue

        node_id = (
            n.get("id") or n.get("node_id") or n.get("nodeId") or
            n.get("node_num") or str(n.get("num", ""))
        )
        if not node_id:
            continue

        # Coordenadas: meshview las guarda como enteros ×1e7
        # Ej: 415422579 → 41.5422579
        lat_raw = n.get("last_lat") or n.get("latitude") or n.get("lat")
        lon_raw = n.get("last_long") or n.get("longitude") or n.get("lon")
        lat = _decode_coord(lat_raw)
        lon = _decode_coord(lon_raw)
        alt = _safe_float(n.get("altitude") or n.get("last_alt"))

        # Telemetría (puede venir directa o anidada)
        telem    = n.get("device_metrics") or n.get("telemetry") or {}
        battery  = n.get("battery_level") or telem.get("battery_level")
        voltage  = n.get("voltage")       or telem.get("voltage")
        chan_ut  = n.get("channel_utilization") or telem.get("channel_utilization")
        air_ut   = n.get("air_util_tx")   or telem.get("air_util_tx")

        # Timestamps en microsegundos → convertir a segundos
        last_seen_raw = (
            n.get("last_seen_us") or n.get("last_seen") or
            n.get("last_update")  or n.get("updated_at")
        )
        last_seen      = _to_unix_seconds(last_seen_raw)
        first_seen_raw = n.get("first_seen_us") or n.get("first_seen")
        first_seen     = _to_unix_seconds(first_seen_raw)

        nodes.append({
            "node_id":         str(node_id),
            "short_name":      n.get("short_name") or n.get("shortName") or "",
            "long_name":       n.get("long_name")  or n.get("longName")  or "",
            "hardware":        n.get("hw_model")   or n.get("hardware")  or "",
            "role":            n.get("role")        or "",
            "latitude":        lat,
            "longitude":       lon,
            "altitude":        alt,
            "battery_level":   _safe_int(battery),
            "voltage":         _safe_float(voltage),
            "snr":             _safe_float(n.get("snr")),
            "rssi":            _safe_int(n.get("rssi")),
            "channel_util":    _safe_float(chan_ut),
            "air_util_tx":     _safe_float(air_ut),
            "firmware":        n.get("firmware") or n.get("firmware_version") or "",
            "channel":         n.get("channel") or "",
            "is_mqtt_gateway": 1 if n.get("is_mqtt_gateway") else 0,
            "hops_away":       _safe_int(n.get("hops_away")),
            "last_seen":       last_seen,
            "first_seen":      first_seen,
        })
    return nodes


def _decode_coord(v) -> float | None:
    """
    Las coordenadas de meshview vienen como enteros ×1e7.
    Ej: 415422579 → 41.5422579
    Si ya es un float razonable (−180..180) se devuelve tal cual.
    """
    f = _safe_float(v)
    if f is None:
        return None
    # Si el valor absoluto es mayor que 180, asumimos que es ×1e7
    if abs(f) > 180:
        f = f / 1e7
    # Sanity check final
    if abs(f) > 180:
        return None
    return round(f, 7)


def _int_to_node_id(v) -> str:
    """
    Convierte un node ID entero al formato '!hexvalue' que usa meshview.
    Ej: 42115050 → '!02829fea'
    Si ya es un string con '!', lo devuelve tal cual.
    """
    if isinstance(v, str):
        return v
    try:
        return f"!{int(v):08x}"
    except (TypeError, ValueError):
        return str(v)


def parse_edges(raw: list | dict) -> list[dict]:
    """Normaliza edges/neighbors de meshview."""
    if isinstance(raw, dict):
        items = raw.get("edges") or raw.get("neighbors") or list(raw.values())
        if isinstance(items, dict):
            items = list(items.values())
    else:
        items = raw

    edges = []
    for e in items:
        if not isinstance(e, dict):
            continue
        from_raw  = e.get("from") or e.get("from_node") or e.get("source") or ""
        to_raw    = e.get("to")   or e.get("to_node")   or e.get("target") or ""
        from_node = _int_to_node_id(from_raw)
        to_node   = _int_to_node_id(to_raw)
        if not from_node or not to_node:
            continue
        last_seen_raw = e.get("last_seen_us") or e.get("last_seen") or e.get("updated_at")
        edges.append({
            "from_node": from_node,
            "to_node":   to_node,
            "snr":       _safe_float(e.get("snr")),
            "edge_type": e.get("type") or e.get("edge_type") or "neighbor",
            "last_seen": _to_unix_seconds(last_seen_raw),
        })
    return edges


def _to_unix_seconds(v) -> int | None:
    if v is None:
        return None
    try:
        v = int(v)
        # Si viene en microsegundos (>= año 3000 en segundos) → dividir
        if v > 32503680000:
            v = v // 1_000_000
        # Si viene en milisegundos
        elif v > 9_999_999_999:
            v = v // 1000
        return v
    except (TypeError, ValueError):
        return None


def _safe_float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _safe_int(v) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


# ─── Guardado en BD ────────────────────────────────────────────────────────────

def upsert_nodes(conn: sqlite3.Connection, nodes: list[dict]) -> int:
    now = int(datetime.now(timezone.utc).timestamp())
    saved = 0
    for n in nodes:
        conn.execute("""
            INSERT INTO nodes (
                node_id, short_name, long_name, hardware, role,
                latitude, longitude, altitude,
                battery_level, voltage, snr, rssi,
                channel_util, air_util_tx, firmware, channel,
                is_mqtt_gateway, hops_away, last_seen,
                first_seen, updated_at
            ) VALUES (
                :node_id, :short_name, :long_name, :hardware, :role,
                :latitude, :longitude, :altitude,
                :battery_level, :voltage, :snr, :rssi,
                :channel_util, :air_util_tx, :firmware, :channel,
                :is_mqtt_gateway, :hops_away, :last_seen,
                :now, :now
            )
            ON CONFLICT(node_id) DO UPDATE SET
                short_name      = excluded.short_name,
                long_name       = excluded.long_name,
                hardware        = excluded.hardware,
                role            = excluded.role,
                latitude        = COALESCE(excluded.latitude,   nodes.latitude),
                longitude       = COALESCE(excluded.longitude,  nodes.longitude),
                altitude        = COALESCE(excluded.altitude,   nodes.altitude),
                battery_level   = COALESCE(excluded.battery_level, nodes.battery_level),
                voltage         = COALESCE(excluded.voltage,    nodes.voltage),
                snr             = COALESCE(excluded.snr,        nodes.snr),
                rssi            = COALESCE(excluded.rssi,       nodes.rssi),
                channel_util    = COALESCE(excluded.channel_util, nodes.channel_util),
                air_util_tx     = COALESCE(excluded.air_util_tx,  nodes.air_util_tx),
                firmware        = COALESCE(excluded.firmware,   nodes.firmware),
                channel         = COALESCE(excluded.channel,    nodes.channel),
                is_mqtt_gateway = excluded.is_mqtt_gateway,
                hops_away       = COALESCE(excluded.hops_away,  nodes.hops_away),
                last_seen       = COALESCE(excluded.last_seen,  nodes.last_seen),
                updated_at      = :now
        """, {**n, "now": now})
        saved += 1
    conn.commit()
    return saved


def upsert_edges(conn: sqlite3.Connection, edges: list[dict]) -> int:
    now = int(datetime.now(timezone.utc).timestamp())
    saved = 0
    for e in edges:
        # La API de meshview no devuelve timestamp en edges → usamos now
        last_seen = e["last_seen"] if e["last_seen"] is not None else now
        conn.execute("""
            INSERT INTO edges (from_node, to_node, snr, edge_type, last_seen)
            VALUES (:from_node, :to_node, :snr, :edge_type, :last_seen)
            ON CONFLICT(from_node, to_node) DO UPDATE SET
                snr       = COALESCE(excluded.snr, edges.snr),
                edge_type = excluded.edge_type,
                last_seen = excluded.last_seen
        """, {**e, "last_seen": last_seen})
        saved += 1
    # Corregir edges existentes con last_seen NULL (colecciones anteriores)
    conn.execute("UPDATE edges SET last_seen = ? WHERE last_seen IS NULL", (now,))
    # Migrar edges con IDs enteros al formato !hexvalue para que el JOIN funcione
    _migrate_edge_ids(conn, now)
    conn.commit()
    return saved


def _migrate_edge_ids(conn: sqlite3.Connection, now: int):
    """
    Convierte edges almacenados con IDs enteros ('42115050') a formato
    '!hexvalue' ('!02829fea') para que coincidan con los node_id de la tabla nodes.
    Se ejecuta en cada colección y es idempotente (solo afecta a filas no migradas).
    """
    old_edges = conn.execute("""
        SELECT id, from_node, to_node, snr, edge_type, last_seen
        FROM edges WHERE from_node NOT LIKE '!%'
    """).fetchall()

    for row in old_edges:
        try:
            new_from = f"!{int(row['from_node']):08x}"
            new_to   = f"!{int(row['to_node']):08x}"
        except (ValueError, TypeError):
            continue
        # Insertar con nuevo formato (o actualizar si ya existe)
        conn.execute("""
            INSERT INTO edges (from_node, to_node, snr, edge_type, last_seen)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(from_node, to_node) DO UPDATE SET
                snr       = COALESCE(excluded.snr, edges.snr),
                edge_type = excluded.edge_type,
                last_seen = MAX(excluded.last_seen, edges.last_seen)
        """, (new_from, new_to, row['snr'], row['edge_type'], row['last_seen'] or now))
        # Eliminar la fila con ID entero
        conn.execute("DELETE FROM edges WHERE id = ?", (row['id'],))

    if old_edges:
        log.info(f"  → Migrados {len(old_edges)} edges de formato entero a !hexvalue")


def record_snapshot(conn, collected_at, nodes_count, edges_count, active_nodes, source_url):
    conn.execute("""
        INSERT INTO snapshots (collected_at, nodes_count, edges_count, active_nodes, source_url)
        VALUES (?, ?, ?, ?, ?)
    """, (collected_at, nodes_count, edges_count, active_nodes, source_url))
    conn.commit()


def record_telemetry(conn: sqlite3.Connection, node_ids: list[str], collected_at: int):
    """Guarda telemetría actual leyendo desde la BD (incluye valores COALESCE'd)."""
    if not node_ids:
        return
    placeholders = ','.join('?' * len(node_ids))
    rows = conn.execute(f"""
        SELECT node_id, snr, rssi, battery_level, voltage
        FROM nodes
        WHERE node_id IN ({placeholders})
          AND (snr IS NOT NULL OR rssi IS NOT NULL
               OR battery_level IS NOT NULL OR voltage IS NOT NULL)
    """, node_ids).fetchall()
    if rows:
        conn.executemany("""
            INSERT INTO node_telemetry (node_id, collected_at, snr, rssi, battery_level, voltage)
            VALUES (?, ?, ?, ?, ?, ?)
        """, [(r[0], collected_at, r[1], r[2], r[3], r[4]) for r in rows])
        conn.commit()
        log.info(f"  → Telemetría registrada: {len(rows)} nodos")


# ─── Exportación JSON estática ────────────────────────────────────────────────

def export_json(conn: sqlite3.Connection, out_dir: Path):
    """Genera nodes.json, edges.json, stats.json, history.json para el frontend estático."""
    out_dir.mkdir(parents=True, exist_ok=True)
    now    = int(time.time())
    cutoff = now - RETENTION_DAYS * 24 * 3600

    # ── Historial de telemetría por nodo (últimas 24h, agrupado por hora) ──
    telem_cutoff = now - 24 * 3600
    telem_rows = conn.execute("""
        SELECT node_id,
               (collected_at / 3600) * 3600 AS hour,
               ROUND(AVG(snr), 1)           AS snr,
               ROUND(AVG(rssi))             AS rssi,
               ROUND(AVG(battery_level))    AS battery_level,
               ROUND(AVG(voltage), 2)       AS voltage
        FROM node_telemetry
        WHERE collected_at >= ?
        GROUP BY node_id, hour
        ORDER BY node_id, hour ASC
    """, (telem_cutoff,)).fetchall()

    telemetry_by_node: dict[str, list] = {}
    for row in telem_rows:
        nid = row[0]
        telemetry_by_node.setdefault(nid, []).append({
            "t":   row[1],
            "snr": row[2],
            "bat": row[4],
        })

    # ── nodes.json ──
    cur = conn.execute("""
        SELECT node_id, short_name, long_name, hardware, role,
               latitude, longitude, altitude,
               battery_level, voltage, snr, rssi,
               channel_util, air_util_tx, firmware, channel,
               is_mqtt_gateway, hops_away,
               last_seen, first_seen, updated_at
        FROM nodes
        WHERE last_seen >= ?
          AND NOT (ABS(latitude) < 0.5 AND ABS(longitude) < 0.5)
        ORDER BY last_seen DESC
    """, (cutoff,))
    cols  = [d[0] for d in cur.description]
    nodes = [dict(zip(cols, row)) for row in cur.fetchall()]
    for n in nodes:
        ls = n.get("last_seen")
        n["last_seen_ago_min"] = round((now - ls) / 60) if ls else None
        n["is_recent"]         = bool(ls and (now - ls) < 3600)
        n["history"]           = telemetry_by_node.get(n["node_id"], [])

    with open(out_dir / "nodes.json", "w", encoding="utf-8") as f:
        json.dump({"nodes": nodes, "count": len(nodes), "generated_at": now}, f)

    # ── edges.json ──
    cur = conn.execute("""
        SELECT
            CASE WHEN e.from_node LIKE '!%' THEN e.from_node
                 ELSE '!' || printf('%08x', CAST(e.from_node AS INTEGER))
            END AS from_node,
            CASE WHEN e.to_node LIKE '!%' THEN e.to_node
                 ELSE '!' || printf('%08x', CAST(e.to_node AS INTEGER))
            END AS to_node,
            e.snr, e.edge_type, e.last_seen,
            COALESCE(NULLIF(fn.long_name,''), fn.short_name) AS from_name,
            fn.latitude AS from_lat, fn.longitude AS from_lon,
            COALESCE(NULLIF(tn.long_name,''), tn.short_name) AS to_name,
            tn.latitude AS to_lat, tn.longitude AS to_lon
        FROM edges e
        LEFT JOIN nodes fn ON fn.node_id = e.from_node
                           OR fn.node_id = '!' || printf('%08x', CAST(e.from_node AS INTEGER))
        LEFT JOIN nodes tn ON tn.node_id = e.to_node
                           OR tn.node_id = '!' || printf('%08x', CAST(e.to_node AS INTEGER))
        WHERE e.last_seen >= ?
          AND fn.latitude IS NOT NULL AND fn.longitude IS NOT NULL
          AND tn.latitude IS NOT NULL AND tn.longitude IS NOT NULL
          AND NOT (ABS(fn.latitude) < 0.5 AND ABS(fn.longitude) < 0.5)
          AND NOT (ABS(tn.latitude) < 0.5 AND ABS(tn.longitude) < 0.5)
        ORDER BY e.last_seen DESC
    """, (cutoff,))
    cols  = [d[0] for d in cur.description]
    edges = [dict(zip(cols, row)) for row in cur.fetchall()]

    with open(out_dir / "edges.json", "w", encoding="utf-8") as f:
        json.dump({"edges": edges, "count": len(edges)}, f)

    # ── history.json (actividad de la red últimas 24h por hora) ──
    hist_rows = conn.execute("""
        SELECT (collected_at / 3600) * 3600 AS hour,
               ROUND(AVG(active_nodes))     AS active_nodes
        FROM snapshots
        WHERE collected_at >= ?
          AND active_nodes IS NOT NULL
        GROUP BY hour
        ORDER BY hour ASC
    """, (telem_cutoff,)).fetchall()

    history = [{"t": r[0], "active": int(r[1])} for r in hist_rows]
    with open(out_dir / "history.json", "w", encoding="utf-8") as f:
        json.dump({"history": history, "generated_at": now}, f)

    # ── stats.json ──
    total_nodes   = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    with_pos      = conn.execute("SELECT COUNT(*) FROM nodes WHERE latitude IS NOT NULL").fetchone()[0]
    active_24h    = conn.execute("SELECT COUNT(*) FROM nodes WHERE last_seen >= ?", (now - 86400,)).fetchone()[0]
    active_1h     = conn.execute("SELECT COUNT(*) FROM nodes WHERE last_seen >= ?", (now - 3600,)).fetchone()[0]
    gateways      = conn.execute("SELECT COUNT(*) FROM nodes WHERE is_mqtt_gateway = 1").fetchone()[0]
    active_edges  = conn.execute("SELECT COUNT(*) FROM edges WHERE last_seen >= ?", (cutoff,)).fetchone()[0]
    last_snapshot = conn.execute("SELECT MAX(collected_at) FROM snapshots").fetchone()[0]
    total_snaps   = conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
    failed_snaps  = conn.execute(
        "SELECT COUNT(*) FROM snapshots WHERE nodes_count = 0"
    ).fetchone()[0]

    with open(out_dir / "stats.json", "w", encoding="utf-8") as f:
        json.dump({
            "nodes": {
                "total":         total_nodes,
                "with_position": with_pos,
                "active_24h":    active_24h,
                "active_1h":     active_1h,
                "mqtt_gateways": gateways,
            },
            "edges":    {"active_24h": active_edges},
            "snapshots": {
                "last_at":   last_snapshot,
                "total":     total_snaps,
                "failed":    failed_snaps,
            },
            "collector": {
                "source":          MESHVIEW_BASE,
                "retention_days":  RETENTION_DAYS,
                "interval_min":    INTERVAL_MIN,
            },
            "generated_at": now,
        }, f)

    # ── config.json ──
    with open(out_dir / "config.json", "w", encoding="utf-8") as f:
        json.dump({
            "map_auto_fit": MAP_AUTO_FIT,
            "map_lat":      MAP_LAT,
            "map_lng":      MAP_LNG,
            "map_zoom":     MAP_ZOOM,
        }, f)

    log.info(f"JSON exportado → {out_dir}  ({len(nodes)} nodos, {len(edges)} edges)")

    # ── Purge de datos antiguos (>RETENTION_DAYS) ──
    deleted_nodes = conn.execute("DELETE FROM nodes WHERE last_seen < ?", (cutoff,)).rowcount
    deleted_edges = conn.execute("DELETE FROM edges WHERE last_seen < ?", (cutoff,)).rowcount
    deleted_telem = conn.execute("DELETE FROM node_telemetry WHERE collected_at < ?", (cutoff,)).rowcount
    deleted_snaps = conn.execute("DELETE FROM snapshots WHERE collected_at < ?", (cutoff,)).rowcount
    if deleted_nodes or deleted_edges or deleted_telem:
        log.info(f"Purge: {deleted_nodes} nodos, {deleted_edges} edges, "
                 f"{deleted_telem} telemetría, {deleted_snaps} snapshots "
                 f"eliminados (>{RETENTION_DAYS} días)")


# ─── Colección principal ───────────────────────────────────────────────────────

def collect_once(conn: sqlite3.Connection):
    collected_at = int(datetime.now(timezone.utc).timestamp())
    nodes_saved = 0
    edges_saved = 0

    nodes = []

    # 1. Nodos
    nodes_url = f"{MESHVIEW_BASE}/api/nodes"
    log.info(f"Pidiendo nodos a {nodes_url} …")
    raw_nodes = fetch_json(nodes_url)
    if raw_nodes is not None:
        save_cache(nodes_url, raw_nodes)
        nodes = parse_nodes(raw_nodes)
        nodes_saved = upsert_nodes(conn, nodes)
        record_telemetry(conn, [n["node_id"] for n in nodes], collected_at)
        log.info(f"  → {nodes_saved} nodos guardados/actualizados")
    else:
        log.warning("  No se obtuvieron nodos")

    # 2. Edges
    edges_url = f"{MESHVIEW_BASE}/api/edges"
    log.info(f"Pidiendo edges a {edges_url} …")
    raw_edges = fetch_json(edges_url)
    if raw_edges is not None:
        save_cache(edges_url, raw_edges)
        edges = parse_edges(raw_edges)
        edges_saved = upsert_edges(conn, edges)
        log.info(f"  → {edges_saved} edges guardados/actualizados")
    else:
        log.warning("  No se obtuvieron edges (el endpoint puede no existir en esta versión)")

    active_nodes = conn.execute(
        "SELECT COUNT(*) FROM nodes WHERE last_seen >= ?", (collected_at - 3600,)
    ).fetchone()[0]

    record_snapshot(conn, collected_at, nodes_saved, edges_saved, active_nodes, MESHVIEW_BASE)
    log.info(f"Snapshot registrado: {nodes_saved} nodos, {edges_saved} edges, {active_nodes} activos 1h")
    return nodes_saved, edges_saved


# ─── Entrypoint ────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Meshtastic-es-map Collector")
    parser.add_argument("--daemon",   action="store_true", help="Modo bucle continuo")
    parser.add_argument("--interval", type=int, default=INTERVAL_MIN,
                        help="Minutos entre colecciones (default: 5)")
    parser.add_argument("--db", default=str(DB_PATH), help="Ruta a la BD SQLite")
    args = parser.parse_args()

    db_path  = Path(args.db)
    json_out = JSON_OUT
    conn = get_db(db_path)
    log.info(f"BD: {db_path}")
    log.info(f"JSON → {json_out}")
    log.info(f"Fuente: {MESHVIEW_BASE}")

    if args.daemon:
        log.info(f"Modo daemon — intervalo: {args.interval} min")
        while True:
            try:
                collect_once(conn)
                export_json(conn, json_out)
            except Exception as e:
                log.error(f"Error en colección: {e}", exc_info=True)
            log.info(f"Durmiendo {args.interval} min …")
            time.sleep(args.interval * 60)
    else:
        collect_once(conn)
        export_json(conn, json_out)
        log.info("Listo.")


if __name__ == "__main__":
    main()
