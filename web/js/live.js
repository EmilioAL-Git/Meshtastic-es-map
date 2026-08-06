// ─── Feed en vivo: MQTT → WebSocket → animación en el mapa ─────────────────────

let liveTracked = new Map();  // packet_id → { info, stages, legIndex, marker, halo, trails, color, expiring }
let liveLayer;                // L.layerGroup de marcadores/halos animados
let liveTrailLayer;           // L.layerGroup de las líneas de recorrido (por debajo de los marcadores)
let livePingLayer;            // L.layerGroup de los pings de origen
let liveNodeLayer;            // L.layerGroup de puntos base de nodos
let liveWs = null;
let liveBackoffMs = 1000;
let livePaused = false;
const LIVE_BACKOFF_MAX_MS = 30000;
const LIVE_LOG_MAX = 200;

// packet_id → { info, stages, path_confidence } — historial persistente
// para el desglose, independiente del ciclo de vida de la animación
// (liveTracked se borra al expirar; esto se conserva mientras la fila
// siga en la lista, hasta LIVE_LOG_MAX).
let livePacketLog = new Map();

// Paleta para diferenciar paquetes simultáneos — cada packet_id se queda
// siempre con el mismo color mientras esté en vuelo (hash estable).
const PACKET_COLORS = [
  '#f97316', '#38bdf8', '#a78bfa', '#f472b6', '#4ade80',
  '#facc15', '#fb7185', '#22d3ee', '#c084fc', '#84cc16',
];
function packetColor(packetId) {
  let h = 0;
  const s = String(packetId);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PACKET_COLORS[h % PACKET_COLORS.length];
}

function easeInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

