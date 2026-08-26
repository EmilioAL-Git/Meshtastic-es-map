// ─── Aviso de arranque en frío ────────────────────────────────────────────────
function updateWarmupBanner(show) {
  const el = document.getElementById('warmup-banner');
  if (el) el.classList.toggle('visible', show);
}

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
      malUpdated = malResp.value.updated || null;
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
          entry.issues.push({ key: 'client_base_fw', label: t('issueLabelsLong.client_base_fw'), severity: 'medium' });
        }
      });

      renderNodes(allNodes);
      applyFilters();
      // Re-ocultar marker del nodo seleccionado tras re-renderizar
      if (selectedNodeId && markers[selectedNodeId]) {
        if (markers[selectedNodeId].setStyle)
          markers[selectedNodeId].setStyle({ fillOpacity: 0, opacity: 0 });
      }
      // El fetch fue correcto pero sin nodos: no es un error de red (ya
      // cubierto por el catch/toast de abajo), sino que el recolector
      // probablemente aún no ha completado su primer ciclo — el auto-refresh
      // de 5 min ya reintenta solo, esto solo se lo indica al usuario en vez
      // de dejar el mapa vacío sin explicación.
      updateWarmupBanner(allNodes.length === 0);
    } else {
      console.error('Error cargando nodos:', nodesResp.reason);
      showToast(t('toast.nodesError'));
    }

    const noOptCount = [...malConfigurados.values()].filter(n => detectIssues(n).length > 0).length;
    document.getElementById('noopt-label').textContent = t('header.notOptimizedCount', { n: noOptCount });

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
    }

    const now = new Date();
    document.getElementById('last-update').textContent =
      t('header.lastUpdate', { time: now.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' }) });

    if (MAP_AUTO_FIT && !autoFitDone) {
      autoFitDone = fitAllNodes();
    }

    // Enlace directo a un nodo: ?node=!abcd1234
    if (firstLoad) {
      const nodeParam = new URLSearchParams(location.search).get('node');
      if (nodeParam) {
        if (nodesById.has(nodeParam)) selectNode(nodeParam, true);
        else showToast(t('toast.nodeNotFound', { node: nodeParam }));
      }

      // Enlace directo a un informe de recomendaciones: ?report=!abcd1234
      const reportParam = new URLSearchParams(location.search).get('report');
      if (reportParam) {
        if (malConfigurados.has(reportParam)) openNodeReport(reportParam);
        else showToast(t('toast.reportNotFound', { node: reportParam }));
      }

      firstLoad = false;
    }

  } catch (e) {
    console.error(e);
    showToast(t('toast.apiError'));
  } finally {
    document.getElementById('loading').classList.add('hidden');
    loadRunning = false;
  }
}

// ─── Hint: banner novedades ───────────────────────────────────────────────────
function positionEdgeHint() {
  const bubble = document.getElementById('hint-novedades');
  const target = document.querySelector('.live-link');
  if (!bubble || !target || bubble.classList.contains('hidden')) return;
  const r = target.getBoundingClientRect();
  bubble.classList.add('arrow-up');
  bubble.classList.remove('arrow-down', 'arrow-right');
  const left = Math.max(10, Math.min(r.right - 200, window.innerWidth - 200 - 10));
  bubble.style.left   = left + 'px';
  bubble.style.top    = (r.bottom + 10) + 'px';
  bubble.style.right  = 'auto';
  bubble.style.bottom = 'auto';
  bubble.style.setProperty('--arrow-left', (r.left + r.width / 2 - left - 7) + 'px');
}

(function() {
  if (document.body.classList.contains('embed-mode')) return;
  try {
    if (!localStorage.getItem('mesh_hint_live')) {
      document.getElementById('hint-novedades').classList.remove('hidden');
      requestAnimationFrame(positionEdgeHint);
    }
  } catch {}
})();

function dismissEdgeHint() {
  try { localStorage.setItem('mesh_hint_live', '1'); } catch {}
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

// ─── Configuración de marca/sitio (config.json) ───────────────────────────────
// Cada campo es opcional: si el collector no lo emite, se mantiene el valor por
// defecto del HTML/i18n. Los textos vienen de variables de entorno del operador.
function applySiteConfig(cfg) {
  if (cfg.site_title) document.title = cfg.site_title;

  const brand = document.getElementById('brand-title');
  if (brand && (cfg.brand_primary != null || cfg.brand_secondary != null)) {
    const primary   = cfg.brand_primary   != null ? cfg.brand_primary   : 'MESHTASTIC ESPAÑA';
    const secondary = cfg.brand_secondary != null ? cfg.brand_secondary : 'Mapa de nodos';
    brand.innerHTML = escHtml(primary) + ' <em>/ ' + escHtml(secondary) + '</em>';
  }

  const link = document.getElementById('footer-source-link');
  if (link) {
    if (cfg.source_url)  link.href        = cfg.source_url;
    if (cfg.source_name) link.textContent = cfg.source_name;
  }
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
    if (cfg.carto_api_key  != null) CARTO_API_KEY  = cfg.carto_api_key;
    // Idioma por defecto y marca del sitio (antes de renderizar contenido)
    applyDefaultLang(cfg.default_lang);
    applySiteConfig(cfg);
    initMap();
    syncFilterChips();
    syncEdgeFilterChips();
    updateFavListCount();
    if (mapSettings.autoLocate) locateUser({ onFound: () => { autoFitDone = true; } });
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
  if (!e.target.closest('#fav-list-wrap')) closeFavoritesList();
  if (!e.target.closest('#filter-panel') && !e.target.closest('#filter-toggle-btn')) {
    document.getElementById('filter-panel').classList.remove('open');
    document.getElementById('filter-toggle-btn').classList.remove('active');
  }
  if (!e.target.closest('#settings-panel') && !e.target.closest('#settings-btn')) {
    closeSettingsPanel();
  } else if (!e.target.closest('.settings-info-icon') && !e.target.closest('#settings-info-popover')) {
    closeSettingInfo();
  }
});

// Auto-refresh cada 5 minutos
setInterval(loadAll, 5 * 60 * 1000);
