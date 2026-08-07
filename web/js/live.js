// ─── Feed en directo: MQTT → WebSocket → animación en el mapa ─────────────────────

// packet_id NO es identidad suficiente: es un entero de 32 bits que cada
// nodo genera por su cuenta, sin garantía de unicidad en toda la malla
// (el firmware solo evita repetirlo consigo mismo). Con tráfico EU_868 y
// varios días de histórico, dos nodos distintos pueden coincidir por azar
// — por eso todo se indexa por la pareja (packet_id, from), igual que hace
// el propio firmware para deduplicar. pktKey() construye esa clave.
function pktKey(packetId, from) { return packetId + ':' + (from || ''); }

let liveTracked = new Map();  // pktKey → { info, stages, legIndex, marker, halo, trails, color, expiring, pathConfidence }
let liveLayer;                // L.layerGroup de marcadores/halos animados
let liveTrailLayer;           // L.layerGroup de las líneas de recorrido (por debajo de los marcadores)
let liveSiblingLayer;         // L.layerGroup de las líneas de "mismo salto oído por varios gateways"
// El mapa grande usa preferCanvas:true (rendimiento con muchos nodos), pero
// Canvas pinta todo en un único <canvas> sin nodos DOM por trazo — no hay
// nada a lo que engancharle una clase CSS ni una animación. Los tramos de
// traceroute confirmado fuerzan este renderer SVG propio (mismo pane) para
// poder animarlos con CSS igual que en el mini-mapa del desglose.
let liveTraceRenderer;
let livePingLayer;            // L.layerGroup de los pings de origen
let liveNodeLayer;            // L.layerGroup de puntos base de nodos
let liveWs = null;
let liveBackoffMs = 1000;
let livePaused = false;
let liveFocusNodeId = null;   // !xxxxxxxx del nodo enfocado, o null (sin filtro)
let liveFocusLayer;           // L.layerGroup con el resaltado del nodo enfocado
let currentDetailPacketId = null; // pktKey() del desglose abierto ahora mismo, o null
const LIVE_BACKOFF_MAX_MS = 30000;
const LIVE_LOG_MAX = 200;

// ─── Filtro por tipo de paquete ─────────────────────────────────────────────
// Lista larga: cada portnum real es su propio filtro, sin agrupar los
// menos comunes bajo un "otros" salvo que de verdad no tengamos fila
// dedicada para él (portnums muy raros/experimentales, o sin decodificar).
const KNOWN_PORTNUMS = [
  'POSITION_APP', 'TEXT_MESSAGE_APP', 'TELEMETRY_APP', 'NODEINFO_APP', 'WAYPOINT_APP',
  'TRACEROUTE_APP', 'NEIGHBORINFO_APP', 'RANGE_TEST_APP', 'MAP_REPORT_APP',
];
function portnumCategory(portnum) {
  if (!portnum) return 'OTHER';
  if (portnum === 'ENCRYPTED') return 'ENCRYPTED';
  return KNOWN_PORTNUMS.includes(portnum) ? portnum : 'OTHER';
}
const ALL_PORTNUM_CATS = [...KNOWN_PORTNUMS, 'ENCRYPTED', 'OTHER'];
const PORTNUM_FILTER_KEY = 'mesh_live_portnum_filters';

function loadPortnumFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(PORTNUM_FILTER_KEY));
    if (Array.isArray(saved) && saved.every(c => ALL_PORTNUM_CATS.includes(c))) {
      return new Set(saved);
    }
  } catch {}
  return new Set(ALL_PORTNUM_CATS);
}

let activePortnumFilters = loadPortnumFilters();

// El HTML trae todas las filas marcadas "active" por defecto — hay que
// reflejar aquí el filtro ya guardado antes de que se vea la cabecera.
function syncPortnumFilterButtons() {
  document.querySelectorAll('#portnum-filter-panel .pf-row').forEach(btn => {
    btn.classList.toggle('active', activePortnumFilters.has(btn.dataset.cat));
  });
  updatePortnumFilterCount();
}

function updatePortnumFilterCount() {
  const el = document.getElementById('portnum-filter-count');
  if (!el) return;
  const n = activePortnumFilters.size;
  el.textContent = n === ALL_PORTNUM_CATS.length ? '' : `${n}/${ALL_PORTNUM_CATS.length}`;
}

function togglePortnumFilter(cat) {
  if (activePortnumFilters.has(cat)) activePortnumFilters.delete(cat);
  else activePortnumFilters.add(cat);
  try { localStorage.setItem(PORTNUM_FILTER_KEY, JSON.stringify([...activePortnumFilters])); } catch {}
  const btn = document.querySelector(`#portnum-filter-panel [data-cat="${cat}"]`);
  if (btn) btn.classList.toggle('active', activePortnumFilters.has(cat));
  updatePortnumFilterCount();
}

function savePortnumFiltersAndSync() {
  try { localStorage.setItem(PORTNUM_FILTER_KEY, JSON.stringify([...activePortnumFilters])); } catch {}
  syncPortnumFilterButtons();
}

function selectAllPortnumFilters() {
  activePortnumFilters = new Set(ALL_PORTNUM_CATS);
  savePortnumFiltersAndSync();
}

function clearAllPortnumFilters() {
  activePortnumFilters = new Set();
  savePortnumFiltersAndSync();
}

function togglePortnumFilterPanel() {
  document.getElementById('portnum-filter-wrap').classList.toggle('open');
}

function closePortnumFilterPanel() {
  document.getElementById('portnum-filter-wrap').classList.remove('open');
}

// ─── Paquetes/min: tasa de tráfico en vivo ──────────────────────────────────
let recentPacketTimes = []; // timestamps (ms) de packet_new reales, ventana de 60s

function recordPacketForRate() {
  recentPacketTimes.push(Date.now());
}

