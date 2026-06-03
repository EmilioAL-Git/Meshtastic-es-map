// ─── Definiciones de problemas ────────────────────────────────────────────────
const ISSUE_DEFS = {
  range_test: {
    desc: 'El módulo Range Test está activo y genera tráfico innecesario. Debe desactivarse cuando no se estén realizando pruebas de cobertura.',
    fix:  'Módulos → Range Test → Desactivar',
  },
  position_fixed: {
    desc: 'Según meshtastic.es, un nodo fijo debe emitir su posición 1 vez al día (86 400 s). La posición de un nodo fijo no cambia, no tiene sentido enviarla frecuentemente.',
    fix:  'Config → Posición → Broadcast Interval → 86400',
  },
  position_mobile: {
    desc: 'Según meshtastic.es, un nodo móvil no debería emitir su posición más de 48 veces al día (mínimo cada 30 min, 1 800 s).',
    fix:  'Config → Posición → Broadcast Interval → 1800 (mínimo)',
  },
  position_unknown: {
    desc: 'El nodo emite su posición con mucha frecuencia. Según meshtastic.es: nodos fijos 1/día (86 400 s), móviles máximo 48/día (1 800 s).',
    fix:  'Config → Posición → Broadcast Interval → 86400 (fijo) o 1800 (móvil)',
  },
  nodeinfo: {
    desc: 'Según meshtastic.es, el NodeInfo debe emitirse 1 vez al día (86 400 s). La información del nodo raramente cambia.',
    fix:  'Config → Dispositivo → Node Info Broadcast Interval → 86400',
  },
  telemetry_device: {
    desc: 'Según meshtastic.es, las métricas del dispositivo (batería, voltaje, uso del canal) deben enviarse cada 12 h (43 200 s), 2 veces al día.',
    fix:  'Módulos → Telemetría del dispositivo → Intervalo → 43200',
  },
  telemetry_environment: {
    desc: 'Las métricas del entorno (temperatura, presión...) se están enviando con más frecuencia de la necesaria. 4-6 veces al día es suficiente.',
    fix:  'Módulos → Telemetría del entorno → Intervalo → aumentar',
  },
  telemetry_power: {
    desc: 'Las métricas eléctricas se están enviando con mucha frecuencia. 4-6 veces al día es suficiente salvo monitorización activa.',
    fix:  'Módulos → Telemetría eléctrica → Intervalo → aumentar',
  },
  routing: {
    desc: 'Un alto número de paquetes de routing (ACKs de protocolo) puede indicar que el módulo Store & Forward está mal configurado, o tráfico de control excesivo.',
    fix:  'Módulos → Store & Forward → desactivar si no es necesario',
  },
  traceroute_auto: {
    desc: 'Se están generando traceroutes periódicos, consumiendo ancho de banda de la red. Comprueba si tienes el traceroute periódico activo.',
    fix:  'Config → Dispositivo → desactivar traceroute periódico',
  },
};

