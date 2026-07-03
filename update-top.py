#!/usr/bin/env python3
"""
Genera top-nodos.json con el top 100 de nodos por canal (300 en total) más análisis detallado:
  - Conteo de paquetes por tipo (portnum)
  - Sub-tipos de telemetría (device / environment / power)
  - Uniformidad de traceroutes (automáticos vs manuales)
  - Detección de movilidad por coordenadas históricas (no por location_source)
  - Detección de hop_limit excesivo (> 5) en todos los nodos activos del mapa
Todo a partir de /api/packets por nodo y /api/packets_seen/{id} para hop_start.
El payload de la API viene en formato proto-text, no bytes.

Checks desactivables vía DISABLED_CHECKS (línea ~21), uno o varios:
  - range_test            Range Test activo
  - position_fixed        Posición muy/algo frecuente en nodo fijo
  - position_mobile       Posición muy/algo frecuente en nodo móvil
  - position_unknown      Posición frecuente sin datos de movilidad
  - nodeinfo              NodeInfo automático frecuente
  - telemetry_device      Telemetría de dispositivo frecuente
  - telemetry_environment Telemetría ambiental frecuente
  - telemetry_power       Telemetría eléctrica frecuente
  - routing               Routing excesivo
  - traceroute_auto       Traceroute sistemático (automático o con hop_start máximo)
  - position_flags        Flags GPS innecesarios en nodo fijo
  - hop_limit_high        Hop limit excesivo (hop_start >= 7) — desactivado por defecto
  - client_base_fw        CLIENT_BASE con firmware >= 2.7.17 (actúa como ROUTER_LATE)
"""
import json, math, os, re, statistics, time, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

OUT      = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web", "top-nodos.json")
BASE     = os.environ.get("MESHVIEW_URL", "http://localhost:18085")
BROADCAST_ID = 4294967295  # to_node_id de los paquetes broadcast (^all)

# Checks de detect_issues() desactivados. Añade aquí la key (ver THRESHOLDS más abajo)
# de cualquier detección que quieras quitar, p.ej. {'hop_limit_high', 'range_test'}.
DISABLED_CHECKS = {'hop_limit_high'}

def _fw_gte(firmware, major, minor, patch):
    parts = (firmware or '').split('.')
    a = []
    for p in parts[:3]:
        try: a.append(int(p))
        except ValueError: a.append(0)
    while len(a) < 3: a.append(0)
    b = [major, minor, patch]
    for i in range(3):
        if a[i] > b[i]: return True
        if a[i] < b[i]: return False
    return True

PORTNUMS = {
    "text":         1,
    "position":     3,
    "nodeinfo":     4,
    "routing":      5,
    "telemetry":   67,
    "range_test":  66,
    "traceroute":  70,
    "neighborinfo": 71,
}

# ── Parseo de payload (proto-text) ────────────────────────────────────────────

def telemetry_subtype(payload):
    """Detecta el sub-tipo de telemetría del payload en formato proto-text."""
    if not isinstance(payload, str):
        return 'other'
    if 'device_metrics'      in payload: return 'device'
    if 'environment_metrics' in payload: return 'environment'
    if 'power_metrics'       in payload: return 'power'
    return 'other'

def parse_position(payload):
    """
    Extrae lat/lon (en grados) y location_source del payload proto-text.
    latitude_i y longitude_i están en enteros × 1e7.
    """
    if not isinstance(payload, str):
        return None, None

    lat_i = lon_i = None
    m = re.search(r'latitude_i:\s*(-?\d+)', payload)
    if m: lat_i = int(m.group(1))
    m = re.search(r'longitude_i:\s*(-?\d+)', payload)
    if m: lon_i = int(m.group(1))

    if lat_i is None or lon_i is None:
        return None, None
    # Filtrar null island (|lat| < 0.5°)
    if abs(lat_i) < 5_000_000:
        return None, None

    return lat_i / 1e7, lon_i / 1e7

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((phi2 - phi1) / 2) ** 2
       + math.cos(phi1) * math.cos(phi2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(a))

# ── Comunidad autónoma (reverse geocoding con caché) ─────────────────────────

