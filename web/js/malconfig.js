// ─── Diagnóstico de problemas ─────────────────────────────────────────────────
function detectIssues(malData) {
  const p = malData?.packets;
  if (!p) return [];

  const issues = [];
  const t = MAL_CONFIG_THRESHOLDS;

  if (p.range_test >= t.range_test.critical)
    issues.push({ key: 'range_test', label: 'Range Test activo', severity: 'critical' });

  if (p.position >= t.position.critical)
    issues.push({ key: 'position', label: `Posición muy frecuente (${p.position}/día)`, severity: 'critical' });
  else if (p.position >= t.position.high)
    issues.push({ key: 'position', label: `Posición frecuente (${p.position}/día)`, severity: 'high' });

  if (p.nodeinfo >= t.nodeinfo.critical)
    issues.push({ key: 'nodeinfo', label: `NodeInfo muy frecuente (${p.nodeinfo}/día)`, severity: 'critical' });
  else if (p.nodeinfo >= t.nodeinfo.high)
    issues.push({ key: 'nodeinfo', label: `NodeInfo frecuente (${p.nodeinfo}/día)`, severity: 'high' });

  if (p.telemetry >= t.telemetry.critical)
    issues.push({ key: 'telemetry', label: `Telemetría muy frecuente (${p.telemetry}/día)`, severity: 'critical' });
  else if (p.telemetry >= t.telemetry.high)
    issues.push({ key: 'telemetry', label: `Telemetría frecuente (${p.telemetry}/día)`, severity: 'medium' });

  return issues;
}

function renderIssueChips(issues) {
  if (!issues.length) return '<span class="issue-none">—</span>';
  return issues.map(i =>
    `<span class="issue-chip ${i.severity}">${escHtml(i.label)}</span>`
  ).join('');
}

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
          <th>Problemas detectados</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${nodes.map((n, i) => {
          const hex    = toHex(n.node_id);
          const issues = detectIssues(n);
          return `<tr>
            <td class="mc-rank">${i + 1}</td>
            <td class="mc-name">
              <div class="mc-longname">${escHtml(n.long_name || n.short_name || hex)}</div>
              <div class="mc-id">${escHtml(hex)}</div>
            </td>
            <td><span class="mc-preset">${escHtml(n.channel)}</span></td>
            <td class="mc-num">${n.sent.toLocaleString('es-ES')}</td>
            <td class="mc-issues">${renderIssueChips(issues)}</td>
            <td><a class="mc-link" href="https://meshview.meshtastic.es/node/${n.node_id}" target="_blank" rel="noopener">Ver →</a></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}
