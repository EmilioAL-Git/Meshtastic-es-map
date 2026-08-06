// ─── Feed en directo: MQTT → WebSocket → animación en el mapa ─────────────────────

let liveTracked = new Map();  // packet_id → { info, stages, legIndex, marker, halo, trails, color, expiring }
let liveLayer;                // L.layerGroup de marcadores/halos animados
let liveTrailLayer;           // L.layerGroup de las líneas de recorrido (por debajo de los marcadores)
let liveSiblingLayer;         // L.layerGroup de las líneas de "mismo salto oído por varios gateways"
let livePingLayer;            // L.layerGroup de los pings de origen
let liveNodeLayer;            // L.layerGroup de puntos base de nodos
let liveWs = null;
let liveBackoffMs = 1000;
let livePaused = false;
let liveFocusNodeId = null;   // !xxxxxxxx del nodo enfocado, o null (sin filtro)
let liveFocusLayer;           // L.layerGroup con el resaltado del nodo enfocado
let currentDetailPacketId = null; // packet_id del desglose abierto ahora mismo, o null
const LIVE_BACKOFF_MAX_MS = 30000;
const LIVE_LOG_MAX = 200;

// ─── Filtro por tipo de paquete ─────────────────────────────────────────────
const PORTNUM_CATEGORIES = {
  TEXT_MESSAGE_APP: 'text',
  POSITION_APP: 'position',
  NODEINFO_APP: 'nodeinfo',
  TELEMETRY_APP: 'telemetry',
};
function portnumCategory(portnum) {
  if (!portnum) return 'other';
  if (portnum === 'ENCRYPTED') return 'encrypted';
  return PORTNUM_CATEGORIES[portnum] || 'other';
}
let activePortnumFilters = new Set(['position', 'text', 'telemetry', 'nodeinfo', 'encrypted', 'other']);

function togglePortnumFilter(cat) {
  if (activePortnumFilters.has(cat)) activePortnumFilters.delete(cat);
  else activePortnumFilters.add(cat);
  const btn = document.querySelector(`#portnum-filter-group [data-cat="${cat}"]`);
  if (btn) btn.classList.toggle('active', activePortnumFilters.has(cat));
}

// ─── Contador de actividad por nodo (ranking de la sesión) ─────────────────
let nodeActivityCount = new Map(); // node_id → nº de paquetes vistos como origen

function recordNodeActivity(nodeId) {
  if (!nodeId || nodeId === '!ffffffff') return;
  nodeActivityCount.set(nodeId, (nodeActivityCount.get(nodeId) || 0) + 1);
}