CCAA_NORMALIZE = {
    'principado de asturias':     'Asturias',
    'asturias':                   'Asturias',
    'islas baleares':             'Baleares',
    'illes balears':              'Baleares',
    'comunitat valenciana':       'C. Valenciana',
    'comunidad valenciana':       'C. Valenciana',
    'comunidad de madrid':        'Madrid',
    'región de murcia':           'Murcia',
    'comunidad foral de navarra': 'Navarra',
    'comunitat foral de navarra': 'Navarra',
    'nafarroa':                   'Navarra',
    'ciudad autónoma de ceuta':   'Ceuta',
    'ciudad autónoma de melilla': 'Melilla',
    'país vasco':                 'País Vasco',
    'euskadi':                    'País Vasco',
    'basque country':             'País Vasco',
    'la rioja':                   'La Rioja',
    'cataluña':                   'Cataluña',
    'catalunya':                  'Cataluña',
    'castilla y león':            'Castilla y León',
    'castilla - la mancha':       'Castilla-La Mancha',
    'castilla-la mancha':         'Castilla-La Mancha',
    'extremadura':                'Extremadura',
    'galicia':                    'Galicia',
    'cantabria':                  'Cantabria',
    'aragón':                     'Aragón',
    'aragon':                     'Aragón',
    'canarias':                   'Canarias',
    'islas canarias':             'Canarias',
    'andalucía':                  'Andalucía',
    'andalucia':                  'Andalucía',
}

CCAA_CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ccaa-cache.json")

def load_ccaa_cache():
    try:
        with open(CCAA_CACHE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}

def nominatim_ccaa(lat, lon):
    url = (f"https://nominatim.openstreetmap.org/reverse"
           f"?format=json&lat={lat:.4f}&lon={lon:.4f}"
           f"&addressdetails=1&accept-language=es")
    req = urllib.request.Request(url, headers={"User-Agent": "meshtastic-es-map/1.0 (open source)"})
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read())
    raw = (data.get("address") or {}).get("state") or (data.get("address") or {}).get("county")
    if raw:
        return CCAA_NORMALIZE.get(raw.strip().lower(), raw.strip())
    return None

# ── API ───────────────────────────────────────────────────────────────────────

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def fetch_json_retry(url, retries=3, wait_s=30):
    for attempt in range(1, retries + 1):
        try:
            return fetch_json(url)
        except Exception as e:
            if attempt == retries:
                raise
            print(f"  [warn] {url}: {e} — reintentando en {wait_s}s ({attempt}/{retries})")
            time.sleep(wait_s)

def fetch_hop_start(packet_id):
    """
    Consulta /api/packets_seen/{packet_id} y devuelve el hop_start configurado
    por el emisor original. hop_start es el valor máximo de hop_limit que se puede
    observar en los receptores (antes de que disminuya con cada rebroadcast).
    """
    url = f"{BASE}/api/packets_seen/{packet_id}"
    try:
        data = fetch_json(url)
        seen = data.get("seen", [])
        if not seen:
            return None
        # hop_start explícito (firmware reciente): todos los entries lo comparten
        hop_starts = [e["hop_start"] for e in seen if e.get("hop_start", 0) > 0]
        if hop_starts:
            return max(hop_starts)
        # Fallback (firmware antiguo sin hop_start): max(hop_limit) = valor original
        hop_limits = [e["hop_limit"] for e in seen if e.get("hop_limit") is not None]
        return max(hop_limits) if hop_limits else None
    except Exception:
        return None

# ── Análisis completo de un nodo ──────────────────────────────────────────────

