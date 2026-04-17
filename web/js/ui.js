// ─── Selección de nodo ────────────────────────────────────────────────────────
function selectNode(nodeId, fly = false) {
  const prevNodeId = selectedNodeId;
  selectedNodeId   = nodeId;
  const node = allNodes.find(n => n.node_id === nodeId);
  if (!node) return;

  if (node.latitude == null || node.longitude == null) {
    closeDetail();
    showToast('Ubicación no disponible para este nodo');
    return;
  }

  // Restaurar marker anterior y colocar overlay animado en el nuevo
  if (selOverlay) { map.removeLayer(selOverlay); selOverlay = null; }
  if (prevNodeId && markers[prevNodeId]) {
    const prev = allNodes.find(n => n.node_id === prevNodeId);
    if (prev) markers[prevNodeId].setStyle({ fillOpacity: circleMarkerOptions(nodeColor(prev)).fillOpacity, opacity: 1 });
  }

  if (markers[nodeId]) {
    markers[nodeId].setStyle({ fillOpacity: 0, opacity: 0 });
    selOverlay = L.marker([node.latitude, node.longitude], {
      icon: makeSelectedIcon(nodeColor(node)),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(map);

    if (fly) {
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
  }

  showNodeEdges(nodeId);

  document.querySelectorAll('.node-item').forEach(el =>
    el.classList.toggle('selected', el.dataset.id === nodeId)
  );

  // Panel de detalle
  const name = node.long_name || node.short_name || nodeId;
  document.getElementById('detail-title').textContent = name;
  document.getElementById('detail-dot').className = `node-dot dot-${
    node.is_mqtt_gateway ? 'gateway' : node.is_recent ? 'recent' : 'active'
  }`;

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

  const nodeEdges  = allEdges.filter(e => e.from_node === nodeId || e.to_node === nodeId);
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

  const sparklineHtml = buildSparklines(node.history || []);

  document.getElementById('detail-body').innerHTML = fieldsHtml + sparklineHtml;

  document.getElementById('detail-panel').classList.add('visible');
  document.body.classList.add('detail-open');

  const listItem = document.querySelector(`.node-item[data-id="${nodeId}"]`);
  if (listItem) listItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeDetail() {
  if (selOverlay) { map.removeLayer(selOverlay); selOverlay = null; }
  if (selectedNodeId && markers[selectedNodeId]) {
    const n = allNodes.find(n => n.node_id === selectedNodeId);
    if (n) markers[selectedNodeId].setStyle({ fillOpacity: circleMarkerOptions(nodeColor(n)).fillOpacity, opacity: 1 });
  }
  selectedNodeId = null;
  document.getElementById('detail-panel').classList.remove('visible');
  document.body.classList.remove('detail-open');
  clearNodeEdges();
}

// ─── Sparkline de historial ───────────────────────────────────────────────────
function buildSparklines(history) {
  if (!history || history.length < 2) return '';

  const hasBat = history.some(h => h.bat != null);
  const hasSnr = history.some(h => h.snr != null);
  if (!hasBat && !hasSnr) return '';

  function sparkline(values, color, unit) {
    const clean = values.filter(v => v != null);
    if (clean.length < 2) return '';
    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const range = max - min || 1;
    const W = 200, H = 36, pad = 2;
    const pts = values.map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (W - pad * 2);
      const y = v != null ? H - pad - ((v - min) / range) * (H - pad * 2) : null;
      return y != null ? `${x.toFixed(1)},${y.toFixed(1)}` : null;
    }).filter(Boolean).join(' ');
    const last = clean[clean.length - 1];
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
      <text x="${W - pad}" y="${H - pad}" text-anchor="end" fill="${color}" font-size="9">${last}${unit}</text>`;
  }

  let html = '<div class="sparkline-wrap">';
  if (hasBat) {
    const vals = history.map(h => h.bat);
    html += `<div class="sparkline-label">Batería (24h)</div>
      <svg class="sparkline" viewBox="0 0 200 36">${sparkline(vals, '#5eead4', '%')}</svg>`;
  }
  if (hasSnr) {
    const vals = history.map(h => h.snr);
    html += `<div class="sparkline-label">SNR (24h)</div>
      <svg class="sparkline" viewBox="0 0 200 36">${sparkline(vals, '#7dd3fc', 'dB')}</svg>`;
  }
  html += '</div>';
  return html;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, ms = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}