function renderTopNodes() {
  const el = document.getElementById('live-log-top');
  if (!el) return;
  const top = [...nodeActivityCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!top.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="lt-title">Más activos en esta sesión</div>
    ${top.map(([id, count], i) => `
      <div class="lt-row">
        <span class="lt-rank">${i + 1}</span>
        <span class="lt-name">${nodeLabel(id)}</span>
        <span class="lt-count">${count}</span>
      </div>`).join('')}`;
}

// Solo se dibujan en el mapa los últimos MAX_VISIBLE_PACKETS paquetes — el
// que se sale de esa ventana arranca una cuenta atrás de TRAIL_GRACE_MS
// antes de desvanecerse, en vez de desaparecer de golpe.
// OJO con subir mucho este valor: con tráfico alto (red EU_868 entera,
// no solo España) entran paquetes nuevos constantemente, así que durante
// la cuenta atrás se siguen acumulando más — el "límite de 20" deja de
// notarse porque en la práctica hay 20 + (todos los que cayeron en los
// últimos TRAIL_GRACE_MS) a la vez en el mapa.
let liveOrder = [];                      // packet_id en orden de llegada (packet_new)
const pendingTrailRemovals = new Map();  // packet_id → timeoutId
const MAX_VISIBLE_PACKETS = 20;
const TRAIL_GRACE_MS = 5000;

// packet_id → { info, stages, path_confidence } — historial persistente
// para el desglose, independiente del ciclo de vida de la animación
// (liveTracked se borra al expirar; esto se conserva mientras la fila
// siga en la lista, hasta LIVE_LOG_MAX).
let livePacketLog = new Map();

// ─── Exportar la sesión ─────────────────────────────────────────────────────
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportSessionJSON() {
  if (!livePacketLog.size) { showToast('No hay paquetes en la sesión todavía'); return; }
  const packets = [...livePacketLog.values()];
  downloadFile(`meshtastic-live-${Date.now()}.json`, JSON.stringify(packets, null, 2), 'application/json');
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportSessionCSV() {
  if (!livePacketLog.size) { showToast('No hay paquetes en la sesión todavía'); return; }
  const header = ['packet_id', 'from', 'to', 'hop_start', 'channel', 'portnum', 'text', 'path_confidence', 'saltos'];
  const lines = [header.join(',')];
  for (const { info, stages, path_confidence } of livePacketLog.values()) {
    lines.push([
      info.packet_id, info.from, info.to, info.hop_start,
      info.channel, info.portnum, info.text, path_confidence, stages.length,
    ].map(csvCell).join(','));
  }
  downloadFile(`meshtastic-live-${Date.now()}.csv`, lines.join('\n'), 'text/csv');
}

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

// El selector de velocidad de la reproducción histórica (0.25x…5x) solo debe
// ralentizar la animación del paquete moviéndose por el mapa, nunca
// acelerarla — a >1x el paquete seguiría viajando a su ritmo visual normal,
// solo se reproducen más rápido los huecos de espera entre paquetes
// (ver runNextReplayEvent). Fuera de la reproducción histórica siempre 1x.
function packetAnimSlowdown() {
  return inReplayView ? Math.max(1, 1 / replaySpeed) : 1;
}

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

  // bottom-right lo ocupan la leyenda y la barra de línea de tiempo.
  map.attributionControl.setPosition('bottomleft');

  map.createPane('livePane');
  map.getPane('livePane').style.zIndex = 460;

  liveNodeLayer = L.layerGroup().addTo(map);
  liveTrailLayer = L.layerGroup().addTo(map);
  liveSiblingLayer = L.layerGroup().addTo(map);
  liveLayer = L.layerGroup().addTo(map);
  livePingLayer = L.layerGroup().addTo(map);
  liveFocusLayer = L.layerGroup().addTo(map);

  applyAllLiveLayerVisibility();
}

function nodeTooltipHtml(n) {
  const name = escHtml(n.long_name || n.short_name || n.node_id);
  const sub = [n.short_name, n.node_id].filter(Boolean).map(escHtml).join(' · ');
  const meta = [n.role, n.hardware].filter(Boolean).map(escHtml).join(' · ');
  return `<div class="node-tooltip"><strong>${name}</strong>${sub ? `<br>${sub}` : ''}${meta ? `<br>${meta}` : ''}</div>`;
}

function renderBaseNodes() {
  liveNodeLayer.clearLayers();
  for (const n of allNodes) {
    if (n.latitude == null || n.longitude == null) continue;
    if (n.node_id === liveFocusNodeId) continue; // ya tiene su propio resaltado
    L.circleMarker([n.latitude, n.longitude], {
      pane: 'livePane',
      radius: 2,
      weight: 0,
      fillColor: C_OLD,
      fillOpacity: 0.45,
      interactive: true,
    }).bindTooltip(nodeTooltipHtml(n), { direction: 'top', offset: [0, -3] })
      .addTo(liveNodeLayer);
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

function enforceLiveWindow() {
  while (liveOrder.length > MAX_VISIBLE_PACKETS) {
    const oldId = liveOrder.shift();
    if (pendingTrailRemovals.has(oldId) || !liveTracked.has(oldId)) continue;
    const timer = setTimeout(() => {
      pendingTrailRemovals.delete(oldId);
      expirePacket(oldId);
    }, TRAIL_GRACE_MS);
    pendingTrailRemovals.set(oldId, timer);
  }
}

function handleLiveEvent(event) {
  if (event.type === 'packet_new') {
    if (liveFocusNodeId && event.from !== liveFocusNodeId && event.to !== liveFocusNodeId) return;
    if (!activePortnumFilters.has(portnumCategory(event.portnum))) return;
    liveTracked.set(event.packet_id, {
      info: event, stages: [], legIndex: 0,
      marker: null, halo: null, trails: [],
      color: packetColor(event.packet_id),
      expiring: false, animating: false,
    });
    liveOrder.push(event.packet_id);
    enforceLiveWindow();
    addLogRow(event);
    spawnOriginPing(event);
    if (!inReplayView) { recordNodeActivity(event.from); renderTopNodes(); }
    if (soundEnabled && liveFocusNodeId && !inReplayView) playAlertBeep();
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

function stageSiblingLines(stage) {
  // Cuando una misma etapa la oyen varios gateways a la vez, no solo se
  // anima hacia el representativo (stagePosition) — también se traza un
  // pequeño abanico hacia los demás que conozcamos, para que se vea que el
  // paquete "salió por varios sitios" en ese salto. Usada tanto por el mapa
  // grande como por el mini-mapa del desglose, para que no diverjan.
  const positions = stage.gateway_ids.map(nodeLatLng).filter(Boolean);
  if (positions.length < 2) return [];
  const [rep, ...rest] = positions;
  return rest.map(pos => [rep, pos]);
}

function spawnOriginPing(event) {
  const pos = nodeLatLng(event.from);
  if (!pos) return;
  const color = packetColor(event.packet_id);
  const ring = L.circleMarker(pos, {
    pane: 'livePane', radius: 6, color, weight: 2,
    fillOpacity: 0, interactive: false,
  }).addTo(livePingLayer);

  const durationMs = 900 * packetAnimSlowdown();
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

function drawStageSiblingLines(tracked, stage) {
  for (const [a, b] of stageSiblingLines(stage)) {
    const line = L.polyline([a, b], {
      pane: 'livePane', color: tracked.color, weight: 1.5, opacity: 0.35,
      dashArray: '3 4', interactive: false,
    }).addTo(liveSiblingLayer);
    tracked.trails.push(line);
  }
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
  drawStageSiblingLines(tracked, stages[tracked.legIndex]);

  ensureMarker(tracked, fromPos);
  tracked.animating = true;

  const durationMs = 900 * packetAnimSlowdown();
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
  const timer = pendingTrailRemovals.get(packetId);
  if (timer) { clearTimeout(timer); pendingTrailRemovals.delete(packetId); }
  const orderIdx = liveOrder.indexOf(packetId);
  if (orderIdx !== -1) liveOrder.splice(orderIdx, 1);

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
    else layers.forEach(l => {
      const owner = liveLayer.hasLayer(l) ? liveLayer
        : liveSiblingLayer.hasLayer(l) ? liveSiblingLayer
        : liveTrailLayer;
      owner.removeLayer(l);
    });
  }
  requestAnimationFrame(step);
}

// ─── Sidebar de paquetes ────────────────────────────────────────────────────

function addLogRow(event) {
  livePacketLog.set(event.packet_id, { info: event, stages: [], path_confidence: event.path_confidence });

  const empty = document.getElementById('live-log-empty');
  if (empty) empty.remove();

  const log = document.getElementById('live-log-rows');
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
  const textHtml = info.text
    ? `<div class="lr-text">💬 “${escHtml(info.text)}”</div>`
    : '';
  return `
    <div class="lr-route"><span class="lr-swatch" style="background:${color};box-shadow:0 0 5px ${color}"></span>${nodeLabel(info.from)} → ${nodeLabel(info.to)}</div>
    ${textHtml}
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
    ? 'Ruta confirmada — al menos un salto trae el nodo real que retransmitió (relay_node)'
    : 'Ruta aproximada — estimada por qué gateways oyeron cada salto, sin relay_node';

  const hopsHtml = stages.length
    ? stages.map((s, i) => `
      <div class="pkt-hop">
        <div class="pkt-hop-num">${i + 1}</div>
        <div class="pkt-hop-body">
          <div class="pkt-hop-meta">
            <span>hop_limit ${s.hop_limit}</span>
            <span>${formatTime(s.rx_time)}</span>
          </div>
          <div class="pkt-hop-gateways">
            ${s.gateway_ids.map(gw => `<span class="pkt-gw-chip${gw === s.relay_node ? ' relay' : ''}">${gw === s.relay_node ? '🔗 ' : ''}${nodeLabel(gw)}</span>`).join('')}
            ${s.relay_node && !s.gateway_ids.includes(s.relay_node) ? `<span class="pkt-gw-chip relay">🔗 ${nodeLabel(s.relay_node)}</span>` : ''}
          </div>
        </div>
      </div>`).join('')
    : '<p class="pkt-hop-empty">Sin saltos con coordenadas conocidas todavía</p>';

  const textRow = info.text
    ? `<tr><td>Mensaje</td><td>💬 “${escHtml(info.text)}”</td></tr>`
    : '';

  return `
    <table class="malconfig-table pkt-kv">
      <tr><td>Packet ID</td><td>${info.packet_id}</td></tr>
      <tr><td>Origen</td><td>${nodeLabelFull(info.from)}</td></tr>
      <tr><td>Destino</td><td>${nodeLabelFull(info.to)}</td></tr>
      <tr><td>hop_start</td><td>${info.hop_start ?? '—'}</td></tr>
      <tr><td>Canal</td><td>${info.channel ?? '—'}</td></tr>
      <tr><td>Tipo (portnum)</td><td>${escHtml(info.portnum || '—')}</td></tr>
      ${textRow}
      <tr><td>Confianza de ruta</td><td>${confLabel}</td></tr>
    </table>
    <h4 class="pkt-hops-title">
      Saltos detectados (${stages.length})
      <span class="pkt-hops-hint">🔗 = relay_node confirmado en ese salto</span>
    </h4>
    <div class="pkt-hops">${hopsHtml}</div>`;
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
      zoomControl: true,
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
  const allPositions = [...latlngs];
  L.polyline(latlngs, { color, weight: 3, opacity: 0.8 }).addTo(detailMapLayer);
  for (const stage of data.stages) {
    for (const [a, b] of stageSiblingLines(stage)) {
      L.polyline([a, b], { color, weight: 1.5, opacity: 0.45, dashArray: '3 4' }).addTo(detailMapLayer);
      L.circleMarker(b, {
        radius: 4, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.7,
      }).bindTooltip(`hop_limit ${stage.hop_limit} — también oído aquí`, { direction: 'top' }).addTo(detailMapLayer);
      allPositions.push(b);
    }
  }
  points.forEach((p, i) => {
    L.circleMarker(p.pos, {
      radius: i === 0 ? 7 : 5,
      color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 1,
    }).bindTooltip(p.label, { direction: 'top' }).addTo(detailMapLayer);
  });

  if (allPositions.length === 1) {
    detailMap.setView(allPositions[0], 13);
  } else {
    detailMap.fitBounds(L.latLngBounds(allPositions), { padding: [24, 24] });
  }
}

function openPacketDetail(packetId) {
  currentDetailPacketId = packetId;
  document.getElementById('packet-detail-tables').innerHTML = renderPacketDetail(packetId);
  document.getElementById('packet-detail-modal').classList.add('open');
  renderDetailMiniMap(packetId);
  // El modal acaba de hacerse visible — Leaflet necesita recalcular el
  // tamaño del contenedor una vez el navegador aplique el nuevo layout.
  setTimeout(() => { if (detailMap) detailMap.invalidateSize(); }, 60);
  syncUrl();
}

function closePacketDetail() {
  currentDetailPacketId = null;
  document.getElementById('packet-detail-modal').classList.remove('open');
  syncUrl();
}

// ─── Enlaces compartibles (?focus=, ?packet=) ───────────────────────────────

function syncUrl() {
  const params = new URLSearchParams();
  if (liveFocusNodeId) params.set('focus', liveFocusNodeId);
  if (currentDetailPacketId) params.set('packet', currentDetailPacketId);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function showToast(msg, ms = 3000) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

async function copyCurrentLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('Enlace copiado');
  } catch {
    showToast('No se pudo copiar — usa la barra de direcciones');
  }
}