def analyze_node(node_id):
    since = (int(time.time()) - 86400) * 1_000_000
    url   = f"{BASE}/api/packets?from_node_id={node_id}&since={since}&limit=10000"
    try:
        data    = fetch_json(url)
        packets = [p for p in data.get("packets", []) if p.get("from_node_id") == node_id]
    except Exception as e:
        print(f"  [warn] {node_id}: {e}")
        return None

    # ── 1. Conteo por portnum ─────────────────────────────────────────────────
    # Para traceroute (portnum=70) solo contamos los requests (los que el nodo
    # inició). Las responses se identifican por tener "route_back" en el payload.
    # Para position (3), nodeinfo (4) y telemetry (67) solo contamos los
    # broadcast (to_node_id=^all). Las peticiones/respuestas van como unicast
    # y no reflejan la configuración propia del nodo (Broadcast Interval),
    # sino que alguien las pidió.
    BROADCAST_ONLY = {"position", "nodeinfo", "telemetry"}
    counts = {name: 0 for name in PORTNUMS}
    for p in packets:
        for name, portnum in PORTNUMS.items():
            if p.get("portnum") == portnum:
                if name == "traceroute" and "route_back" in (p.get("payload") or ""):
                    continue  # response a un traceroute ajeno, no contar
                if name in BROADCAST_ONLY and p.get("to_node_id") != BROADCAST_ID:
                    continue  # petición/respuesta unicast, no contar
                counts[name] += 1

    # ── 2. Sub-tipos de telemetría ────────────────────────────────────────────
    tel_detail = {"device": 0, "environment": 0, "power": 0, "other": 0}
    for p in packets:
        if p.get("portnum") == 67 and p.get("to_node_id") == BROADCAST_ID:
            stype = telemetry_subtype(p.get("payload"))
            tel_detail[stype] += 1

    # ── 3. Uniformidad de traceroutes y nodeinfo ──────────────────────────────
    def uniformity(portnum, short_cycle_min=None, short_cycle_count=None, payload_exclude=None, broadcast_only=False):
        ts = sorted(
            p["import_time_us"] for p in packets
            if p.get("portnum") == portnum and p.get("import_time_us")
            and (payload_exclude is None or payload_exclude not in (p.get("payload") or ""))
            and (not broadcast_only or p.get("to_node_id") == BROADCAST_ID)
        )
        count = len(ts)
        if count < 3:
            return None
        intervals = [(ts[i + 1] - ts[i]) / 60e6 for i in range(count - 1)]
        mean = sum(intervals) / len(intervals)
        try:
            cv = statistics.stdev(intervals) / mean if mean > 0 else 1.0
        except Exception:
            cv = 1.0
        uniform    = cv < 0.2
        short_cycle = (short_cycle_min is not None
                       and short_cycle_count is not None
                       and mean < short_cycle_min
                       and count > short_cycle_count)
        return {
            "avg_interval_min": round(mean, 1),
            "cv":               round(cv, 3),
            "is_automatic":     uniform or short_cycle,
        }

    tr_u  = uniformity(70, short_cycle_min=20, short_cycle_count=50,
                       payload_exclude="route_back")
    ni_u  = uniformity(4, broadcast_only=True)
    ro_u  = uniformity(5,  short_cycle_min=10, short_cycle_count=50)

    # Comprobar si los traceroutes usan hop_start=7 (señal de herramienta automática)
    tr_max_hops = False
    tr_requests = [p for p in packets
                   if p.get("portnum") == 70
                   and "route_back" not in (p.get("payload") or "")]
    if tr_requests:
        recent_tr = max(tr_requests, key=lambda p: p.get("import_time_us") or 0)
        tr_hop = fetch_hop_start(recent_tr.get("id"))
        tr_max_hops = (tr_hop == 7)

    tr_detail = None
    if tr_u or tr_max_hops:
        is_auto = (tr_u["is_automatic"] if tr_u else False) or tr_max_hops
        tr_detail = {
            "avg_interval_min": tr_u["avg_interval_min"] if tr_u else None,
            "cv":               tr_u["cv"]               if tr_u else None,
            "is_automatic":     is_auto,
            "uses_max_hops":    tr_max_hops,
            "auto_count":       counts["traceroute"] if is_auto else 0,
            "manual_count":     0 if is_auto else counts["traceroute"],
        }
    ni_detail = None
    if ni_u:
        ni_detail = {**ni_u,
            "auto_count":   counts["nodeinfo"] if ni_u["is_automatic"] else 0,
            "manual_count": 0 if ni_u["is_automatic"] else counts["nodeinfo"],
        }
    ro_detail = None
    if ro_u:
        ro_detail = {**ro_u,
            "auto_count":   counts["routing"] if ro_u["is_automatic"] else 0,
            "manual_count": 0 if ro_u["is_automatic"] else counts["routing"],
        }

    # ── 4. Movilidad + desglose de campos de posición ────────────────────────
    POS_FIELDS = [
        "altitude", "speed", "heading", "ground_speed", "ground_track",
        "sats_in_view", "pdop", "hdop", "gdop", "timestamp",
        "seq_number", "precision_bits", "location_source",
    ]
    coords      = []
    pos_total   = 0
    pos_fields  = {f: 0 for f in POS_FIELDS}

    for p in packets:
        if p.get("portnum") == 3:
            if p.get("to_node_id") != BROADCAST_ID:
                continue  # petición/respuesta de posición unicast, no contar
            payload = p.get("payload") or ""
            lat, lon = parse_position(payload)
            if lat is not None:
                coords.append((lat, lon))
            pos_total += 1
            for f in POS_FIELDS:
                if re.search(rf'\b{f}\s*:', payload):
                    pos_fields[f] += 1

    # Solo incluir campos que aparecen en al menos 1 paquete
    position_detail = {"total": pos_total}
    if pos_total > 0:
        position_detail["fields"] = {
            f: {"count": v, "pct": round(v / pos_total * 100)}
            for f, v in pos_fields.items() if v > 0
        }

    mobility = None
    if len(coords) >= 2:
        ref_lat, ref_lon = coords[0]
        distances = [haversine_m(ref_lat, ref_lon, lat, lon) for lat, lon in coords[1:]]
        max_dist  = max(distances)
        mobility  = {
            "max_distance_m":    round(max_dist),
            "positions_checked": len(coords),
            "is_fixed":          max_dist < 100,
        }

    # ── 5. hop_start del último paquete ──────────────────────────────────────
    hop_start = None
    if packets:
        recent    = max(packets, key=lambda p: p.get("import_time_us") or 0)
        packet_id = recent.get("id")
        if packet_id:
            hop_start = fetch_hop_start(packet_id)

    return {
        "packets":           counts,
        "telemetry_detail":  tel_detail,
        "traceroute_detail": tr_detail,
        "nodeinfo_detail":   ni_detail,
        "routing_detail":    ro_detail,
        "position_detail":   position_detail if pos_total > 0 else None,
        "mobility":          mobility,
        "hop_start":         hop_start,
        "_lat":              coords[-1][0] if coords else None,
        "_lon":              coords[-1][1] if coords else None,
    }

