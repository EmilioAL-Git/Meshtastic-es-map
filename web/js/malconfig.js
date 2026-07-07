// ─── Comparación de versión de firmware ──────────────────────────────────────
function fwGte(firmware, major, minor, patch) {
  const parts = (firmware || '').split('.');
  const a = [parseInt(parts[0]) || 0, parseInt(parts[1]) || 0, parseInt(parts[2]) || 0];
  const b = [major, minor, patch];
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

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
  position_flags: {
    desc: 'Este nodo fijo está enviando campos GPS innecesarios en sus paquetes de posición. Según meshtastic.es, para nodos fijos solo debe activarse el flag DOP. SPEED y HEADING son exclusivos de nodos móviles; NVSS_SATS, SEQ_NO, TIMESTAMP y ALT_HAE añaden datos sin valor en un nodo estático.',
    fix:  'Config → Posición → Position Flags → activar solo DOP, desactivar el resto',
  },
  traceroute_auto: {
    desc: 'Este nodo está generando traceroutes de forma sistemática (posiblemente una herramienta de monitorización de red). Genera tráfico considerable en la red.',
    fix:  'Configura la herramienta de monitorización (MeshSense, MeshMonitor...) para reducir la frecuencia de traceroutes o el número de nodos destino',
  },
  hop_limit_high: {
    desc: 'El nodo tiene configurado un hop_limit superior al recomendado. Un hop_limit alto provoca que cada paquete se reemita en cascada muchas más veces de lo necesario, saturando el canal y perjudicando a toda la red. Si estás en un extremo de la malla y tienes problemas de cobertura, puedes probar con 5-6, pero usa siempre el mínimo que te permita comunicarte.',
    fix:  'Config → LoRa → Hop Limit → 3 (recomendado). Si estás en el borde de la malla: prueba 5 o como máximo 6, nunca 7',
  },
  client_base_fw: {
    desc: 'A partir del firmware 2.7.17, el rol CLIENT_BASE se comporta como ROUTER_LATE: el nodo espera antes de reemitir paquetes, lo que ralentiza la propagación de mensajes en la red. Se recomienda no usar este rol.',
    fix:  'Config → Dispositivo → Rol → cambiar a CLIENT o CLIENT_MUTE si el nodo no necesita enrutar',
  },
};

// ─── Tab de estadísticas ──────────────────────────────────────────────────────
let _malCurrentTab = 'list';