async function loadSharedPacket(rawId) {
  const packetId = Number(rawId);
  if (!Number.isFinite(packetId)) return;
  try {
    const r = await fetch(`${API_BASE}/live-ws/packet/${packetId}`);
    if (!r.ok) { showToast('Ese paquete ya no está disponible (caducó)'); return; }
    const data = await r.json();
    livePacketLog.set(data.packet_id, {
      info: {
        packet_id: data.packet_id, from: data.from, to: data.to,
        hop_start: data.hop_start, channel: data.channel, portnum: data.portnum,
        text: data.text,
      },
      stages: data.stages,
      path_confidence: data.path_confidence,
    });
    openPacketDetail(data.packet_id);
  } catch {
    showToast('No se pudo cargar el paquete compartido');
  }
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
    tracked.trails.forEach(l => { liveTrailLayer.removeLayer(l); liveSiblingLayer.removeLayer(l); });
  }
  liveTracked.clear();
  livePacketLog.clear();
  for (const timer of pendingTrailRemovals.values()) clearTimeout(timer);
  pendingTrailRemovals.clear();
  liveOrder = [];
  document.getElementById('live-log-rows').innerHTML = '<div class="live-log-empty" id="live-log-empty">Esperando paquetes…</div>';
  nodeActivityCount.clear();
  renderTopNodes();
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
  document.getElementById('focus-sound-btn').style.display = '';
  document.getElementById('focus-wrap').classList.add('active');

  resetLiveState();
  updateFocusHighlight();
  renderBaseNodes(); // el nodo enfocado se excluye solo (ya tiene su propio halo)

  const pos = nodeLatLng(nodeId);
  if (pos) map.setView(pos, Math.max(map.getZoom(), 11));
  syncUrl();
}

