// ─── Rutas más frecuentes ───────────────────────────────────────────────────
// Agrega, sobre una ventana histórica servida por /live-ws/timeline, qué
// cadenas de nodos (salto a salto) se repiten más. Solo se cuentan cadenas
// con orden CONFIRMADO — traceroute real, o relay_node con candidato único
// ('confirmed' en resolvePacketRelays) — igual que estimateReachedNodes.
// La heurística de gateways (gateway_heuristic) no tiene un orden real más
// allá del hop_limit, así que un paquete así se descarta aquí en vez de
// inflar el ranking con secuencias inventadas.
function buildConfirmedHopChain(data) {
  const confidence = effectiveConfidence(data.path_confidence, data.stages);
  if (confidence === 'traceroute') {
    const ids = traceRouteIds(data);
    return ids.length > 1 ? { ids, confidence } : null;
  }
  if (confidence === 'relay_node') {
    const relays = resolvePacketRelays(data.stages);
    const ids = [data.info.from];
    data.stages.forEach((s, i) => {
      if (relays[i] && relays[i].confidence === 'confirmed') ids.push(relays[i].id);
    });
    return ids.length > 1 ? { ids, confidence } : null;
  }
  return null;
}

// /live-ws/timeline devuelve los campos "en plano" (packet_id, from, to,
// stages...), no en la forma { info, stages } que usan el resto de helpers
// de este fichero (traceRouteIds, resolvePacketRelays, etc.) — se adapta
// aquí una sola vez en vez de tocar cada helper.
function normalizeTimelinePacket(raw) {
  return {
    info: {
      packet_id: raw.packet_id, from: raw.from, to: raw.to, hop_start: raw.hop_start,
      channel: raw.channel, portnum: raw.portnum, text: raw.text,
      route: raw.route, route_back: raw.route_back,
    },
    stages: raw.stages || [],
    path_confidence: raw.path_confidence,
  };
}

let routePatternsWindowS = 21600;
let routePatternsData = [];

async function loadRoutePatterns() {
  const content = document.getElementById('route-patterns-content');
  if (content) content.innerHTML = `<p class="malconfig-empty">${t('live.routePatterns.loading')}</p>`;
  const until = Date.now() / 1000;
  const since = until - routePatternsWindowS;
  let raws;
  try {
    const r = await fetch(`${API_BASE}/live-ws/timeline?since=${since}&until=${until}`);
    const data = await r.json();
    raws = data.packets || [];
  } catch {
    if (content) content.innerHTML = `<p class="malconfig-empty">${t('live.historyLoadError')}</p>`;
    return;
  }

  const byPath = new Map();
  for (const raw of raws) {
    const data = normalizeTimelinePacket(raw);
    const chain = buildConfirmedHopChain(data);
    if (!chain) continue;
    const key = pktKey(raw.packet_id, raw.from);
    // Se aprovecha para poblar livePacketLog — así el desglose (openPacketDetail)
    // funciona al hacer clic en un paquete de esta ventana histórica sin
    // pedirlo aparte, igual que si hubiera llegado por WebSocket.
    if (!livePacketLog.has(key)) {
      livePacketLog.set(key, { info: data.info, stages: data.stages, path_confidence: data.path_confidence });
    }
    const pathKey = chain.ids.join('>');
    let entry = byPath.get(pathKey);
    if (!entry) {
      entry = { ids: chain.ids, confidence: chain.confidence, count: 0, packets: [] };
      byPath.set(pathKey, entry);
    }
    entry.count++;
    entry.packets.push({ key, time: raw.first_seen });
  }
  routePatternsData = [...byPath.values()].sort((a, b) => b.count - a.count).slice(0, 30);
  renderRoutePatterns();
}

