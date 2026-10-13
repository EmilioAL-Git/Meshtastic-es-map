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

// ─── Filtro "solo favoritos" ────────────────────────────────────────────────
// Distinto del "Modo Focus" (liveFocusNodeId, un solo nodo con seguimiento
// de sonido/URL): esto es un filtro simple sobre el conjunto de nodos que
// el usuario ya marcó como favoritos (state.js, compartido con el mapa).
let favoritesOnlyFilter = false;

function toggleFavoritesOnly() {
  favoritesOnlyFilter = !favoritesOnlyFilter;
  const btn = document.getElementById('live-favorites-btn');
  if (btn) btn.classList.toggle('active', favoritesOnlyFilter);
}

function packetMatchesFavorites(event) {
  if (!favoritesOnlyFilter) return true;
  return isFavoriteNode(event.from) || isFavoriteNode(event.to);
}

// ─── Lista de nodos favoritos ("mis nodos") — desplegable junto al filtro ───
// En móvil el desplegable pasa a position:fixed (ver .fav-list-dropdown en
// style.css) porque .fav-list-wrap no está pegado al borde del header —
// hay otros botones detrás — así que un simple "right:0" relativo a él se
// salía de la pantalla. Con fixed hace falta fijar el "top" a mano.
function positionFavDropdown() {
  const dd = document.getElementById('fav-list-dropdown');
  const wrap = document.getElementById('fav-list-wrap');
  if (!dd || !wrap) return;
  if (!window.matchMedia('(max-width: 768px)').matches) { dd.style.top = ''; return; }
  dd.style.top = (wrap.getBoundingClientRect().bottom + 6) + 'px';
}

function toggleFavoritesList() {
  const dd = document.getElementById('fav-list-dropdown');
  if (!dd) return;
  const open = dd.classList.toggle('open');
  if (open) { positionFavDropdown(); renderFavoritesList(); }
}

function closeFavoritesList() {
  const dd = document.getElementById('fav-list-dropdown');
  if (dd) dd.classList.remove('open');
}

function renderFavoritesList() {
  const dd = document.getElementById('fav-list-dropdown');
  if (!dd) return;
  if (!favoriteNodes.size) {
    dd.innerHTML = `<div class="search-no-results">${escHtml(t('favorites.empty'))}</div>`;
    return;
  }
  const items = [...favoriteNodes]
    .map(id => nodesById.get(id))
    .filter(Boolean)
    .sort((a, b) => (a.long_name || a.node_id).localeCompare(b.long_name || b.node_id));
  dd.innerHTML = items.map(n => `
    <div class="search-result fav-list-row" data-id="${escHtml(n.node_id)}">
      <div class="result-name">${escHtml(n.long_name || n.short_name || n.node_id)}</div>
      <button class="search-fav-star active" data-fav-id="${escHtml(n.node_id)}" title="${escHtml(t('favorites.toggle'))}">★</button>
    </div>`).join('');

  dd.querySelectorAll('.fav-list-row').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.search-fav-star')) return;
      setFocusNode(el.dataset.id);
      closeFavoritesList();
    });
  });
  dd.querySelectorAll('.search-fav-star').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavoriteNode(el.dataset.favId);
      renderFavoritesList();
    });
  });
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
  });

  L.tileLayer(cartoTilesUrl('rastertiles/voyager'), {
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

