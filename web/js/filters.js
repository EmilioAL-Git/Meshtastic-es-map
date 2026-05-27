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
  document.querySelectorAll('.fchip').forEach(el =>
    el.classList.toggle('active', activeFilters.has(el.dataset.cat))
  );
  applyFilters();
}

function syncFilterChips() {
  document.querySelectorAll('.fchip').forEach(el =>
    el.classList.toggle('active', activeFilters.has(el.dataset.cat))
  );
}

function applyFilters() {
  allNodes.forEach(n => {
    const show = activeFilters.has(nodeCategory(n));
    if (!markers[n.node_id]) return;
    if (show) markers[n.node_id].addTo(map);
    else {
      map.removeLayer(markers[n.node_id]);
      if (n.node_id === selectedNodeId) closeDetail();
    }
  });
}