function renderRoutePatterns() {
  const content = document.getElementById('route-patterns-content');
  if (!content) return;
  if (!routePatternsData.length) {
    content.innerHTML = `<p class="malconfig-empty">${t('live.routePatterns.empty')}</p>`;
    return;
  }
  content.innerHTML = routePatternsData.map((entry, i) => {
    const confClass = entry.confidence === 'traceroute' ? 'lr-conf-traceroute' : 'lr-conf-relay';
    const confLabel = entry.confidence === 'traceroute' ? t('live.route.exactShort') : t('live.route.confirmedShort');
    const pathHtml = entry.ids.map(nodeLabel).join(' <span class="rp-arrow">→</span> ');
    return `
      <div class="rp-row">
        <div class="rp-row-main" data-action="toggle-route-pattern" data-idx="${i}">
          <span class="rp-rank">${i + 1}</span>
          <span class="rp-path">${pathHtml}</span>
          <span class="rp-conf ${confClass}">${confLabel}</span>
          <span class="rp-count">${tp('live.routePatterns.timesCount', entry.count, { n: entry.count })}</span>
        </div>
        <div class="rp-detail" id="rp-detail-${i}"></div>
      </div>`;
  }).join('');
}

function toggleRoutePatternDetail(i) {
  const el = document.getElementById('rp-detail-' + i);
  if (!el) return;
  const wasOpen = el.classList.contains('open');
  document.querySelectorAll('.rp-detail.open').forEach(d => { d.classList.remove('open'); d.innerHTML = ''; });
  if (wasOpen) return;
  const entry = routePatternsData[i];
  el.innerHTML = entry.packets.slice(-10).reverse().map(p => `
    <div class="rp-pkt-link" data-action="open-packet" data-key="${escHtml(p.key)}">🕐 ${formatTime(p.time)}</div>
  `).join('');
  el.classList.add('open');
}

function setRoutePatternsWindow(seconds) {
  routePatternsWindowS = seconds;
  document.querySelectorAll('#route-patterns-range-group .tl-chip').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.range) === seconds);
  });
  loadRoutePatterns();
}

function openRoutePatterns() {
  document.getElementById('route-patterns-modal').classList.add('open');
  loadRoutePatterns();
}

function closeRoutePatterns() {
  document.getElementById('route-patterns-modal').classList.remove('open');
}

// ─── Comparar dos gateways ──────────────────────────────────────────────────
// Sobre la misma ventana histórica que "Rutas más frecuentes", compara qué
// paquetes oyó cada gateway (aparece en gateway_ids de alguna etapa) —
// diferencia de conjuntos, sin telemetría: sirve para detectar un gateway
// con cobertura floja o una caída silenciosa (deja de aparecer en "ambos").
let gatewayCompareWindowS = 21600;

function gatewayOptionsHtml() {
  return allNodes
    .filter(n => n.is_mqtt_gateway)
    .sort((a, b) => (a.long_name || a.node_id).localeCompare(b.long_name || b.node_id))
    .map(n => `<option value="${escHtml(n.node_id)}">${escHtml(n.long_name || n.short_name || n.node_id)}</option>`)
    .join('');
}

function openGatewayCompare() {
  const selA = document.getElementById('gw-compare-a');
  const selB = document.getElementById('gw-compare-b');
  if (selA && selB && !selA.dataset.filled) {
    const opts = gatewayOptionsHtml();
    selA.innerHTML = '<option value="">—</option>' + opts;
    selB.innerHTML = '<option value="">—</option>' + opts;
    selA.dataset.filled = '1';
  }
  document.getElementById('gateway-compare-modal').classList.add('open');
}

function closeGatewayCompare() {
  document.getElementById('gateway-compare-modal').classList.remove('open');
}

function setGatewayCompareWindow(seconds) {
  gatewayCompareWindowS = seconds;
  document.querySelectorAll('#gw-compare-range-group .tl-chip').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.range) === seconds);
  });
  runGatewayCompare();
}