function clearFocus() {
  liveFocusNodeId = null;
  document.getElementById('focus-input').value = '';
  document.getElementById('focus-clear-btn').style.display = 'none';
  document.getElementById('focus-sound-btn').style.display = 'none';
  document.getElementById('focus-wrap').classList.remove('active');
  document.getElementById('focus-dropdown').classList.remove('open');
  liveFocusLayer.clearLayers();
  renderBaseNodes(); // reincluye el nodo que estaba enfocado, sin tocar lo demás
  syncUrl();
}

// ─── Aviso sonoro (opcional, ligado al Modo Focus) ──────────────────────────
let soundEnabled = false;
let audioCtx = null;

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playAlertBeep() {
  try {
    const ctx = ensureAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch { /* audio no disponible en este navegador/contexto — se ignora */ }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  const btn = document.getElementById('focus-sound-btn');
  btn.textContent = soundEnabled ? '🔊' : '🔇';
  btn.classList.toggle('active', soundEnabled);
  if (soundEnabled) ensureAudioCtx(); // el gesto del click habilita el audio
}

// ─── Línea de tiempo: barras de actividad + reproducción ───────────────────
// Reutiliza handleLiveEvent() para "reproducir" — un paquete histórico se
// alimenta al mismo pipeline que uno en directo (animación, panel, Modo Focus
// incluido), solo que la fuente es /timeline en vez del WebSocket. Mientras
// se reproduce, el feed en directo real se pausa (mismo livePaused de siempre)
// para no mezclar ambos.

let timelineRangeS = 3600;
let timelineSince = 0;
let timelineUntil = 0;
let timelineBuckets = [];
let replayPackets = [];
let replayCursorTime = null;
let replayPlaying = false;
let replaySpeed = 1;
let replayEventQueue = [];
let replayStepTimer = null;
let inReplayView = false;
let timelineRefreshInterval = null;
const REPLAY_MAX_GAP_MS = 4000; // tope de espera entre paquetes aunque vaya a 1x — si no, un hueco de tráfico se convierte en minutos de espera real

function timelineBucketSize() {
  return timelineRangeS <= 3600 ? 60 : (timelineRangeS <= 43200 ? 600 : 3600);
}

async function loadTimelineActivity() {
  try {
    const r = await fetch(`${API_BASE}/live-ws/activity?since=${timelineSince}&until=${timelineUntil}&bucket=${timelineBucketSize()}`);
    const data = await r.json();
    timelineBuckets = data.buckets || [];
  } catch {
    timelineBuckets = [];
  }
  drawTimeline();
  drawTimelineAxis();
}

function formatAxisTime(t) {
  const d = new Date(t * 1000);
  const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  if (timelineRangeS <= 43200) return time; // 1h/12h: solo hora
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) + ' ' + time;
}