function updatePacketRateDisplay() {
  const cutoff = Date.now() - 60000;
  while (recentPacketTimes.length && recentPacketTimes[0] < cutoff) recentPacketTimes.shift();
  const el = document.getElementById('packet-rate-value');
  if (el) el.textContent = recentPacketTimes.length;
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
let liveOrder = [];                      // pktKey() en orden de llegada (packet_new)
const pendingTrailRemovals = new Map();  // pktKey() → timeoutId
const MAX_VISIBLE_PACKETS = 20;
// Red de seguridad aparte para traceroutes: se les da prioridad para NO
// expulsarlos mientras siguen esperando el salto final (advanceTraceroute
// espera hasta 2 min), pero sin este tope podrían acumularse sin límite en
// un rato con muchos traceroutes seguidos.
const MAX_VISIBLE_TRACEROUTES = 30;
const TRAIL_GRACE_MS = 5000;

// pktKey() → { info, stages, path_confidence } — historial persistente
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
  liveTraceRenderer = L.svg({ pane: 'livePane' });

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
  // Los traceroutes se dejan más tiempo para poder llegar hasta el final
  // (ver advanceTraceroute) — al superar MAX_VISIBLE_PACKETS se expulsa
  // primero el paquete NORMAL más antiguo; un traceroute solo se expulsa
  // si ya no queda ningún paquete normal que expulsar, o si hay demasiados
  // traceroutes acumulados a la vez (MAX_VISIBLE_TRACEROUTES).
  let overflow = liveOrder.length - MAX_VISIBLE_PACKETS;
  let traceCount = 0;
  for (const id of liveOrder) {
    const t = liveTracked.get(id);
    if (t && t.isTraceroute) traceCount++;
  }
  let traceOverflow = traceCount - MAX_VISIBLE_TRACEROUTES;

  let i = 0;
  while ((overflow > 0 || traceOverflow > 0) && i < liveOrder.length) {
    const id = liveOrder[i];
    const tracked = liveTracked.get(id);
    const isTrace = !!(tracked && tracked.isTraceroute);
    if (overflow <= 0 || (isTrace && traceOverflow <= 0)) { i++; continue; }
    liveOrder.splice(i, 1);
    overflow--;
    if (isTrace) traceOverflow--;
    if (!pendingTrailRemovals.has(id) && liveTracked.has(id)) {
      const timer = setTimeout(() => {
        pendingTrailRemovals.delete(id);
        expirePacket(id);
      }, TRAIL_GRACE_MS);
      pendingTrailRemovals.set(id, timer);
    }
  }
}