async function runGatewayCompare() {
  const content = document.getElementById('gw-compare-content');
  const a = document.getElementById('gw-compare-a').value;
  const b = document.getElementById('gw-compare-b').value;
  if (!a || !b) { content.innerHTML = `<p class="malconfig-empty">${t('live.gatewayCompare.pickBoth')}</p>`; return; }
  if (a === b) { content.innerHTML = `<p class="malconfig-empty">${t('live.gatewayCompare.sameNode')}</p>`; return; }
  content.innerHTML = `<p class="malconfig-empty">${t('live.routePatterns.loading')}</p>`;

  const until = Date.now() / 1000;
  const since = until - gatewayCompareWindowS;
  let raws;
  try {
    const r = await fetch(`${API_BASE}/live-ws/timeline?since=${since}&until=${until}`);
    const data = await r.json();
    raws = data.packets || [];
  } catch {
    content.innerHTML = `<p class="malconfig-empty">${t('live.historyLoadError')}</p>`;
    return;
  }

  const onlyA = [], onlyB = [], both = [];
  for (const raw of raws) {
    const stages = raw.stages || [];
    const heardA = stages.some(s => (s.gateway_ids || []).includes(a));
    const heardB = stages.some(s => (s.gateway_ids || []).includes(b));
    if (!heardA && !heardB) continue;
    const key = pktKey(raw.packet_id, raw.from);
    if (!livePacketLog.has(key)) {
      const normalized = normalizeTimelinePacket(raw);
      livePacketLog.set(key, { info: normalized.info, stages, path_confidence: raw.path_confidence });
    }
    const item = { key, time: raw.first_seen, from: raw.from };
    if (heardA && heardB) both.push(item);
    else if (heardA) onlyA.push(item);
    else onlyB.push(item);
  }

  renderGatewayCompare({ a, b, onlyA, onlyB, both });
}

function renderGatewayCompare({ a, b, onlyA, onlyB, both }) {
  const content = document.getElementById('gw-compare-content');
  if (!onlyA.length && !onlyB.length && !both.length) {
    content.innerHTML = `<p class="malconfig-empty">${t('live.gatewayCompare.empty')}</p>`;
    return;
  }
  const section = (title, items, colorClass) => `
    <div class="gwc-section">
      <div class="gwc-section-title ${colorClass}">${title} <span class="gwc-count">${items.length}</span></div>
      ${items.slice(0, 12).map(it => `
        <div class="rp-pkt-link" data-action="open-packet" data-key="${escHtml(it.key)}">🕐 ${formatTime(it.time)} — ${nodeLabel(it.from)}</div>
      `).join('') || `<div class="gwc-empty">—</div>`}
    </div>`;
  content.innerHTML = `
    <div class="gwc-grid">
      ${section(`${nodeLabel(a)} ${t('live.gatewayCompare.only')}`, onlyA, 'gwc-a')}
      ${section(t('live.gatewayCompare.both'), both, 'gwc-both')}
      ${section(`${nodeLabel(b)} ${t('live.gatewayCompare.only')}`, onlyB, 'gwc-b')}
    </div>`;
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

// ─── Gradiente de salto (1º→último) ─────────────────────────────────────────
// En vez de una escala de color fija (tipo viridis) ajena al paquete, se
// generan tonos DEL PROPIO color asignado a ese paquete (packetColor) —
// mismo tono/saturación, variando solo la luminosidad de más oscuro (origen)
// a más claro (destino). Así el orden de los saltos se lee de un vistazo
// pero sigue leyéndose como "el mismo paquete" en vez de un arcoíris ajeno.
function _hexToRgb(hex) {
  const p = parseInt(hex.slice(1), 16);
  return [(p >> 16) & 255, (p >> 8) & 255, p & 255];
}
function _rgbToHex(r, g, b) {
  return `#${((1 << 24) + (Math.round(r) << 16) + (Math.round(g) << 8) + Math.round(b)).toString(16).slice(1)}`;
}
function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h, s, l];
}
function _hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue2rgb = (p, q, tt) => {
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}
function hopGradientColor(baseColor, i, total) {
  if (total <= 1) return baseColor;
  const [h, s, l] = _rgbToHsl(..._hexToRgb(baseColor));
  const lMin = Math.max(0.24, l - 0.26);
  const lMax = Math.min(0.82, l + 0.26);
  const newL = lMin + (lMax - lMin) * (i / (total - 1));
  return _rgbToHex(..._hslToRgb(h, Math.max(s, 0.5), newL));
}

