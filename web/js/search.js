// ─── Buscador ─────────────────────────────────────────────────────────────────
function onSearchInput() {
  const q  = document.getElementById('search-input').value.trim().toLowerCase();
  const dd = document.getElementById('search-dropdown');
  searchIndex = -1;

  if (!q) { dd.classList.remove('open'); return; }

  const results = allNodes.filter(n => {
    const name = (n.long_name || n.short_name || '').toLowerCase();
    const id   = (n.node_id || '').toLowerCase();
    return name.includes(q) || id.includes(q);
  }).slice(0, 5);

  if (!results.length) { dd.classList.remove('open'); return; }

  const dotClass = n => n.is_mqtt_gateway ? 'dot-gateway'
                      : n.is_recent       ? 'dot-recent'
                      : (n.last_seen_ago_min != null && n.last_seen_ago_min < 1440) ? 'dot-active'
                      : 'dot-old';
  const ago = n => n.last_seen_ago_min != null
    ? (n.last_seen_ago_min < 60 ? `${n.last_seen_ago_min}m` : `${Math.floor(n.last_seen_ago_min/60)}h`)
    : '?';

  dd.innerHTML = results.map(n => `
    <div class="search-result" data-id="${escHtml(n.node_id)}">
      <div class="node-dot ${dotClass(n)}"></div>
      <div class="result-name">${escHtml(n.long_name || n.short_name || n.node_id)}</div>
      <div class="result-meta">${ago(n)}</div>
    </div>`).join('');

  dd.querySelectorAll('.search-result').forEach(el => {
    el.addEventListener('mousedown', () => { selectNode(el.dataset.id, true); closeSearch(); });
  });

  dd.classList.add('open');
  setMapControlsVisible(false);
}

function onSearchKey(e) {
  const dd    = document.getElementById('search-dropdown');
  const items = dd.querySelectorAll('.search-result');
  if (!dd.classList.contains('open') || !items.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchIndex = Math.min(searchIndex + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchIndex = Math.max(searchIndex - 1, 0);
  } else if (e.key === 'Enter' && searchIndex >= 0) {
    e.preventDefault();
    selectNode(items[searchIndex].dataset.id, true);
    closeSearch();
  } else if (e.key === 'Escape') {
    closeSearch();
  }
  items.forEach((el, i) => el.classList.toggle('active', i === searchIndex));
}

function setMapControlsVisible(visible) {
  if (window.innerWidth > 768) return;
  const display = visible ? '' : 'none';
  document.querySelectorAll('.map-zoom-ctrl, .filter-toggle-btn')
    .forEach(el => el.style.display = display);
}

function closeSearch() {
  document.getElementById('search-dropdown').classList.remove('open');
  document.getElementById('search-input').value = '';
  searchIndex = -1;
  setMapControlsVisible(true);
}