function drawTimelineAxis() {
  const axis = document.getElementById('timeline-axis');
  if (!axis) return;
  const ticks = 5;
  const labels = [];
  for (let i = 0; i < ticks; i++) {
    const t = timelineSince + (timelineUntil - timelineSince) * (i / (ticks - 1));
    labels.push(`<span>${formatAxisTime(t)}</span>`);
  }
  axis.innerHTML = labels.join('');
}

function drawTimeline() {
  const canvas = document.getElementById('timeline-canvas');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const span = Math.max(1, timelineUntil - timelineSince);
  const maxCount = Math.max(1, ...timelineBuckets.map(b => b.count));
  const barW = Math.max(1, (timelineBucketSize() / span) * cssW - 1);

  ctx.fillStyle = '#38bdf8';
  for (const b of timelineBuckets) {
    const x = ((b.t - timelineSince) / span) * cssW;
    const barH = (b.count / maxCount) * (cssH - 4);
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x, cssH - barH, barW, barH);
  }
  ctx.globalAlpha = 1;

  if (replayCursorTime != null) {
    const x = ((replayCursorTime - timelineSince) / span) * cssW;
    ctx.strokeStyle = '#5eead4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssH);
    ctx.stroke();
  }
}

function timelineTimeFromEvent(e) {
  const canvas = document.getElementById('timeline-canvas');
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return timelineSince + frac * (timelineUntil - timelineSince);
}

function updateCursorLabel() {
  const el = document.getElementById('timeline-cursor-label');
  if (!el) return;
  el.textContent = replayCursorTime != null
    ? new Date(replayCursorTime * 1000).toLocaleString('es-ES')
    : '';
}