# ── Detección de problemas ────────────────────────────────────────────────────

THRESHOLDS = {
    'range_test':            {'critical': 1},
    'position_fixed':        {'critical': 24,  'high': 6,   'medium': 2},
    'position_mobile':       {'critical': 96,  'high': 48,  'medium': 30},
    'nodeinfo':              {'critical': 24,  'high': 6,   'medium': 2},
    'telemetry_device':      {'critical': 24,  'high': 8,   'medium': 4},
    'telemetry_environment': {'critical': 25,  'high': 15,  'medium': 8},
    'telemetry_power':       {'critical': 25,  'high': 15,  'medium': 6},
    'routing':               {'critical': 150, 'high': 30,  'medium': 15},
    'traceroute_auto':       {'critical': 24,  'high': 12,  'medium': 10},
    'hop_limit_high':        {'critical': 7},
}

def _issue(key, label, severity):
    return {"key": key, "label": label, "severity": severity}

def detect_issues(node):
    p   = node.get("packets") or {}
    tel = node.get("telemetry_detail") or {}
    tr  = node.get("traceroute_detail") or {}
    ni  = node.get("nodeinfo_detail") or {}
    ro  = node.get("routing_detail") or {}
    mob = node.get("mobility")
    t   = THRESHOLDS
    issues = []

    # Range Test
    if (p.get("range_test") or 0) > t['range_test']['critical'] - 1:
        issues.append(_issue('range_test', f"Range Test activo ({p['range_test']}/día)", 'critical'))

    # Posición
    pos = p.get("position") or 0
    if pos > 0:
        if mob is not None:
            pt  = t['position_fixed'] if mob['is_fixed'] else t['position_mobile']
            key = 'position_fixed' if mob['is_fixed'] else 'position_mobile'
            tag = 'nodo fijo' if mob['is_fixed'] else 'nodo móvil'
            if pos > pt['critical']:
                issues.append(_issue(key, f"Posición muy frecuente para {tag} ({pos}/día)", 'critical'))
            elif pos > pt['high']:
                issues.append(_issue(key, f"Posición frecuente para {tag} ({pos}/día)", 'high'))
            elif pos > pt['medium']:
                issues.append(_issue(key, f"Posición algo frecuente para {tag} ({pos}/día)", 'medium'))
        else:
            if pos > t['position_fixed']['critical']:
                issues.append(_issue('position_unknown', f"Posición muy frecuente ({pos}/día)", 'critical'))
            elif pos > t['position_fixed']['high']:
                issues.append(_issue('position_unknown', f"Posición frecuente ({pos}/día)", 'high'))
            elif pos > t['position_fixed']['medium']:
                issues.append(_issue('position_unknown', f"Posición frecuente ({pos}/día)", 'medium'))

    # NodeInfo
    ni_count = p.get("nodeinfo") or 0
    ni_auto  = ni.get("is_automatic") if ni else (ni_count > t['nodeinfo']['critical'])
    if ni_auto:
        if ni_count > t['nodeinfo']['critical']:
            issues.append(_issue('nodeinfo', f"NodeInfo automático muy frecuente ({ni_count}/día)", 'critical'))
        elif ni_count > t['nodeinfo']['high']:
            issues.append(_issue('nodeinfo', f"NodeInfo automático frecuente ({ni_count}/día)", 'high'))
        elif ni_count > t['nodeinfo']['medium']:
            issues.append(_issue('nodeinfo', f"NodeInfo automático frecuente ({ni_count}/día)", 'medium'))

    # Telemetría por sub-tipo
    if tel:
        dev = tel.get("device") or 0
        env = tel.get("environment") or 0
        pwr = tel.get("power") or 0
        if dev > t['telemetry_device']['critical']:
            issues.append(_issue('telemetry_device', f"Telemetría dispositivo muy frecuente ({dev}/día)", 'critical'))
        elif dev > t['telemetry_device']['high']:
            issues.append(_issue('telemetry_device', f"Telemetría dispositivo frecuente ({dev}/día)", 'high'))
        elif dev > t['telemetry_device']['medium']:
            issues.append(_issue('telemetry_device', f"Telemetría dispositivo frecuente ({dev}/día)", 'medium'))
        if env > t['telemetry_environment']['critical']:
            issues.append(_issue('telemetry_environment', f"Telemetría entorno muy frecuente ({env}/día)", 'critical'))
        elif env > t['telemetry_environment']['high']:
            issues.append(_issue('telemetry_environment', f"Telemetría entorno frecuente ({env}/día)", 'high'))
        elif env > t['telemetry_environment']['medium']:
            issues.append(_issue('telemetry_environment', f"Telemetría entorno frecuente ({env}/día)", 'medium'))
        if pwr > t['telemetry_power']['critical']:
            issues.append(_issue('telemetry_power', f"Telemetría eléctrica muy frecuente ({pwr}/día)", 'critical'))
        elif pwr > t['telemetry_power']['high']:
            issues.append(_issue('telemetry_power', f"Telemetría eléctrica frecuente ({pwr}/día)", 'high'))
        elif pwr > t['telemetry_power']['medium']:
            issues.append(_issue('telemetry_power', f"Telemetría eléctrica frecuente ({pwr}/día)", 'medium'))
    else:
        total_tel = p.get("telemetry") or 0
        if total_tel > t['telemetry_device']['critical']:
            issues.append(_issue('telemetry_device', f"Telemetría muy frecuente ({total_tel}/día)", 'critical'))
        elif total_tel > t['telemetry_device']['high']:
            issues.append(_issue('telemetry_device', f"Telemetría frecuente ({total_tel}/día)", 'high'))
        elif total_tel > t['telemetry_device']['medium']:
            issues.append(_issue('telemetry_device', f"Telemetría frecuente ({total_tel}/día)", 'medium'))

    # Routing
    ro_count = p.get("routing") or 0
    ro_auto  = ro.get("is_automatic") if ro else (ro_count > t['routing']['critical'])
    if ro_auto and ro_count > t['routing']['medium']:
        if ro_count > t['routing']['critical']:
            sev = 'critical'
        elif ro_count > t['routing']['high']:
            sev = 'high'
        else:
            sev = 'medium'
        issues.append(_issue('routing', f"Routing excesivo ({ro_count}/día)", sev))

    # Traceroute
    # is_automatic (CV) = señal fuerte → umbral 'medium'
    # uses_max_hops solo (hop_start=7 sin CV uniforme) = señal débil → umbral 'high'
    tr_count      = p.get("traceroute") or 0
    tr_is_auto    = tr.get("is_automatic")   if tr else False
    tr_max_hops   = tr.get("uses_max_hops")  if tr else False
    tr_threshold  = t['traceroute_auto']['medium'] if tr_is_auto else t['traceroute_auto']['high']
    if (tr_is_auto or tr_max_hops) and tr_count > tr_threshold:
        if tr_count > t['traceroute_auto']['critical']:
            sev = 'critical'
        elif tr_count > t['traceroute_auto']['high']:
            sev = 'high'
        else:
            sev = 'medium'
        issues.append(_issue('traceroute_auto', f"Traceroute sistemático ({tr_count}/día)", sev))

    # Flags de posición innecesarios en nodo fijo
    if mob and mob.get("is_fixed") and (p.get("position") or 0) > 0:
        pos_fields = (node.get("position_detail") or {}).get("fields") or {}
        FLAG_LABELS = {
            "ground_speed": "SPEED",
            "ground_track": "HEADING",
            "sats_in_view": "NVSS_SATS",
            "seq_number":   "SEQ_NO",
            "timestamp":    "TIMESTAMP",
            "altitude_hae": "ALT_HAE",
        }
        unwanted = [FLAG_LABELS[f] for f in FLAG_LABELS if pos_fields.get(f, {}).get("count", 0) > 0]
        if unwanted:
            issues.append(_issue('position_flags',
                f"Flags GPS innecesarios en nodo fijo: {', '.join(unwanted)}", 'medium'))

    # Hop limit excesivo (valor discreto 1-7, usa >= no >)
    hop_start = node.get("hop_start")
    if hop_start is not None and hop_start >= t['hop_limit_high']['critical']:
        issues.append(_issue('hop_limit_high', f"Hop limit excesivo ({hop_start})", 'critical'))

    # CLIENT_BASE con firmware >= 2.7.17 actúa como ROUTER_LATE
    meta = _node_meta.get(node.get("node_id"), {})
    if meta.get("role") == "CLIENT_BASE" and _fw_gte(meta.get("firmware"), 2, 7, 17):
        issues.append(_issue('client_base_fw', "CLIENT_BASE ≥ 2.7.17 actúa como ROUTER_LATE", 'medium'))

    return [i for i in issues if i['key'] not in DISABLED_CHECKS]

