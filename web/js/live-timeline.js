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

