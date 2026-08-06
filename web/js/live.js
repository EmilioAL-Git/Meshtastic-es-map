// ─── Feed en vivo: MQTT → WebSocket → animación en el mapa ─────────────────────

let liveTracked = new Map();  // packet_id → { info, stages, legIndex, marker, halo, trails, color, expiring }
let liveLayer;                // L.layerGroup de marcadores/halos animados
let liveTrailLayer;           // L.layerGroup de las líneas de recorrido (por debajo de los marcadores)
let livePingLayer;            // L.layerGroup de los pings de origen
let liveNodeLayer;            // L.layerGroup de puntos base de nodos
let liveWs = null;
let liveBackoffMs = 1000;
let livePaused = false;
let liveFocusNodeId = null;   // !xxxxxxxx del nodo enfocado, o null (sin filtro)
let liveFocusLayer;           // L.layerGroup con el resaltado del nodo enfocado
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
  liveFocusLayer = L.layerGroup().addTo(map);
}

function renderBaseNodes(dim) {
  liveNodeLayer.clearLayers();
  const color = dim ? '#334155' : C_OLD;
  for (const n of allNodes) {
    if (n.latitude == null || n.longitude == null) continue;
    if (dim && n.node_id === liveFocusNodeId) continue; // ya tiene su propio resaltado
    L.circleMarker([n.latitude, n.longitude], {
      pane: 'livePane',
      radius: 3,
      color,
      weight: 1,
      fillColor: color,
      fillOpacity: dim ? 0.35 : 0.6,
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
    if (liveFocusNodeId && event.from !== liveFocusNodeId && event.to !== liveFocusNodeId) return;
    liveTracked.set(event.packet_id, {
      info: event, stages: [], legIndex: 0,
      marker: null, halo: null, trails: [],
      color: packetColor(event.packet_id),
      expiring: false, animating: false,
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
  // tracked.animating evita lanzar dos animaciones a la vez sobre el mismo
  // marcador si llega una nueva etapa mientras el tramo anterior aún se
  // está moviendo — si no, ambas escriben setLatLng() cada frame y el
  // punto se ve "pasarse" de sitio, pisándose entre sí. El propio step()
  // encadena la siguiente etapa pendiente al terminar, así que aquí basta
  // con no hacer nada y dejar que continúe cuando le toque.
  if (!tracked || tracked.expiring || tracked.animating) return;
  const stages = tracked.stages;

  // La posición de partida es siempre la última posición conocida en la
  // que el marcador se dibujó de verdad — nunca se recalcula desde una
  // etapa intermedia sin coordenadas, o el "salto" se perdía por completo.
  // legIndex arranca en -1 cuando el origen es conocido para que stages[0]
  // siga contando como un tramo real (si no, se saltaba y el mini-mapa del
  // desglose — que sí usa todas las etapas vía buildPacketPath — no
  // coincidía con lo animado aquí).
  if (!tracked.lastPos) {
    const originPos = nodeLatLng(tracked.info.from);
    if (originPos) {
      tracked.lastPos = originPos;
      tracked.legIndex = -1;
    } else {
      const firstPos = stagePosition(stages[0]);
      if (!firstPos) return; // aún no hay ninguna posición conocida
      tracked.lastPos = firstPos;
      tracked.legIndex = 0; // ya "empezamos" en stages[0], no se re-anima hacia él
    }
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
  tracked.animating = true;

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
      tracked.animating = false;
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

  // En Modo Focus las líneas se quedan como historial permanente de la
  // sesión — solo se desvanece el punto animado, no la ruta ya trazada.
  const layers = liveFocusNodeId ? [] : [...tracked.trails];
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

// ─── Modo Focus: filtrar el feed a un solo nodo ─────────────────────────────

function onFocusInput() {
  const q = document.getElementById('focus-input').value.trim().toLowerCase();
  const dd = document.getElementById('focus-dropdown');
  searchIndex = -1;

  if (!q) { dd.classList.remove('open'); return; }

  const results = allNodes.filter(n => {
    const longName = (n.long_name || '').toLowerCase();
    const shortName = (n.short_name || '').toLowerCase();
    const id = (n.node_id || '').toLowerCase();
    return longName.includes(q) || shortName.includes(q) || id.includes(q);
  }).slice(0, 8);

  if (!results.length) {
    dd.innerHTML = '<div class="search-no-results">Sin resultados</div>';
    dd.classList.add('open');
    return;
  }

  dd.innerHTML = results.map(n => `
    <div class="search-result" data-id="${escHtml(n.node_id)}">
      <div class="result-name">${escHtml(n.long_name || n.short_name || n.node_id)}</div>
      <div class="result-meta">${escHtml(n.node_id)}</div>
    </div>`).join('');

  dd.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('mousedown', () => setFocusNode(el.dataset.id));
  });

  dd.classList.add('open');
}

function onFocusKey(e) {
  const dd = document.getElementById('focus-dropdown');
  const items = dd.querySelectorAll('.search-result');
  if (!dd.classList.contains('open') || !items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchIndex = Math.min(searchIndex + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchIndex = Math.max(searchIndex - 1, 0);
  } else if (e.key === 'Enter' && searchIndex >= 0) {
    e.preventDefault();
    setFocusNode(items[searchIndex].dataset.id);
  } else if (e.key === 'Escape') {
    dd.classList.remove('open');
    searchIndex = -1;
    return;
  }
  items.forEach((el, i) => el.classList.toggle('active', i === searchIndex));
}

function resetLiveState() {
  // Limpia todo lo que había en vuelo/en la lista — al enfocar un nodo
  // queremos partir de cero, sin ruido de paquetes que ya no interesan.
  for (const tracked of liveTracked.values()) {
    if (tracked.marker) liveLayer.removeLayer(tracked.marker);
    if (tracked.halo) liveLayer.removeLayer(tracked.halo);
    tracked.trails.forEach(l => liveTrailLayer.removeLayer(l));
  }
  liveTracked.clear();
  livePacketLog.clear();
  document.getElementById('live-log').innerHTML = '<div class="live-log-empty" id="live-log-empty">Esperando paquetes…</div>';
}

function updateFocusHighlight() {
  liveFocusLayer.clearLayers();
  if (!liveFocusNodeId) return;
  const pos = nodeLatLng(liveFocusNodeId);
  if (!pos) return;
  L.circleMarker(pos, {
    pane: 'livePane', radius: 12, color: '#5eead4', weight: 2,
    fillColor: '#5eead4', fillOpacity: 0.12, interactive: false,
  }).addTo(liveFocusLayer);
  L.circleMarker(pos, {
    pane: 'livePane', radius: 6, color: '#fff', weight: 1.5,
    fillColor: '#5eead4', fillOpacity: 1, interactive: false,
  }).addTo(liveFocusLayer);
}

function setFocusNode(nodeId) {
  liveFocusNodeId = nodeId;
  const input = document.getElementById('focus-input');
  input.value = nodeLabel(nodeId);
  document.getElementById('focus-dropdown').classList.remove('open');
  document.getElementById('focus-clear-btn').style.display = '';
  document.getElementById('focus-wrap').classList.add('active');

  resetLiveState();
  updateFocusHighlight();
  renderBaseNodes(true); // resto de nodos, atenuados — el enfocado ya destaca con su halo

  const pos = nodeLatLng(nodeId);
  if (pos) map.setView(pos, Math.max(map.getZoom(), 11));
}

function clearFocus() {
  liveFocusNodeId = null;
  document.getElementById('focus-input').value = '';
  document.getElementById('focus-clear-btn').style.display = 'none';
  document.getElementById('focus-wrap').classList.remove('active');
  document.getElementById('focus-dropdown').classList.remove('open');
  liveFocusLayer.clearLayers();
  renderBaseNodes(); // restaura el brillo normal del resto de nodos, sin tocar lo demás
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
    if (e.key !== 'Escape') return;
    closePacketDetail();
    document.getElementById('focus-dropdown').classList.remove('open');
  });

  document.addEventListener('click', (e) => {
    if (!document.getElementById('focus-wrap').contains(e.target)) {
      document.getElementById('focus-dropdown').classList.remove('open');
    }
  });
}

document.addEventListener('DOMContentLoaded', bootLive);