function handleLiveEvent(event) {
  const key = pktKey(event.packet_id, event.from);
  if (event.type === 'packet_new') {
    if (liveFocusNodeId && event.from !== liveFocusNodeId && event.to !== liveFocusNodeId) return;
    if (!activePortnumFilters.has(portnumCategory(event.portnum))) return;
    liveTracked.set(key, {
      info: event, stages: [], legIndex: 0,
      marker: null, halo: null, trails: [],
      color: packetColor(event.packet_id),
      expiring: false, animating: false, pathConfidence: event.path_confidence,
      // Estado de la animación por ruta confirmada de traceroute — ver
      // advanceTraceroute(). isTraceroute empieza en false a propósito
      // aunque path_confidence ya sea 'traceroute' desde el primer evento:
      // el primer stage con new_event()/route no dispara animación hasta
      // que llega el packet_stage correspondiente.
      isTraceroute: false, traceField: null, traceDrawn: 0, traceLastHops: 0,
      traceUnknown: false, laneOffset: null,
      traceHopsSeen: -1, traceIncludeDest: false, traceFinalTimer: null,
    });
    liveOrder.push(key);
    enforceLiveWindow();
    addLogRow(event);
    spawnOriginPing(event);
    if (!inReplayView) { recordNodeActivity(event.from); renderTopNodes(); recordPacketForRate(); }
    if (soundEnabled && liveFocusNodeId && !inReplayView) playAlertBeep();
  } else if (event.type === 'packet_stage') {
    const tracked = liveTracked.get(key);
    if (!tracked) return;
    const hadStages = tracked.stages.length;
    tracked.stages = event.stages;
    tracked.pathConfidence = event.path_confidence;
    tracked.info.route = event.route;
    tracked.info.route_back = event.route_back;
    updateLogRow(event);
    // Una vez el paquete se confirma como traceroute (route/route_back del
    // propio firmware, salto a salto real) dejamos de animar por la
    // heurística de gateways — no coincide con la ruta real y confundía
    // más que ayudaba (ver conversación: el mapa grande no encajaba con el
    // desglose). advanceTraceroute() dibuja solo lo confirmado hasta ahora
    // y se re-invoca según route/route_back se van completando.
    if (tracked.pathConfidence === 'traceroute') advanceTraceroute(key);
    else if (event.stages.length > hadStages) animateNextLeg(key);
  } else if (event.type === 'packet_expired') {
    expirePacket(key);
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

// Nº de saltos reales desde el origen hasta la etapa que el marcador
// tiene alcanzada ahora mismo — hop_start menos el hop_limit de esa
// etapa, no solo el índice dentro de las etapas conocidas (que podría
// no arrancar en hop_start si faltan las primeras por falta de
// cobertura MQTT, ver modal de info).
function hopCountFor(tracked) {
  // En modo traceroute el nº de salto es el índice dentro de la ruta
  // confirmada (igual numeración que el mini-mapa del desglose), no la
  // heurística de hop_start - hop_limit de abajo.
  if (tracked.isTraceroute) return tracked.traceLastHops;
  if (tracked.legIndex < 0) return 0;
  const stage = tracked.stages[tracked.legIndex];
  if (stage && tracked.info.hop_start != null) {
    return Math.max(0, tracked.info.hop_start - stage.hop_limit);
  }
  return tracked.legIndex + 1;
}

// free (opcional): { free, certain } de detectFreeHops() — añade una
// insignia de rayo al marcador del salto cuando es "gratis" (no decrementó
// hop_limit). "certain" (con evidencia real de hop_limit) se pinta sólido;
// sin ella, solo inferido por el rol del nodo, se pinta en contorno.
function markerIconHtml(color, hops, isOrigin, isUnknown, free) {
  const cls = ['pkt-marker-icon'];
  if (isOrigin) cls.push('pkt-marker-origin');
  if (isUnknown) cls.push('pkt-marker-unknown');
  if (free && free.free) cls.push(free.certain ? 'pkt-marker-free-certain' : 'pkt-marker-free');
  const label = isUnknown ? '?' : hops;
  return `<div class="${cls.join(' ')}" style="background:${color}"><span class="pkt-marker-num">${label}</span></div>`;
}

function updateMarkerHops(tracked) {
  const el = tracked.marker && tracked.marker.getElement();
  if (!el) return;
  const numEl = el.querySelector('.pkt-marker-num');
  if (numEl) numEl.textContent = tracked.traceUnknown ? '?' : hopCountFor(tracked);
  const iconEl = el.querySelector('.pkt-marker-icon');
  if (iconEl) iconEl.classList.toggle('pkt-marker-unknown', !!tracked.traceUnknown);
}

function ensureMarker(tracked, atPos) {
  if (tracked.marker) return;
  tracked.halo = L.circleMarker(atPos, {
    pane: 'livePane', radius: 9, color: tracked.color, weight: 0,
    fillColor: tracked.color, fillOpacity: 0.25, interactive: false,
  }).addTo(liveLayer);
  tracked.marker = L.marker(atPos, {
    pane: 'livePane',
    icon: L.divIcon({
      className: 'pkt-marker-wrap',
      html: markerIconHtml(tracked.color, hopCountFor(tracked)),
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
    interactive: true,
    bubblingMouseEvents: false,
  }).addTo(liveLayer);
  tracked.marker.on('click', () => openPacketDetail(pktKey(tracked.info.packet_id, tracked.info.from)));
  idlePulse(tracked);
}

// Dedo persistente en un salto ya confirmado de un traceroute — el
// marcador "en movimiento" (ensureMarker/tracked.marker) es uno solo y se
// reutiliza salto a salto, así que sin esto el número de cada salto
// desaparecía en cuanto el paquete avanzaba al siguiente (igual que hace
// el mini-mapa del desglose, que sí dibuja un círculo fijo por salto). Se
// añade a tracked.trails para que expirePacket/resetLiveState lo limpien
// igual que el resto del rastro.
function dropHopMarker(tracked, pos, point, isOrigin, free) {
  const size = isOrigin ? 22 : 16;
  const marker = L.marker(pos, {
    pane: 'livePane', interactive: false,
    icon: L.divIcon({
      className: 'pkt-marker-wrap',
      html: markerIconHtml(tracked.color, point.hops, isOrigin, point.unknown, free),
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    }),
  }).addTo(liveTrailLayer);
  tracked.trails.push(marker);
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

// Vector de desplazamiento FIJO para todo un paquete (no por tramo): un
// único (latOff, lngOff), perpendicular al rumbo general origen→destino,
// que se suma tal cual a cada punto de la ruta. Calcularlo por tramo
// individual (rumbo propio de cada salto) rompía la continuidad en cada
// zigzag — dos saltos consecutivos con rumbos distintos se desplazaban en
// direcciones distintas y el punto que deberían compartir dejaba de
// coincidir, dando líneas "cortadas" en cada vértice. Con un vector fijo
// toda la ruta se traslada en bloque: sigue siendo exactamente la misma
// forma, solo que corrida a un lado — y como el rumbo general se invierte
// entre ida y vuelta, cada una cae a un lado distinto sin tocarse.
function laneOffsetVector(from, to, meters) {
  if (!meters || !from || !to) return null;
  const lat0 = (from[0] + to[0]) / 2 * Math.PI / 180;
  const kx = Math.cos(lat0) || 1e-6; // escala aprox longitud→distancia real a esta latitud
  const dx = (to[1] - from[1]) * kx;
  const dy = to[0] - from[0];
  const len = Math.hypot(dx, dy);
  if (!len) return null;
  const ux = dy / len, uy = -dx / len; // perpendicular a la derecha de (dx,dy)
  const degPerMeter = 1 / 111320; // aprox, grados de latitud por metro
  return {
    lat: uy * meters * degPerMeter,
    lng: (ux * meters * degPerMeter) / kx,
  };
}

function applyLaneOffset(pos, offset) {
  return offset ? [pos[0] + offset.lat, pos[1] + offset.lng] : pos;
}

// Ver el comentario donde se usa (advanceTraceroute) para el porqué de una
// distancia real fija en vez de basada en zoom o en la escala de la ruta.
const LANE_OFFSET_METERS = 50;

// Las 3 líneas visuales (halo + sólida + guion animado) de un tramo, más un
// hit-stroke invisible opcional más ancho para poder pinchar la línea sin
// puntería milimétrica — creadas en un punto (longitud cero) para poder ir
// estirándolas frame a frame mientras el marcador se anima — ver
// updateTraceLines()/advanceTraceroute(). El mini-mapa del desglose no
// anima, así que las crea y las estira en el mismo instante (ver
// drawTraceSegment más abajo) y sin onClick (ya está dentro del propio
// desglose, no hace falta).
//
// onClick (opcional): OJO con esto — CLAUDE.md documenta que un hit line
// invisible de las edges del mapa base "siempre ganaba" a los marcadores
// alrededor pese al z-index de panes, y hubo que quitarlo. Aquí se acepta
// ese mismo riesgo a propósito porque el hit-stroke es temporal (el tramo
// desaparece a los pocos segundos, no es un elemento permanente del mapa
// como las edges) y va en su propio pane 'livePane' por encima de todo lo
// demás — si tapa el click de un nodo base un instante, se resuelve solo.
function createTraceLines(layerGroup, at, color, extraOpts = {}) {
  const { onClick, ...restOpts } = extraOpts;
  const base = { interactive: false, ...restOpts };
  const glow = L.polyline([at, at], { ...base, color, weight: 8, opacity: 0.22 }).addTo(layerGroup);
  const line = L.polyline([at, at], { ...base, color, weight: 3.5, opacity: 1 }).addTo(layerGroup);
  // dashArray es en pixels fijos, no escala con el zoom — con un hueco de
  // 10px se veía bien en el mini-mapa (ruta entera encogida a un área
  // pequeña) pero en el mapa grande, a su zoom habitual bastante más
  // cercano, esos huecos se repetían muchas más veces a lo largo de la
  // línea y se leían como cortes reales en vez de un flujo animado.
  const flow = L.polyline([at, at], {
    ...base, color: '#fff', weight: 1.8, opacity: 0.9, dashArray: '4 6', className: 'pkt-route-flow',
  }).addTo(layerGroup);
  let hit = null;
  if (onClick) {
    hit = L.polyline([at, at], {
      ...restOpts, interactive: true, bubblingMouseEvents: false,
      color: '#000', opacity: 0, weight: 14,
    }).addTo(layerGroup);
    hit.on('click', onClick);
  }
  return { glow, line, flow, hit };
}

function updateTraceLines(lines, from, to) {
  lines.glow.setLatLngs([from, to]);
  lines.line.setLatLngs([from, to]);
  lines.flow.setLatLngs([from, to]);
  if (lines.hit) lines.hit.setLatLngs([from, to]);
}

// El rumbo de la flecha se calcula con lat/lng planas (sin pasar por
// latLngToLayerPoint) a propósito: el mini-mapa se acaba de crear con
// L.map() y aún no tiene centro/zoom asignado en el momento en que
// renderDetailMiniMap dibuja la ruta (el fitBounds llega después) — pedirle
// la proyección de pixel antes de tener vista lanza "Set map center and
// zoom first". No hay rotación del mapa en este proyecto, así que lat/lng
// planas dan el mismo ángulo en pantalla que la proyección real.
function createTraceArrow(layerGroup, from, to, color, extraOpts = {}) {
  const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const latCorrection = Math.cos(mid[0] * Math.PI / 180);
  const dx = (to[1] - from[1]) * latCorrection;
  const dy = -(to[0] - from[0]); // lat crece hacia arriba, y de pantalla hacia abajo
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  return L.marker(mid, {
    // Ojo: no pasar "pane: undefined" — aunque no haya pane explícito, la
    // propia clave sobrescribiría el default interno de Leaflet
    // ('markerPane') con undefined y _initIcon revienta al hacer
    // appendChild sobre un pane inexistente. Solo se incluye si hay valor.
    ...(extraOpts.pane ? { pane: extraOpts.pane } : {}),
    interactive: false,
    icon: L.divIcon({
      className: 'pkt-route-arrow-wrap',
      // El triángulo es una caja 0x0 (border-trick) que solo "existe" hacia
      // +x (a la derecha) — sin el translateX(-4px) su centro visual queda
      // 4px por delante del punto de anclaje real. Va DESPUÉS de rotate()
      // en la lista para que se aplique en coordenadas locales (antes de
      // rotar) y la corrección apunte siempre "hacia atrás" en el sentido
      // de la flecha, sea cual sea el ángulo.
      html: `<div class="pkt-route-arrow" style="border-left-color:${color};transform:rotate(${angle}deg) translateX(-4px)"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    }),
  }).addTo(layerGroup);
}

// Traza un tramo de ruta completo de una vez (sin animar): halo + línea
// sólida + guion animado + flecha. Usada por el mini-mapa del desglose, que
// dibuja la ruta entera de golpe. El mapa grande (tramos de traceroute en
// directo) usa createTraceLines/updateTraceLines/createTraceArrow por
// separado para poder ir estirando la línea mientras el marcador se anima
// — ver advanceTraceroute(). Devuelve las capas creadas para limpiarlas
// luego.
function drawTraceSegment(layerGroup, from, to, color, extraOpts = {}) {
  const lines = createTraceLines(layerGroup, from, color, extraOpts);
  updateTraceLines(lines, from, to);
  const arrow = createTraceArrow(layerGroup, from, to, color, extraOpts);
  return [lines.glow, lines.line, lines.flow, arrow];
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
  updateMarkerHops(tracked);
  tracked.animating = true;

  // La línea se crea ya (longitud cero, en fromPos) y se va estirando cada
  // frame hasta la posición actual del marcador — igual que hace
  // advanceTraceroute() — en vez de aparecer de golpe cuando el tramo
  // termina. Se mete en tracked.trails desde ya para que si el paquete
  // expira a mitad de tramo, el trozo dibujado hasta ese momento también
  // se recoja en el fade-out de expirePacket().
  const line = L.polyline([fromPos, fromPos], {
    pane: 'livePane', color: tracked.color, weight: 2.5, opacity: 0.55,
    interactive: false,
  }).addTo(liveTrailLayer);
  tracked.trails.push(line);

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
    line.setLatLngs([fromPos, [lat, lng]]);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      tracked.animating = false;
      if (tracked.legIndex < stages.length - 1) animateNextLeg(packetId);
    }
  }
  requestAnimationFrame(step);
}

// Anima el marcador por la ruta REAL de un traceroute (route/route_back del
// propio firmware), no por la heurística de gateway_ids oídos — esa
// heurística puede tomar atajos geográficos que no son el camino RF real y
// no coincidía con lo que se ve en el mini-mapa del desglose (mismo bug
// que motivó esto). route/route_back llegan incompletos y se van
// completando salto a salto en sucesivos packet_stage — cada llamada aquí
// dibuja/anima solo el tramo nuevo confirmado desde la última vez.
function advanceTraceroute(packetId) {
  const tracked = liveTracked.get(packetId);
  if (!tracked || tracked.expiring || tracked.animating) return;

  // traceRouteIds()/traceRoutePath() (usadas por el mini-mapa) recalculan
  // SIEMPRE en frío y prefieren route_back en cuanto tiene algo — correcto
  // para un render final. Pero aquí el dibujado es incremental: route
  // suele llegar ya completo desde el primer sighting (es la ruta de ida,
  // copiada tal cual en el paquete de respuesta), mientras que route_back
  // es la que de verdad se va completando salto a salto PARA ESTE paquete.
  // Si dejásemos que la base cambiara de "route" a "route_back" a mitad de
  // animación (en cuanto route_back consigue su primer salto), traceDrawn
  // seguiría contando posiciones de una lista que ya no es la que se está
  // usando — el mapa grande acababa mostrando un camino truncado/roto que
  // no coincidía con el mini-mapa (que sí recalcula en frío). Por eso aquí
  // se fija una única base por paquete y solo se cambia (reiniciando el
  // dibujado desde cero) si la base realmente cambia.
  const hasRouteBack = !!(tracked.info.route_back && tracked.info.route_back.length);
  const wantField = hasRouteBack ? 'route_back' : 'route';
  const hops = tracked.info[wantField] || [];
  const hopsChanged = hops.length !== tracked.traceHopsSeen;
  // Si ya habíamos dado el destino por bueno (traceIncludeDest, ver más
  // abajo) y ahora resulta que llega un salto real nuevo, ese destino
  // especulativo ha quedado invalidado — su posición en la lista de ids ya
  // no es la misma. Se trata igual que un cambio de base de route a
  // route_back: reset completo y se vuelve a dibujar desde el origen.
  const invalidatedFinal = hopsChanged && tracked.traceIncludeDest;

  if (!tracked.isTraceroute || tracked.traceField !== wantField || invalidatedFinal) {
    // Primera confirmación de traceroute, cambio de base a mitad de
    // camino, o destino invalidado: cualquier rastro ya dibujado no tiene
    // por qué coincidir con lo que toca dibujar ahora — se borra y se
    // retoma desde el origen con los saltos confirmados.
    tracked.trails.forEach(l => { liveTrailLayer.removeLayer(l); liveSiblingLayer.removeLayer(l); });
    tracked.trails = [];
    tracked.isTraceroute = true;
    tracked.traceField = wantField;
    tracked.traceDrawn = 0;
    tracked.lastPos = null;
    tracked.traceIncludeDest = false;
    // Vector de carril fijo para TODO el paquete (ver laneOffsetVector) —
    // se calcula una vez con el origen/destino reales (no con los extremos
    // de "points", que de momento solo llegan hasta el último salto
    // confirmado) para que no cambie a medio dibujar.
    //
    // El tamaño es una distancia real FIJA (LANE_OFFSET_METERS), a
    // propósito NADA relativa al zoom ni a la escala de la ruta — ya se
    // probaron las dos y ambas fallan:
    //  - Basado en pixels-al-zoom-actual: un traceroute puede tardar hasta
    //    2 min en completarse, así que si el usuario hace zoom mientras
    //    tanto, el mismo desplazamiento en metros pasa a verse muchos más
    //    pixels al acercar — la línea se arrancaba de sus propios
    //    marcadores (visto con un traceroute real cruzándose consigo mismo).
    //  - Proporcional a la distancia origen→destino: si esos dos extremos
    //    están lejos pero un tramo concreto de la ruta pasa por un grupo de
    //    saltos muy juntos entre sí (visto con un traceroute real por
    //    Valencia), el carril calculado para "toda la ruta" resultaba
    //    enorme comparado con esos saltos locales — la línea se separaba
    //    claramente de sus marcadores otra vez, en la dirección contraria.
    // Una distancia real fija no depende de ninguna de las dos cosas:
    // invisible a escala país (perfecto, ahí no se puede distinguir carriles
    // de todos modos) y una separación modesta y consistente a escala
    // ciudad/calle, sea cual sea el zoom o la escala de la ruta.
    const originPos = nodeLatLng(tracked.info.from);
    const destPos = nodeLatLng(tracked.info.to);
    tracked.laneOffset = (originPos && destPos)
      ? laneOffsetVector(originPos, destPos, LANE_OFFSET_METERS)
      : null;
  }

  // "to" (destino) NO se añade a la lista de ids hasta que llevamos 2
  // minutos sin que lleguen saltos nuevos — no hay una señal fiable de
  // "ya está completo": hop_start NO es un tope real, los saltos entre
  // nodos ROUTER no lo decrementan, así que route puede acabar teniendo
  // más entradas que hop_start. Un traceroute puede tardar más de 60s en
  // completarse con huecos de varios segundos entre saltos (normal en
  // LoRa), así que la espera es larga a propósito. Si durante esos 2 min
  // llega un salto real, se invalida (invalidatedFinal arriba) y se
  // reinicia el plazo desde cero.
  if (hopsChanged) {
    tracked.traceHopsSeen = hops.length;
    if (tracked.traceFinalTimer) clearTimeout(tracked.traceFinalTimer);
    tracked.traceFinalTimer = setTimeout(() => {
      tracked.traceFinalTimer = null;
      tracked.traceIncludeDest = true;
      advanceTraceroute(packetId);
    }, 120000);
  }

  const ids = [tracked.info.from, ...hops, ...(tracked.traceIncludeDest ? [tracked.info.to] : [])];
  const points = buildSequencedPath(
    ids,
    (id) => nodeLabel(id),
  );
  const freeHops = detectFreeHops(hops, tracked.stages, tracked.info.hop_start);

  if (points.length <= tracked.traceDrawn) return; // nada nuevo confirmado todavía

  if (!tracked.lastPos) {
    tracked.lastPos = points[0].pos;
    tracked.traceDrawn = 1;
    tracked.traceLastHops = points[0].hops;
    tracked.traceUnknown = !!points[0].unknown;
    // El marcador y el "dedo" de salto van en la posición REAL del nodo
    // (igual que el mini-mapa del desglose) — solo las líneas se desplazan
    // con el carril, si no los puntos del mapa grande no coincidían con
    // los del mini-mapa ni con el marker real del nodo en el mapa base.
    ensureMarker(tracked, points[0].pos);
    updateMarkerHops(tracked);
    dropHopMarker(tracked, points[0].pos, points[0], true, freeHops.get(points[0].id));
    if (points.length <= tracked.traceDrawn) return;
  }

  const target = points[tracked.traceDrawn];
  const toPos = target.pos;
  const fromPos = tracked.lastPos;
  // fromDraw/toDraw (con el carril aplicado) son solo para las LÍNEAS, que
  // sí se desplazan para separar ida/vuelta cuando coinciden; el marcador y
  // los "dedos" de salto siguen la posición real (fromPos/toPos).
  const fromDraw = applyLaneOffset(fromPos, tracked.laneOffset);
  const toDraw = applyLaneOffset(toPos, tracked.laneOffset);
  tracked.animating = true;
  ensureMarker(tracked, fromPos);

  // La línea se crea ya (longitud cero, en fromDraw) y se va estirando cada
  // frame hasta la posición actual del marcador — no se dibuja de golpe al
  // llegar. Se mete en tracked.trails desde ya (no solo al terminar) para
  // que si el paquete expira a mitad de tramo, el trozo dibujado hasta ese
  // momento también se recoja en el fade-out de expirePacket().
  const growLines = createTraceLines(liveTrailLayer, fromDraw, tracked.color, {
    pane: 'livePane', renderer: liveTraceRenderer,
    onClick: () => openPacketDetail(pktKey(tracked.info.packet_id, tracked.info.from)),
  });
  tracked.trails.push(growLines.glow, growLines.line, growLines.flow, growLines.hit);

  const durationMs = 900 * packetAnimSlowdown();
  const start = performance.now();

  function step(now) {
    if (tracked.expiring) return;
    const t = Math.min(1, (now - start) / durationMs);
    const e = easeInOutQuad(t);
    const curPos = [
      fromPos[0] + (toPos[0] - fromPos[0]) * e,
      fromPos[1] + (toPos[1] - fromPos[1]) * e,
    ];
    tracked.marker.setLatLng(curPos);
    tracked.halo.setLatLng(curPos);
    updateTraceLines(growLines, fromDraw, applyLaneOffset(curPos, tracked.laneOffset));
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      tracked.trails.push(createTraceArrow(liveTrailLayer, fromDraw, toDraw, tracked.color, { pane: 'livePane' }));
      dropHopMarker(tracked, toPos, target, false, freeHops.get(target.id));
      tracked.lastPos = toPos;
      tracked.traceDrawn++;
      tracked.traceLastHops = target.hops;
      tracked.traceUnknown = !!target.unknown;
      updateMarkerHops(tracked);
      tracked.animating = false;
      if (tracked.traceDrawn < points.length) advanceTraceroute(packetId);
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
  if (tracked.traceFinalTimer) { clearTimeout(tracked.traceFinalTimer); tracked.traceFinalTimer = null; }

  const layers = [...tracked.trails];
  if (tracked.halo) layers.push(tracked.halo);
  // tracked.marker es un L.Marker (divIcon, para poder mostrar el nº de
  // saltos) — no es un Path, no tiene .setStyle(); su opacidad se anima
  // tocando el estilo del elemento DOM directamente.
  const markerEl = tracked.marker && tracked.marker.getElement();
  if (!layers.length && !markerEl) return;

  const durationMs = 700;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const opacity = 1 - t;
    for (const l of layers) {
      if (l instanceof L.Polyline) l.setStyle({ opacity: opacity * 0.55 });
      else if (l instanceof L.Marker) {
        // Las flechas de dirección de un tramo de traceroute son L.Marker
        // (divIcon), no L.Path — no tienen .setStyle(), su opacidad se anima
        // igual que tracked.marker: tocando el elemento DOM directamente.
        const el = l.getElement();
        if (el) el.style.opacity = opacity;
      }
      else l.setStyle({ opacity, fillOpacity: opacity });
    }
    if (markerEl) markerEl.style.opacity = opacity;
    if (t < 1) requestAnimationFrame(step);
    else {
      layers.forEach(l => {
        const owner = liveLayer.hasLayer(l) ? liveLayer
          : liveSiblingLayer.hasLayer(l) ? liveSiblingLayer
          : liveTrailLayer;
        owner.removeLayer(l);
      });
      if (tracked.marker) liveLayer.removeLayer(tracked.marker);
    }
  }
  requestAnimationFrame(step);
}

// ─── Sidebar de paquetes ────────────────────────────────────────────────────

function addLogRow(event) {
  const key = pktKey(event.packet_id, event.from);
  livePacketLog.set(key, { info: event, stages: [], path_confidence: event.path_confidence });

  const empty = document.getElementById('live-log-empty');
  if (empty) empty.remove();

  const log = document.getElementById('live-log-rows');
  const row = document.createElement('div');
  row.className = 'live-log-row';
  row.id = 'live-log-row-' + key;
  row.innerHTML = renderLogRow(event, { hop_start: event.hop_start, hops: 0, path_confidence: event.path_confidence });
  row.addEventListener('click', () => openPacketDetail(key));
  log.insertBefore(row, log.firstChild);

  while (log.children.length > LIVE_LOG_MAX) {
    const last = log.lastChild;
    const m = /^live-log-row-(.+)$/.exec(last.id);
    if (m) livePacketLog.delete(m[1]);
    log.removeChild(last);
  }
}

function updateLogRow(stageEvent) {
  const key = pktKey(stageEvent.packet_id, stageEvent.from);
  const data = livePacketLog.get(key);
  if (data) {
    data.stages = stageEvent.stages;
    data.path_confidence = stageEvent.path_confidence;
    // route/route_back de un traceroute se van completando en sucesivas
    // etapas — se actualizan en info para que buildPacketPath() las vea.
    if (stageEvent.route) data.info.route = stageEvent.route;
    if (stageEvent.route_back) data.info.route_back = stageEvent.route_back;
  }

  const row = document.getElementById('live-log-row-' + key);
  if (!row) return;
  const tracked = liveTracked.get(key);
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
  const confClass = path_confidence === 'traceroute' ? 'lr-conf-traceroute'
    : path_confidence === 'relay_node' ? 'lr-conf-relay' : 'lr-conf-heuristic';
  const confLabel = path_confidence === 'traceroute' ? 'ruta exacta (traceroute)'
    : path_confidence === 'relay_node' ? 'ruta confirmada' : 'ruta aproximada';
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

// Cota inferior del alcance real: solo cuenta nodos que además son
// gateway MQTT (si no, meshview nunca nos habría llegado su "oída" del
// paquete) — un nodo pudo recibirlo y retransmitirlo sin que ningún
// gateway lo oyera directamente, así que el número real siempre es >= este.
function estimateReachedNodes(data) {
  const ids = new Set();
  if (data.info.from) ids.add(data.info.from);
  for (const stage of data.stages) {
    for (const gw of stage.gateway_ids) ids.add(gw);
    if (stage.relay_node) ids.add(stage.relay_node);
  }
  return ids;
}

// Detecta saltos "gratis" (que no decrementan hop_limit) entre nodos
// ROUTER/ROUTER_CLIENT/REPEATER — combina dos fuentes:
//  1) Evidencia empírica: el hop_limit real visto en los "stages" (la
//     heurística de gateways, que sí registra hop_limit por sighting). Se
//     cruza con route/route_back por relay_node — OJO: relay_node en el
//     protobuf de Meshtastic es solo el ÚLTIMO BYTE del node_id (por eso
//     stages trae cosas como "!000000dd"), no el id completo, así que el
//     cruce se hace comparando ese único byte contra cada id de la ruta.
//  2) Si no hay evidencia directa para un salto, se infiere por el rol del
//     nodo que retransmite (ROUTER/ROUTER_CLIENT/REPEATER) — no es una
//     confirmación real, solo una suposición razonable.
// Devuelve un Map node_id → { free, certain }. hopIds no debe incluir el
// origen (el primer salto real es el primer elemento).
function detectFreeHops(hopIds, stages, hopStart) {
  const hopLimitByLastByte = new Map();
  for (const s of stages) {
    if (s.relay_node) hopLimitByLastByte.set(s.relay_node.slice(-2).toLowerCase(), s.hop_limit);
  }
  const result = new Map();
  let prevHopLimit = hopStart;
  for (const id of hopIds) {
    const hl = hopLimitByLastByte.get(id.slice(-2).toLowerCase());
    const n = nodesById.get(id);
    const roleFree = !!(n && isRouter(n));
    if (hl != null && prevHopLimit != null) {
      result.set(id, { free: hl >= prevHopLimit, certain: true });
      prevHopLimit = hl;
    } else {
      result.set(id, { free: roleFree, certain: false });
      if (hl != null) prevHopLimit = hl;
    }
  }
  return result;
}

function renderPacketDetail(packetId) {
  const data = livePacketLog.get(packetId);
  if (!data) return '<p class="malconfig-empty">Sin datos de este paquete (se ha perdido del historial).</p>';
  const { info, stages, path_confidence } = data;
  const isTraceroute = path_confidence === 'traceroute';
  const confLabel = isTraceroute
    ? 'Ruta exacta — registrada por el propio traceroute, salto a salto real (no es una aproximación)'
    : path_confidence === 'relay_node'
      ? 'Ruta confirmada — al menos un salto trae el nodo real que retransmitió (relay_node)'
      : 'Ruta aproximada — estimada por qué gateways oyeron cada salto, sin relay_node';
  const reachedCount = estimateReachedNodes(data).size;

  const traceIds = isTraceroute ? traceRouteIds(data) : null;
  const freeHops = isTraceroute ? detectFreeHops(traceIds.slice(1), stages, info.hop_start) : null;
  const hopsHtml = isTraceroute
    ? traceIds.map((id, i) => {
        const known = !!nodeLatLng(id);
        const roleLabel = i === 0 ? 'origen' : i === traceIds.length - 1 ? 'destino' : `salto ${i}`;
        const free = i > 0 ? freeHops.get(id) : null;
        const freeBadge = free && free.free
          ? (free.certain
            ? '<span class="pkt-hop-free certain" title="Confirmado: el hop_limit no bajó en este salto (visto en los stages de gateways)">⚡ salto reducido</span>'
            : '<span class="pkt-hop-free" title="Inferido por el rol del nodo (ROUTER/REPEATER) — sin confirmar con hop_limit real">⚡ posible salto reducido</span>')
          : '';
        return `
        <div class="pkt-hop">
          <div class="pkt-hop-num">${i}</div>
          <div class="pkt-hop-body">
            <div class="pkt-hop-meta"><span>${roleLabel}</span>${freeBadge}</div>
            <div class="pkt-hop-gateways">
              <span class="pkt-gw-chip${known ? ' relay' : ' unknown'}">${known ? '🔗' : '❓'} ${nodeLabel(id)}</span>
            </div>
          </div>
        </div>`;
      }).join('')
    : (stages.length
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
      : '<p class="pkt-hop-empty">Sin saltos con coordenadas conocidas todavía</p>');

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
      <tr><td>Nodos alcanzados</td><td>~${reachedCount} <span class="pkt-reached-hint" title="Cota mínima: solo cuenta nodos que son gateway MQTT (los únicos visibles desde aquí). El alcance real puede ser mayor.">(aprox.)</span></td></tr>
    </table>
    <h4 class="pkt-hops-title">
      Saltos detectados (${isTraceroute ? traceIds.length : stages.length})
      <span class="pkt-hops-hint">${isTraceroute ? '🔗 = posición conocida · ❓ = nodo real, posición desconocida · ⚡ = salto reducido (router)' : '🔗 = relay_node confirmado en ese salto'}</span>
    </h4>
    <div class="pkt-hops">${hopsHtml}</div>`;
}

// ─── Mini-mapa del desglose ─────────────────────────────────────────────────

let detailMap = null;
let detailMapLayer = null;

// Un traceroute trae la lista exacta de node_id que retransmitieron el
// paquete (RouteDiscovery.route/route_back) — no todos tendrán posición
// conocida en nodes.json. En vez de saltárnoslos sin más (perdiendo el
// hueco), se interpola su posición a medio camino entre el salto
// conocido anterior y el siguiente, y se marcan como "unknown" para que
// el marcador dibuje un "?" en vez de fingir precisión que no tenemos.
function buildSequencedPath(ids, labelFor) {
  const positions = ids.map(id => nodeLatLng(id));
  const points = [];
  for (let i = 0; i < ids.length; i++) {
    if (positions[i]) {
      points.push({ pos: positions[i], label: labelFor(ids[i], i), hops: i, unknown: false, id: ids[i] });
      continue;
    }
    let prevIdx = -1;
    for (let j = i - 1; j >= 0; j--) { if (positions[j]) { prevIdx = j; break; } }
    let nextIdx = -1;
    for (let j = i + 1; j < ids.length; j++) { if (positions[j]) { nextIdx = j; break; } }
    if (prevIdx === -1 || nextIdx === -1) continue; // sin referencia a ambos lados, no se puede ni interpolar
    const t = (i - prevIdx) / (nextIdx - prevIdx);
    const a = positions[prevIdx], b = positions[nextIdx];
    points.push({
      pos: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
      label: `${labelFor(ids[i], i)} — posición desconocida`,
      hops: i,
      unknown: true,
      id: ids[i],
    });
  }
  return points;
}

function traceRouteIds(data) {
  // route_back es el camino de ESTE paquete si es la respuesta (va
  // completándose salto a salto según se retransmite de vuelta); route
  // es el camino ya completo de la solicitud original — se usa route
  // solo cuando route_back todavía no tiene nada.
  const hops = (data.info.route_back && data.info.route_back.length) ? data.info.route_back : (data.info.route || []);
  return [data.info.from, ...hops, data.info.to];
}

function traceroutePath(data) {
  const ids = traceRouteIds(data);
  return buildSequencedPath(ids, (id, i) => {
    if (i === 0) return `${nodeLabel(id)} (origen)`;
    if (i === ids.length - 1) return `${nodeLabel(id)} (destino)`;
    return `${nodeLabel(id)} — salto ${i} (traceroute)`;
  });
}

function buildPacketPath(data) {
  const isTraceroute = (data.info.route && data.info.route.length) || (data.info.route_back && data.info.route_back.length);
  if (isTraceroute) return traceroutePath(data);

  // Sin traceroute: mismo criterio que animateNextLeg — solo puntos con
  // coordenadas conocidas, en orden, origen y luego cada etapa que sí
  // resolvimos (aproximación por heurística de gateways).
  const points = [];
  const originPos = nodeLatLng(data.info.from);
  if (originPos) points.push({ pos: originPos, label: `${nodeLabel(data.info.from)} (origen)`, hops: 0 });
  for (const stage of data.stages) {
    const pos = stagePosition(stage);
    if (pos) {
      const hops = data.info.hop_start != null ? Math.max(0, data.info.hop_start - stage.hop_limit) : null;
      points.push({ pos, label: `hop_limit ${stage.hop_limit} — ${stage.gateway_ids.map(nodeLabel).join(', ')}`, hops });
    }
  }
  return points;
}

// Dibuja la ruta exacta de un traceroute en el mini-mapa del desglose,
// tramo a tramo, con el mismo estilo que el mapa grande (drawTraceSegment).
function drawTraceroutePath(latlngs, color) {
  for (let i = 0; i < latlngs.length - 1; i++) {
    drawTraceSegment(detailMapLayer, latlngs[i], latlngs[i + 1], color);
  }
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

  // packetColor() se hashea siempre sobre el packet_id numérico (igual que
  // en el mapa grande y el log) — no sobre packetId aquí, que ya es la
  // clave compuesta pktKey(), o el color no coincidiría con el resto.
  const isTraceroute = (data.info.route && data.info.route.length) || (data.info.route_back && data.info.route_back.length);
  const freeHops = isTraceroute ? detectFreeHops(traceRouteIds(data).slice(1), data.stages, data.info.hop_start) : null;
  const color = packetColor(data.info.packet_id);
  const latlngs = points.map(p => p.pos);
  const allPositions = [...latlngs];
  if (isTraceroute) {
    drawTraceroutePath(latlngs, color);
  } else {
    L.polyline(latlngs, { color, weight: 3, opacity: 0.8 }).addTo(detailMapLayer);
  }
  // Las líneas de "mismo salto oído por otro gateway" son de la heurística
  // de gateways — con un traceroute la ruta ya es exacta, mezclar ambos
  // modelos en el mismo mini-mapa solo confunde.
  if (!isTraceroute) {
    for (const stage of data.stages) {
      for (const [a, b] of stageSiblingLines(stage)) {
        L.polyline([a, b], { color, weight: 1.5, opacity: 0.45, dashArray: '3 4' }).addTo(detailMapLayer);
        L.circleMarker(b, {
          radius: 4, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.7,
        }).bindTooltip(`hop_limit ${stage.hop_limit} — también oído aquí`, { direction: 'top' }).addTo(detailMapLayer);
        allPositions.push(b);
      }
    }
  }
  points.forEach((p, i) => {
    const isOrigin = i === 0;
    const size = isOrigin ? 24 : 18;
    const free = freeHops && !isOrigin ? freeHops.get(p.id) : null;
    const freeLabel = free && free.free
      ? (free.certain ? ' · ⚡ salto reducido (confirmado)' : ' · ⚡ posible salto reducido (router)')
      : '';
    L.marker(p.pos, {
      icon: L.divIcon({
        className: 'pkt-marker-wrap',
        html: markerIconHtml(color, p.hops ?? i, isOrigin, p.unknown, free),
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      }),
      interactive: true,
    }).bindTooltip(p.label + freeLabel, { direction: 'top' }).addTo(detailMapLayer);
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

// ─── Modal: cómo funciona el directo ────────────────────────────────────────

function openLiveInfo() {
  document.getElementById('live-info-modal').classList.add('open');
}

function closeLiveInfo() {
  document.getElementById('live-info-modal').classList.remove('open');
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
  // Formato nuevo "packetId:from" (ver pktKey); se acepta también un
  // enlace viejo con solo el packetId — el backend hace un mejor esfuerzo
  // si no le llega "from" (ver storage.get_packet).
  const sep = rawId.indexOf(':');
  const packetIdStr = sep === -1 ? rawId : rawId.slice(0, sep);
  const fromId = sep === -1 ? null : rawId.slice(sep + 1);
  const packetId = Number(packetIdStr);
  if (!Number.isFinite(packetId)) return;
  try {
    const qs = fromId ? `?from=${encodeURIComponent(fromId)}` : '';
    const r = await fetch(`${API_BASE}/live-ws/packet/${packetId}${qs}`);
    if (!r.ok) { showToast('Ese paquete ya no está disponible (caducó)'); return; }
    const data = await r.json();
    const key = pktKey(data.packet_id, data.from);
    livePacketLog.set(key, {
      info: {
        packet_id: data.packet_id, from: data.from, to: data.to,
        hop_start: data.hop_start, channel: data.channel, portnum: data.portnum,
        text: data.text, route: data.route, route_back: data.route_back,
      },
      stages: data.stages,
      path_confidence: data.path_confidence,
    });
    openPacketDetail(key);
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
    if (tracked.traceFinalTimer) clearTimeout(tracked.traceFinalTimer);
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
          text: pkt.text, route: pkt.route, route_back: pkt.route_back,
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
          type: 'packet_stage', packet_id: pkt.packet_id, from: pkt.from,
          path_confidence: pkt.path_confidence, stages: stagesSoFar,
          route: pkt.route, route_back: pkt.route_back,
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

// ─── Leyenda: colapsable ────────────────────────────────────────────────────

const LEGEND_COLLAPSE_KEY = 'mesh_live_legend_collapsed';

function toggleLiveLegendCollapse() {
  const legend = document.getElementById('live-legend');
  if (!legend) return;
  const collapsed = legend.classList.toggle('collapsed');
  try { localStorage.setItem(LEGEND_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch {}
}

function initLegendCollapse() {
  const legend = document.getElementById('live-legend');
  if (!legend) return;
  // Siempre abierta por defecto (CLAUDE.md) — el botón ▾ sigue ahí para
  // quien quiera colapsarla, pero eso lo decide el usuario, no el arranque.
  let collapsed = false;
  try { collapsed = localStorage.getItem(LEGEND_COLLAPSE_KEY) === '1'; } catch {}
  legend.classList.toggle('collapsed', collapsed);
}

// La leyenda debe quedar lo más abajo posible sin tapar la línea de
// tiempo — se mide la altura real de .timeline-bar y se apoya justo
// encima. Un valor fijo no vale: la barra cambia de alto según cuánto
// envuelvan sus controles (ancho de ventana, idioma...).
function positionLegendAboveTimeline() {
  const legend = document.getElementById('live-legend');
  const bar = document.getElementById('timeline-bar');
  if (!legend || !bar) return;
  const barBottom = parseFloat(getComputedStyle(bar).bottom) || 0;
  legend.style.bottom = (barBottom + bar.offsetHeight + 10) + 'px';
}

// Un único cálculo tras cargar podía quedar mal si la barra cambia de
// tamaño después (fuentes cargando tarde, la leyenda se colapsa/expande,
// resize de ventana...) — un ResizeObserver sobre .timeline-bar reacciona
// a cualquier cambio real de su tamaño, no solo al resize de window.
function initLegendTimelineOffset() {
  const bar = document.getElementById('timeline-bar');
  if (!bar) return;
  if (window.ResizeObserver) {
    new ResizeObserver(positionLegendAboveTimeline).observe(bar);
  } else {
    window.addEventListener('resize', positionLegendAboveTimeline);
  }
  positionLegendAboveTimeline();
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
  syncPortnumFilterButtons();
  initLegendCollapse();
  try { await loadNodes(); } catch (e) { console.error(e); }
  connectLive();
  await initTimeline();
  initLegendTimelineOffset();
  updatePacketRateDisplay();
  setInterval(updatePacketRateDisplay, 2000);

  const params = new URLSearchParams(location.search);
  const focusParam = params.get('focus');
  if (focusParam && nodesById.has(focusParam)) setFocusNode(focusParam);
  const packetParam = params.get('packet');
  if (packetParam) loadSharedPacket(packetParam);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closePacketDetail();
    closeLiveInfo();
    closePortnumFilterPanel();
    document.getElementById('focus-dropdown').classList.remove('open');
  });

  document.addEventListener('click', (e) => {
    if (!document.getElementById('focus-wrap').contains(e.target)) {
      document.getElementById('focus-dropdown').classList.remove('open');
    }
    if (!document.getElementById('portnum-filter-wrap').contains(e.target)) {
      closePortnumFilterPanel();
    }
  });
}

document.addEventListener('DOMContentLoaded', bootLive);
