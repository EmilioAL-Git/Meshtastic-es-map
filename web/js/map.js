// ─── Init mapa ────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: [MAP_LAT, MAP_LNG],
    zoom: MAP_ZOOM,
    zoomControl: false,
    preferCanvas: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);

  const ZoomCtrl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const c = L.DomUtil.create('div', 'map-zoom-ctrl');
      c.innerHTML = `
        <button class="map-zoom-btn" id="zoom-in"  title="Acercar">+</button>
        <button class="map-zoom-btn" id="zoom-out" title="Alejar">−</button>
        <button class="map-zoom-btn" id="zoom-locate" title="Mi ubicación">◎</button>`;
      L.DomEvent.disableClickPropagation(c);
      c.querySelector('#zoom-in').addEventListener('click', () => map.zoomIn());
      c.querySelector('#zoom-out').addEventListener('click', () => map.zoomOut());
      c.querySelector('#zoom-locate').addEventListener('click', () => {
        map.locate({ setView: true, maxZoom: 14 });
        map.once('locationerror', () => showToast('No se pudo obtener tu ubicación'));
      });
      return c;
    }
  });
  new ZoomCtrl().addTo(map);

  // Pane dedicado para markers — z-index 450, por encima del overlayPane (400)
  map.createPane('markersPane');
  map.getPane('markersPane').style.zIndex = 450;
  markerRenderer = L.svg({ pane: 'markersPane', padding: 0.5 });

  edgeGroup = L.layerGroup().addTo(map);
  map.on('zoomend', updateMarkerSizes);

  // Cerrar panel al tap en el fondo del mapa (móvil)
  map.on('click', () => {
    if (markerClicked) { markerClicked = false; return; }
    if (window.innerWidth <= 768 && selectedNodeId) closeDetail();
  });
}

// ─── Helpers de color/icono ───────────────────────────────────────────────────
function nodeColor(node) {
  if (node.is_mqtt_gateway) return C_GATEWAY;
  if (isRouter(node))       return C_ROUTER;
  if (node.is_recent)       return C_RECENT;
  const ago = node.last_seen_ago_min;
  if (ago !== null && ago < 1440) return C_ACTIVE;
  return C_OLD;
}

function circleMarkerOptions(color, size = 9) {
  const isOld = color === C_OLD;
  return {
    radius: isOld ? Math.max(size - 1, 2) : size,
    fillColor: color,
    color: '#1e293b',
    weight: isOld ? 0.5 : 1,
    opacity: isOld ? 0.4 : 1,
    fillOpacity: (color === C_RECENT || color === C_GATEWAY) ? 1 : isOld ? 0.3 : 0.85,
    renderer: canvasRenderer,
  };
}

function makeRouterIcon(color, radius) {
  const inner = radius;
  const outer = radius + 4;
  const d     = outer * 2 + 2;
  const cx    = d / 2;
  return L.divIcon({
    html: `<svg width="${d}" height="${d}" viewBox="0 0 ${d} ${d}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${cx}" cy="${cx}" r="${outer}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.7"/>
      <circle cx="${cx}" cy="${cx}" r="${inner}" fill="${color}" stroke="#1e293b" stroke-width="1"/>
    </svg>`,
    iconSize:   [d, d],
    iconAnchor: [cx, cx],
    className:  '',
  });
}

function makeMalConfiguradoIcon(color, size = 6) {
  const w = Math.round(size * 3.5);
  const h = Math.round(size * 3.2);
  return L.divIcon({
    html: `<svg width="${w}" height="${h}" viewBox="0 0 22 20" xmlns="http://www.w3.org/2000/svg">
      <polygon points="11,1 21,19 1,19" fill="${color}" stroke="#1e293b" stroke-width="1.5" stroke-linejoin="round"/>
      <text x="11" y="15.5" text-anchor="middle" font-size="9" font-weight="bold" font-family="monospace" fill="#1e293b">!</text>
    </svg>`,
    iconSize:   [w, h],
    iconAnchor: [w / 2, h],
    className:  '',
  });
}

