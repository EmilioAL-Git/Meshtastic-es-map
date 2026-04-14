// ─── Filtros ──────────────────────────────────────────────────────────────────
function nodeCategory(n) {
  if (n.is_mqtt_gateway) return 'gateway';
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
  const onlyThis = activeFilters.size === 1 && activeFilters.has(cat);
  activeFilters.clear();
  if (onlyThis) {
    ALL_CATS.forEach(c => activeFilters.add(c));
  } else {
    activeFilters.add(cat);
  }
  document.querySelectorAll('.fchip').forEach(el =>
    el.classList.toggle('active', activeFilters.has(el.dataset.cat))
  );
  applyFilters();
}

function applyFilters() {
  allNodes.forEach(n => {
    const show = activeFilters.has(nodeCategory(n));
    if (!markers[n.node_id]) return;
    if (show) markers[n.node_id].addTo(map);
    else      map.removeLayer(markers[n.node_id]);
  });
}