# ── Comprobación de hop_limit en todos los nodos activos ─────────────────────

def collect_hop_limit_nodes(known_ids):
    """
    Comprueba el hop_start de TODOS los nodos de la red (no solo el top).
    Para cada nodo de /api/nodes que no esté en known_ids, pide su último
    paquete y consulta /api/packets_seen/{id} para obtener el hop_start.
    """
    try:
        data  = fetch_json_retry(f"{BASE}/api/nodes")
        nodes = data if isinstance(data, list) else data.get("nodes", [])
    except Exception as e:
        print(f"  [warn] collect_hop_limit_nodes (nodes): {e}")
        return []

    # Solo nodos no analizados ya en el top
    candidates = [n for n in nodes if n.get("node_id") not in known_ids]
    print(f"  {len(candidates)} nodos fuera del top a comprobar...")

    results = []

    def check_hop(node):
        node_id = node.get("node_id")
        if node_id is None:
            return None
        try:
            data    = fetch_json(f"{BASE}/api/packets?from_node_id={node_id}&limit=1")
            packets = data.get("packets", []) if isinstance(data, dict) else []
        except Exception:
            return None
        if not packets:
            return None
        packet_id = packets[0].get("id")
        if not packet_id:
            return None
        hs = fetch_hop_start(packet_id)
        if hs is None or hs < THRESHOLDS['hop_limit_high']['critical']:
            return None
        sev = 'critical'
        return {
            "node_id":           node_id,
            "long_name":         node.get("long_name") or "",
            "short_name":        node.get("short_name") or "",
            "channel":           node.get("channel") or packets[0].get("channel") or "",
            "sent":              0,
            "hop_start":         hs,
            "packets":           {k: None for k in PORTNUMS},
            "issues":            [_issue('hop_limit_high', f"Hop limit excesivo ({hs})", sev)],
            "telemetry_detail":  None,
            "traceroute_detail": None,
            "nodeinfo_detail":   None,
            "routing_detail":    None,
            "position_detail":   None,
            "mobility":          None,
            "lat":               None,
            "lon":               None,
            "ccaa":              None,
        }

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(check_hop, n): n for n in candidates}
        for future in as_completed(futures):
            result = future.result()
            if result:
                name = result['long_name'] or result['short_name'] or str(result['node_id'])
                hs   = result['hop_start']
                sev  = result['issues'][0]['severity'].upper()
                print(f"  [{sev}] {name}: hop_start={hs}")
                results.append(result)

    return results

