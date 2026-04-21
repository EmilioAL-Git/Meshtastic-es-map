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
      });
      return c;
    }
  });
  new ZoomCtrl().addTo(map);

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
  if (z <= 7) return 3;
  if (z <= 9) return 4;
  return 6;
}

function updateMarkerSizes() {
  const sz = markerSize();
  allNodes.forEach(n => {
    if (markers[n.node_id]) markers[n.node_id].setRadius(sz);
  });
}

// ─── Renderizar nodos ─────────────────────────────────────────────────────────
function renderNodes(nodes) {
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  const isMobile = window.innerWidth <= 768;
  const isEmbed  = document.body.classList.contains('embed-mode');
  const sz       = markerSize();

  nodes.forEach(node => {
    if (node.latitude == null || node.longitude == null) return;

    const color  = nodeColor(node);
    const marker = L.circleMarker([node.latitude, node.longitude], circleMarkerOptions(color, sz));

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
}

// ─── Edges ────────────────────────────────────────────────────────────────────
function nodeName(nodeId) {
  const n = allNodes.find(n => n.node_id === nodeId);
  return n ? (n.long_name || n.short_name || nodeId) : nodeId;
}

function edgeNodeCard(name, node) {
  const hw   = node?.hardware || '—';
  const role = node?.role     || '—';
  const gw   = node?.is_mqtt_gateway;
  return `
    <div style="flex:1;min-width:0">
      <div style="color:#f1f5f9;font-weight:700;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(name)}</div>
      <div style="color:#64748b;font-size:10px;margin-top:3px">${escHtml(hw)}</div>
      <div style="color:#64748b;font-size:10px">${escHtml(role)}</div>
      ${gw ? '<div style="color:#f59e0b;font-size:10px">⚡ Gateway</div>' : ''}
    </div>`;
}

function edgePopupContent(m) {
  const fromNode  = allNodes.find(n => n.node_id === m.from_node);
  const toNode    = allNodes.find(n => n.node_id === m.to_node);
  const fromName  = m.from_name || m.from_node;
  const toName    = m.to_name   || m.to_node;
  const typeLabel = m.type === 'neighbor' ? 'Enlace directo' : 'Traceroute';
  const typeIcon  = m.type === 'neighbor' ? '⬡' : '↝';
  const agoSec    = m.last_seen ? (Date.now() / 1000 - m.last_seen) : null;
  const agoStr    = agoSec != null
    ? (agoSec < 3600 ? `hace ${Math.round(agoSec / 60)} min` : `hace ${Math.round(agoSec / 3600)}h`)
    : '—';

  return `
    <div style="font-family:'Space Mono',monospace;min-width:220px;padding:2px 0">
      <div style="font-size:10px;color:#5eead4;letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px">
        ${typeIcon} ${typeLabel}
      </div>
      <div style="display:flex;align-items:flex-start;gap:10px">
        ${edgeNodeCard(fromName, fromNode)}
        <div style="color:#475569;font-size:16px;padding-top:4px;flex-shrink:0">→</div>
        ${edgeNodeCard(toName, toNode)}
      </div>
      <div style="margin-top:8px;padding-top:7px;border-top:1px solid #1e293b;font-size:10px;color:#475569">
        ${agoStr}
      </div>
    </div>`;
}

// Recorta los extremos de una línea para que el área de clic no llegue hasta el nodo
function trimLine(coords, fraction = 0.18) {
  const [a, b] = coords;
  return [
    [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction],
    [b[0] + (a[0] - b[0]) * fraction, b[1] + (a[1] - b[1]) * fraction],
  ];
}

function showNodeEdges(nodeId) {
  edgeGroup.clearLayers();

  const isMobile = window.innerWidth <= 768;
  const isEmbed  = document.body.classList.contains('embed-mode');

  allEdges.forEach(e => {
    if (e.from_node !== nodeId && e.to_node !== nodeId) return;
    if (e.from_lat == null || e.from_lon == null || e.to_lat == null || e.to_lon == null) return;
    if (Math.abs(e.from_lat) < 0.5 && Math.abs(e.from_lon) < 0.5) return;
    if (Math.abs(e.to_lat)   < 0.5 && Math.abs(e.to_lon)   < 0.5) return;

    const coords = [[e.from_lat, e.from_lon], [e.to_lat, e.to_lon]];
    const type   = e.edge_type === 'neighbor' ? 'neighbor' : 'traceroute';
    const meta   = {
      from_node: e.from_node, to_node: e.to_node,
      from_name: e.from_name, to_name: e.to_name,
      last_seen: e.last_seen, type,
    };

    edgeGroup.addLayer(
      L.polyline(coords, { ...EDGE_STYLE_HI[type], interactive: false, renderer: canvasRenderer })
    );

    if (!isEmbed) {
      const hitLine = L.polyline(trimLine(coords), { opacity: 0, weight: isMobile ? 30 : 20, interactive: true, renderer: canvasRenderer });
      hitLine.on('click', function(ev) {
        L.DomEvent.stopPropagation(ev);
        L.popup({ className: 'edge-popup' })
          .setLatLng(ev.latlng)
          .setContent(edgePopupContent(meta))
          .openOn(map);
      });
      edgeGroup.addLayer(hitLine);
    }
  });
}

function clearNodeEdges() {
  edgeGroup.clearLayers();
}
