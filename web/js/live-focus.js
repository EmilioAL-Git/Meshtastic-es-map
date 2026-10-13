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
      <button class="search-fav-star${isFavoriteNode(n.node_id) ? ' active' : ''}" data-fav-id="${escHtml(n.node_id)}" title="${escHtml(t('favorites.toggle'))}">${isFavoriteNode(n.node_id) ? '★' : '☆'}</button>
      <div class="result-name">${escHtml(n.long_name || n.short_name || n.node_id)}</div>
      <div class="result-meta">${escHtml(n.node_id)}</div>
    </div>`).join('');

  dd.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('mousedown', () => setFocusNode(el.dataset.id));
  });
  // stopPropagation en su propio mousedown: si no, el mousedown de la fila
  // (setFocusNode) también saltaría y el clic en la estrella acabaría
  // enfocando el nodo en vez de solo marcarlo como favorito.
  dd.querySelectorAll('.search-fav-star').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const active = toggleFavoriteNode(el.dataset.favId);
      el.classList.toggle('active', active);
      el.textContent = active ? '★' : '☆';
    });
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

