// ─── Boot ───────────────────────────────────────────────────────────────────

function toggleLiveLogPanel() {
  const panel = document.getElementById('live-log');
  const open = panel.classList.toggle('open');
  document.getElementById('live-log-toggle-btn').classList.toggle('active');
  // Cada apertura arranca con la altura por defecto (CSS) — el arrastre
  // del tirador es un ajuste puntual, no un tamaño que deba persistir.
  if (open) {
    panel.style.height = '';
    maybeShowLogHandleHint();
  }
}

// ─── Aviso de gesto (una sola vez): el tirador del panel se puede arrastrar ──
// Nadie descubre por su cuenta que ese tirador estira el panel — un aviso
// que se muestra una vez (localStorage) y se desvanece solo, o al primer
// arrastre. prefers-reduced-motion solo quita la transición de aparición
// (fade+slide): el aviso en sí es información funcional, no una animación
// decorativa, así que ocultarlo del todo dejaría a quien pide menos
// movimiento sin enterarse nunca de que el tirador se puede arrastrar.
const GESTURE_HINT_KEY = 'mesh_live_gesture_hint_seen';

function maybeShowLogHandleHint() {
  if (!window.matchMedia('(max-width: 768px)').matches) return;
  try { if (localStorage.getItem(GESTURE_HINT_KEY)) return; } catch { return; }
  const handle = document.getElementById('live-log-handle');
  if (!handle || handle.querySelector('.gesture-hint')) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hint = document.createElement('div');
  hint.className = 'gesture-hint' + (reduceMotion ? ' no-anim' : '');
  hint.textContent = t('live.dragHandleHint');
  handle.appendChild(hint);
  requestAnimationFrame(() => hint.classList.add('show'));

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    try { localStorage.setItem(GESTURE_HINT_KEY, '1'); } catch {}
    hint.classList.remove('show');
    setTimeout(() => hint.remove(), 400);
  };
  setTimeout(dismiss, 4000);
  handle.addEventListener('pointerdown', dismiss, { once: true });
}

// ─── Panel de paquetes en móvil: estirable desde el tirador superior ───────
function initLiveLogResize() {
  const handle = document.getElementById('live-log-handle');
  const panel = document.getElementById('live-log');
  if (!handle || !panel) return;
  let dragging = false, startY = 0, startH = 0;

  function onPointerDown(e) {
    if (!window.matchMedia('(max-width: 768px)').matches) return;
    dragging = true;
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    handle.classList.add('dragging');
    try { handle.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!dragging) return;
    // El tirador está arriba del panel: subir el dedo/ratón (deltaY
    // negativo) debe agrandar el panel, de ahí startY - clientY.
    const delta = startY - e.clientY;
    const minH = 120;
    const maxH = window.innerHeight * 0.9;
    const h = Math.min(maxH, Math.max(minH, startH + delta));
    panel.style.height = h + 'px';
  }
  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch {}
  }

  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);
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

// ─── Leyenda en móvil: botón flotante, sin persistir estado (siempre
// cerrada al cargar la página) — en pantallas pequeñas no hay sitio para
// tenerla siempre visible como en escritorio.
function toggleLiveLegendMobile() {
  const legend = document.getElementById('live-legend');
  const btn = document.getElementById('live-legend-toggle-btn');
  if (!legend || !btn) return;
  const open = legend.classList.toggle('mobile-open');
  btn.classList.toggle('active', open);
}

// La leyenda debe quedar lo más abajo posible sin tapar la línea de
// tiempo — se mide la altura real de .timeline-bar y se apoya justo
// encima. Un valor fijo no vale: la barra cambia de alto según cuánto
// envuelvan sus controles (ancho de ventana, idioma...).
function positionLegendAboveTimeline() {
  const legend = document.getElementById('live-legend');
  const bar = document.getElementById('timeline-bar');
  if (!legend || !bar) return;
  // En móvil la leyenda es un panel flotante anclado arriba (botón
  // toggleable), no pegada abajo junto a la línea de tiempo — no tocar su
  // "bottom" aquí o se pisa el posicionamiento fijado por CSS.
  if (window.matchMedia('(max-width: 768px)').matches) return;
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
    if (cfg.carto_api_key) CARTO_API_KEY = cfg.carto_api_key;
  } catch { /* config.json es opcional aquí, se usan los valores por defecto */ }

  initLiveMap();
  syncLiveLegendToggles();
  syncPortnumFilterButtons();
  initLegendCollapse();
  initLiveLogResize();
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
    closeFavoritesList();
    document.getElementById('focus-dropdown').classList.remove('open');
  });

  document.addEventListener('click', (e) => {
    if (!document.getElementById('focus-wrap').contains(e.target)) {
      document.getElementById('focus-dropdown').classList.remove('open');
    }
    if (!document.getElementById('portnum-filter-wrap').contains(e.target)) {
      closePortnumFilterPanel();
    }
    if (!document.getElementById('fav-list-wrap').contains(e.target)) {
      closeFavoritesList();
    }
  });
}

document.addEventListener('DOMContentLoaded', bootLive);
