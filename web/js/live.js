// ─── Feed en vivo: MQTT → WebSocket → animación en el mapa ─────────────────────

let liveTracked = new Map();  // packet_id → { stages: [], marker, legIndex }
let liveLayer;                // L.layerGroup de marcadores animados
let liveNodeLayer;            // L.layerGroup de puntos base de nodos
let liveWs = null;
let liveBackoffMs = 1000;
const LIVE_BACKOFF_MAX_MS = 30000;
const LIVE_LOG_MAX = 200;

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

  liveLayer = L.layerGroup().addTo(map);
  liveNodeLayer = L.layerGroup().addTo(map);
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
    liveTracked.set(event.packet_id, { info: event, stages: [], legIndex: 0, marker: null });
    addLogRow(event);
  } else if (event.type === 'packet_stage') {
    const tracked = liveTracked.get(event.packet_id);
    if (!tracked) return;
    const hadStages = tracked.stages.length;
    tracked.stages = event.stages;
    updateLogRow(event);
    if (event.stages.length > hadStages) animateNextLeg(event.packet_id);
  } else if (event.type === 'packet_expired') {
    const tracked = liveTracked.get(event.packet_id);
    if (tracked && tracked.marker) liveLayer.removeLayer(tracked.marker);
    liveTracked.delete(event.packet_id);
  }
}

function stagePosition(stage) {
  // Varios gateways pueden compartir etapa (oyeron la misma transmisión) —
  // se usa el primero como posición representativa.
  const gw = stage.gateway_ids[0];
  return gw ? nodeLatLng(gw) : null;
}

function animateNextLeg(packetId) {
  const tracked = liveTracked.get(packetId);
  if (!tracked) return;
  const stages = tracked.stages;
  if (tracked.legIndex >= stages.length - 1) return; // nada nuevo que animar aún

  const fromPos = tracked.legIndex === 0
    ? (nodeLatLng(tracked.info.from) || stagePosition(stages[0]))
    : stagePosition(stages[tracked.legIndex]);
  const toPos = stagePosition(stages[tracked.legIndex + 1]);
  tracked.legIndex++;

  if (!fromPos || !toPos) { animateNextLeg(packetId); return; } // sin coords, salta a la siguiente etapa

  if (!tracked.marker) {
    tracked.marker = L.circleMarker(fromPos, {
      pane: 'livePane',
      radius: 5,
      color: '#ef4444',
      weight: 2,
      fillColor: '#fbbf24',
      fillOpacity: 0.9,
      interactive: false,
    }).addTo(liveLayer);
  }

  const durationMs = 800;
  const start = performance.now();

  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const lat = fromPos[0] + (toPos[0] - fromPos[0]) * t;
    const lng = fromPos[1] + (toPos[1] - fromPos[1]) * t;
    if (tracked.marker) tracked.marker.setLatLng([lat, lng]);
    if (t < 1) {
      requestAnimationFrame(step);
    } else if (tracked.legIndex < stages.length - 1) {
      animateNextLeg(packetId);
    }
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
  return `
    <div class="lr-route">${nodeLabel(info.from)} → ${nodeLabel(info.to)}</div>
    <div class="lr-meta">
      <span>${hops} etapa${hops === 1 ? '' : 's'}</span>
      <span>${escHtml(info.portnum || '—')}</span>
      <span class="${confClass}">${confLabel}</span>
    </div>`;
}

// ─── Boot ───────────────────────────────────────────────────────────────────

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