// ─── Diagnóstico de problemas ─────────────────────────────────────────────────
function detectIssues(malData) {
  const p   = malData?.packets;
  if (!p) return [];

  const issues = [];
  const t   = MAL_CONFIG_THRESHOLDS;
  const mob = malData?.mobility;
  const tel = malData?.telemetry_detail || {};
  const tr  = malData?.traceroute_detail;
  const ni  = malData?.nodeinfo_detail;

  // Range Test
  if ((p.range_test || 0) >= t.range_test.critical)
    issues.push({ key: 'range_test', label: `Range Test activo (${p.range_test}/día)`, severity: 'critical' });

  // Posición — umbrales distintos según movilidad
  if ((p.position || 0) > 0) {
    if (mob !== null && mob !== undefined) {
      const pt    = mob.is_fixed ? t.position_fixed : t.position_mobile;
      const key   = mob.is_fixed ? 'position_fixed' : 'position_mobile';
      const label = mob.is_fixed ? 'Posición muy frecuente para nodo fijo' : 'Posición muy frecuente para nodo móvil';
      if (p.position >= pt.critical)
        issues.push({ key, label: `${label} (${p.position}/día)`, severity: 'critical' });
      else if (p.position >= pt.high)
        issues.push({ key, label: `${label.replace('muy ', '')} (${p.position}/día)`, severity: 'high' });
    } else if (p.position >= t.position_fixed.critical) {
      issues.push({ key: 'position_unknown', label: `Posición frecuente (${p.position}/día)`, severity: 'high' });
    }
  }

  // NodeInfo — solo avisar si es automático (o sin datos de uniformidad y conteo muy alto)
  const nodeinfoCount = p.nodeinfo || 0;
  const nodeinfoAuto  = ni ? ni.is_automatic : nodeinfoCount >= t.nodeinfo.critical;
  if (nodeinfoAuto) {
    if (nodeinfoCount >= t.nodeinfo.critical)
      issues.push({ key: 'nodeinfo', label: `NodeInfo automático muy frecuente (${p.nodeinfo}/día)`, severity: 'critical' });
    else if (nodeinfoCount >= t.nodeinfo.high)
      issues.push({ key: 'nodeinfo', label: `NodeInfo automático frecuente (${p.nodeinfo}/día)`, severity: 'high' });
  }

  // Telemetría — por sub-tipo si disponible
  if (tel.device !== undefined) {
    if ((tel.device || 0) >= t.telemetry_device.critical)
      issues.push({ key: 'telemetry_device', label: `Tel. dispositivo muy frecuente (${tel.device}/día)`, severity: 'critical' });
    else if ((tel.device || 0) >= t.telemetry_device.high)
      issues.push({ key: 'telemetry_device', label: `Tel. dispositivo frecuente (${tel.device}/día)`, severity: 'medium' });

    if ((tel.environment || 0) >= t.telemetry_environment.high)
      issues.push({ key: 'telemetry_environment', label: `Tel. entorno frecuente (${tel.environment}/día)`, severity: 'medium' });

    if ((tel.power || 0) >= t.telemetry_power.high)
      issues.push({ key: 'telemetry_power', label: `Tel. eléctrica frecuente (${tel.power}/día)`, severity: 'medium' });
  } else if ((p.telemetry || 0) >= t.telemetry_device.critical) {
    issues.push({ key: 'telemetry_device', label: `Telemetría muy frecuente (${p.telemetry}/día)`, severity: 'critical' });
  }

  // Routing
  if ((p.routing || 0) >= t.routing.critical)
    issues.push({ key: 'routing', label: `Routing excesivo (${p.routing}/día)`, severity: 'critical' });
  else if ((p.routing || 0) >= t.routing.high)
    issues.push({ key: 'routing', label: `Routing elevado (${p.routing}/día)`, severity: 'high' });

  // Traceroute — solo avisar si es automático
  if (tr?.is_automatic) {
    if ((p.traceroute || 0) >= t.traceroute_auto.critical)
      issues.push({ key: 'traceroute_auto', label: `Traceroute automático excesivo (${p.traceroute}/día)`, severity: 'critical' });
    else if ((p.traceroute || 0) >= t.traceroute_auto.high)
      issues.push({ key: 'traceroute_auto', label: `Traceroute automático (${p.traceroute}/día)`, severity: 'high' });
  }

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
  const toHex   = id => '!' + parseInt(id).toString(16).padStart(8, '0');
  const key     = String(nodeId).startsWith('!') ? nodeId : toHex(nodeId);
  const malData = malConfigurados.get(key);
  if (!malData) return;

  const issues = detectIssues(malData);
  const p      = malData.packets || {};
  const tel    = malData.telemetry_detail || {};
  const mob    = malData.mobility;
  const tr     = malData.traceroute_detail;
  const ni     = malData.nodeinfo_detail;
  const hex    = toHex(malData.node_id);
  const name   = escHtml(malData.long_name || malData.short_name || hex);
  const total  = malData.sent || 1;

  const severityLabel = { critical: '🔴', high: '🟠', medium: '🟡' };

  // Indicador de movilidad
  let mobHtml = '';
  if (mob !== null && mob !== undefined) {
    const isFixed = mob.is_fixed;
    const dist    = mob.max_distance_m;
    const checks  = mob.positions_checked;
    mobHtml = `<div class="nr-mobility nr-mobility-${isFixed ? 'fixed' : 'mobile'}">
      <span class="nr-mob-icon">${isFixed ? '📍' : '🚶'}</span>
      <span>Detectado como <strong>${isFixed ? 'nodo fijo' : 'nodo móvil'}</strong>
        — desplazamiento máximo ${dist >= 1000 ? (dist/1000).toFixed(1)+'km' : dist+'m'}
        (${checks} posiciones analizadas)</span>
    </div>`;
  }

  // Problemas detectados
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

  // Desglose de paquetes
  const PACKET_LABELS = {
    position: 'Posición', nodeinfo: 'NodeInfo', telemetry: 'Telemetría',
    routing: 'Routing', traceroute: 'Traceroute', text: 'Texto',
    range_test: 'Range Test', neighborinfo: 'Neighbor Info',
  };

  const breakdownHtml = Object.entries(PACKET_LABELS)
    .filter(([k]) => p[k] != null)
    .sort(([, a], [, b]) => (p[b] || 0) - (p[a] || 0))
    .map(([k, label]) => {
      const count    = p[k] || 0;
      const pct      = Math.round((count / total) * 100);
      const hasIssue = issues.some(i => i.key.startsWith(k));
      // Sub-tipos de telemetría
      let subHtml = '';
      if (k === 'telemetry' && (tel.device || tel.environment || tel.power)) {
        subHtml = `<div class="nr-bar-sub">`
          + (tel.device      ? `<span>Dispositivo: ${tel.device}</span>` : '')
          + (tel.environment ? `<span>Entorno: ${tel.environment}</span>` : '')
          + (tel.power       ? `<span>Eléctrica: ${tel.power}</span>` : '')
          + `</div>`;
      }
      if (k === 'traceroute' && tr) {
        subHtml = `<div class="nr-bar-sub"><span>${tr.is_automatic ? '⚡ Automático' : 'Manual'} · cada ${tr.avg_interval_min}min</span></div>`;
      }
      if (k === 'nodeinfo' && ni) {
        subHtml = `<div class="nr-bar-sub"><span>${ni.is_automatic ? '⚡ Automático' : 'Manual/petición'} · cada ${ni.avg_interval_min}min</span></div>`;
      }
      return `<div class="nr-bar-row ${hasIssue ? 'nr-bar-flagged' : ''}">
        <div class="nr-bar-label">${escHtml(label)}</div>
        <div class="nr-bar-col">
          <div class="nr-bar-track"><div class="nr-bar-fill" style="width:${Math.min(pct, 100)}%"></div></div>
          ${subHtml}
        </div>
        <div class="nr-bar-num">${count.toLocaleString('es-ES')} <span class="nr-bar-pct">(${pct}%)</span></div>
      </div>`;
    }).join('');

  document.getElementById('node-report-body').innerHTML = `
    <div class="nr-header">
      <div class="nr-node-name">${name}</div>
      <div class="nr-node-meta">${escHtml(hex)} · ${escHtml(malData.channel)} · ${total.toLocaleString('es-ES')} paquetes/día</div>
    </div>
    ${mobHtml}
    <div class="nr-section-title">Problemas detectados</div>
    ${issuesHtml}
    <div class="nr-section-title">Desglose de paquetes (últimas 24h)</div>
    <div class="nr-breakdown">${breakdownHtml}</div>
    <div class="nr-meshview">
      <a href="https://meshview.meshtastic.es/node/${malData.node_id}" target="_blank" rel="noopener">Ver actividad en meshview →</a>
    </div>`;

  const fromList = document.getElementById('malconfig-modal').classList.contains('open');
  closeMalConfigModal();
  document.getElementById('node-report-back').style.display = fromList ? '' : 'none';
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
  const all      = [...malConfigurados.values()]
    .filter(n => detectIssues(n).length > 0)
    .sort((a, b) => b.sent - a.sent);
  const channels = ['Todos', ...[...new Set(all.map(n => n.channel))].sort()];

  document.getElementById('malconfig-tabs').innerHTML = channels.map((ch, i) =>
    `<button class="malconfig-tab${i === 0 ? ' active' : ''}" onclick="switchMalConfigTab('${escHtml(ch)}', this)">${escHtml(ch)}</button>`
  ).join('');

  renderMalConfigTable(all);
}

function switchMalConfigTab(channel, btn) {
  document.querySelectorAll('.malconfig-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const all      = [...malConfigurados.values()]
    .filter(n => detectIssues(n).length > 0)
    .sort((a, b) => b.sent - a.sent);
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
          const mob    = n.mobility;
          const mobChip = mob != null
            ? `<span class="mob-chip ${mob.is_fixed ? 'mob-fixed' : 'mob-mobile'}">${mob.is_fixed ? '📍 Fijo' : '🚶 Móvil'}</span>`
            : '';
          return `<tr>
            <td class="mc-rank">${i + 1}</td>
            <td class="mc-name">
              <div class="mc-longname">${escHtml(n.long_name || n.short_name || hex)} ${mobChip}</div>
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