function enterReplayView() {
  if (inReplayView) return;
  inReplayView = true;
  if (!livePaused) togglePause();
  document.getElementById('timeline-live-btn').classList.remove('active');
  stopTimelineAutoRefresh();
}

async function loadReplayPackets() {
  try {
    const r = await fetch(`${API_BASE}/live-ws/timeline?since=${timelineSince}&until=${timelineUntil}`);
    const data = await r.json();
    replayPackets = (data.packets || []).slice().sort((a, b) => a.first_seen - b.first_seen);
  } catch {
    replayPackets = [];
    showToast('No se pudo cargar el histórico de ese rango');
  }
}

async function seekTimelineTo(t, { autoplay = true } = {}) {
  enterReplayView();
  stopReplayPlayback();
  replayCursorTime = t;
  updateCursorLabel();
  drawTimeline();
  resetLiveState();
  if (!replayPackets.length) await loadReplayPackets();
  if (autoplay) startReplayPlayback();
}

function buildReplayEventQueue() {
  const events = [];
  for (const pkt of replayPackets) {
    if (pkt.first_seen >= replayCursorTime) {
      events.push({
        time: pkt.first_seen,
        run: () => handleLiveEvent({
          type: 'packet_new', packet_id: pkt.packet_id, from: pkt.from, to: pkt.to,
          hop_start: pkt.hop_start, channel: pkt.channel, portnum: pkt.portnum,
          path_confidence: pkt.path_confidence,
        }),
      });
    }
    for (let i = 0; i < pkt.stages.length; i++) {
      const stageTime = pkt.stages[i].rx_time || pkt.first_seen;
      if (stageTime < replayCursorTime) continue;
      const stagesSoFar = pkt.stages.slice(0, i + 1);
      events.push({
        time: stageTime,
        run: () => handleLiveEvent({
          type: 'packet_stage', packet_id: pkt.packet_id,
          path_confidence: pkt.path_confidence, stages: stagesSoFar,
        }),
      });
    }
  }
  events.sort((a, b) => a.time - b.time);
  return events;
}

function runNextReplayEvent() {
  if (!replayPlaying) return;
  if (!replayEventQueue.length) { stopReplayPlayback(); return; }
  const next = replayEventQueue[0];
  const delayMs = Math.min(REPLAY_MAX_GAP_MS, Math.max(0, (next.time - replayCursorTime) * 1000 / replaySpeed));
  replayStepTimer = setTimeout(() => {
    replayEventQueue.shift();
    replayCursorTime = Math.max(replayCursorTime, next.time);
    next.run();
    updateCursorLabel();
    drawTimeline();
    runNextReplayEvent();
  }, delayMs);
}

function startReplayPlayback() {
  replayEventQueue = buildReplayEventQueue();
  replayPlaying = true;
  const btn = document.getElementById('timeline-play-btn');
  btn.textContent = '⏸';
  btn.classList.add('playing');
  runNextReplayEvent();
}

async function toggleReplay() {
  if (replayPlaying) { stopReplayPlayback(); return; }
  enterReplayView();
  if (replayCursorTime == null) replayCursorTime = timelineSince;
  if (!replayPackets.length) await loadReplayPackets();
  startReplayPlayback();
}

function stopReplayPlayback() {
  replayPlaying = false;
  if (replayStepTimer) { clearTimeout(replayStepTimer); replayStepTimer = null; }
  const btn = document.getElementById('timeline-play-btn');
  if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); }
}

function setReplaySpeed(speed) {
  replaySpeed = speed;
  document.querySelectorAll('#timeline-speed-group .tl-chip').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.speed) === speed);
  });
}

async function setTimelineRange(seconds) {
  enterReplayView();
  timelineRangeS = seconds;
  document.querySelectorAll('#timeline-range-group .tl-chip').forEach(el => {
    el.classList.toggle('active', Number(el.dataset.range) === seconds);
  });
  timelineUntil = Math.floor(Date.now() / 1000);
  timelineSince = timelineUntil - timelineRangeS;
  replayPackets = [];
  stopReplayPlayback();
  replayCursorTime = null;
  await loadTimelineActivity();
}

function goLive() {
  stopReplayPlayback();
  inReplayView = false;
  replayCursorTime = null;
  replayPackets = [];
  resetLiveState();
  if (livePaused) togglePause();
  document.getElementById('timeline-live-btn').classList.add('active');
  updateCursorLabel();
  drawTimeline();
  startTimelineAutoRefresh();
}