# ── Main ──────────────────────────────────────────────────────────────────────

try:
    CHANNELS = fetch_json_retry(f"{BASE}/api/channels").get("channels", [])
    print(f"Canales: {CHANNELS}")
except Exception as e:
    print(f"Error obteniendo canales: {e}. JSON anterior conservado.")
    raise SystemExit(1)

# Lookup role+firmware por node_id para el check client_base_fw
_node_meta = {}
try:
    _nodes_data = fetch_json_retry(f"{BASE}/api/nodes")
    _nodes_list = _nodes_data if isinstance(_nodes_data, list) else _nodes_data.get("nodes", [])
    for _n in _nodes_list:
        _nid = _n.get("node_id")
        if _nid is not None:
            _node_meta[_nid] = {"role": _n.get("role") or "", "firmware": _n.get("firmware") or ""}
    print(f"Metadata de nodos cargada: {len(_node_meta)} entradas")
except Exception as e:
    print(f"[warn] No se pudo cargar /api/nodes para client_base_fw: {e}")

all_nodes = []
for ch in CHANNELS:
    url = f"{BASE}/api/stats/top?channel={ch}&limit=100&offset=0"
    try:
        data  = fetch_json_retry(url)
        nodes = data.get("nodes", [])
        for n in nodes:
            n["channel"] = ch
        all_nodes += nodes
        print(f"{ch}: {len(nodes)} nodos")
    except Exception as e:
        print(f"Error {ch}: {e}")