function initLiveMap() {
  map = L.map('map', {
    center: [MAP_LAT, MAP_LNG],
    zoom: MAP_ZOOM,
    zoomControl: true,
    preferCanvas: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);

  map.createPane('livePane');
  map.getPane('livePane').style.zIndex = 460;

  liveNodeLayer = L.layerGroup().addTo(map);
  liveTrailLayer = L.layerGroup().addTo(map);
  liveLayer = L.layerGroup().addTo(map);
  livePingLayer = L.layerGroup().addTo(map);
}

function renderBaseNodes() {
  liveNodeLayer.clearLayers();
  for (const n of allNodes) {
    if (n.latitude == null || n.longitude == null) continue;
    L.circleMarker([n.latitude, n.longitude], {
      pane: 'livePane',
      radius: 3,
      color: C_OLD,
      weight: 1,
      fillColor: C_OLD,
      fillOpacity: 0.6,
      interactive: false,
    }).addTo(liveNodeLayer);
  }
}

async function loadNodes() {
  const r = await fetch(API_BASE + '/data/nodes.json?t=' + Date.now());
  if (!r.ok) throw new Error('No se pudo cargar nodes.json');
  const data = await r.json();
  allNodes = data.nodes || [];
  nodesById = new Map(allNodes.map(n => [n.node_id, n]));
  renderBaseNodes();
}

function nodeLatLng(nodeId) {
  const n = nodesById.get(nodeId);
  if (!n || n.latitude == null || n.longitude == null) return null;
  return [n.latitude, n.longitude];
}

// ─── Conexión WebSocket ─────────────────────────────────────────────────────

function liveWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${API_BASE}/live-ws/`;
}

function setConnBadge(state, label) {
  const el = document.getElementById('conn-badge');
  el.className = 'conn-badge ' + state;
  document.getElementById('conn-label').textContent = label;
}

function connectLive() {
  setConnBadge('reconnecting', 'Conectando…');
  liveWs = new WebSocket(liveWsUrl());

  liveWs.onopen = () => {
    liveBackoffMs = 1000;
    setConnBadge('connected', 'Conectado');
  };

  liveWs.onmessage = (ev) => {
    if (livePaused) return;
    let event;
    try { event = JSON.parse(ev.data); } catch { return; }
    handleLiveEvent(event);
  };

  liveWs.onclose = () => {
    setConnBadge('reconnecting', `Reconectando en ${Math.round(liveBackoffMs / 1000)}s…`);
    setTimeout(connectLive, liveBackoffMs);
    liveBackoffMs = Math.min(liveBackoffMs * 2, LIVE_BACKOFF_MAX_MS);
  };

  liveWs.onerror = () => { liveWs.close(); };
}

// ─── Eventos de paquetes ────────────────────────────────────────────────────

function handleLiveEvent(event) {
  if (event.type === 'packet_new') {
    liveTracked.set(event.packet_id, {
      info: event, stages: [], legIndex: 0,
      marker: null, halo: null, trails: [],
      color: packetColor(event.packet_id),
      expiring: false,
    });
    addLogRow(event);
    spawnOriginPing(event);
  } else if (event.type === 'packet_stage') {
    const tracked = liveTracked.get(event.packet_id);
    if (!tracked) return;
    const hadStages = tracked.stages.length;
    tracked.stages = event.stages;
    updateLogRow(event);
    if (event.stages.length > hadStages) animateNextLeg(event.packet_id);
  } else if (event.type === 'packet_expired') {
    expirePacket(event.packet_id);
  }
}

function stagePosition(stage) {
  // Varios gateways pueden compartir etapa (oyeron la misma transmisión) —
  // se prueban todos hasta encontrar uno que conozcamos (muchos gateways
  // del feed EU_868/LORA_24 no son nodos españoles rastreados por nuestro
  // mapa, así que limitarse al primero perdía casi todos los saltos).
  for (const gw of stage.gateway_ids) {
    const pos = nodeLatLng(gw);
    if (pos) return pos;
  }
  return null;
}

function spawnOriginPing(event) {
  const pos = nodeLatLng(event.from);
  if (!pos) return;
  const color = packetColor(event.packet_id);
  const ring = L.circleMarker(pos, {
    pane: 'livePane', radius: 6, color, weight: 2,
    fillOpacity: 0, interactive: false,
  }).addTo(livePingLayer);

  const durationMs = 900;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    ring.setRadius(6 + t * 18);
    ring.setStyle({ opacity: 1 - t });
    if (t < 1) requestAnimationFrame(step);
    else livePingLayer.removeLayer(ring);
  }
  requestAnimationFrame(step);
}

function ensureMarker(tracked, atPos) {
  if (tracked.marker) return;
  tracked.halo = L.circleMarker(atPos, {
    pane: 'livePane', radius: 9, color: tracked.color, weight: 0,
    fillColor: tracked.color, fillOpacity: 0.25, interactive: false,
  }).addTo(liveLayer);
  tracked.marker = L.circleMarker(atPos, {
    pane: 'livePane', radius: 5, color: '#fff', weight: 1.5,
    fillColor: tracked.color, fillOpacity: 1, interactive: true,
    bubblingMouseEvents: false,
  }).addTo(liveLayer);
  tracked.marker.on('click', () => openPacketDetail(tracked.info.packet_id));
  idlePulse(tracked);
}

function idlePulse(tracked) {
  // Halo respirando alrededor del marcador mientras el paquete sigue vivo.
  function step(now) {
    if (!tracked.marker || !tracked.halo) return;
    const wave = Math.sin(now / 260);
    tracked.halo.setRadius(9 + wave * 2.5);
    tracked.halo.setStyle({ fillOpacity: 0.18 + (wave + 1) * 0.06 });
    if (!tracked.expiring) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function drawTrailLeg(tracked, fromPos, toPos) {
  const line = L.polyline([fromPos, toPos], {
    pane: 'livePane', color: tracked.color, weight: 2.5, opacity: 0.55,
    interactive: false,
  }).addTo(liveTrailLayer);
  tracked.trails.push(line);
}

function animateNextLeg(packetId) {
  const tracked = liveTracked.get(packetId);
  if (!tracked || tracked.expiring) return;
  const stages = tracked.stages;

  // La posición de partida es siempre la última posición conocida en la
  // que el marcador se dibujó de verdad — nunca se recalcula desde una
  // etapa intermedia sin coordenadas, o el "salto" se perdía por completo.
  if (!tracked.lastPos) {
    tracked.lastPos = nodeLatLng(tracked.info.from) || stagePosition(stages[0]);
    if (!tracked.lastPos) return; // aún no hay ninguna posición conocida
  }

  // Avanza etapa a etapa hasta encontrar la siguiente con coordenadas
  // conocidas; las intermedias sin coordenadas se saltan sin animar pero
  // sin perder la posición de partida real.
  let toPos = null;
  while (tracked.legIndex < stages.length - 1) {
    toPos = stagePosition(stages[tracked.legIndex + 1]);
    tracked.legIndex++;
    if (toPos) break;
  }
  if (!toPos) return; // no queda ninguna etapa nueva con coordenadas

  const fromPos = tracked.lastPos;
  tracked.lastPos = toPos;

  ensureMarker(tracked, fromPos);

  const durationMs = 900;
  const start = performance.now();

  function step(now) {
    if (tracked.expiring) return;
    const t = Math.min(1, (now - start) / durationMs);
    const e = easeInOutQuad(t);
    const lat = fromPos[0] + (toPos[0] - fromPos[0]) * e;
    const lng = fromPos[1] + (toPos[1] - fromPos[1]) * e;
    tracked.marker.setLatLng([lat, lng]);
    tracked.halo.setLatLng([lat, lng]);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      drawTrailLeg(tracked, fromPos, toPos);
      if (tracked.legIndex < stages.length - 1) animateNextLeg(packetId);
    }
  }
  requestAnimationFrame(step);
}

function expirePacket(packetId) {
  const tracked = liveTracked.get(packetId);
  if (!tracked) return;
  tracked.expiring = true;
  liveTracked.delete(packetId);

  const layers = [...tracked.trails];
  if (tracked.marker) layers.push(tracked.marker);
  if (tracked.halo) layers.push(tracked.halo);
  if (!layers.length) return;

  const durationMs = 700;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const opacity = 1 - t;
    for (const l of layers) {
      if (l instanceof L.Polyline) l.setStyle({ opacity: opacity * 0.55 });
      else l.setStyle({ opacity, fillOpacity: opacity });
    }
    if (t < 1) requestAnimationFrame(step);
    else layers.forEach(l => (liveLayer.hasLayer(l) ? liveLayer : liveTrailLayer).removeLayer(l));
  }
  requestAnimationFrame(step);
}

// ─── Sidebar de paquetes ────────────────────────────────────────────────────

function addLogRow(event) {
  livePacketLog.set(event.packet_id, { info: event, stages: [], path_confidence: event.path_confidence });

  const empty = document.getElementById('live-log-empty');
  if (empty) empty.remove();

  const log = document.getElementById('live-log');
  const row = document.createElement('div');
  row.className = 'live-log-row';
  row.id = 'live-log-row-' + event.packet_id;
  row.innerHTML = renderLogRow(event, { hop_start: event.hop_start, hops: 0, path_confidence: event.path_confidence });
  row.addEventListener('click', () => openPacketDetail(event.packet_id));
  log.insertBefore(row, log.firstChild);

  while (log.children.length > LIVE_LOG_MAX) {
    const last = log.lastChild;
    const m = /^live-log-row-(\d+)$/.exec(last.id);
    if (m) livePacketLog.delete(Number(m[1]));
    log.removeChild(last);
  }
}

function updateLogRow(stageEvent) {
  const data = livePacketLog.get(stageEvent.packet_id);
  if (data) { data.stages = stageEvent.stages; data.path_confidence = stageEvent.path_confidence; }

  const row = document.getElementById('live-log-row-' + stageEvent.packet_id);
  if (!row) return;
  const tracked = liveTracked.get(stageEvent.packet_id);
  if (!tracked) return;
  row.innerHTML = renderLogRow(tracked.info, {
    hop_start: tracked.info.hop_start,
    hops: stageEvent.stages.length,
    path_confidence: stageEvent.path_confidence,
  });
}

function nodeLabel(nodeId) {
  if (!nodeId) return '?';
  if (nodeId === '!ffffffff') return 'Todos';
  const n = nodesById.get(nodeId);
  return n && n.long_name ? escHtml(n.long_name) : escHtml(nodeId);
}

function renderLogRow(info, { hops, path_confidence }) {
  const confClass = path_confidence === 'relay_node' ? 'lr-conf-relay' : 'lr-conf-heuristic';
  const confLabel = path_confidence === 'relay_node' ? 'ruta confirmada' : 'ruta aproximada';
  const color = packetColor(info.packet_id);
  return `
    <div class="lr-route"><span class="lr-swatch" style="background:${color};box-shadow:0 0 5px ${color}"></span>${nodeLabel(info.from)} → ${nodeLabel(info.to)}</div>
    <div class="lr-meta">
      <span>${hops} salto${hops === 1 ? '' : 's'}</span>
      <span>${escHtml(info.portnum || '—')}</span>
      <span class="${confClass}">${confLabel}</span>
    </div>`;
}

// ─── Desglose de paquete ────────────────────────────────────────────────────

function formatTime(unixSeconds) {
  if (!unixSeconds) return '—';
  return new Date(unixSeconds * 1000).toLocaleTimeString('es-ES');
}

function nodeLabelFull(nodeId) {
  if (!nodeId) return '—';
  if (nodeId === '!ffffffff') return 'Todos (broadcast)';
  const n = nodesById.get(nodeId);
  return n && n.long_name
    ? `${escHtml(n.long_name)} (${escHtml(n.short_name || '')}) — ${escHtml(nodeId)}`
    : escHtml(nodeId);
}

function renderPacketDetail(packetId) {
  const data = livePacketLog.get(packetId);
  if (!data) return '<p class="malconfig-empty">Sin datos de este paquete (se ha perdido del historial).</p>';
  const { info, stages, path_confidence } = data;
  const confLabel = path_confidence === 'relay_node'
    ? 'Ruta confirmada — al menos una etapa trae el nodo real que retransmitió (relay_node)'
    : 'Ruta aproximada — estimada por qué gateways oyeron cada etapa, sin relay_node';

  const stagesRows = stages.length
    ? stages.map((s, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${s.hop_limit}</td>
        <td>${s.gateway_ids.map(nodeLabel).join(', ')}</td>
        <td>${s.relay_node ? nodeLabel(s.relay_node) : '—'}</td>
        <td>${formatTime(s.rx_time)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5">Sin etapas con coordenadas conocidas todavía</td></tr>';

  return `
    <table class="malconfig-table">
      <tr><td>Packet ID</td><td>${info.packet_id}</td></tr>
      <tr><td>Origen</td><td>${nodeLabelFull(info.from)}</td></tr>
      <tr><td>Destino</td><td>${nodeLabelFull(info.to)}</td></tr>
      <tr><td>hop_start</td><td>${info.hop_start ?? '—'}</td></tr>
      <tr><td>Canal</td><td>${info.channel ?? '—'}</td></tr>
      <tr><td>Tipo (portnum)</td><td>${escHtml(info.portnum || '—')}</td></tr>
      <tr><td>Confianza de ruta</td><td>${confLabel}</td></tr>
    </table>
    <h4 style="margin:16px 0 8px;font-size:12px;color:var(--muted);font-family:var(--mono)">Etapas detectadas (${stages.length})</h4>
    <table class="malconfig-table">
      <thead><tr><th>#</th><th>hop_limit</th><th>Gateways que la oyeron</th><th>relay_node</th><th>Hora</th></tr></thead>
      <tbody>${stagesRows}</tbody>
    </table>`;
}

// ─── Mini-mapa del desglose ─────────────────────────────────────────────────

let detailMap = null;
let detailMapLayer = null;

function buildPacketPath(data) {
  // Mismo criterio que animateNextLeg: solo puntos con coordenadas
  // conocidas, en orden — origen y luego cada etapa que sí resolvimos.
  const points = [];
  const originPos = nodeLatLng(data.info.from);
  if (originPos) points.push({ pos: originPos, label: `${nodeLabel(data.info.from)} (origen)` });
  for (const stage of data.stages) {
    const pos = stagePosition(stage);
    if (pos) {
      points.push({ pos, label: `hop_limit ${stage.hop_limit} — ${stage.gateway_ids.map(nodeLabel).join(', ')}` });
    }
  }
  return points;
}

function renderDetailMiniMap(packetId) {
  if (!detailMap) {
    detailMap = L.map('packet-detail-map', {
      zoomControl: false,
      attributionControl: false,
      scrollWheelZoom: false,
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(detailMap);
    detailMapLayer = L.layerGroup().addTo(detailMap);
  }
  detailMapLayer.clearLayers();

  const data = livePacketLog.get(packetId);
  const points = data ? buildPacketPath(data) : [];

  if (!points.length) {
    detailMap.setView([MAP_LAT, MAP_LNG], MAP_ZOOM);
    return;
  }

  const color = packetColor(packetId);
  const latlngs = points.map(p => p.pos);
  L.polyline(latlngs, { color, weight: 3, opacity: 0.8 }).addTo(detailMapLayer);
  points.forEach((p, i) => {
    L.circleMarker(p.pos, {
      radius: i === 0 ? 7 : 5,
      color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 1,
    }).bindTooltip(p.label, { direction: 'top' }).addTo(detailMapLayer);
  });

  if (latlngs.length === 1) {
    detailMap.setView(latlngs[0], 13);
  } else {
    detailMap.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24] });
  }
}

function openPacketDetail(packetId) {
  document.getElementById('packet-detail-tables').innerHTML = renderPacketDetail(packetId);
  document.getElementById('packet-detail-modal').classList.add('open');
  renderDetailMiniMap(packetId);
  // El modal acaba de hacerse visible — Leaflet necesita recalcular el
  // tamaño del contenedor una vez el navegador aplique el nuevo layout.
  setTimeout(() => { if (detailMap) detailMap.invalidateSize(); }, 60);
}

function closePacketDetail() {
  document.getElementById('packet-detail-modal').classList.remove('open');
}

// ─── Boot ───────────────────────────────────────────────────────────────────

function toggleLiveLogPanel() {
  document.getElementById('live-log').classList.toggle('open');
  document.getElementById('live-log-toggle-btn').classList.toggle('active');
}

function togglePause() {
  livePaused = !livePaused;
  const btn = document.getElementById('live-pause-btn');
  const icon = document.getElementById('pause-icon');
  btn.classList.toggle('paused', livePaused);
  document.getElementById('pause-label').textContent = livePaused ? 'Reanudar' : 'Pausar';
  icon.innerHTML = livePaused
    ? '<path d="M4 3l9 5-9 5V3z" fill="currentColor"/>'
    : '<rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor"/>';
}

async function bootLive() {
  try {
    const cfg = await fetch(API_BASE + '/data/config.json?t=' + Date.now()).then(r => r.ok ? r.json() : {});
    if (cfg.map_lat) MAP_LAT = cfg.map_lat;
    if (cfg.map_lng) MAP_LNG = cfg.map_lng;
    if (cfg.map_zoom) MAP_ZOOM = cfg.map_zoom;
  } catch { /* config.json es opcional aquí, se usan los valores por defecto */ }

  initLiveMap();
  try { await loadNodes(); } catch (e) { console.error(e); }
  connectLive();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePacketDetail();
  });
}

document.addEventListener('DOMContentLoaded', bootLive);
