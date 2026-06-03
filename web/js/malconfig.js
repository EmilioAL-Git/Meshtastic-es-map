// ─── Definiciones de problemas con descripción y solución ─────────────────────
const ISSUE_DEFS = {
  range_test: {
    desc: 'El módulo Range Test está activo y generando tráfico. Debe desactivarse cuando no se estén haciendo pruebas de cobertura.',
    fix:  'Módulos → Range Test → Desactivar',
  },
  position: {
    desc: 'El nodo emite su posición con demasiada frecuencia. Para nodos fijos se recomienda una vez al día; para móviles, mínimo cada 30 minutos.',
    fix:  'Config → Posición → Broadcast Interval → 86400 (fijo) o 1800 (móvil)',
  },
  nodeinfo: {
    desc: 'El nodo transmite su información (nombre, hardware...) con demasiada frecuencia. Debería emitirse una vez al día como máximo.',
    fix:  'Config → Dispositivo → Node Info Broadcast Interval → 86400',
  },
  telemetry: {
    desc: 'Las métricas del dispositivo (batería, voltaje, uso del canal) se envían con demasiada frecuencia. Se recomienda cada 12 horas para nodos fijos.',
    fix:  'Módulos → Telemetría del dispositivo → Intervalo → 43200',
  },
  routing: {
    desc: 'Un alto número de paquetes de routing (ACKs de protocolo) puede indicar el módulo Store & Forward mal configurado o un flujo de mensajes excesivo.',
    fix:  'Módulos → Store & Forward → desactivar si no es necesario',
  },
  traceroute: {
    desc: 'Se están generando muchos traceroutes automáticamente, lo que consume ancho de banda de la red.',
    fix:  'Config → Dispositivo → desactivar traceroute periódico si está activo',
  },
};

// ─── Diagnóstico de problemas ─────────────────────────────────────────────────
function detectIssues(malData) {
  const p = malData?.packets;
  if (!p) return [];

  const issues = [];
  const t = MAL_CONFIG_THRESHOLDS;

  if (p.range_test >= t.range_test.critical)
    issues.push({ key: 'range_test', label: `Range Test activo (${p.range_test}/día)`, severity: 'critical' });

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

  if (p.routing >= t.routing.high)
    issues.push({ key: 'routing', label: `Routing excesivo (${p.routing}/día)`, severity: 'high' });

  if (p.traceroute >= t.traceroute.high)
    issues.push({ key: 'traceroute', label: `Traceroute excesivo (${p.traceroute}/día)`, severity: 'high' });

  return issues;
}

function renderIssueChips(issues) {
  if (!issues.length) return '<span class="issue-none">—</span>';
  return issues.map(i =>
    `<span class="issue-chip ${i.severity}">${escHtml(i.label)}</span>`
  ).join('');
}

// ─── Modal de reporte por nodo ────────────────────────────────────────────────
function openNodeReport(nodeId) {
  const toHex = id => '!' + parseInt(id).toString(16).padStart(8, '0');
  // Acepta !hexvalue (desde ui.js) o entero (desde la tabla del modal)
  const key     = String(nodeId).startsWith('!') ? nodeId : toHex(nodeId);
  const malData = malConfigurados.get(key);
  if (!malData) return;

  const issues = detectIssues(malData);
  const p      = malData.packets || {};
  const hex    = toHex(malData.node_id);
  const name   = escHtml(malData.long_name || malData.short_name || hex);
  const total  = malData.sent || 1;

  const severityLabel = { critical: '🔴', high: '🟠', medium: '🟡' };

  const issuesHtml = issues.length
    ? issues.map(i => {
        const def = ISSUE_DEFS[i.key] || {};
        return `<div class="nr-issue nr-issue-${i.severity}">
          <div class="nr-issue-title">${severityLabel[i.severity] || '●'} ${escHtml(i.label)}</div>
          <div class="nr-issue-desc">${escHtml(def.desc || '')}</div>
          ${def.fix ? `<div class="nr-issue-fix"><strong>Solución:</strong> ${escHtml(def.fix)}</div>` : ''}
        </div>`;
      }).join('')
    : '<div class="nr-no-issues">No se han detectado problemas específicos con los datos disponibles.</div>';

  const PACKET_LABELS = {
    position: 'Posición', nodeinfo: 'NodeInfo', telemetry: 'Telemetría',
    routing: 'Routing', traceroute: 'Traceroute', text: 'Texto',
    range_test: 'Range Test', neighborinfo: 'Neighbor Info',
  };

  const breakdownHtml = Object.entries(PACKET_LABELS)
    .filter(([k]) => p[k] != null)
    .sort(([, a], [, b]) => (p[b] || 0) - (p[a] || 0))
    .map(([k, label]) => {
      const count = p[k] || 0;
      const pct   = Math.round((count / total) * 100);
      const hasIssue = issues.some(i => i.key === k);
      return `<div class="nr-bar-row ${hasIssue ? 'nr-bar-flagged' : ''}">
        <div class="nr-bar-label">${escHtml(label)}</div>
        <div class="nr-bar-track"><div class="nr-bar-fill" style="width:${Math.min(pct, 100)}%"></div></div>
        <div class="nr-bar-num">${count.toLocaleString('es-ES')} <span class="nr-bar-pct">(${pct}%)</span></div>
      </div>`;
    }).join('');

  document.getElementById('node-report-body').innerHTML = `
    <div class="nr-header">
      <div class="nr-node-name">${name}</div>
      <div class="nr-node-meta">${escHtml(hex)} · ${escHtml(malData.channel)} · ${total.toLocaleString('es-ES')} paquetes/día</div>
    </div>

    <div class="nr-section-title">Problemas detectados</div>
    ${issuesHtml}

    <div class="nr-section-title">Desglose de paquetes (últimas 24h)</div>
    <div class="nr-breakdown">${breakdownHtml}</div>

    <div class="nr-meshview">
      <a href="https://meshview.meshtastic.es/node/${malData.node_id}" target="_blank" rel="noopener">Ver actividad en meshview →</a>
    </div>`;

  document.getElementById('node-report-modal').classList.add('open');
}

function closeNodeReport() {
  document.getElementById('node-report-modal').classList.remove('open');
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
            <td><button class="mc-link" onclick="openNodeReport(${n.node_id})">Ver →</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}