print(f"\nAnalizando {len(all_nodes)} nodos...")

with ThreadPoolExecutor(max_workers=5) as executor:
    futures = {executor.submit(analyze_node, n["node_id"]): n for n in all_nodes}
    for future in as_completed(futures):
        node   = futures[future]
        result = future.result()
        name   = node.get("long_name") or node.get("short_name") or str(node["node_id"])
        if result:
            node.update(result)
            node["issues"] = detect_issues(node)
            tel    = result.get("telemetry_detail", {})
            tr     = result.get("traceroute_detail")
            mob    = result.get("mobility")
            issues = node["issues"]
            print(f"  {name}")
            print(f"    pkts={sum(v for v in result['packets'].values() if v)} "
                  f"issues={len(issues)} "
                  f"fijo={'sí (±' + str(mob['max_distance_m']) + 'm)' if mob and mob['is_fixed'] else 'móvil' if mob and not mob['is_fixed'] else '—'}")
            for iss in issues:
                print(f"      [{iss['severity']}] {iss['label']}")
        else:
            node["packets"] = {k: None for k in PORTNUMS}
            node["issues"]  = []
            print(f"  {name}: sin datos")

# ── hop_limit en todos los nodos activos (no solo top) ───────────────────────

if 'hop_limit_high' in DISABLED_CHECKS:
    print("\nCheck hop_limit_high desactivado (DISABLED_CHECKS) — omitiendo escaneo de red")
