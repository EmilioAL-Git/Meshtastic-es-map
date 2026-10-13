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
    if (!packetMatchesFavorites(event)) return;
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
    // Si el desglose de este paquete concreto está abierto, se refresca en
    // caliente — si no, "nodos alcanzados" se quedaba congelado al número
    // que había al abrir el panel, aunque el paquete siguiera propagándose.
    if (currentDetailPacketId === key) {
      document.getElementById('packet-detail-tables').innerHTML = renderPacketDetail(key);
      renderDetailMiniMap(key);
      bindPacketDetailHopHover();
    }
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
  const rest = stage.gateway_ids
    .filter(id => id !== repId)
    .map(id => [id, nodeLatLng(id)])
    .filter(([, pos]) => pos);
  if (!rest.length) return [];
  return rest.map(([id, pos]) => [rep, pos, id]);
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