function makeSelectedIcon(color) {
  return L.divIcon({
    html: `
      <div class="sel-marker">
        <div class="sel-pulse" style="border-color:${color}"></div>
        <div class="sel-pulse sel-pulse2" style="border-color:${color}"></div>
        <div class="sel-dot" style="background:${color}"></div>
      </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    className: '',
  });
}

function markerSize() {
  const z = map.getZoom();
  const mobile = window.innerWidth <= 768;
  if (z <= 7) return mobile ? 5  : 3;
  if (z <= 9) return mobile ? 7  : 4;
  return mobile ? 10 : 6;
}

function updateMarkerSizes() {
  computeSpreadGroups(allNodes);
  renderClusters();
  applyFilters();

  const sz = markerSize();
  allNodes.forEach(n => {
    const m = markers[n.node_id];
    if (!m || spreadHidden.has(n.node_id)) return;
    if (spreadGroups.has(n.node_id)) {
      const [dLat, dLng] = getSpreadLatLng(n.node_id, n.latitude, n.longitude);
      m.setLatLng([dLat, dLng]);
    }
    const md = malConfigurados.get(n.node_id);
    if (md && detectIssues(md).length > 0) m.setIcon(makeMalConfiguradoIcon(nodeColor(n), sz));
    else if (m.setRadius) m.setRadius(sz);
    else if (isRouter(n) && !n.is_mqtt_gateway) m.setIcon(makeRouterIcon(nodeColor(n), sz));
  });
  if (selectedNodeId && selOverlay) {
    const selNode = allNodes.find(n => n.node_id === selectedNodeId);
    if (selNode && spreadGroups.has(selectedNodeId)) {
      const [dLat, dLng] = getSpreadLatLng(selectedNodeId, selNode.latitude, selNode.longitude);
      selOverlay.setLatLng([dLat, dLng]);
    }
  }
}

// ─── Desagrupación / clustering de nodos superpuestos ─────────────────────────
const CLUSTER_PX      = 40;  // px — umbral de agrupación a zoom bajo
const SPREAD_GEO_M    = 8;   // m  — umbral de separación a zoom alto (≥ SPREAD_MIN_ZOOM)
const SPREAD_PREC     = Math.round(111000 / SPREAD_GEO_M); // grados equiv.
const SPREAD_MINPX    = 18;  // radio mínimo del círculo de separación
const SPREAD_MIN_ZOOM = 15;  // zoom a partir del cual se separan individualmente

function computeSpreadGroups(nodes) {
  spreadGroups.clear();
  const z     = map.getZoom();
  const valid = nodes.filter(n => n.latitude != null && n.longitude != null);
  const assigned = new Set();

  valid.forEach(node => {
    if (assigned.has(node.node_id)) return;
    const group = [node];
    assigned.add(node.node_id);

    if (z >= SPREAD_MIN_ZOOM) {
      // Threshold geográfico (~8 m) para la separación en estrella
      const GEO = 1 / SPREAD_PREC;
      valid.forEach(other => {
        if (assigned.has(other.node_id)) return;
        if (Math.abs(node.latitude  - other.latitude)  <= GEO &&
            Math.abs(node.longitude - other.longitude) <= GEO) {
          group.push(other);
          assigned.add(other.node_id);
        }
      });
    } else {
      // Threshold en píxeles para clustering — se adapta al zoom
      const nodePx = map.project([node.latitude, node.longitude], z);
      valid.forEach(other => {
        if (assigned.has(other.node_id)) return;
        const oPx = map.project([other.latitude, other.longitude], z);
        if (Math.hypot(nodePx.x - oPx.x, nodePx.y - oPx.y) <= CLUSTER_PX) {
          group.push(other);
          assigned.add(other.node_id);
        }
      });
    }

    if (group.length < 2) return;
    const centerLat = group.reduce((s, n) => s + n.latitude,  0) / group.length;
    const centerLng = group.reduce((s, n) => s + n.longitude, 0) / group.length;
    group.forEach((n, idx) => {
      spreadGroups.set(n.node_id, { centerLat, centerLng, idx, total: group.length });
    });
  });
}

// zoom es opcional; si se omite usa el zoom actual del mapa
function getSpreadLatLng(nodeId, lat, lng, zoom) {
  const info = spreadGroups.get(nodeId);
  if (!info) return [lat, lng];
  const z = zoom != null ? zoom : map.getZoom();
  if (z < SPREAD_MIN_ZOOM) return [lat, lng];
  const spacing    = markerSize() * 3;   // espacio mínimo entre nodos = 3× el radio del icono
  const baseRadius = Math.max(SPREAD_MINPX, Math.ceil(info.total * spacing / (2 * Math.PI)));
  const radius     = baseRadius + Math.max(0, z - SPREAD_MIN_ZOOM) * 20;
  const center = map.project([info.centerLat, info.centerLng], z);
  const angle  = (2 * Math.PI * info.idx) / info.total - Math.PI / 2;
  const ll     = map.unproject(
    [center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle)], z
  );
  return [ll.lat, ll.lng];
}

function clusterDominantColor(nodeIds) {
  const nodes = nodeIds.map(id => allNodes.find(n => n.node_id === id)).filter(Boolean);
  if (nodes.some(n => n.is_mqtt_gateway))                                           return C_GATEWAY;
  if (nodes.some(n => isRouter(n)))                                                 return C_ROUTER;
  if (nodes.some(n => n.is_recent))                                                 return C_RECENT;
  if (nodes.some(n => n.last_seen_ago_min != null && n.last_seen_ago_min < 1440))   return C_ACTIVE;
  return C_OLD;
}

function makeClusterIcon(count, color) {
  const sz = Math.max(28, markerSize() * 2 + 6 + String(count).length * 6);
  return L.divIcon({
    html: `<div class="spread-cluster" style="width:${sz}px;height:${sz}px;background:${color}"><span>${count}</span></div>`,
    iconSize:   [sz, sz],
    iconAnchor: [sz / 2, sz / 2],
    className:  '',
  });
}

function renderClusters() {
  Object.values(clusterMarkers).forEach(m => map.removeLayer(m));
  clusterMarkers = {};
  spreadHidden.clear();

  if (map.getZoom() >= SPREAD_MIN_ZOOM) return;

  // Agrupar por centroide
  const groups = new Map();
  spreadGroups.forEach((info, nodeId) => {
    const key = `${info.centerLat},${info.centerLng}`;
    if (!groups.has(key)) groups.set(key, { ...info, nodeIds: [] });
    groups.get(key).nodeIds.push(nodeId);
  });

  groups.forEach((group, key) => {
    group.nodeIds.forEach(id => spreadHidden.add(id));
    const color  = clusterDominantColor(group.nodeIds);
    const marker = L.marker([group.centerLat, group.centerLng], {
      icon:         makeClusterIcon(group.nodeIds.length, color),
      pane:         'markersPane',
      zIndexOffset: 200,
    });
    marker.on('click', () => {
      markerClicked = true;
      map.flyTo([group.centerLat, group.centerLng], SPREAD_MIN_ZOOM, { animate: true, duration: 0.5 });
    });
    marker.addTo(map);
    clusterMarkers[key] = marker;
  });
}

// ─── Renderizar nodos ─────────────────────────────────────────────────────────
function renderNodes(nodes) {
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  computeSpreadGroups(nodes);

  const isMobile = window.innerWidth <= 768;
  const isEmbed  = document.body.classList.contains('embed-mode');
  const sz       = markerSize();

  nodes.forEach(node => {
    if (node.latitude == null || node.longitude == null) return;

    const [dLat, dLng] = getSpreadLatLng(node.node_id, node.latitude, node.longitude);
    const color        = nodeColor(node);
    const malData      = malConfigurados.get(node.node_id);
    const isMalConfig  = !!malData && detectIssues(malData).length > 0;
    const marker = isMalConfig
      ? L.marker([dLat, dLng], { icon: makeMalConfiguradoIcon(color, sz), pane: 'markersPane' })
      : (isRouter(node) && !node.is_mqtt_gateway)
        ? L.marker([dLat, dLng], { icon: makeRouterIcon(color, sz), pane: 'markersPane' })
        : L.circleMarker([dLat, dLng], { ...circleMarkerOptions(color, sz), renderer: markerRenderer });

    if (!isMobile && !isEmbed) {
      const name = node.long_name || node.short_name || node.node_id;
      const ago  = node.last_seen_ago_min != null
        ? (node.last_seen_ago_min < 60
          ? `${node.last_seen_ago_min}min`
          : `${Math.floor(node.last_seen_ago_min/60)}h`)
        : '?';
      marker.bindPopup(`
        <div style="font-family:'Space Mono',monospace">
          <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:#00e5a0">${escHtml(name)}</div>
          <div style="font-size:11px;color:#64748b;margin-bottom:8px">${escHtml(node.node_id)}</div>
          ${node.is_mqtt_gateway ? '<div style="background:rgba(245,158,11,.15);color:#f59e0b;font-size:11px;padding:2px 6px;border-radius:4px;margin-bottom:6px;display:inline-block">⚡ GATEWAY MQTT</div><br>' : ''}
          ${isRouter(node) && !node.is_mqtt_gateway ? `<div style="background:rgba(251,146,60,.15);color:#fb923c;font-size:11px;padding:2px 6px;border-radius:4px;margin-bottom:6px;display:inline-block">⇆ ${escHtml(node.role)}</div><br>` : ''}
          <table style="font-size:11px;width:100%;border-collapse:collapse">
            ${node.hardware      ? row('Hardware', node.hardware) : ''}
            ${node.role          ? row('Rol', node.role) : ''}
            ${node.battery_level != null ? row('Batería', node.battery_level + '%') : ''}
            ${node.snr      != null ? row('SNR', node.snr + ' dB') : ''}
            ${node.hops_away != null ? row('Saltos', node.hops_away) : ''}
            ${node.firmware      ? row('Firmware', node.firmware) : ''}
            ${row('Visto', 'hace ' + ago)}
            ${node.latitude != null ? row('Coords', node.latitude.toFixed(4) + ', ' + node.longitude.toFixed(4)) : ''}
          </table>
        </div>
      `);
    }

    marker.on('click', () => { markerClicked = true; selectNode(node.node_id); });
    marker.addTo(map);
    markers[node.node_id] = marker;
  });

  renderClusters();
}

// ─── Edges ────────────────────────────────────────────────────────────────────
function showNodeEdges(nodeId) {
  edgeGroup.clearLayers();

  allEdges.forEach(e => {
    if (e.from_node !== nodeId && e.to_node !== nodeId) return;
    if (e.from_lat == null || e.from_lon == null || e.to_lat == null || e.to_lon == null) return;
    if (Math.abs(e.from_lat) < 0.5 && Math.abs(e.from_lon) < 0.5) return;
    if (Math.abs(e.to_lat)   < 0.5 && Math.abs(e.to_lon)   < 0.5) return;

    const coords = [[e.from_lat, e.from_lon], [e.to_lat, e.to_lon]];
    const type   = e.edge_type === 'neighbor' ? 'neighbor' : 'traceroute';
    if (!activeEdgeFilters.has(type)) return;

    edgeGroup.addLayer(
      L.polyline(coords, { ...EDGE_STYLE_HI[type], interactive: false, renderer: canvasRenderer })
    );
  });
}

function clearNodeEdges() {
  edgeGroup.clearLayers();
}
