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

// Un paquete solo se marca como "confirmado" si TODAS las etapas que traían
// relay_node (es decir, todos los saltos que de verdad necesitaban
// retransmisión — los de hop 0/"salto libre" no tienen relay_node porque no
// hizo falta que nadie reenviara nada) resuelven a un único nodo con
// certeza ('confirmed'). Con que una sola quede en 'estimated' (mejor
// candidato entre varios, no un hecho) ya no se puede presentar la ruta
// entera como confirmada — sí se sigue mostrando esa pista por salto en el
// desglose.
function effectiveConfidence(path_confidence, stages) {
  if (path_confidence !== 'relay_node') return path_confidence;
  const relayed = (stages || []).filter(s => s.relay_node);
  if (!relayed.length) return 'gateway_heuristic';
  const relays = resolvePacketRelays(stages || []);
  const allConfirmed = (stages || []).every((s, i) => !s.relay_node || relays[i].confidence === 'confirmed');
  return allConfirmed ? 'relay_node' : 'gateway_heuristic';
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
  const reached = estimateReachedNodes({ info, stages: stages || [] }).size;
  return `
    <div class="lr-route"><span class="lr-swatch" style="background:${color};box-shadow:0 0 5px ${color}"></span>${nodeLabel(info.from)} → ${nodeLabel(info.to)}</div>
    ${textHtml}
    <div class="lr-meta">
      <span>${tp('live.hopCount', hops, { n: hops })}</span>
      <span title="${t('live.packetDetail.reachedHint')}">${tp('live.reachedCount', reached, { n: reached })}</span>
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

