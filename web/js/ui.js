// ─── Círculo de precisión de posición ────────────────────────────────────────
function precisionRadiusMeters(precisionBits, lat) {
  if (precisionBits == null || precisionBits >= 32) return 0;
  const stepDeg = Math.pow(2, 32 - precisionBits) / 1e7;
  return stepDeg * 111320 * Math.cos(lat * Math.PI / 180);
}

// ─── Selección de nodo ────────────────────────────────────────────────────────
function selectNode(nodeId, fly = false) {
  const node = allNodes.find(n => n.node_id === nodeId);
  if (!node) return;

  const prevNodeId = selectedNodeId;
  selectedNodeId   = nodeId;

  // Restaurar marker anterior y colocar overlay animado en el nuevo
  if (selOverlay)      { map.removeLayer(selOverlay);      selOverlay      = null; }
  if (precisionCircle) { map.removeLayer(precisionCircle); precisionCircle = null; }
  if (prevNodeId && markers[prevNodeId]) {
    const prev = allNodes.find(n => n.node_id === prevNodeId);
    if (prev) {
      if (markers[prevNodeId].setStyle)
        markers[prevNodeId].setStyle({ fillOpacity: circleMarkerOptions(nodeColor(prev)).fillOpacity, opacity: 1 });
      else if (markers[prevNodeId].setOpacity)
        markers[prevNodeId].setOpacity(1);
    }
  }

  if (node.latitude != null && node.longitude != null) {
    // Overlay: usar posición spread del zoom actual (se reposiciona en zoomend si cambia)
    const [sLat, sLng] = getSpreadLatLng(nodeId, node.latitude, node.longitude);

    if (markers[nodeId]) {
      if (markers[nodeId].setStyle) markers[nodeId].setStyle({ fillOpacity: 0, opacity: 0 });
      else if (markers[nodeId].setOpacity) markers[nodeId].setOpacity(0);
      selOverlay = L.marker([sLat, sLng], {
        icon: makeSelectedIcon(nodeColor(node)),
        interactive: false,
        zIndexOffset: 1000,
      }).addTo(map);
    }

    // Círculo de incertidumbre de posición
    const radius = precisionRadiusMeters(node.precision_bits, node.latitude);
    if (radius > 10) {
      const color = nodeColor(node);
      precisionCircle = L.circle([node.latitude, node.longitude], {
        radius,
        color,
        weight: 1.5,
        opacity: 0.55,
        fillColor: color,
        fillOpacity: 0.08,
        interactive: false,
        pane: 'overlayPane',
      }).addTo(map);
    }

    if (fly) {
      // flyTo siempre a las coordenadas reales — el spread se reposiciona al llegar (zoomend)
      map.stop();
      const zoom     = Math.max(map.getZoom(), 16);
      const isMobile = window.innerWidth <= 768;
      const offsetPx = isMobile ? Math.round(window.innerHeight * 0.22) : 0;
      if (offsetPx > 0) {
        const targetPx  = map.project([node.latitude, node.longitude], zoom);
        const shiftedPx = targetPx.add([0, offsetPx]);
        map.flyTo(map.unproject(shiftedPx, zoom), zoom, { animate: true, duration: 0.6 });
      } else {
        map.flyTo([node.latitude, node.longitude], zoom, { animate: true, duration: 0.6 });
      }
    }

    showNodeEdges(nodeId);
  } else {
    showToast('Ubicación no disponible para este nodo');
  }

  // Panel de detalle
  const name = node.long_name || node.short_name || nodeId;
  document.getElementById('detail-title').textContent = name;
  document.getElementById('detail-dot').className = `node-dot dot-${nodeCategory(node)}`;

  const ago = node.last_seen_ago_min != null
    ? (node.last_seen_ago_min < 60
      ? `hace ${node.last_seen_ago_min} min`
      : `hace ${Math.floor(node.last_seen_ago_min/60)}h ${node.last_seen_ago_min%60}min`)
    : 'desconocido';

  const fields = [
    ['ID',           node.node_id],
    ['Nombre corto', node.short_name || '—'],
    ['Hardware',     node.hardware   || '—'],
    ['Rol',          node.role       || '—'],
    ...(node.channel       ? [['Canal',       node.channel]]                       : []),
    ...(node.firmware      ? [['Firmware',    node.firmware]]                      : []),
    ['Gateway MQTT', node.is_mqtt_gateway ? '✓ Sí' : 'No'],
    ...(node.battery_level != null ? [['Batería',     node.battery_level + '%']]   : []),
    ...(node.voltage       != null ? [['Voltaje',     node.voltage.toFixed(2) + ' V']] : []),
    ...(node.snr           != null ? [['SNR',         node.snr + ' dB']]           : []),
    ...(node.rssi          != null ? [['RSSI',        node.rssi + ' dBm']]         : []),
    ...(node.channel_util  != null ? [['Chan. util.', node.channel_util.toFixed(1) + '%']] : []),
    ...(node.hops_away     != null ? [['Saltos',      node.hops_away]]             : []),
    ['Latitud',  node.latitude  != null ? node.latitude.toFixed(5)  : '—'],
    ['Longitud', node.longitude != null ? node.longitude.toFixed(5) : '—'],
    ...(node.altitude != null ? [['Altitud', node.altitude + ' m']] : []),
    ['Último visto', ago],
  ];

  // Solo conexiones con nodos activos (vistos en las últimas 24h)
  const nodeEdges = allEdges.filter(e => {
    if (e.from_node !== nodeId && e.to_node !== nodeId) return false;
    const otherId = e.from_node === nodeId ? e.to_node : e.from_node;
    const other   = allNodes.find(n => n.node_id === otherId);
    return other && other.last_seen_ago_min != null && other.last_seen_ago_min < 1440;
  });
  const nNeighbour = nodeEdges.filter(e => e.edge_type === 'neighbor').length;
  const nTrace     = nodeEdges.filter(e => e.edge_type !== 'neighbor').length;
  if (nodeEdges.length > 0) {
    const parts = [];
    if (nNeighbour) parts.push(`${nNeighbour} vecino${nNeighbour > 1 ? 's' : ''}`);
    if (nTrace)     parts.push(`${nTrace} conexión${nTrace > 1 ? 'es' : ''}`);
    fields.splice(fields.length - 1, 0, ['Conexiones', parts.join(' · ')]);
  }

  const fieldsHtml = fields
    .map(([k, v]) => `<div class="detail-row">
      <span class="detail-key">${k}</span>
      <span class="detail-val ${k === 'ID' ? 'accent' : ''}">${escHtml(String(v))}</span>
    </div>`).join('');

  const malData   = malConfigurados.get(node.node_id);
  const malIssues = malData ? detectIssues(malData) : [];
  let   malBanner = '';
  if (malData && malIssues.length > 0) {
    const issuesHtml = malIssues.slice(0, 3).map(i =>
      `<div class="mal-config-issue issue-${i.severity}">${escHtml(i.label)}</div>`
    ).join('');
    malBanner = `<div class="mal-config-banner">
      <div class="mal-config-row">
        <svg width="14" height="13" viewBox="0 0 22 20" aria-hidden="true"><polygon points="11,1 21,19 1,19" fill="#f97316" stroke="#ef4444" stroke-width="2" stroke-linejoin="round"/><text x="11" y="15.5" text-anchor="middle" font-size="10" font-weight="bold" font-family="monospace" fill="#1e293b">!</text></svg>
        <span>Este nodo puede estar <strong>no optimizado</strong>.</span>
      </div>
      ${issuesHtml}
      <button class="mal-config-link" onclick="openNodeReport('${node.node_id}')">Ver recomendaciones →</button>
    </div>`;
  }

  document.getElementById('detail-body').innerHTML = malBanner + fieldsHtml;

  document.getElementById('detail-panel').classList.add('visible');
  document.body.classList.add('detail-open');

  if (window.innerWidth <= 768) {
    const legend = document.querySelector('.legend');
    const panel  = document.getElementById('detail-panel');
    if (legend && panel) {
      panel.addEventListener('animationend', () => {
        const top = panel.getBoundingClientRect().top;
        legend.style.position = 'fixed';
        legend.style.bottom   = (window.innerHeight - top + 4) + 'px';
        legend.style.left     = '10px';
        legend.style.right    = 'auto';
        legend.style.top      = 'auto';
      }, { once: true });
    }
  }

  // Actualizar URL con el nodo seleccionado (sin recargar la página)
  const url = new URL(location.href);
  url.searchParams.set('node', nodeId);
  history.replaceState(null, '', url);
}

function closeDetail() {
  const legend = document.querySelector('.legend');
  if (legend) {
    legend.style.position = '';
    legend.style.bottom   = '';
    legend.style.left     = '';
    legend.style.right    = '';
    legend.style.top      = '';
  }
  if (selOverlay)      { map.removeLayer(selOverlay);      selOverlay      = null; }
  if (precisionCircle) { map.removeLayer(precisionCircle); precisionCircle = null; }
  if (selectedNodeId && markers[selectedNodeId]) {
    const n = allNodes.find(n => n.node_id === selectedNodeId);
    if (n) {
      if (markers[selectedNodeId].setStyle)
        markers[selectedNodeId].setStyle({ fillOpacity: circleMarkerOptions(nodeColor(n)).fillOpacity, opacity: 1 });
      else if (markers[selectedNodeId].setOpacity)
        markers[selectedNodeId].setOpacity(1);
    }
  }
  selectedNodeId = null;
  document.getElementById('detail-panel').classList.remove('visible');
  document.body.classList.remove('detail-open');
  clearNodeEdges();

  // Limpiar ?node= de la URL
  const url = new URL(location.href);
  url.searchParams.delete('node');
  history.replaceState(null, '', url);
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, ms = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}
