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

// ─── Modo kiosko: pantalla limpia, sin mover la cámara automáticamente ─────────
let liveKioskActive = false;
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
    <div class="lt-title">${t('live.topActiveSession')}</div>
    ${top.map(([id, count], i) => `
      <div class="lt-row">
        <span class="lt-rank">${i + 1}</span>
        <span class="lt-name">${nodeLabel(id)}</span>
        <span class="lt-count">${count}</span>
      </div>`).join('')}`;
}

// ─── "Latido" del mapa: destello breve en el gateway que sube un paquete ───────
// La atribución de gateway solo se conoce por etapa (stage.gateway_ids, ver
// packet_stage más abajo) — packet_new no trae esa información todavía.
let gatewayHeartbeatLayer; // L.layerGroup de destellos, cada uno se autodestruye
const GATEWAY_UPLOAD_FLASH_MS = 900; // debe casar con @keyframes gw-upload-ring-out/dot-fade

function makeGatewayUploadIcon() {
  return L.divIcon({
    html: `<div class="gw-upload-marker">
        <div class="gw-upload-ring"></div>
        <div class="gw-upload-dot">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 15V9" stroke="#1e293b" stroke-width="1.4" stroke-linecap="round"/>
            <circle cx="8" cy="6.6" r="1.2" fill="#1e293b"/>
            <path d="M5.6 5A3.2 3.2 0 0 1 8 3.7 3.2 3.2 0 0 1 10.4 5" stroke="#1e293b" stroke-width="1.2" stroke-linecap="round"/>
            <path d="M3.9 3.2A5.8 5.8 0 0 1 8 1.4a5.8 5.8 0 0 1 4.1 1.8" stroke="#1e293b" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </div>
      </div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    className: '',
  });
}

