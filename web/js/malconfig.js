// ─── Modal: Nodos mal configurados ────────────────────────────────────────────
function openMalConfigModal() {
  document.getElementById('malconfig-modal').classList.add('open');
  renderMalConfigModal();
}

function closeMalConfigModal() {
  document.getElementById('malconfig-modal').classList.remove('open');
}

function renderMalConfigModal() {
  const all = [...malConfigurados.values()].sort((a, b) => b.sent - a.sent);
  const channels = ['Todos', ...[...new Set(all.map(n => n.channel))].sort()];

  const tabsEl = document.getElementById('malconfig-tabs');
  tabsEl.innerHTML = channels.map((ch, i) =>
    `<button class="malconfig-tab${i === 0 ? ' active' : ''}" onclick="switchMalConfigTab('${escHtml(ch)}', this)">${escHtml(ch)}</button>`
  ).join('');

  renderMalConfigTable(all);
}

function switchMalConfigTab(channel, btn) {
  document.querySelectorAll('.malconfig-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const all      = [...malConfigurados.values()].sort((a, b) => b.sent - a.sent);
  const filtered = channel === 'Todos' ? all : all.filter(n => n.channel === channel);
  renderMalConfigTable(filtered);
}

function renderMalConfigTable(nodes) {
  const toHex = id => '!' + id.toString(16).padStart(8, '0');
  const el    = document.getElementById('malconfig-content');

  if (!nodes.length) {
    el.innerHTML = '<div class="malconfig-empty">Sin datos disponibles</div>';
    return;
  }

  el.innerHTML = `
    <table class="malconfig-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Nombre</th>
          <th>Preset</th>
          <th>Paquetes enviados</th>
          <th>Recibidos</th>
          <th>Ratio</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${nodes.map((n, i) => {
          const hex = toHex(n.node_id);
          return `<tr>
            <td class="mc-rank">${i + 1}</td>
            <td class="mc-name">
              <div class="mc-longname">${escHtml(n.long_name || n.short_name || hex)}</div>
              <div class="mc-id">${escHtml(hex)}</div>
            </td>
            <td><span class="mc-preset">${escHtml(n.channel)}</span></td>
            <td class="mc-num">${n.sent.toLocaleString('es-ES')}</td>
            <td class="mc-num mc-muted">${n.seen.toLocaleString('es-ES')}</td>
            <td class="mc-num mc-muted">${n.avg.toFixed(2)}</td>
            <td><a class="mc-link" href="https://meshview.meshtastic.es/node/${n.node_id}" target="_blank" rel="noopener">Ver →</a></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}
