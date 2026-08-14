// ─── Círculo de precisión de posición ────────────────────────────────────────
function precisionRadiusMeters(precisionBits, lat) {
  if (precisionBits == null || precisionBits >= 32) return 0;
  const stepDeg = Math.pow(2, 32 - precisionBits) / 1e7;
  return stepDeg * 111320 * Math.cos(lat * Math.PI / 180);
}

function _flyToCircle(nodeId, lat, lng, circle, duration) {
  const isMobile = window.innerWidth <= 768;
  const offsetPx = isMobile ? Math.round(window.innerHeight * 0.38) : 0;
  map.flyToBounds(circle.getBounds(), {
    animate: true,
    duration,
    paddingTopLeft: [40, 40],
    paddingBottomRight: [40, 40 + offsetPx],
  });
}

function _makePrecisionCircle(node) {
  const radius = precisionRadiusMeters(node.precision_bits, node.latitude);
  if (radius <= 10) return null;
  const color = nodeColor(node);
  return L.circle([node.latitude, node.longitude], {
    radius,
    color,
    weight: 1.5,
    opacity: 0.55,
    fillColor: color,
    fillOpacity: 0.08,
    interactive: false,
    pane: 'overlayPane',
  });
}

// Aplica el ajuste showPrecisionCircle al vuelo, sin esperar a la próxima
// selección de nodo (el propio toggle del panel de ajustes llama a esto)
function refreshPrecisionCircle() {
  if (precisionCircle) { map.removeLayer(precisionCircle); precisionCircle = null; }
  if (!selectedNodeId) return;
  const node = nodesById.get(selectedNodeId);
  if (!node || node.latitude == null || !mapSettings.showPrecisionCircle) return;
  const circle = _makePrecisionCircle(node);
  if (circle) precisionCircle = circle.addTo(map);
}