function switchMalTab(tab) {
  _malCurrentTab = tab;
  _hideChartTip();
  document.querySelectorAll('.mc-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  const filtersEl = document.getElementById('malconfig-tabs');
  if (tab === 'stats') {
    filtersEl.style.display = 'none';
    renderMalConfigStats();
  } else {
    filtersEl.style.display = '';
    renderMalConfigTable(_filteredMalNodes());
  }
}

function _showChartTip(evt, el) {
  let tip = document.getElementById('mcs-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'mcs-tooltip';
    tip.className = 'mcs-tooltip';
    document.body.appendChild(tip);
  }
  const d = el.dataset;
  tip.innerHTML = `
    <div class="mcs-tip-date">${d.date}</div>
    <div class="mcs-tip-main">${d.wi} <span>con problemas</span></div>
    ${+d.ta ? `<div class="mcs-tip-analyzed">${d.ta} analizados</div>` : ''}`;
  const x = evt.clientX, y = evt.clientY;
  tip.style.left = (x + 16) + 'px';
  tip.style.top  = (y - 10) + 'px';
  tip.classList.add('visible');
  // Ajustar si sale por la derecha
  requestAnimationFrame(() => {
    if (tip.getBoundingClientRect().right > window.innerWidth - 8)
      tip.style.left = (x - tip.offsetWidth - 12) + 'px';
  });
}

function _hideChartTip() {
  const tip = document.getElementById('mcs-tooltip');
  if (tip) tip.classList.remove('visible');
}

function _svgPie(slices, size) {
  size = size || 110;
  const active = slices.filter(s => s.value > 0);
  const total  = active.reduce((s, sl) => s + sl.value, 0);
  if (!total) return '';
  const cx = size / 2, cy = size / 2, r = size / 2 - 2;
  if (active.length === 1) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="${active[0].color}" stroke="#0f172a" stroke-width="1.5"/>
    </svg>`;
  }
  let angle = -Math.PI / 2;
  const paths = active.map(sl => {
    const sweep = (sl.value / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    angle += sweep;
    const x2 = cx + r * Math.cos(angle), y2 = cy + r * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    return `<path d="M${cx},${cy}L${x1.toFixed(2)},${y1.toFixed(2)}A${r},${r},0,${large},1,${x2.toFixed(2)},${y2.toFixed(2)}Z" fill="${sl.color}" stroke="#0f172a" stroke-width="1.5"/>`;
  });
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block">${paths.join('')}</svg>`;
}

function _svgLineChart(history) {
  const VW = 760, VH = 140;
  const PAD = { t: 12, r: 12, b: 26, l: 36 };
  const W = VW - PAD.l - PAD.r, H = VH - PAD.t - PAD.b;

  const vals = history.map(d => d.with_issues);
  const maxV = Math.max(...vals, 1);
  const xS   = i => history.length > 1 ? (i / (history.length - 1)) * W : W / 2;
  const yS   = v => H - (v / maxV) * H;
  const pts  = history.map((d, i) => [xS(i), yS(d.with_issues)]);

  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `M0,${H}` + pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join('') + `L${W},${H}Z`;

  const yTicks = [0, Math.ceil(maxV / 2), maxV];
  const grid = yTicks.map(v => {
    const y = yS(v).toFixed(1);
    return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>
            <text x="-5" y="${(+y + 3.5).toFixed(1)}" text-anchor="end" font-size="9" fill="#64748b">${v}</text>`;
  }).join('');

  const step = Math.max(1, Math.floor((history.length - 1) / 5));
  const idxs = [];
  for (let i = 0; i < history.length; i += step) idxs.push(i);
  if (idxs[idxs.length - 1] !== history.length - 1) idxs.push(history.length - 1);
  const xLabels = idxs.map(i => {
    const label = history[i].date.slice(5);
    return `<text x="${xS(i).toFixed(1)}" y="${H + 17}" text-anchor="middle" font-size="9" fill="#64748b">${label}</text>`;
  }).join('');

  const dots = pts.map(([x, y], i) => {
    const d    = history[i];
    const last = i === history.length - 1;
    const sev  = d.by_severity || {};
    const cx   = x.toFixed(1), cy = y.toFixed(1);
    return `<g style="cursor:pointer"
        data-date="${d.date}" data-wi="${d.with_issues}" data-ta="${d.total_analyzed || 0}"
        data-cr="${sev.critical || 0}" data-hi="${sev.high || 0}" data-me="${sev.medium || 0}"
        onmouseenter="_showChartTip(event,this)" onmouseleave="_hideChartTip()">
      <circle cx="${cx}" cy="${cy}" r="10" fill="transparent"/>
      <circle cx="${cx}" cy="${cy}" r="${last ? 5 : 3.5}" fill="#f97316" stroke="#0f172a" stroke-width="1.5" style="pointer-events:none"/>
    </g>`;
  }).join('');

  return `<svg width="100%" viewBox="0 0 ${VW} ${VH}" style="display:block;overflow:visible">
    <defs>
      <linearGradient id="mcs-lg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f97316" stop-opacity=".28"/>
        <stop offset="100%" stop-color="#f97316" stop-opacity=".02"/>
      </linearGradient>
      <clipPath id="mcs-cp"><rect x="0" y="0" width="${W}" height="${H}"/></clipPath>
    </defs>
    <g transform="translate(${PAD.l},${PAD.t})">
      ${grid}
      <path d="${area}" fill="url(#mcs-lg)" clip-path="url(#mcs-cp)"/>
      <path d="${line}" fill="none" stroke="#f97316" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${xLabels}
    </g>
  </svg>`;
}

function renderMalConfigStats() {
  _doRenderStats(malHistory);
}

function _doRenderStats(history) {
  const all     = [...malConfigurados.values()];
  const withIss = all.filter(n => (n.issues || []).length > 0);
  const el      = document.getElementById('malconfig-content');

  if (!all.length) {
    el.innerHTML = '<div class="malconfig-empty">Sin datos disponibles</div>';
    return;
  }

  // Nodos por tipo de problema (cada nodo cuenta 1 vez por issue key)
  const issueCounts = {};
  withIss.forEach(n => {
    const seen = new Set();
    (n.issues || []).forEach(i => {
      if (!seen.has(i.key)) { seen.add(i.key); issueCounts[i.key] = (issueCounts[i.key] || 0) + 1; }
    });
  });

  // Total de issues por severidad
  const sevCounts = { critical: 0, high: 0, medium: 0 };
  withIss.forEach(n => {
    (n.issues || []).forEach(i => { sevCounts[i.severity] = (sevCounts[i.severity] || 0) + 1; });
  });

  // Categorías agrupadas
  const GROUPS = {
    'Posición':   ['position_fixed', 'position_mobile', 'position_unknown', 'position_flags'],
    'Telemetría': ['telemetry_device', 'telemetry_environment', 'telemetry_power'],
    'NodeInfo':   ['nodeinfo'],
    'Red/Routing':['routing', 'traceroute_auto', 'hop_limit_high'],
    'Otros':      ['range_test', 'client_base_fw'],
  };
  const GROUP_COLORS = {
    'Posición':    '#7dd3fc',
    'Telemetría':  '#f97316',
    'NodeInfo':    '#a78bfa',
    'Red/Routing': '#ef4444',
    'Otros':       '#6b7280',
  };
  const groupSlices = Object.entries(GROUPS).map(([group, keys]) => ({
    label: group, color: GROUP_COLORS[group],
    value: keys.reduce((s, k) => s + (issueCounts[k] || 0), 0),
  })).filter(s => s.value > 0);

  // CCAA
  const ccaaCounts = {};
  withIss.forEach(n => { if (n.ccaa) ccaaCounts[n.ccaa] = (ccaaCounts[n.ccaa] || 0) + 1; });

  const ISSUE_LABELS = ISSUE_SHORT_LABELS;

  const sortedIssues  = Object.entries(issueCounts).sort(([, a], [, b]) => b - a);
  const maxIssueCount = (sortedIssues[0] || [, 1])[1];

  // ── Summary cards ────────────────────────────────────────────────────────
  const networkTotal = parseInt(document.getElementById('hdr-nodes').textContent) || all.length;
  const summaryHtml = `
    <div class="mcs-summary">
      <div class="mcs-card">
        <div class="mcs-card-val">${networkTotal.toLocaleString('es-ES')}</div>
        <div class="mcs-card-lbl">Nodos en la red</div>
      </div>
      <div class="mcs-card mcs-card-warn">
        <div class="mcs-card-val">${withIss.length}</div>
        <div class="mcs-card-lbl">Con problemas detectados</div>
      </div>
    </div>
    <div class="mcs-scope-note">Solo se analizan los ~300 nodos con mayor tráfico — puede haber más nodos con problemas no detectados.</div>`;

  // ── Issue type bar chart ──────────────────────────────────────────────────
  const issuesBarHtml = `
    <div class="mcs-section-title">Tipos de problema <span class="mcs-subtitle">· nodos afectados</span></div>
    <div class="mcs-bar-list">
      ${sortedIssues.map(([key, count]) => `
        <div class="mcs-bar-row">
          <div class="mcs-bar-lbl" title="${escHtml(ISSUE_LABELS[key] || key)}">${escHtml(ISSUE_LABELS[key] || key)}</div>
          <div class="mcs-bar-track"><div class="mcs-bar-fill" style="width:${Math.round(count / maxIssueCount * 100)}%"></div></div>
          <div class="mcs-bar-num">${count}</div>
        </div>`).join('')}
    </div>`;

  // ── Severity pie ──────────────────────────────────────────────────────────
  const sevSlices = [
    { label: 'Crítico', value: sevCounts.critical, color: '#ef4444' },
    { label: 'Alto',    value: sevCounts.high,     color: '#f97316' },
    { label: 'Medio',   value: sevCounts.medium,   color: '#eab308' },
  ].filter(s => s.value > 0);
  const totalIssues = sevSlices.reduce((s, sl) => s + sl.value, 0);

  const sevPieHtml = `
    <div class="mcs-pie-section">
      <div class="mcs-section-title">Severidad</div>
      <div class="mcs-pie-row">
        ${_svgPie(sevSlices)}
        <div class="mcs-pie-legend">
          ${sevSlices.map(s => {
            const pct = Math.round(s.value / totalIssues * 100);
            return `<div class="mcs-pie-item">
              <span class="mcs-pie-dot" style="background:${s.color}"></span>
              <span class="mcs-pie-label">${s.label}</span>
              <span class="mcs-pie-count">${s.value} <span class="mcs-pie-pct">(${pct}%)</span></span>
            </div>`;
          }).join('')}
          <div class="mcs-pie-total">${totalIssues} issues en total</div>
        </div>
      </div>
    </div>`;

  // ── Category pie ──────────────────────────────────────────────────────────
  const catTotal   = groupSlices.reduce((s, sl) => s + sl.value, 0);
  const catPieHtml = `
    <div class="mcs-pie-section">
      <div class="mcs-section-title">Categoría de problema</div>
      <div class="mcs-pie-row">
        ${_svgPie(groupSlices)}
        <div class="mcs-pie-legend">
          ${groupSlices.map(s => {
            const pct = Math.round(s.value / catTotal * 100);
            return `<div class="mcs-pie-item">
              <span class="mcs-pie-dot" style="background:${s.color}"></span>
              <span class="mcs-pie-label">${s.label}</span>
              <span class="mcs-pie-count">${s.value} <span class="mcs-pie-pct">(${pct}%)</span></span>
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>`;

  // ── CCAA bar chart ────────────────────────────────────────────────────────
  const sortedCCAA   = Object.entries(ccaaCounts).sort(([, a], [, b]) => b - a).slice(0, 12);
  const maxCCAACount = (sortedCCAA[0] || [, 1])[1];
  const ccaaHtml = sortedCCAA.length ? `
    <div>
      <div class="mcs-section-title">Por comunidad autónoma <span class="mcs-subtitle">· nodos con problemas</span></div>
      <div class="mcs-bar-list mcs-ccaa-list">
        ${sortedCCAA.map(([ccaa, count]) => `
          <div class="mcs-bar-row">
            <div class="mcs-bar-lbl">${escHtml(ccaa)}</div>
            <div class="mcs-bar-track"><div class="mcs-bar-fill mcs-bar-accent" style="width:${Math.round(count / maxCCAACount * 100)}%"></div></div>
            <div class="mcs-bar-num">${count}</div>
          </div>`).join('')}
      </div>
    </div>` : '';

  const chartHtml = `
    <div>
      <div class="mcs-section-title">Evolución últimos 30 días <span class="mcs-subtitle">· nodos con problemas detectados</span></div>
      ${history.length >= 2
        ? _svgLineChart(history)
        : `<div class="mcs-chart-empty">${history.length === 1 ? 'Solo hay datos de 1 día — el gráfico aparecerá a partir del segundo día.' : 'Sin historial disponible aún — se acumula con cada ejecución diaria.'}</div>`}
    </div>`;

  el.innerHTML = `
    <div class="mcs-wrap">
      ${summaryHtml}
      ${chartHtml}
      ${issuesBarHtml}
      <div class="mcs-pies">${sevPieHtml}${catPieHtml}</div>
      ${ccaaHtml}
    </div>`;
}

// ─── Diagnóstico de problemas (calculado en el servidor, leído aquí) ──────────
function detectIssues(malData) {
  return malData?.issues || [];
}

// Recorta el detalle tras ":" (ej. listas de flags) para evitar etiquetas demasiado largas
function shortIssueLabel(label) {
  return label.split(':')[0];
}

function renderIssueChips(issues) {
  if (!issues.length) return '<span class="issue-none">—</span>';
  return issues.map(i =>
    `<span class="issue-chip ${i.severity}">${escHtml(shortIssueLabel(i.label))}</span>`
  ).join('');
}

// ─── Modal de reporte por nodo ────────────────────────────────────────────────
function openNodeReport(nodeId) {
  const toHex   = id => '!' + parseInt(id).toString(16).padStart(8, '0');
  const key     = String(nodeId).startsWith('!') ? nodeId : toHex(nodeId);
  const malData = malConfigurados.get(key);
  if (!malData) return;

  const issues   = detectIssues(malData);
  const p        = malData.packets || {};
  const tel      = malData.telemetry_detail || {};
  const mob      = malData.mobility;
  const tr       = malData.traceroute_detail;
  const ni       = malData.nodeinfo_detail;
  const hopStart = malData.hop_start ?? null;
  const hex      = toHex(malData.node_id);
  const name     = escHtml(malData.long_name || malData.short_name || hex);
  const total    = malData.sent || 1;

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

  // Indicador de hop_start (solo si no está ya en la sección de problemas)
  const hopFlagged = issues.some(i => i.key === 'hop_limit_high');
  let hopHtml = '';
  if (hopStart !== null && !hopFlagged && hopStart < 7) {
    hopHtml = `<div class="nr-hop nr-hop-ok">
      <span class="nr-hop-icon">🔁</span>
      <span>Hop Limit configurado: <strong>${hopStart}</strong> — dentro del rango recomendado</span>
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
    .sort(([ka], [kb]) => (p[kb] || 0) - (p[ka] || 0))
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
    ${hopHtml}
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

  // Enlace directo al informe: ?report=!abcd1234
  const url = new URL(location.href);
  url.searchParams.set('report', hex);
  history.replaceState(null, '', url);
}

function closeNodeReport() {
  document.getElementById('node-report-modal').classList.remove('open');

  const url = new URL(location.href);
  url.searchParams.delete('report');
  history.replaceState(null, '', url);
}

// ─── Etiquetas de tipos de problema (compartidas) ────────────────────────────
const ISSUE_SHORT_LABELS = {
  range_test:            'Range Test activo',
  position_fixed:        'Posición / nodo fijo',
  position_mobile:       'Posición / nodo móvil',
  position_unknown:      'Posición frecuente',
  nodeinfo:              'NodeInfo frecuente',
  telemetry_device:      'Telemetría dispositivo',
  telemetry_environment: 'Telemetría entorno',
  telemetry_power:       'Telemetría eléctrica',
  routing:               'Routing excesivo',
  traceroute_auto:       'Traceroute sistemático',
  position_flags:        'Flags GPS (fijo)',
  hop_limit_high:        'Hop limit excesivo',
  client_base_fw:        'CLIENT_BASE ≥ 2.7.17',
};

// ─── Modal: Nodos mal configurados ────────────────────────────────────────────
let _malChannelFilter = 'Todos';
let _malCCAAFilter    = '';
let _malIssueFilter   = '';

function _filteredMalNodes() {
  return [...malConfigurados.values()]
    .filter(n => detectIssues(n).length > 0)
    .filter(n => _malChannelFilter === 'Todos' || n.channel === _malChannelFilter)
    .filter(n => !_malCCAAFilter || n.ccaa === _malCCAAFilter)
    .filter(n => !_malIssueFilter || detectIssues(n).some(i => i.key === _malIssueFilter))
    .sort((a, b) => (b.sent || 0) - (a.sent || 0));
}

function openMalConfigModal() {
  document.getElementById('malconfig-modal').classList.add('open');
  renderMalConfigModal();
}

function closeMalConfigModal() {
  document.getElementById('malconfig-modal').classList.remove('open');
}

function renderMalConfigModal() {
  _malCurrentTab    = 'list';
  _malChannelFilter = 'Todos';
  _malCCAAFilter    = '';
  _malIssueFilter   = '';
  document.querySelectorAll('.mc-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === 'list');
  });
  document.getElementById('malconfig-tabs').style.display = '';

  const all      = [...malConfigurados.values()].filter(n => detectIssues(n).length > 0);
  const channels = ['Todos', ...[...new Set(all.map(n => n.channel))].sort()];
  const ccaas    = [...new Set(all.map(n => n.ccaa).filter(Boolean))].sort();

  // Conteo de nodos por tipo de problema (ordenado de mayor a menor)
  const issueCounts = {};
  all.forEach(n => detectIssues(n).forEach(i => {
    issueCounts[i.key] = (issueCounts[i.key] || 0) + 1;
  }));
  const issueKeys = Object.entries(issueCounts).sort(([,a],[,b]) => b - a).map(([k]) => k);

  const channelHtml = `<select class="malconfig-filter-select" onchange="switchChannelFilter(this.value)">
    ${channels.map(ch => `<option value="${escHtml(ch)}">Preset: ${escHtml(ch)}</option>`).join('')}
  </select>`;

  const ccaaHtml = ccaas.length
    ? `<select class="malconfig-filter-select" onchange="switchCCAAFilter(this.value)">
        <option value="">CCAA: Todas</option>
        ${ccaas.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('')}
       </select>`
    : '';

  const issueHtml = issueKeys.length
    ? `<select class="malconfig-filter-select" onchange="switchIssueFilter(this.value)">
        <option value="">Problema: Todos</option>
        ${issueKeys.map(k => `<option value="${k}">${escHtml(ISSUE_SHORT_LABELS[k] || k)} (${issueCounts[k]})</option>`).join('')}
       </select>`
    : '';

  document.getElementById('malconfig-tabs').innerHTML = channelHtml + ccaaHtml + issueHtml;
  renderMalConfigTable(_filteredMalNodes());
}

function switchChannelFilter(channel) {
  _malChannelFilter = channel;
  renderMalConfigTable(_filteredMalNodes());
}

function switchCCAAFilter(ccaa) {
  _malCCAAFilter = ccaa;
  renderMalConfigTable(_filteredMalNodes());
}

function switchIssueFilter(key) {
  _malIssueFilter = key;
  renderMalConfigTable(_filteredMalNodes());
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
          <th>Paquetes</th>
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
          return `<tr class="mc-row" onclick="openNodeReport(${n.node_id})">
            <td class="mc-rank">${i + 1}</td>
            <td class="mc-name">
              <div class="mc-longname">${escHtml(n.long_name || n.short_name || hex)} ${mobChip}</div>
              <div class="mc-id">${escHtml(hex)}</div>
            </td>
            <td><span class="mc-preset">${escHtml(n.channel)}</span></td>
            <td class="mc-num">${n.sent.toLocaleString('es-ES')}</td>
            <td class="mc-issues">${renderIssueChips(issues)}</td>
            <td class="mc-action"><button class="mc-link" onclick="event.stopPropagation(); openNodeReport(${n.node_id})">Ver →</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}
