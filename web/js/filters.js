// ─── Filtros ──────────────────────────────────────────────────────────────────
function nodeCategory(n) {
  if (n.is_mqtt_gateway) return 'gateway';
  if (isRouter(n))       return 'router';
  if (n.is_recent)       return 'recent';
  if (n.last_seen_ago_min != null && n.last_seen_ago_min < 1440) return 'active';
  return 'old';
}

function toggleFilterPanel() {
  const panel = document.getElementById('filter-panel');
  const btn   = document.getElementById('filter-toggle-btn');
  const open  = panel.classList.toggle('open');
  btn.classList.toggle('active', open);
  if (open) {
    const rect = btn.getBoundingClientRect();
    panel.style.top   = (rect.bottom + 6) + 'px';
    panel.style.right = (window.innerWidth - rect.right) + 'px';
  }
}

function toggleFilter(cat) {
  if (activeFilters.has(cat)) activeFilters.delete(cat);
  else                        activeFilters.add(cat);
  try { localStorage.setItem(FILTER_KEY, JSON.stringify([...activeFilters])); } catch {}
  syncFilterChips();
  // renderClusters antes de applyFilters: recalcula badges y spreadHidden
  // con los filtros nuevos (el conteo del badge solo incluye nodos visibles)
  renderClusters();
  applyFilters();
  renderSpiderLegs();
}

function syncFilterChips() {
  document.querySelectorAll('.fchip[data-cat]').forEach(el =>
    el.classList.toggle('active', activeFilters.has(el.dataset.cat))
  );
}

function toggleEdgeFilter(type) {
  if (activeEdgeFilters.has(type)) activeEdgeFilters.delete(type);
  else                              activeEdgeFilters.add(type);
  try { localStorage.setItem(EDGE_FILTER_KEY, JSON.stringify([...activeEdgeFilters])); } catch {}
  syncEdgeFilterChips();
  if (selectedNodeId) showNodeEdges(selectedNodeId);
}

function syncEdgeFilterChips() {
  document.querySelectorAll('[data-edge]').forEach(el =>
    el.classList.toggle('active', activeEdgeFilters.has(el.dataset.edge))
  );
}

function applyFilters() {
  allNodes.forEach(n => {
    const m = markers[n.node_id];
    if (!m) return;
    if (spreadHidden.has(n.node_id)) {
      map.removeLayer(m);
      return;
    }
    const show = activeFilters.has(nodeCategory(n));
    if (show) m.addTo(map);
    else {
      map.removeLayer(m);
      if (n.node_id === selectedNodeId) closeDetail();
    }
  });
}
