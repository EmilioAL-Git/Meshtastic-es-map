// ─── Feed en vivo: MQTT → WebSocket → animación en el mapa ─────────────────────

let liveTracked = new Map();  // packet_id → { info, stages, legIndex, marker, halo, trails, color, expiring }
let liveLayer;                // L.layerGroup de marcadores/halos animados
let liveTrailLayer;           // L.layerGroup de las líneas de recorrido (por debajo de los marcadores)
let livePingLayer;            // L.layerGroup de los pings de origen
let liveNodeLayer;            // L.layerGroup de puntos base de nodos
let liveWs = null;
let liveBackoffMs = 1000;
const LIVE_BACKOFF_MAX_MS = 30000;
const LIVE_LOG_MAX = 200;

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
  // se usa el primero como posición representativa.
  const gw = stage.gateway_ids[0];
  return gw ? nodeLatLng(gw) : null;
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
    fillColor: tracked.color, fillOpacity: 1, interactive: false,
  }).addTo(liveLayer);
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
  if (tracked.legIndex >= stages.length - 1) return; // nada nuevo que animar aún

  const fromPos = tracked.legIndex === 0
    ? (nodeLatLng(tracked.info.from) || stagePosition(stages[0]))
    : stagePosition(stages[tracked.legIndex]);
  const toPos = stagePosition(stages[tracked.legIndex + 1]);
  tracked.legIndex++;

  if (!fromPos || !toPos) { animateNextLeg(packetId); return; } // sin coords, salta a la siguiente etapa

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
  const empty = document.getElementById('live-log-empty');
  if (empty) empty.remove();

  const log = document.getElementById('live-log');
  const row = document.createElement('div');
  row.className = 'live-log-row';
  row.id = 'live-log-row-' + event.packet_id;
  row.innerHTML = renderLogRow(event, { hop_start: event.hop_start, hops: 0, path_confidence: event.path_confidence });
  log.insertBefore(row, log.firstChild);

  while (log.children.length > LIVE_LOG_MAX) log.removeChild(log.lastChild);
}

function updateLogRow(stageEvent) {
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
  return n && n.short_name ? `${escHtml(n.short_name)}` : escHtml(nodeId);
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

// ─── Boot ───────────────────────────────────────────────────────────────────

function toggleLiveLogPanel() {
  document.getElementById('live-log').classList.toggle('open');
  document.getElementById('live-log-toggle-btn').classList.toggle('active');
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
}

document.addEventListener('DOMContentLoaded', bootLive);