else:
    known_ids = {n["node_id"] for n in all_nodes}
    print(f"\nComprobando hop_limit en todos los nodos activos...")
    hop_nodes = collect_hop_limit_nodes(known_ids)
    if hop_nodes:
        print(f"  → {len(hop_nodes)} nodos adicionales con hop_limit excesivo")
        all_nodes += hop_nodes
    else:
        print("  → ningún nodo adicional con hop_limit excesivo")

# ── Comunidad autónoma (solo nodos con problemas) ─────────────────────────────

ccaa_cache     = load_ccaa_cache()
nominatim_calls = 0
print(f"\nDetectando comunidad autónoma...")

for node in all_nodes:
    lat = node.pop("_lat", None)
    lon = node.pop("_lon", None)
    if lat is None or not node.get("issues"):
        node["lat"] = node["lon"] = node["ccaa"] = None
        continue
    node["lat"] = round(lat, 5)
    node["lon"] = round(lon, 5)
    key = f"{lat:.3f},{lon:.3f}"
    if key not in ccaa_cache:
        try:
            ccaa_cache[key] = nominatim_ccaa(lat, lon)
            nominatim_calls += 1
            time.sleep(1.1)
        except Exception as e:
            print(f"  [warn] nominatim {lat:.4f},{lon:.4f}: {e}")
            ccaa_cache[key] = None
    node["ccaa"] = ccaa_cache[key]

if nominatim_calls:
    print(f"  {nominatim_calls} llamadas Nominatim realizadas")
    try:
        with open(CCAA_CACHE_PATH, "w") as f:
            json.dump(ccaa_cache, f)
    except Exception as e:
        print(f"  [warn] no se pudo guardar ccaa-cache.json: {e}")

if not all_nodes:
    print("\nNo se obtuvo ningún nodo (timeout o error de red). JSON anterior conservado.")
else:
    result_data = {"updated": int(time.time()), "nodes": all_nodes}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(result_data, f)
    print(f"\nGuardado: {len(all_nodes)} nodos en {OUT}")

    # ── Historial diario ──────────────────────────────────────────────────────
    import datetime
    _json_out    = os.environ.get("JSON_OUT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "web", "data"))
    HISTORY_PATH = os.path.join(_json_out.rstrip("/"), "history.json")
    today = datetime.date.today().isoformat()
    with_issues = [n for n in all_nodes if n.get("issues")]

    issue_by_type = {}
    for n in with_issues:
        seen = set()
        for i in n.get("issues", []):
            if i["key"] not in seen:
                seen.add(i["key"])
                issue_by_type[i["key"]] = issue_by_type.get(i["key"], 0) + 1

    by_severity = {"critical": 0, "high": 0, "medium": 0}
    for n in with_issues:
        for i in n.get("issues", []):
            sev = i.get("severity", "medium")
            by_severity[sev] = by_severity.get(sev, 0) + 1

    entry = {
        "date":           today,
        "with_issues":    len(with_issues),
        "total_analyzed": len(all_nodes),
        "by_type":        issue_by_type,
        "by_severity":    by_severity,
    }
    try:
        with open(HISTORY_PATH) as f:
            history = json.load(f)
    except Exception:
        history = []
    history = [h for h in history if h.get("date") != today]
    history.append(entry)
    history = sorted(history, key=lambda h: h["date"])[-30:]
    try:
        os.makedirs(os.path.dirname(HISTORY_PATH), exist_ok=True)
        with open(HISTORY_PATH, "w") as f:
            json.dump(history, f)
        print(f"Historial actualizado: {len(history)} días")
    except Exception as e:
        print(f"  [warn] no se pudo guardar history.json: {e}")