async function refreshTimelineWindow() {
  if (inReplayView) return;
  timelineUntil = Math.floor(Date.now() / 1000);
  timelineSince = timelineUntil - timelineRangeS;
  await loadTimelineActivity();
}

function startTimelineAutoRefresh() {
  stopTimelineAutoRefresh();
  timelineRefreshInterval = setInterval(refreshTimelineWindow, 30000);
}

function stopTimelineAutoRefresh() {
  if (timelineRefreshInterval) { clearInterval(timelineRefreshInterval); timelineRefreshInterval = null; }
}

function timelineBucketAt(t) {
  const bucketSize = timelineBucketSize();
  const bucketStart = Math.floor(t / bucketSize) * bucketSize;
  return timelineBuckets.find(b => b.t === bucketStart);
}

function handleTimelineHover(e) {
  const canvas = document.getElementById('timeline-canvas');
  const tooltip = document.getElementById('timeline-tooltip');
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const t = timelineTimeFromEvent(e);
  const bucket = timelineBucketAt(t);
  tooltip.style.left = `${x}px`;
  tooltip.style.display = 'block';
  const label = formatAxisTime(Math.floor(t / timelineBucketSize()) * timelineBucketSize());
  tooltip.textContent = `${label} — ${bucket ? bucket.count : 0} paquete${bucket && bucket.count === 1 ? '' : 's'}`;
}