// Destello puntual: aparece, se marca y se autodestruye — no queda nada fijo
// en el mapa, solo el instante en que el gateway sube el paquete al broker.
function flashGatewayUpload(gatewayId) {
  const pos = nodeLatLng(gatewayId);
  if (!pos) return;
  const marker = L.marker(pos, {
    pane: 'livePane',
    icon: makeGatewayUploadIcon(),
    interactive: false,
    zIndexOffset: 300,
  }).addTo(gatewayHeartbeatLayer);
  setTimeout(() => gatewayHeartbeatLayer.removeLayer(marker), GATEWAY_UPLOAD_FLASH_MS);
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
// Por encima de TRAIL_MAX_WAIT_MS (ver más abajo, junto a
// scheduleGatewayTrailDraw) — si no, un paquete con feed muy activo podía
// expirar por overflow de MAX_VISIBLE_PACKETS antes de que le diera tiempo
// siquiera a empezar a dibujarse en el mapa grande.
const TRAIL_GRACE_MS = 9000;

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
  if (!livePacketLog.size) { showToast(t('live.noPacketsYet')); return; }
  const packets = [...livePacketLog.values()];
  downloadFile(`meshtastic-live-${Date.now()}.json`, JSON.stringify(packets, null, 2), 'application/json');
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportSessionCSV() {
  if (!livePacketLog.size) { showToast(t('live.noPacketsYet')); return; }
  const header = ['packet_id', 'from', 'to', 'hop_start', 'channel', 'portnum', 'text', 'path_confidence', 'saltos'];
  const lines = [header.join(',')];
  for (const { info, stages, path_confidence } of livePacketLog.values()) {
    lines.push([
      info.packet_id, info.from, info.to, info.hop_start,
      info.channel, info.portnum, info.text, effectiveConfidence(path_confidence, stages), stages.length,
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

// Antes se animaba el mapa grande salto a salto según iban llegando los
// packet_stage, avanzando un índice fijo (legIndex) sobre tracked.stages —
// pero una etapa sin ningún gateway con posición conocida en ese momento se
// saltaba PARA SIEMPRE, aunque esa misma etapa consiguiera un gateway con
// posición conocida en un packet_stage posterior (el índice ya la había
// dejado atrás). El mini-mapa del desglose sí recalcula en frío con los
// datos más recientes, así que divergía del mapa grande (visto en la
// conversación: una línea recta larga en el grande frente a una ruta con
// más puntos intermedios en el desglose).
//
// buildGatewayLegs() reconstruye la lista de puntos DESDE CERO en cada
// packet_stage (misma lógica que buildPacketPath, usado por el mini-mapa),
// así que nunca pierde un salto que se resuelve tarde.
//
// Pero reaccionar a CADA packet_stage al instante (versión anterior) tenía
// su propio problema: un paquete de varios saltos puede tardar bastantes
// segundos en tener todas sus etapas (visto en la conversación: 15s entre
// la primera y la última sighting del mismo paquete), y animar con datos a
// medias dibujaba saltos directos de un extremo a otro de España — el
// desglose, que carga el paquete ya completo desde el backend, sí lo
// dibujaba bien. Ahora se espera un pequeño "silencio" tras la última
// novedad (STAGE_QUIET_MS) antes de empezar a dibujar — cada packet_stage
// nuevo reinicia la espera — con un tope absoluto (TRAIL_MAX_WAIT_MS) para
// que un paquete con sightings muy espaciadas en el tiempo no se quede sin
// dibujar nunca ni se salga de la ventana visible (enforceLiveWindow) antes
// de que le toque.
//
// El mismo silencio se respeta también DESPUÉS de arrancar el dibujo
// (tracked.trailStarted): buildGatewayLegs() reconstruye la lista de legs
// desde cero en cada packet_stage, y un gateway que resuelve una etapa
// intermedia que antes se saltaba puede desplazar los índices de legs[]
// respecto a los ya animados — aplicar ese cambio al instante hacía que la
// línea ya dibujada "saltara" de sitio en cuanto llegaba el siguiente
// paquete. Esperar el mismo STAGE_QUIET_MS en cada redibujado (sin el tope
// TRAIL_MAX_WAIT_MS, que ya no aplica una vez hay algo en pantalla) reduce
// esos saltos a que solo se note un realineado tras una pausa real en el
// tráfico, no en cada evento suelto.
const STAGE_QUIET_MS = 1500;
const TRAIL_MAX_WAIT_MS = 8000;

function initLiveMap() {
  map = L.map('map', {
    center: [MAP_LAT, MAP_LNG],
    zoom: MAP_ZOOM,
    zoomControl: true,
    preferCanvas: true,
    zoomSnap: 0,
    zoomDelta: 0.5,
    scrollWheelZoom: false,
    smoothWheelZoom: true,
    smoothSensitivity: 1.8,
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
  gatewayHeartbeatLayer = L.layerGroup().addTo(map);

  applyAllLiveLayerVisibility();

  // El header de live.html envuelve en varias filas (fuentes cargando
  // tarde, badges/filtros que cambian de ancho, teclado/barra del
  // navegador en móvil...) sin que eso dispare un 'resize' de window.
  // Leaflet solo escucha window resize (trackResize), así que su tamaño
  // interno se queda obsoleto. invalidateSize() por defecto compensa
  // repartiendo la diferencia a partes iguales entre los lados
  // (panBy(diff/2)), asumiendo un resize simétrico — pero #map solo
  // encoge/crece por arriba (el header empuja el borde superior, el
  // inferior queda fijo al fondo del viewport), así que esa compensación
  // se queda corta. Guardamos el centro justo antes y lo reimponemos tras
  // invalidateSize para que el punto geográfico central no se mueva.
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      const center = map.getCenter();
      const zoom = map.getZoom();
      map.invalidateSize({ pan: false });
      map.setView(center, zoom, { animate: false });
    }).observe(map.getContainer());
  }
}

// La barra de línea de tiempo (#timeline-bar) es un overlay ABSOLUTO sobre
// el mapa (ver .timeline-bar en style.css): ocupa espacio visual en la
// franja inferior sin reducir el tamaño real del contenedor Leaflet. Como
// Leaflet centra el punto geográfico configurado en el centro del
// contenedor COMPLETO (incluyendo la franja tapada por la barra), ese
// centro queda por debajo del centro de la zona realmente visible — España
// aparece desplazada hacia abajo y se cuela Francia por arriba. Se llama
// una vez el arranque ha terminado (barra ya con su altura real, incluido
// el eje de tiempo que se rellena en initTimeline) para compensar
// desplazando la vista la mitad de esa altura tapada.
function compensateLiveMapForTimelineOverlay() {
  const bar = document.getElementById('timeline-bar');
  if (!map || !bar) return;
  const barHeight = bar.getBoundingClientRect().height;
  if (barHeight > 0) map.panBy([0, barHeight / 2], { animate: false });
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
  if (!r.ok) throw new Error(t('live.errorLoadingNodes'));
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
  setConnBadge('reconnecting', t('live.connecting'));
  liveWs = new WebSocket(liveWsUrl());

  liveWs.onopen = () => {
    liveBackoffMs = 1000;
    setConnBadge('connected', t('live.connected'));
  };

  liveWs.onmessage = (ev) => {
    if (livePaused) return;
    let event;
    try { event = JSON.parse(ev.data); } catch { return; }
    handleLiveEvent(event);
  };

  liveWs.onclose = () => {
    setConnBadge('reconnecting', t('live.reconnectingIn', { s: Math.round(liveBackoffMs / 1000) }));
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
      gatewayLegs: null, drawTimer: null, drawDeadline: performance.now() + TRAIL_MAX_WAIT_MS,
      trailStarted: false, trailLine: null, hitLine: null, trailConfirmed: [],
      firedGateways: new Set(), // gateways ya destellados para este paquete — 1 pulso cada uno, no más
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
    tracked.stages = event.stages;
    tracked.pathConfidence = event.path_confidence;
    tracked.info.route = event.route;
    tracked.info.route_back = event.route_back;
    updateLogRow(event);
    if (!inReplayView) {
      const lastStage = event.stages[event.stages.length - 1];
      // El mismo salto puede llegar en varios packet_stage según se suman
      // más gateways que lo oyeron — sin este filtro, cada uno de esos
      // eventos repetía el destello de los gateways ya vistos.
      if (lastStage) (lastStage.gateway_ids || []).forEach(gw => {
        if (tracked.firedGateways.has(gw)) return;
        tracked.firedGateways.add(gw);
        flashGatewayUpload(gw);
      });
    }
    // Una vez el paquete se confirma como traceroute (route/route_back del
    // propio firmware, salto a salto real) dejamos de animar por la
    // heurística de gateways — no coincide con la ruta real y confundía
    // más que ayudaba (ver conversación: el mapa grande no encajaba con el
    // desglose). advanceTraceroute() dibuja solo lo confirmado hasta ahora
    // y se re-invoca según route/route_back se van completando.
    if (tracked.pathConfidence === 'traceroute') advanceTraceroute(key);
    else scheduleGatewayTrailDraw(key);
  } else if (event.type === 'packet_expired') {
    expirePacket(key);
  }
}

// Varios gateways pueden compartir etapa (oyeron la misma transmisión). El
// representativo de la etapa no puede ser "el primero de la lista" (orden
// arbitrario del backend) — eso producía saltos sin sentido en el mapa: un
// paquete visto en Almería en la etapa anterior "saltaba" a un gateway en
// Mallorca a 700km solo porque venía primero en gateway_ids, cuando otro
// gateway de la misma etapa estaba a 70km de esa posición previa. Un
// gateway que oyó una etapa no implica que el paquete pasara físicamente
// cerca de él (puede oírlo por MQTT/topología, no por LoRa directo), así
// que "el más cercano al punto anterior" es la mejor aproximación
// disponible a dónde estuvo realmente el paquete en ese salto.
function pickStageGateway(stage, refPos) {
  if (!refPos) {
    for (const gw of stage.gateway_ids) {
      if (nodeLatLng(gw)) return gw;
    }
    return null;
  }
  const ref = L.latLng(refPos);
  let best = null, bestDist = Infinity;
  for (const gw of stage.gateway_ids) {
    const pos = nodeLatLng(gw);
    if (!pos) continue;
    const dist = ref.distanceTo(L.latLng(pos));
    if (dist < bestDist) { bestDist = dist; best = gw; }
  }
  return best;
}

function stagePosition(stage, refPos) {
  const gw = pickStageGateway(stage, refPos);
  return gw ? nodeLatLng(gw) : null;
}

function stageSiblingLines(stage, refPos) {
  // Cuando una misma etapa la oyen varios gateways a la vez, no solo se
  // anima hacia el representativo (stagePosition) — también se traza un
  // pequeño abanico hacia los demás que conozcamos, para que se vea que el
  // paquete "salió por varios sitios" en ese salto. Usada tanto por el mapa
  // grande como por el mini-mapa del desglose, para que no diverjan. El
  // representativo aquí debe ser el MISMO que eligió stagePosition (mismo
  // refPos), o el abanico saldría desde un nodo distinto de donde llegó la
  // línea principal.
  const repId = pickStageGateway(stage, refPos);
  if (!repId) return [];
  const rep = nodeLatLng(repId);
  const rest = stage.gateway_ids.filter(id => id !== repId).map(nodeLatLng).filter(Boolean);
  if (!rest.length) return [];
  return rest.map(pos => [rep, pos]);
}

// Anillo que se expande y se desvanece sobre un nodo — usado tanto en el
// origen de un paquete nuevo como en cualquier nodo que "recibe" algo
// durante la animación (llegada de un tramo, o de una de las líneas
// discontinuas de "también oído aquí"), para que el propio nodo reaccione
// visualmente, no solo la línea que llega hasta él.
function spawnNodePing(pos, color, { startRadius = 6, growBy = 18, durationMs = 900 } = {}) {
  if (!pos) return;
  const ring = L.circleMarker(pos, {
    pane: 'livePane', renderer: liveTraceRenderer, radius: startRadius, color, weight: 2,
    fillOpacity: 0, interactive: false,
  }).addTo(livePingLayer);

  const total = durationMs * packetAnimSlowdown();
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / total);
    ring.setRadius(startRadius + t * growBy);
    ring.setStyle({ opacity: 1 - t });
    if (t < 1) requestAnimationFrame(step);
    else livePingLayer.removeLayer(ring);
  }
  requestAnimationFrame(step);
}

function spawnOriginPing(event) {
  spawnNodePing(nodeLatLng(event.from), packetColor(event.packet_id));
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
  const leg = tracked.gatewayLegs && tracked.gatewayLegs[tracked.legIndex];
  if (leg && leg.hops != null) return leg.hops;
  return tracked.legIndex;
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
    pane: 'livePane',
    icon: L.divIcon({
      className: 'pkt-marker-wrap',
      html: markerIconHtml(tracked.color, point.hops, isOrigin, point.unknown, free),
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    }),
    interactive: true,
    bubblingMouseEvents: false,
  }).addTo(liveTrailLayer);
  marker.on('click', () => openPacketDetail(pktKey(tracked.info.packet_id, tracked.info.from)));
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
    // Invisible a propósito (opacity 0, solo ensancha el área pinchable) —
    // el fundido de expirePacket() no debe tocar su opacidad: si la anima
    // igual que las líneas visibles, el primer frame la sube de 0 a un
    // valor >0 y aparece de golpe como un flash negro grueso justo al
    // desaparecer el paquete.
    hit.isHitLine = true;
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

// Antes estas líneas se quedaban dibujadas de forma estática mientras
// durase el paquete entero (podían acumularse muchas y saturar la
// pantalla). Ahora cada una es un "flash" independiente — crece hacia el
// gateway, se mantiene un instante y se desvanece sola — igual de efímero
// para todas las etapas, en vez de ir apilándose.
function flashSiblingLine(tracked, a, b) {
  const line = L.polyline([a, a], {
    pane: 'livePane', renderer: liveTraceRenderer, color: tracked.color, weight: 2, opacity: 0,
    dashArray: '4 5', interactive: false,
  }).addTo(liveSiblingLayer);
  tracked.trails.push(line);

  const growMs = 350, holdMs = 650, fadeMs = 550;
  const totalMs = growMs + holdMs + fadeMs;
  const start = performance.now();
  const peakOpacity = 0.55;
  let pinged = false;

  function remove() {
    liveSiblingLayer.removeLayer(line);
    const idx = tracked.trails.indexOf(line);
    if (idx !== -1) tracked.trails.splice(idx, 1);
  }

  function step(now) {
    // Si el paquete expira a mitad del flash, expirePacket() ya se encarga
    // del fundido de todo tracked.trails — dejamos de tocar esta línea para
    // no pelearnos por su opacidad con esa otra animación.
    if (tracked.expiring) return;
    const elapsed = now - start;
    if (elapsed < growMs) {
      const e = easeInOutQuad(elapsed / growMs);
      line.setLatLngs([a, [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e]]);
      line.setStyle({ opacity: peakOpacity * e });
    } else if (elapsed < growMs + holdMs) {
      line.setLatLngs([a, b]);
      line.setStyle({ opacity: peakOpacity });
      if (!pinged) { pinged = true; spawnNodePing(b, tracked.color, { startRadius: 4, growBy: 10, durationMs: 500 }); }
    } else if (elapsed < totalMs) {
      line.setStyle({ opacity: peakOpacity * (1 - (elapsed - growMs - holdMs) / fadeMs) });
    } else {
      remove();
      return;
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function drawStageSiblingLines(tracked, stage, refPos) {
  for (const [a, b] of stageSiblingLines(stage, refPos)) flashSiblingLine(tracked, a, b);
}

// Misma secuencia y mismo filtro que la rama no-traceroute de
// buildPacketPath (usada por el mini-mapa del desglose) — origen si se
// conoce su posición, luego cada etapa con algún gateway de posición
// conocida — pero conservando además la `stage` de origen de cada punto
// (para las líneas de "también oído aquí") y el nº de saltos ya calculado,
// que buildPacketPath no expone porque el mini-mapa no los necesita.
function buildGatewayLegs(tracked) {
  const legs = [];
  const originPos = nodeLatLng(tracked.info.from);
  if (originPos) legs.push({ pos: originPos, stage: null, hops: 0 });
  for (const stage of tracked.stages) {
    const refPos = legs.length ? legs[legs.length - 1].pos : null;
    const pos = stagePosition(stage, refPos);
    if (pos) {
      const hops = tracked.info.hop_start != null ? Math.max(0, tracked.info.hop_start - stage.hop_limit) : null;
      legs.push({ pos, stage, hops });
    }
  }
  return legs;
}

// Se llama en cada packet_stage (ver handleLiveEvent) — reconstruye la
// lista de puntos con lo que se sepa HASTA AHORA y deja que animateNextLeg
// continúe desde donde se quedó. Si todavía no hay ni un segundo punto (el
// origen y como mucho un gateway, o ninguno) no hay nada que animar aún;
// se reintentará solo cuando llegue el próximo packet_stage con más datos,
// no hace falta ningún temporizador de por medio.
function refreshGatewayTrail(packetId) {
  const tracked = liveTracked.get(packetId);
  if (!tracked || tracked.expiring || tracked.isTraceroute) return;
  const legs = buildGatewayLegs(tracked);
  if (legs.length < 2) return;
  // El marcador animado (tracked.marker/tracked.halo) es uno solo y se
  // reutiliza tramo a tramo — en cuanto avanza al siguiente salto, el
  // origen se queda sin ningún indicador propio. Un "dedo" fijo en el
  // origen (igual que dropHopMarker hace por cada salto de un traceroute)
  // deja constancia de dónde arrancó el paquete durante toda su vida en el
  // mapa, no solo mientras el marcador animado sigue ahí.
  // isOrigin=false a propósito: esa clase CSS (.pkt-marker-origin, 24px con
  // anillo) se diseñó para el marcador de origen del mini-mapa del
  // desglose, mucho más grande que cualquier otro punto del mapa grande —
  // aquí solo queremos el tamaño normal (18px) para que no destaque de más
  // frente al resto de marcadores del mapa grande.
  if (!tracked.gatewayLegs) dropHopMarker(tracked, legs[0].pos, legs[0], false, null);
  tracked.gatewayLegs = legs;
  animateNextLeg(packetId);
}

// Reinicia la cuenta atrás de STAGE_QUIET_MS cada vez que llega un
// packet_stage nuevo mientras el dibujo del mapa grande aún no ha
// arrancado — el paquete solo empieza a animarse cuando pasa un rato sin
// novedades (o se alcanza TRAIL_MAX_WAIT_MS desde packet_new, lo primero
// que llegue). Ver comentario de STAGE_QUIET_MS/TRAIL_MAX_WAIT_MS más
// arriba para el motivo.
function scheduleGatewayTrailDraw(packetId) {
  const tracked = liveTracked.get(packetId);
  if (!tracked) return;
  if (tracked.drawTimer) clearTimeout(tracked.drawTimer);
  // Antes de trailStarted respetamos el tope TRAIL_MAX_WAIT_MS desde
  // packet_new (para que el primer trazo no tarde eternamente). Una vez ya
  // hay algo dibujado ese tope deja de tener sentido — no hay prisa por
  // volver a redibujar, así que se espera el silencio completo cada vez.
  const wait = tracked.trailStarted
    ? STAGE_QUIET_MS
    : Math.max(0, Math.min(STAGE_QUIET_MS, tracked.drawDeadline - performance.now()));
  tracked.drawTimer = setTimeout(() => startGatewayTrail(packetId), wait);
}

function startGatewayTrail(packetId) {
  const tracked = liveTracked.get(packetId);
  if (!tracked || tracked.expiring || tracked.isTraceroute) return;
  tracked.drawTimer = null;
  tracked.trailStarted = true;
  refreshGatewayTrail(packetId);
}

function animateNextLeg(packetId) {
  const tracked = liveTracked.get(packetId);
  // tracked.animating evita lanzar dos animaciones a la vez sobre el mismo
  // marcador — el propio step() encadena el siguiente tramo pendiente al
  // terminar, así que aquí basta con no hacer nada.
  if (!tracked || tracked.expiring || tracked.animating) return;
  const legs = tracked.gatewayLegs;
  if (!legs || tracked.legIndex >= legs.length - 1) return;

  const fromPos = legs[tracked.legIndex].pos;
  tracked.legIndex++;
  const toLeg = legs[tracked.legIndex];
  const toPos = toLeg.pos;

  ensureMarker(tracked, fromPos);
  updateMarkerHops(tracked);
  tracked.animating = true;

  // Una sola polyline por paquete que va CRECIENDO (no una nueva por
  // tramo) — con una línea nueva por salto, dos tramos consecutivos
  // comparten vértice pero son dos trazos distintos que se solapan justo
  // ahí; ese pico de opacidad doble en el punto de unión se notaba sobre
  // todo durante el fundido lento de expirePacket() (700ms), como una
  // sombra que se acentuaba justo donde convergían/divergían tramos.
  if (!tracked.trailLine) {
    tracked.trailConfirmed = [fromPos];
    tracked.trailLine = L.polyline([fromPos], {
      pane: 'livePane', renderer: liveTraceRenderer, color: tracked.color, weight: 2.5, opacity: 0.75,
      interactive: false,
    }).addTo(liveTrailLayer);
    tracked.trails.push(tracked.trailLine);

    // Línea invisible mucho más ancha por debajo, solo para el click — la
    // visible (2.5px) es un objetivo demasiado fino para acertar con el
    // ratón. Mismo patrón que el "hit" de createTraceLines() para las
    // líneas de traceroute.
    tracked.hitLine = L.polyline([fromPos], {
      pane: 'livePane', renderer: liveTraceRenderer, color: '#000', opacity: 0, weight: 14,
      interactive: true, bubblingMouseEvents: false,
    }).addTo(liveTrailLayer);
    tracked.hitLine.isHitLine = true;
    tracked.hitLine.on('click', () => openPacketDetail(pktKey(tracked.info.packet_id, tracked.info.from)));
    tracked.trails.push(tracked.hitLine);
  }
  const { trailLine, hitLine, trailConfirmed } = tracked;

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
    trailLine.setLatLngs([...trailConfirmed, [lat, lng]]);
    hitLine.setLatLngs([...trailConfirmed, [lat, lng]]);
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      tracked.animating = false;
      trailConfirmed.push(toPos);
      spawnNodePing(toPos, tracked.color, { startRadius: 5, growBy: 12, durationMs: 600 });
      // El abanico hacia los demás gateways que oyeron esta etapa se
      // dispara AL LLEGAR, no al salir — si no, el flash aparecía antes de
      // que el punto principal hubiera recorrido el tramo, como si el
      // paquete ya estuviera en dos sitios a la vez.
      if (toLeg.stage) drawStageSiblingLines(tracked, toLeg.stage, fromPos);
      if (tracked.legIndex < legs.length - 1) animateNextLeg(packetId);
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
  if (tracked.drawTimer) { clearTimeout(tracked.drawTimer); tracked.drawTimer = null; }

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
      if (l.isHitLine) continue;
      if (l instanceof L.Polyline) l.setStyle({ opacity: opacity * 0.55 });
      else if (l instanceof L.Marker) {
        // Las flechas de dirección de un tramo de traceroute son L.Marker
        // (divIcon), no L.Path — no tienen .setStyle(), su opacidad se anima
        // igual que tracked.marker: tocando el elemento DOM directamente.
        const el = l.getElement();
        if (el) el.style.opacity = opacity;
      }
      // El halo (único que cae aquí: CircleMarker, no Polyline ni Marker)
      // nace con fillOpacity 0.25 — ponerle fillOpacity directamente al
      // progreso del fundido (que empieza en 1) lo disparaba a opacidad
      // TOTAL en el primer frame de la expiración, antes de bajar: un
      // resplandor/sombra que se encendía de golpe justo al desaparecer,
      // en vez de simplemente atenuarse. Hay que escalarlo relativo a su
      // opacidad base, no sustituirla.
      else l.setStyle({ opacity: opacity * 0.25, fillOpacity: opacity * 0.25 });
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
    stages: stageEvent.stages,
  });
}

function nodeLabel(nodeId) {
  if (!nodeId) return '?';
  if (nodeId === '!ffffffff') return t('live.broadcastAll');
  const n = nodesById.get(nodeId);
  return n && n.long_name ? escHtml(n.long_name) : escHtml(nodeId);
}

// relay_node en el protobuf de Meshtastic es solo el ÚLTIMO BYTE del
// node_id real (ver docstring de detectFreeHops), así que por sí solo no
// identifica a un nodo. Con una red nacional de miles de nodos, ese byte
// (256 valores posibles) casi siempre coincide con varios nodos a la vez
// — comparar contra TODOS los nodos de España es inútil (con ~2800 nodos,
// pigeonhole hace que el 99.9% de los bytes ya estén repetidos).
//
// Algoritmo inspirado en el "hash prefix disambiguation" de CoreScope
// (proyecto hermano para MeshCore, mismo problema con hashes de 1 byte —
// ver docs/HASH-PREFIX-DISAMBIGUATION.md de ese repo):
//   1. Candidatos triviales: si el byte solo coincide con 0 o 1 nodo a
//      nivel nacional, resuelto sin más (0 → nada, 1 → confirmado).
//   2. Si hay varios candidatos, se desambigua por evidencia física: el
//      nodo tuvo que estar dentro de alcance LoRa (RELAY_RANGE_M) de algún
//      "ancla" — los gateways que oyeron esa etapa, o (encadenado) la
//      posición ya resuelta de la etapa vecina del MISMO paquete (pase
//      hacia delante y luego hacia atrás por `stages`, que ya vienen en
//      orden cronológico). Los nodos sin posición conocida no se pueden
//      descartar por distancia; si además tienen un edge real (visto en
//      edges.json) con alguna de las anclas, cuentan como candidato viable
//      igualmente (evidencia topológica en vez de geográfica).
//   3. Si tras filtrar sobrevive un único candidato → 'confirmed'. Si
//      sobreviven varios, nos quedamos con el más cercano al ancla en vez
//      de rendirnos (como hacía la versión anterior) — pero marcado
//      'estimated', nunca como si fuera un hecho verificado.
const RELAY_RANGE_M = 50000;

// Un nodo apagado hace días sigue siendo el candidato más cercano si nunca
// se mueve, así que sin este filtro "gana" el desempate por distancia aunque
// no pudiera haber retransmitido nada. Se descartan candidatos sin actividad
// en las últimas 24h (mismo umbral que el resto del proyecto).
const RELAY_CANDIDATE_MAX_AGE_MIN = 1440;

function relayCandidatesByByte(lastByte) {
  const out = [];
  for (const [id, n] of nodesById) {
    if (id.slice(-2).toLowerCase() !== lastByte) continue;
    if (n.last_seen_ago_min != null && n.last_seen_ago_min >= RELAY_CANDIDATE_MAX_AGE_MIN) continue;
    out.push(id);
  }
  return out;
}

function resolvePacketRelays(stages) {
  const n = (stages || []).length;
  const candidates = new Array(n).fill(null).map((_, i) =>
    stages[i].relay_node ? relayCandidatesByByte(stages[i].relay_node.slice(-2).toLowerCase()) : []);
  const resolved = new Array(n).fill(null);
  const confidence = new Array(n).fill(null);

  function attempt(i, extraAnchorId, extraAnchorConfidence) {
    if (resolved[i] || candidates[i].length === 0) return;
    if (candidates[i].length === 1) { resolved[i] = candidates[i][0]; confidence[i] = 'confirmed'; return; }

    const anchorIds = [...(stages[i].gateway_ids || [])];
    if (extraAnchorId) anchorIds.push(extraAnchorId);
    const anchorPts = anchorIds.map(nodeLatLng).filter(Boolean).map(([lat, lon]) => L.latLng(lat, lon));
    if (!anchorPts.length) return; // sin ancla todavía — se reintenta en el siguiente pase

    const linked = new Set();
    for (const e of allEdges) {
      if (anchorIds.includes(e.from_node)) linked.add(e.to_node);
      if (anchorIds.includes(e.to_node)) linked.add(e.from_node);
    }

    const scored = [];
    for (const id of candidates[i]) {
      const pos = nodeLatLng(id);
      if (pos) {
        const p = L.latLng(pos[0], pos[1]);
        const dist = Math.min(...anchorPts.map(a => a.distanceTo(p)));
        if (dist <= RELAY_RANGE_M) scored.push({ id, dist });
      } else if (linked.has(id)) {
        scored.push({ id, dist: Infinity }); // viable por topología, sin distancia real para desempatar
      }
    }
    if (!scored.length) return;
    scored.sort((a, b) => a.dist - b.dist);
    resolved[i] = scored[0].id;
    // Si el desempate dependió de un ancla encadenada que a su vez era solo
    // 'estimated' (una suposición, no un hecho), no se puede heredar
    // 'confirmed' — sería presentar una cadena de suposiciones como certeza.
    const chainedGuess = extraAnchorId && extraAnchorConfidence === 'estimated';
    confidence[i] = (scored.length === 1 && !chainedGuess) ? 'confirmed' : 'estimated';
  }

  for (let i = 0; i < n; i++) attempt(i, null, null);
  for (let i = 1; i < n; i++) attempt(i, resolved[i - 1], confidence[i - 1]);
  for (let i = n - 2; i >= 0; i--) attempt(i, resolved[i + 1], confidence[i + 1]);

  return stages.map((_, i) => ({ id: resolved[i], confidence: confidence[i] }));
}

// Un paquete solo se marca como "confirmado" si al menos una etapa resuelve
// su relay_node a un único nodo con certeza ('confirmed') — un 'estimated'
// (mejor candidato entre varios) no basta para esa etiqueta, aunque sí se
// muestra como pista en el desglose de saltos.
function effectiveConfidence(path_confidence, stages) {
  if (path_confidence !== 'relay_node') return path_confidence;
  const confirmed = resolvePacketRelays(stages || []).some(r => r.confidence === 'confirmed');
  return confirmed ? 'relay_node' : 'gateway_heuristic';
}

// meshview identifica un paquete solo por su packet_id (32 bits, sin el
// nodo origen) — igual de ambiguo que relay_node en teoría, pero es el
// único enlace que expone su web, así que es la mejor referencia cruzada
// disponible para comparar "lo que vemos aquí" con la fuente original.
function meshviewPacketUrl(packetId) {
  return `https://meshview.meshtastic.es/packet/${packetId}`;
}

function renderLogRow(info, { hops, path_confidence, stages }) {
  path_confidence = effectiveConfidence(path_confidence, stages);
  const confClass = path_confidence === 'traceroute' ? 'lr-conf-traceroute'
    : path_confidence === 'relay_node' ? 'lr-conf-relay' : 'lr-conf-heuristic';
  const confLabel = path_confidence === 'traceroute' ? t('live.route.exactShort')
    : path_confidence === 'relay_node' ? t('live.route.confirmedShort') : t('live.route.approxShort');
  const color = packetColor(info.packet_id);
  const textHtml = info.text
    ? `<div class="lr-text">💬 “${escHtml(info.text)}”</div>`
    : '';
  return `
    <div class="lr-route"><span class="lr-swatch" style="background:${color};box-shadow:0 0 5px ${color}"></span>${nodeLabel(info.from)} → ${nodeLabel(info.to)}</div>
    ${textHtml}
    <div class="lr-meta">
      <span>${tp('live.hopCount', hops, { n: hops })}</span>
      <span>${escHtml(info.portnum || t('common.dash'))}</span>
      <span class="${confClass}">${confLabel}</span>
    </div>`;
}

// ─── Desglose de paquete ────────────────────────────────────────────────────

function formatTime(unixSeconds) {
  if (!unixSeconds) return t('common.dash');
  return new Date(unixSeconds * 1000).toLocaleTimeString(getLocale());
}

function nodeLabelFull(nodeId) {
  if (!nodeId) return '—';
  if (nodeId === '!ffffffff') return t('live.broadcastAllFull');
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
  const relays = resolvePacketRelays(data.stages);
  data.stages.forEach((stage, i) => {
    for (const gw of stage.gateway_ids) ids.add(gw);
    // Solo cuenta relays 'confirmed' — un 'estimated' es el mejor candidato,
    // no un hecho, y no debe inflar la cifra mostrada al usuario.
    if (relays[i].confidence === 'confirmed') ids.add(relays[i].id);
  });
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
  if (!data) return `<p class="malconfig-empty">${t('live.packetDetail.noData')}</p>`;
  const { info, stages } = data;
  const path_confidence = effectiveConfidence(data.path_confidence, stages);
  const isTraceroute = path_confidence === 'traceroute';
  const confLabel = isTraceroute
    ? t('live.route.exactLong')
    : path_confidence === 'relay_node'
      ? t('live.route.confirmedLong')
      : t('live.route.approxLong');
  const reachedCount = estimateReachedNodes(data).size;

  const traceIds = isTraceroute ? traceRouteIds(data) : null;
  const freeHops = isTraceroute ? detectFreeHops(traceIds.slice(1), stages, info.hop_start) : null;
  const packetRelays = isTraceroute ? null : resolvePacketRelays(stages);
  const hopsHtml = isTraceroute
    ? traceIds.map((id, i) => {
        const known = !!nodeLatLng(id);
        const roleLabel = i === 0 ? t('live.hop.origin') : i === traceIds.length - 1 ? t('live.hop.destination') : t('live.hop.hopN', { n: i });
        const free = i > 0 ? freeHops.get(id) : null;
        const freeBadge = free && free.free
          ? (free.certain
            ? `<span class="pkt-hop-free certain" title="${t('live.hop.reducedCertainTitle')}">${t('live.hop.reducedCertain')}</span>`
            : `<span class="pkt-hop-free" title="${t('live.hop.reducedGuessTitle')}">${t('live.hop.reducedGuess')}</span>`)
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
      ? stages.map((s, i) => {
        const relay = packetRelays[i];
        const chipClass = relay.confidence === 'confirmed' ? ' relay'
          : relay.confidence === 'estimated' ? ' relay-guess' : '';
        const chipIcon = relay.confidence === 'confirmed' ? '🔗 ' : relay.confidence === 'estimated' ? '🔗? ' : '';
        const chipTitle = relay.confidence === 'estimated'
          ? ` title="${t('live.hop.bestCandidateTitle')}"` : '';
        return `
        <div class="pkt-hop">
          <div class="pkt-hop-num">${i + 1}</div>
          <div class="pkt-hop-body">
            <div class="pkt-hop-meta">
              <span>hop_limit ${s.hop_limit}</span>
              <span>${formatTime(s.rx_time)}</span>
            </div>
            <div class="pkt-hop-gateways">
              ${s.gateway_ids.map(gw => `<span class="pkt-gw-chip${gw === relay.id ? chipClass : ''}">${gw === relay.id ? chipIcon : ''}${nodeLabel(gw)}</span>`).join('')}
              ${relay.id && !s.gateway_ids.includes(relay.id) ? `<span class="pkt-gw-chip${chipClass}"${chipTitle}>${chipIcon}${nodeLabel(relay.id)}</span>` : ''}
            </div>
          </div>
        </div>`;
      }).join('')
      : `<p class="pkt-hop-empty">${t('live.hop.noHopsYet')}</p>`);

  const textRow = info.text
    ? `<tr><td>${t('live.packetDetail.message')}</td><td>💬 “${escHtml(info.text)}”</td></tr>`
    : '';

  return `
    <table class="malconfig-table pkt-kv">
      <tr><td>${t('live.packetDetail.packetId')}</td><td>${info.packet_id} · <a class="lr-meshview" href="${meshviewPacketUrl(info.packet_id)}" target="_blank" rel="noopener">${t('live.packetDetail.viewOnMeshview')}</a></td></tr>
      <tr><td>${t('live.packetDetail.origin')}</td><td>${nodeLabelFull(info.from)}</td></tr>
      <tr><td>${t('live.packetDetail.destination')}</td><td>${nodeLabelFull(info.to)}</td></tr>
      <tr><td>hop_start</td><td>${info.hop_start ?? t('common.dash')}</td></tr>
      <tr><td>${t('live.packetDetail.channel')}</td><td>${info.channel ?? t('common.dash')}</td></tr>
      <tr><td>${t('live.packetDetail.type')}</td><td>${escHtml(info.portnum || t('common.dash'))}</td></tr>
      ${textRow}
      <tr><td>${t('live.packetDetail.routeConfidence')}</td><td>${confLabel}</td></tr>
      <tr><td>${t('live.packetDetail.nodesReached')}</td><td>~${reachedCount} <span class="pkt-reached-hint" title="${t('live.packetDetail.reachedHint')}">${t('live.packetDetail.approx')}</span></td></tr>
    </table>
    <h4 class="pkt-hops-title">
      ${t('live.packetDetail.hopsDetected', { n: isTraceroute ? traceIds.length : stages.length })}
      <span class="pkt-hops-hint">${isTraceroute ? t('live.packetDetail.hopsHintTraceroute') : t('live.packetDetail.hopsHintHeuristic')}</span>
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
    const frac = (i - prevIdx) / (nextIdx - prevIdx);
    const a = positions[prevIdx], b = positions[nextIdx];
    points.push({
      pos: [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac],
      label: `${labelFor(ids[i], i)} — ${t('live.hop.unknownPosition')}`,
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
    if (i === 0) return `${nodeLabel(id)} (${t('live.hop.origin')})`;
    if (i === ids.length - 1) return `${nodeLabel(id)} (${t('live.hop.destination')})`;
    return `${nodeLabel(id)} — ${t('live.hop.hopN', { n: i })} (traceroute)`;
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
  if (originPos) points.push({ pos: originPos, label: `${nodeLabel(data.info.from)} (${t('live.hop.origin')})`, hops: 0 });
  for (const stage of data.stages) {
    const refPos = points.length ? points[points.length - 1].pos : null;
    const pos = stagePosition(stage, refPos);
    if (pos) {
      const hops = data.info.hop_start != null ? Math.max(0, data.info.hop_start - stage.hop_limit) : null;
      points.push({ pos, label: `hop_limit ${stage.hop_limit} — ${stage.gateway_ids.map(nodeLabel).join(', ')}`, hops, stage });
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
      scrollWheelZoom: true,
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
    // Se itera sobre `points` (no sobre data.stages directamente) porque el
    // representativo del abanico tiene que coincidir con el punto que ya
    // eligió buildPacketPath para esa etapa (mismo refPos: el punto
    // anterior en la ruta) — si no, el abanico saldría desde un nodo
    // distinto de donde llegó la línea principal.
    points.forEach((p, i) => {
      if (!p.stage) return; // origen: sin etapa asociada
      const refPos = points[i - 1].pos;
      for (const [a, b] of stageSiblingLines(p.stage, refPos)) {
        L.polyline([a, b], { color, weight: 1.5, opacity: 0.45, dashArray: '3 4' }).addTo(detailMapLayer);
        L.circleMarker(b, {
          radius: 4, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.7,
        }).bindTooltip(`hop_limit ${p.stage.hop_limit} — también oído aquí`, { direction: 'top' }).addTo(detailMapLayer);
        allPositions.push(b);
      }
    });
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
    showToast(t('live.linkCopied'));
  } catch {
    showToast(t('live.copyFailed'));
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
    if (!r.ok) { showToast(t('live.packetExpired')); return; }
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
    showToast(t('live.sharedPacketError'));
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
    dd.innerHTML = `<div class="search-no-results">${t('search.noResults')}</div>`;
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
    if (tracked.drawTimer) clearTimeout(tracked.drawTimer);
  }
  liveTracked.clear();
  livePacketLog.clear();
  for (const timer of pendingTrailRemovals.values()) clearTimeout(timer);
  pendingTrailRemovals.clear();
  liveOrder = [];
  document.getElementById('live-log-rows').innerHTML = `<div class="live-log-empty" id="live-log-empty">${t('live.waitingPackets')}</div>`;
  nodeActivityCount.clear();
  renderTopNodes();
  gatewayHeartbeatLayer.clearLayers();
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

// ─── Modo kiosko ────────────────────────────────────────────────────────────
// Solo pantalla limpia (oculta header/leyenda/timeline/log) + encuadre
// general al entrar. Sin cámara automática: los paquetes ya se animan solos
// sobre el mapa, seguirlos con la cámara daba saltos que no aportaban nada.
function liveKioskFitAll() {
  const pts = allNodes.filter(n => n.latitude != null).map(n => [n.latitude, n.longitude]);
  if (pts.length < 2) return;
  const bounds = L.latLngBounds(pts);
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
}

function enterLiveKiosk() {
  closePortnumFilterPanel();
  document.getElementById('focus-dropdown').classList.remove('open');

  document.body.classList.add('live-kiosk-mode');
  liveKioskActive = true;
  document.getElementById('live-kiosk-exit-btn').classList.add('visible');

  // Ocultar header/leyenda/timeline cambia el tamaño del contenedor del
  // mapa, lo que dispara el ResizeObserver de initLiveMap() (líneas ~327):
  // hace un map.setView(centro, zoom, {animate:false}) para compensar, y si
  // eso llega justo antes de nuestro fitBounds lo cancela en seco. Se
  // espera a que ese ajuste se asiente antes de encuadrar la red.
  setTimeout(() => {
    if (liveKioskActive) liveKioskFitAll();
  }, 250);
}

function exitLiveKiosk() {
  liveKioskActive = false;
  document.body.classList.remove('live-kiosk-mode');
  document.getElementById('live-kiosk-exit-btn').classList.remove('visible');
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

function formatAxisTime(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const time = d.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  if (timelineRangeS <= 43200) return time; // 1h/12h: solo hora
  return d.toLocaleDateString(getLocale(), { day: '2-digit', month: '2-digit' }) + ' ' + time;
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
  if (replayCursorTime == null) { el.textContent = ''; return; }
  const d = new Date(replayCursorTime * 1000);
  const time = d.toLocaleTimeString(getLocale(), { hour12: false });
  el.textContent = timelineRangeS <= 43200
    ? time // 1h/12h: solo hora
    : d.toLocaleDateString(getLocale(), { day: '2-digit', month: '2-digit' }) + ' ' + time;
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
    showToast(t('live.historyLoadError'));
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
  const count = bucket ? bucket.count : 0;
  tooltip.textContent = `${label} — ${tp('live.packetCount', count, { n: count })}`;
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
  document.getElementById('pause-label').textContent = livePaused ? t('live.resume') : t('live.pause');
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
  // La línea de tiempo va centrada y con un ancho máximo (min(560px, ...)),
  // la leyenda pegada a la derecha — en ventanas anchas ni se tocan. Subir
  // la leyenda para esquivarla solo hace falta cuando de verdad se
  // solapan en horizontal; si no, se queda abajo del todo (bottom base),
  // que es donde tiene que estar.
  const legendRect = legend.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  const overlapsHorizontally = legendRect.left < barRect.right && legendRect.right > barRect.left;
  if (!overlapsHorizontally) {
    legend.style.bottom = '';
    return;
  }
  const barBottom = parseFloat(getComputedStyle(bar).bottom) || 0;
  legend.style.bottom = (barBottom + bar.offsetHeight + 10) + 'px';
}

// Un único cálculo tras cargar podía quedar mal si la barra (o la
// ventana) cambia después — fuentes cargando tarde, resize, la leyenda
// colapsándose/expandiéndose... Un ResizeObserver sobre .timeline-bar
// coge los cambios de tamaño de la barra; el listener de resize de
// window coge además los casos en que la barra ya está en su ancho
// máximo (no cambia de tamaño) pero su posición centrada sí se mueve
// respecto a la leyenda al ensanchar/estrechar la ventana.
function initLegendTimelineOffset() {
  const bar = document.getElementById('timeline-bar');
  if (!bar) return;
  if (window.ResizeObserver) {
    new ResizeObserver(positionLegendAboveTimeline).observe(bar);
  }
  window.addEventListener('resize', positionLegendAboveTimeline);
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
  compensateLiveMapForTimelineOverlay();
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
    if (liveKioskActive) { exitLiveKiosk(); return; }
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