// Sincroniza el hover entre una fila de la lista de saltos y su marcador en
// el mini-mapa — solo para traceroute: ahí traceIds y los marcadores de
// renderDetailMiniMap van siempre en el mismo orden 1:1. En la heurística de
// gateways algunas etapas no resuelven posición (stagePosition puede
// devolver null) y los índices dejan de alinear, así que ahí no se conecta
// el hover — solo se aprovecha el color de gradiente en la lista.
let detailMapHopMarkers = [];
function bindPacketDetailHopHover() {
  document.querySelectorAll('#packet-detail-tables .pkt-hop[data-hop-idx]').forEach(el => {
    const idx = Number(el.dataset.hopIdx);
    el.addEventListener('mouseenter', () => highlightDetailHop(idx, true));
    el.addEventListener('mouseleave', () => highlightDetailHop(idx, false));
  });
}
function highlightDetailHop(idx, on) {
  const marker = detailMapHopMarkers[idx];
  const el = marker && marker.getElement && marker.getElement();
  if (el) el.classList.toggle('pkt-hop-marker-highlight', on);
  const row = document.querySelector(`#packet-detail-tables .pkt-hop[data-hop-idx="${idx}"]`);
  if (row) row.classList.toggle('pkt-hop-row-highlight', on);
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
        const gradColor = hopGradientColor(packetColor(info.packet_id), i, traceIds.length);
        return `
        <div class="pkt-hop" data-hop-idx="${i}">
          <div class="pkt-hop-num" style="background:${gradColor};border-color:${gradColor}">${i}</div>
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
        const gradColor = hopGradientColor(packetColor(info.packet_id), i, stages.length);
        return `
        <div class="pkt-hop">
          <div class="pkt-hop-num" style="background:${gradColor};border-color:${gradColor}">${i + 1}</div>
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
    L.tileLayer(cartoTilesUrl('rastertiles/voyager'), {
      maxZoom: 19,
    }).addTo(detailMap);
    detailMapLayer = L.layerGroup().addTo(detailMap);
  }
  detailMapLayer.clearLayers();
  detailMapHopMarkers = [];

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
      for (const [a, b, siblingId] of stageSiblingLines(p.stage, refPos)) {
        L.polyline([a, b], { color, weight: 1.5, opacity: 0.45, dashArray: '3 4' }).addTo(detailMapLayer);
        L.circleMarker(b, {
          radius: 4, color: '#fff', weight: 1, fillColor: color, fillOpacity: 0.7,
        }).bindTooltip(
          `Escuchado en "${nodeLabel(siblingId)}", ${p.hops != null ? p.hops : p.stage.hop_limit} hops`,
          { direction: 'top' },
        ).addTo(detailMapLayer);
        allPositions.push(b);
      }
    });
  }
  // p.hops guarda el índice ORIGINAL dentro de traceIds (buildSequencedPath
  // puede saltarse algún id sin posición resoluble ni por interpolación —
  // ver su docstring), así que para el color/hover-sync de traceroute se usa
  // p.hops en vez del índice del array points, o el color y el marcador
  // resaltado no coincidirían con la fila de la lista tras ese hueco.
  const traceTotal = isTraceroute ? traceRouteIds(data).length : points.length;
  points.forEach((p, i) => {
    const isOrigin = i === 0;
    const size = isOrigin ? 24 : 18;
    const free = freeHops && !isOrigin ? freeHops.get(p.id) : null;
    const freeLabel = free && free.free
      ? (free.certain ? ' · ⚡ salto reducido (confirmado)' : ' · ⚡ posible salto reducido (router)')
      : '';
    const hopIdx = isTraceroute ? p.hops : i;
    const markerColor = isTraceroute ? hopGradientColor(color, hopIdx, traceTotal) : color;
    const marker = L.marker(p.pos, {
      icon: L.divIcon({
        className: 'pkt-marker-wrap',
        html: markerIconHtml(markerColor, p.hops ?? i, isOrigin, p.unknown, free),
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      }),
      interactive: true,
    }).bindTooltip(p.label + freeLabel, { direction: 'top' }).addTo(detailMapLayer);
    if (isTraceroute) detailMapHopMarkers[hopIdx] = marker;
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
  bindPacketDetailHopHover();
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