function hideTimelineHover() {
  const tooltip = document.getElementById('timeline-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

// Arrastrar el cursor sobre las barras: el extremo derecho es "Live" — si
// se suelta cerca de ahí, vuelve directo a en directo en vez de quedarse
// reproduciendo un instante del pasado a medio segundo de "ahora".
let timelineDragging = false;
const TIMELINE_LIVE_EDGE_FRAC = 0.02;

function timelineEventX(e) {
  return e.changedTouches ? e.changedTouches[0] : (e.touches ? e.touches[0] : e);
}

function onTimelinePointerDown(e) {
  timelineDragging = true;
  updateTimelineDragPreview(timelineEventX(e));
  window.addEventListener('mousemove', onTimelinePointerMove);
  window.addEventListener('mouseup', onTimelinePointerUp);
  window.addEventListener('touchmove', onTimelinePointerMove, { passive: false });
  window.addEventListener('touchend', onTimelinePointerUp);
}

function onTimelinePointerMove(e) {
  if (!timelineDragging) return;
  if (e.cancelable) e.preventDefault();
  updateTimelineDragPreview(timelineEventX(e));
}

function updateTimelineDragPreview(e) {
  enterReplayView();
  replayCursorTime = timelineTimeFromEvent(e);
  updateCursorLabel();
  drawTimeline();
}

function onTimelinePointerUp(e) {
  if (!timelineDragging) return;
  timelineDragging = false;
  window.removeEventListener('mousemove', onTimelinePointerMove);
  window.removeEventListener('mouseup', onTimelinePointerUp);
  window.removeEventListener('touchmove', onTimelinePointerMove);
  window.removeEventListener('touchend', onTimelinePointerUp);

  const t = timelineTimeFromEvent(timelineEventX(e));
  const span = timelineUntil - timelineSince;
  if ((timelineUntil - t) < span * TIMELINE_LIVE_EDGE_FRAC) {
    goLive();
  } else {
    seekTimelineTo(t);
  }
}

async function initTimeline() {
  const canvas = document.getElementById('timeline-canvas');
  canvas.addEventListener('mousedown', onTimelinePointerDown);
  canvas.addEventListener('touchstart', onTimelinePointerDown, { passive: true });
  canvas.addEventListener('mousemove', handleTimelineHover);
  canvas.addEventListener('mouseleave', hideTimelineHover);
  window.addEventListener('resize', () => { drawTimeline(); drawTimelineAxis(); });

  // La caja vive dentro de #map (el contenedor de Leaflet) — sin esto,
  // cualquier click/arrastre sobre ella también movía el mapa por debajo.
  const timelineBar = document.getElementById('timeline-bar');
  L.DomEvent.disableClickPropagation(timelineBar);
  L.DomEvent.disableScrollPropagation(timelineBar);

  timelineUntil = Math.floor(Date.now() / 1000);
  timelineSince = timelineUntil - timelineRangeS;
  await loadTimelineActivity();
  startTimelineAutoRefresh();
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

// ─── Leyenda: capas activables/desactivables ───────────────────────────────

const LIVE_LAYER_KEYS = ['nodes', 'trail', 'siblings'];
const LIVE_LAYER_KEY  = 'mesh_live_hidden_layers';
const _savedHiddenLayers = (() => { try { return JSON.parse(localStorage.getItem(LIVE_LAYER_KEY)); } catch { return null; } })();
const liveHiddenLayers = new Set(
  Array.isArray(_savedHiddenLayers) ? _savedHiddenLayers.filter(k => LIVE_LAYER_KEYS.includes(k)) : []
);

function liveLayerGroupFor(key) {
  return { nodes: liveNodeLayer, trail: liveTrailLayer, siblings: liveSiblingLayer }[key];
}

function applyLiveLayerVisibility(key) {
  const show = !liveHiddenLayers.has(key);
  const group = liveLayerGroupFor(key);
  if (show) { if (!map.hasLayer(group)) group.addTo(map); }
  else if (map.hasLayer(group)) map.removeLayer(group);
}

function applyAllLiveLayerVisibility() {
  LIVE_LAYER_KEYS.forEach(applyLiveLayerVisibility);
}

function syncLiveLegendToggles() {
  document.querySelectorAll('.legend-item[data-layer]').forEach(el => {
    el.classList.toggle('active', !liveHiddenLayers.has(el.dataset.layer));
  });
}

function toggleLiveLayer(key) {
  if (liveHiddenLayers.has(key)) liveHiddenLayers.delete(key);
  else liveHiddenLayers.add(key);
  try { localStorage.setItem(LIVE_LAYER_KEY, JSON.stringify([...liveHiddenLayers])); } catch {}
  applyLiveLayerVisibility(key);
  syncLiveLegendToggles();
}

// ─── Leyenda: arrastrable ───────────────────────────────────────────────────

function initLegendDrag() {
  const legend = document.getElementById('live-legend');
  const handle = document.getElementById('live-legend-handle');
  if (!legend || !handle) return;
  const container = legend.parentElement;

  // Sin persistencia entre sesiones a propósito: la posición inicial de
  // cada carga es siempre la de por defecto (abajo a la derecha, ver CSS
  // .legend) — arrastrarla solo vale para la sesión actual.
  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    const rect = legend.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    startLeft = rect.left - containerRect.left;
    startTop = rect.top - containerRect.top;
    startX = e.clientX;
    startY = e.clientY;
    legend.classList.add('dragging');
    e.preventDefault();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const containerRect = container.getBoundingClientRect();
    let left = startLeft + (e.clientX - startX);
    let top = startTop + (e.clientY - startY);
    left = Math.max(0, Math.min(left, containerRect.width - legend.offsetWidth));
    top = Math.max(0, Math.min(top, containerRect.height - legend.offsetHeight));
    legend.style.left = left + 'px';
    legend.style.top = top + 'px';
    legend.style.right = 'auto';
    legend.style.bottom = 'auto';
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    legend.classList.remove('dragging');
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
}

// La leyenda debe quedar lo más abajo posible sin tapar la línea de
// tiempo — en vez de un hueco fijo adivinado (que sobraba o se quedaba
// corto según cuánto envuelvan sus controles), se mide de verdad la
// altura real de .timeline-bar y se apoya justo encima.
function positionLegendAboveTimeline() {
  const legend = document.getElementById('live-legend');
  const bar = document.getElementById('timeline-bar');
  if (!legend || !bar) return;
  if (legend.style.top) return; // el usuario la ha arrastrado en esta sesión, no tocar
  const barBottom = parseFloat(getComputedStyle(bar).bottom) || 0;
  legend.style.bottom = (barBottom + bar.offsetHeight + 10) + 'px';
}

async function bootLive() {
  try {
    const cfg = await fetch(API_BASE + '/data/config.json?t=' + Date.now()).then(r => r.ok ? r.json() : {});
    if (cfg.map_lat) MAP_LAT = cfg.map_lat;
    if (cfg.map_lng) MAP_LNG = cfg.map_lng;
    if (cfg.map_zoom) MAP_ZOOM = cfg.map_zoom;
  } catch { /* config.json es opcional aquí, se usan los valores por defecto */ }

  initLiveMap();
  syncLiveLegendToggles();
  initLegendDrag();
  try { await loadNodes(); } catch (e) { console.error(e); }
  connectLive();
  await initTimeline();
  positionLegendAboveTimeline();
  window.addEventListener('resize', positionLegendAboveTimeline);

  const params = new URLSearchParams(location.search);
  const focusParam = params.get('focus');
  if (focusParam && nodesById.has(focusParam)) setFocusNode(focusParam);
  const packetParam = params.get('packet');
  if (packetParam) loadSharedPacket(packetParam);

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