// ─── Selección de nodo ────────────────────────────────────────────────────────
function selectNode(nodeId, fly = false) {
  const node = nodesById.get(nodeId);
  if (!node) return;

  const prevNodeId = selectedNodeId;
  selectedNodeId   = nodeId;

  // Restaurar marker anterior y colocar overlay animado en el nuevo
  if (selOverlay)      { map.removeLayer(selOverlay);      selOverlay      = null; }
  if (precisionCircle) { map.removeLayer(precisionCircle); precisionCircle = null; }
  if (prevNodeId && markers[prevNodeId]) {
    const prev = nodesById.get(prevNodeId);
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
    if (mapSettings.showPrecisionCircle && radius > 10) {
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

    if (fly && mapSettings.flyToNode) {
      map.stop();
      if (precisionCircle) {
        _flyToCircle(nodeId, node.latitude, node.longitude, precisionCircle, 0.7);
      } else {
        const isMobile = window.innerWidth <= 768;
        const zoom     = Math.max(map.getZoom(), isMobile ? 15 : 16);
        const offsetPx = isMobile ? Math.round(window.innerHeight * 0.38) : 0;
        if (offsetPx > 0) {
          const targetPx  = map.project([node.latitude, node.longitude], zoom);
          const shiftedPx = targetPx.add([0, offsetPx]);
          map.flyTo(map.unproject(shiftedPx, zoom), zoom, { animate: true, duration: 0.6 });
        } else {
          map.flyTo([node.latitude, node.longitude], zoom, { animate: true, duration: 0.6 });
        }
      }
    } else if (precisionCircle && mapSettings.flyToNode) {
      _flyToCircle(nodeId, node.latitude, node.longitude, precisionCircle, 0.5);
    }

    showNodeEdges(nodeId);
  } else {
    showToast(t('toast.locationUnavailable'));
  }

  // Panel de detalle
  const name = node.long_name || node.short_name || nodeId;
  document.getElementById('detail-title').textContent = name;
  document.getElementById('detail-dot').className = `node-dot dot-${nodeCategory(node)}`;
  _syncDetailFavButton(nodeId);

  const ago = node.last_seen_ago_min != null
    ? (node.last_seen_ago_min < 60
      ? t('detail.agoMin', { n: node.last_seen_ago_min })
      : t('detail.agoHourMin', { h: Math.floor(node.last_seen_ago_min/60), m: node.last_seen_ago_min%60 }))
    : t('detail.unknown');

  const fields = [
    ['ID',                   node.node_id],
    [t('detail.shortName'),  node.short_name || '—'],
    [t('detail.hardware'),   node.hardware   || '—'],
    [t('detail.role'),       node.role       || '—'],
    ...(node.channel       ? [[t('detail.channel'),     node.channel]]                   : []),
    ...(node.firmware      ? [[t('detail.firmware'),    node.firmware]]                  : []),
    [t('detail.gatewayMqtt'), node.is_mqtt_gateway ? t('common.yes') : t('common.no')],
    ...(node.battery_level != null ? [[t('detail.battery'),  node.battery_level + '%']]   : []),
    ...(node.voltage       != null ? [[t('detail.voltage'),  node.voltage.toFixed(2) + ' V']] : []),
    ...(node.snr           != null ? [[t('detail.snr'),      node.snr + ' dB']]           : []),
    ...(node.rssi          != null ? [[t('detail.rssi'),     node.rssi + ' dBm']]         : []),
    ...(node.channel_util  != null ? [[t('detail.chanUtil'), node.channel_util.toFixed(1) + '%']] : []),
    ...(node.hops_away     != null ? [[t('detail.hops'),     node.hops_away]]             : []),
    [t('detail.latitude'),  node.latitude  != null ? node.latitude.toFixed(5)  : '—'],
    [t('detail.longitude'), node.longitude != null ? node.longitude.toFixed(5) : '—'],
    ...(node.altitude != null ? [[t('detail.altitude'), node.altitude + ' m']] : []),
    ...(() => {
      const r = (node.precision_bits != null && node.latitude != null)
        ? precisionRadiusMeters(node.precision_bits, node.latitude) : 0;
      if (r <= 10) return [];
      const label = r >= 1000
        ? (r / 1000).toFixed(1) + ' km'
        : Math.round(r) + ' m';
      return [[t('detail.locationPrecision'), t('detail.precisionCircleValue', { label })]];
    })(),
    [t('detail.lastSeen'), ago],
  ];

  // Solo conexiones con nodos activos (vistos en las últimas 24h)
  const nodeEdges = allEdges.filter(e => {
    if (e.from_node !== nodeId && e.to_node !== nodeId) return false;
    const otherId = e.from_node === nodeId ? e.to_node : e.from_node;
    const other   = nodesById.get(otherId);
    return other && other.last_seen_ago_min != null && other.last_seen_ago_min < 1440;
  });
  const nNeighbour = nodeEdges.filter(e => e.edge_type === 'neighbor').length;
  const nTrace     = nodeEdges.filter(e => e.edge_type !== 'neighbor').length;
  if (nodeEdges.length > 0) {
    const parts = [];
    if (nNeighbour) parts.push(tp('detail.neighbors', nNeighbour, { n: nNeighbour }));
    if (nTrace)     parts.push(tp('detail.connections', nTrace, { n: nTrace }));
    fields.splice(fields.length - 1, 0, [t('detail.connectionsLabel'), parts.join(' · ')]);
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
      `<div class="mal-config-issue issue-${i.severity}">${escHtml(issueChipLabel(i))}</div>`
    ).join('');
    malBanner = `<div class="mal-config-banner">
      <div class="mal-config-row">
        <svg width="14" height="13" viewBox="0 0 22 20" aria-hidden="true"><polygon points="11,1 21,19 1,19" fill="#f97316" stroke="#ef4444" stroke-width="2" stroke-linejoin="round"/><text x="11" y="15.5" text-anchor="middle" font-size="10" font-weight="bold" font-family="monospace" fill="#1e293b">!</text></svg>
        <span>${t('detail.malBannerText')}</span>
      </div>
      ${issuesHtml}
      <button class="mal-config-link" onclick="openNodeReport('${node.node_id}')">${escHtml(t('detail.malBannerLink'))}</button>
    </div>`;
  }

  const liveLinkHtml = `<a class="detail-live-link" href="live?focus=${encodeURIComponent(node.node_id)}">
      <span class="live-dot"></span> ${escHtml(t('detail.viewLive'))}
    </a>`;

  const locationManualBanner = node.location_source === 'LOC_MANUAL'
    ? `<div class="location-manual-banner">
        <svg width="14" height="13" viewBox="0 0 22 20" aria-hidden="true"><polygon points="11,1 21,19 1,19" fill="#eab308" stroke="#ca8a04" stroke-width="2" stroke-linejoin="round"/><text x="11" y="15.5" text-anchor="middle" font-size="10" font-weight="bold" font-family="monospace" fill="#1e293b">!</text></svg>
        <span>${t('detail.locationManualBanner')}</span>
      </div>`
    : '';

  document.getElementById('detail-body').innerHTML = malBanner + locationManualBanner + fieldsHtml + liveLinkHtml;

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

function _syncDetailFavButton(nodeId) {
  const btn = document.getElementById('detail-fav-btn');
  if (!btn) return;
  const active = isFavoriteNode(nodeId);
  btn.classList.toggle('active', active);
  btn.textContent = active ? '★' : '☆';
}

function toggleFavoriteFromDetail() {
  if (!selectedNodeId) return;
  toggleFavoriteNode(selectedNodeId);
  _syncDetailFavButton(selectedNodeId);
  updateFavListCount();
  if (document.getElementById('fav-list-dropdown').classList.contains('open')) renderFavoritesList();
}

// ─── Lista de nodos favoritos ("mis nodos") ───────────────────────────────────
function updateFavListCount() {
  const el = document.getElementById('fav-list-count');
  if (el) el.textContent = favoriteNodes.size ? String(favoriteNodes.size) : '';
}

// En móvil el desplegable pasa a position:fixed (ver .fav-list-dropdown en
// style.css) porque .fav-list-wrap no está pegado al borde del header —
// hay otros botones detrás — así que un simple "right:0" relativo a él se
// salía de la pantalla. Con fixed hace falta fijar el "top" a mano.
function positionFavDropdown() {
  const dd = document.getElementById('fav-list-dropdown');
  const wrap = document.getElementById('fav-list-wrap');
  if (!dd || !wrap) return;
  if (!window.matchMedia('(max-width: 768px)').matches) { dd.style.top = ''; return; }
  dd.style.top = (wrap.getBoundingClientRect().bottom + 6) + 'px';
}

function toggleFavoritesList() {
  const dd = document.getElementById('fav-list-dropdown');
  if (!dd) return;
  const open = dd.classList.toggle('open');
  if (open) { positionFavDropdown(); renderFavoritesList(); }
}

function closeFavoritesList() {
  const dd = document.getElementById('fav-list-dropdown');
  if (dd) dd.classList.remove('open');
}

function renderFavoritesList() {
  const dd = document.getElementById('fav-list-dropdown');
  if (!dd) return;
  if (!favoriteNodes.size) {
    dd.innerHTML = `<div class="search-no-results">${escHtml(t('favorites.empty'))}</div>`;
    return;
  }
  const items = [...favoriteNodes]
    .map(id => nodesById.get(id))
    .filter(Boolean)
    .sort((a, b) => (a.long_name || a.node_id).localeCompare(b.long_name || b.node_id));
  dd.innerHTML = items.map(n => `
    <div class="search-result fav-list-row" data-id="${escHtml(n.node_id)}">
      <div class="node-dot dot-${nodeCategory(n)}"></div>
      <div class="result-name">${escHtml(n.long_name || n.short_name || n.node_id)}</div>
      <button class="search-fav-star active" data-fav-id="${escHtml(n.node_id)}" title="${escHtml(t('favorites.toggle'))}">★</button>
    </div>`).join('');

  dd.querySelectorAll('.fav-list-row').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.search-fav-star')) return;
      selectNode(el.dataset.id, true);
      closeFavoritesList();
    });
  });
  dd.querySelectorAll('.search-fav-star').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavoriteNode(el.dataset.favId);
      updateFavListCount();
      renderFavoritesList();
      if (el.dataset.favId === selectedNodeId) _syncDetailFavButton(selectedNodeId);
    });
  });
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
    const n = nodesById.get(selectedNodeId);
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
