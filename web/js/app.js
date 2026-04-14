// ─── Carga de datos ───────────────────────────────────────────────────────────
async function fetchJSON(path) {
  const r = await fetch(API_BASE + path + '?t=' + Date.now());
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${path}`);
  return r.json();
}

async function loadAll() {
  try {
    const [nodesResp, edgesResp, statsResp] = await Promise.allSettled([
      fetchJSON('/data/nodes.json'),
      fetchJSON('/data/edges.json'),
      fetchJSON('/data/stats.json'),
    ]);

    if (nodesResp.status === 'fulfilled') {
      allNodes = nodesResp.value.nodes || [];
      renderNodes(allNodes);
      applyFilters();
      // Re-ocultar marker del nodo seleccionado tras re-renderizar
      if (selectedNodeId && markers[selectedNodeId]) {
        markers[selectedNodeId].setStyle({ fillOpacity: 0, opacity: 0 });
      }
    } else {
      console.error('Error cargando nodos:', nodesResp.reason);
      showToast('⚠ Error cargando nodos — el collector puede no haber generado los datos aún');
    }

    if (edgesResp.status === 'fulfilled') {
      allEdges = edgesResp.value.edges || [];
    }

    if (statsResp.status === 'fulfilled') {
      const s = statsResp.value;
      document.getElementById('hdr-nodes').textContent  = s.nodes?.with_position ?? '—';
      document.getElementById('hdr-active').textContent = s.nodes?.active_1h     ?? '—';
      document.getElementById('hdr-gw').textContent     = s.nodes?.mqtt_gateways ?? '—';
      document.getElementById('hdr-edges').textContent  = s.edges?.active_24h    ?? '—';
    }

    const now = new Date();
    document.getElementById('last-update').textContent =
      'actualizado ' + now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

    if (MAP_AUTO_FIT && firstLoad) {
      const nodesWithPos = allNodes.filter(n => n.latitude != null);
      if (nodesWithPos.length > 1 && Object.keys(markers).length > 0) {
        const bounds = L.latLngBounds(nodesWithPos.map(n => [n.latitude, n.longitude]));
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
      }
    }
    firstLoad = false;

  } catch (e) {
    console.error(e);
    showToast('⚠ Error de conexión con la API');
  } finally {
    document.getElementById('loading').classList.add('hidden');
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
fetch(API_BASE + '/data/config.json')
  .then(r => r.ok ? r.json() : {})
  .catch(() => ({}))
  .then(cfg => {
    if (cfg.map_auto_fit != null) MAP_AUTO_FIT = cfg.map_auto_fit;
    if (cfg.map_lat      != null) MAP_LAT      = cfg.map_lat;
    if (cfg.map_lng      != null) MAP_LNG      = cfg.map_lng;
    if (cfg.map_zoom     != null) MAP_ZOOM     = cfg.map_zoom;
    initMap();
    loadAll();
  });

// ─── Eventos globales ─────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) {
    document.getElementById('search-dropdown').classList.remove('open');
    searchIndex = -1;
  }
  if (!e.target.closest('#filter-panel') && !e.target.closest('#filter-toggle-btn')) {
    document.getElementById('filter-panel').classList.remove('open');
    document.getElementById('filter-toggle-btn').classList.remove('active');
  }
});

// Auto-refresh cada 5 minutos
setInterval(loadAll, 5 * 60 * 1000);
