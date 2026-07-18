// ─── Carga de datos ───────────────────────────────────────────────────────────
async function fetchJSON(path) {
  const r = await fetch(API_BASE + path + '?t=' + Date.now());
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${path}`);
  return r.json();
}

async function loadAll() {
  if (loadRunning) return;
  loadRunning = true;
  try {
    const [nodesResp, edgesResp, statsResp, malResp] = await Promise.allSettled([
      fetchJSON('/data/nodes.json'),
      fetchJSON('/data/edges.json'),
      fetchJSON('/data/stats.json'),
      MAL_CONFIG_URL
        // Ruta interna (empieza por '/'): respeta API_BASE (p.ej. /map) igual
        // que el resto de fetches. URL externa completa: se usa tal cual.
        ? fetch((MAL_CONFIG_URL.startsWith('/') ? API_BASE + MAL_CONFIG_URL : MAL_CONFIG_URL)
            + '?t=' + Date.now()).then(r => r.ok ? r.json() : null).catch(() => null)
        : Promise.resolve(null),
    ]);

    malConfigurados.clear();
    if (malResp.status === 'fulfilled' && malResp.value?.nodes) {
      malHistory = malResp.value.history || [];
      malResp.value.nodes.forEach(n => {
        const hex = '!' + n.node_id.toString(16).padStart(8, '0');
        malConfigurados.set(hex, n);
      });
    }

    if (nodesResp.status === 'fulfilled') {
      allNodes  = nodesResp.value.nodes || [];
      nodesById = new Map(allNodes.map(n => [n.node_id, n]));

      // Inyectar issue client_base_fw para nodos CLIENT_BASE con fw >= 2.7.17
      allNodes.forEach(n => {
        if (n.role !== 'CLIENT_BASE' || !n.firmware || !fwGte(n.firmware, 2, 7, 17)) return;
        let entry = malConfigurados.get(n.node_id);
        if (!entry) {
          // node_id como entero decimal, igual que las entradas del servidor
          entry = { node_id: parseInt(n.node_id.slice(1), 16), short_name: n.short_name,
                    long_name: n.long_name, channel: n.channel || '', sent: 0, issues: [] };
          malConfigurados.set(n.node_id, entry);
        }
        if (!entry.issues) entry.issues = [];
        if (!entry.issues.some(i => i.key === 'client_base_fw')) {
          entry.issues.push({ key: 'client_base_fw', label: 'CLIENT_BASE ≥ 2.7.17 actúa como ROUTER_LATE', severity: 'medium' });
        }
      });

      renderNodes(allNodes);
      applyFilters();
      // Re-ocultar marker del nodo seleccionado tras re-renderizar
      if (selectedNodeId && markers[selectedNodeId]) {
        if (markers[selectedNodeId].setStyle)
          markers[selectedNodeId].setStyle({ fillOpacity: 0, opacity: 0 });
      }
    } else {
      console.error('Error cargando nodos:', nodesResp.reason);
      showToast('⚠ Error cargando nodos — el collector puede no haber generado los datos aún');
    }

    const noOptCount = [...malConfigurados.values()].filter(n => detectIssues(n).length > 0).length;
    document.getElementById('noopt-label').textContent = `No optimizados (${noOptCount})`;

    if (edgesResp.status === 'fulfilled') {
      allEdges = edgesResp.value.edges || [];
      if (selectedNodeId) showNodeEdges(selectedNodeId);
    }

    if (statsResp.status === 'fulfilled') {
      const s = statsResp.value;
      lastStats = s;
      document.getElementById('hdr-nodes').textContent  = s.nodes?.with_position ?? '—';
      document.getElementById('hdr-active').textContent = s.nodes?.active_1h     ?? '—';
      document.getElementById('hdr-gw').textContent     = s.nodes?.mqtt_gateways ?? '—';
      document.getElementById('hdr-edges').textContent  = s.edges?.active_24h    ?? '—';
    }

    const now = new Date();
    document.getElementById('last-update').textContent =
      'actualizado ' + now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

    if (MAP_AUTO_FIT && !autoFitDone) {
      const nodesWithPos = allNodes.filter(n => n.latitude != null);
      if (nodesWithPos.length > 1 && Object.keys(markers).length > 0) {
        const bounds = L.latLngBounds(nodesWithPos.map(n => [n.latitude, n.longitude]));
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [40, 40] });
          autoFitDone = true;
        }
      }
    }

    // Enlace directo a un nodo: ?node=!abcd1234
    if (firstLoad) {
      const nodeParam = new URLSearchParams(location.search).get('node');
      if (nodeParam) {
        if (nodesById.has(nodeParam)) selectNode(nodeParam, true);
        else showToast(`Nodo ${nodeParam} no encontrado en la red`);
      }

      // Enlace directo a un informe de recomendaciones: ?report=!abcd1234
      const reportParam = new URLSearchParams(location.search).get('report');
      if (reportParam) {
        if (malConfigurados.has(reportParam)) openNodeReport(reportParam);
        else showToast(`Informe de ${reportParam} no encontrado`);
      }

      firstLoad = false;
    }

  } catch (e) {
    console.error(e);
    showToast('⚠ Error de conexión con la API');
  } finally {
    document.getElementById('loading').classList.add('hidden');
    loadRunning = false;
  }
}

// ─── Hint: banner novedades ───────────────────────────────────────────────────
function positionEdgeHint() {
  const bubble = document.getElementById('hint-novedades');
  const legend = document.querySelector('.legend');
  if (!bubble || !legend || bubble.classList.contains('hidden')) return;
  const r = legend.getBoundingClientRect();
  if (window.innerWidth <= 768) {
    bubble.classList.add('arrow-down');
    bubble.classList.remove('arrow-right');
    bubble.style.left   = r.left + 'px';
    bubble.style.bottom = (window.innerHeight - r.top + 10) + 'px';
    bubble.style.right  = 'auto';
    bubble.style.top    = 'auto';
  } else {
    bubble.classList.add('arrow-right');
    bubble.classList.remove('arrow-down');
    bubble.style.right  = (window.innerWidth - r.left + 10) + 'px';
    bubble.style.top    = (r.top + r.height / 2 - 35) + 'px';
    bubble.style.left   = 'auto';
    bubble.style.bottom = 'auto';
  }
}

(function() {
  if (document.body.classList.contains('embed-mode')) return;
  try {
    if (!localStorage.getItem('mesh_hint_novedades')) {
      document.getElementById('hint-novedades').classList.remove('hidden');
      requestAnimationFrame(positionEdgeHint);
    }
  } catch {}
})();

function dismissEdgeHint() {
  try { localStorage.setItem('mesh_hint_novedades', '1'); } catch {}
  document.getElementById('hint-novedades').classList.add('hidden');
}

// ─── Cookie consent ───────────────────────────────────────────────────────────
(function() {
  try {
    if (localStorage.getItem('mesh_cookie_ok') === '1')
      document.getElementById('cookie-banner').classList.add('hidden');
  } catch {}
})();

function acceptCookies() {
  try { localStorage.setItem('mesh_cookie_ok', '1'); } catch {}
  document.getElementById('cookie-banner').classList.add('hidden');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
fetch(API_BASE + '/data/config.json')
  .then(r => r.ok ? r.json() : {})
  .catch(() => ({}))
  .then(cfg => {
    if (cfg.map_auto_fit   != null) MAP_AUTO_FIT   = cfg.map_auto_fit;
    if (cfg.map_lat        != null) MAP_LAT        = cfg.map_lat;
    if (cfg.map_lng        != null) MAP_LNG        = cfg.map_lng;
    if (cfg.map_zoom       != null) MAP_ZOOM       = cfg.map_zoom;
    if (cfg.mal_config_url != null) MAL_CONFIG_URL = cfg.mal_config_url;
    initMap();
    syncFilterChips();
    syncEdgeFilterChips();
    loadAll();
  });

// ─── Eventos globales ─────────────────────────────────────────────────────────
// Escape cierra los modales (el del informe tiene prioridad: está encima)
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('node-report-modal').classList.contains('open')) closeNodeReport();
  else if (document.getElementById('malconfig-modal').classList.contains('open')) closeMalConfigModal();
});

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
