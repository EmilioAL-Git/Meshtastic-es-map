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
// Las descripciones y soluciones viven en el diccionario i18n (issueDefs.<key>).
// Estos helpers las leen con fallback vacío si la clave no existe.
function issueDesc(key)       { return tOr('issueDefs.' + key + '.desc', ''); }
function issueFix(key)        { return tOr('issueDefs.' + key + '.fix',  ''); }
// Etiqueta corta del tipo de problema (fallback: la propia clave)
function issueShortLabel(key) { return tOr('issueLabels.' + key, key); }

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
    <div class="mcs-tip-main">${d.wi} <span>${escHtml(t('chartTip.withProblems'))}</span></div>
    ${+d.ta ? `<div class="mcs-tip-analyzed">${escHtml(t('chartTip.analyzed', { n: d.ta }))}</div>` : ''}`;
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
    el.innerHTML = `<div class="malconfig-empty">${escHtml(t('malconfig.noData'))}</div>`;
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

  // Categorías agrupadas (claves estables; la etiqueta visible sale del i18n)
  const GROUPS = {
    position:  ['position_fixed', 'position_mobile', 'position_unknown', 'position_flags'],
    telemetry: ['telemetry_device', 'telemetry_environment', 'telemetry_power'],
    nodeinfo:  ['nodeinfo'],
    network:   ['routing', 'traceroute_auto', 'hop_limit_high'],
    others:    ['range_test', 'client_base_fw', 'client_mute_mobile'],
  };
  const GROUP_COLORS = {
    position:  '#7dd3fc',
    telemetry: '#f97316',
    nodeinfo:  '#a78bfa',
    network:   '#ef4444',
    others:    '#6b7280',
  };
  const groupSlices = Object.entries(GROUPS).map(([group, keys]) => ({
    label: t('stats.groups.' + group), color: GROUP_COLORS[group],
    value: keys.reduce((s, k) => s + (issueCounts[k] || 0), 0),
  })).filter(s => s.value > 0);

  // CCAA
  const ccaaCounts = {};
  withIss.forEach(n => { if (n.ccaa) ccaaCounts[n.ccaa] = (ccaaCounts[n.ccaa] || 0) + 1; });

  const sortedIssues  = Object.entries(issueCounts).sort(([, a], [, b]) => b - a);
  const maxIssueCount = (sortedIssues[0] || [, 1])[1];

  // ── Summary cards ────────────────────────────────────────────────────────
  const networkTotal = lastStats?.nodes?.with_position ?? all.length;
  const summaryHtml = `
    <div class="mcs-summary">
      <div class="mcs-card">
        <div class="mcs-card-val">${networkTotal.toLocaleString(getLocale())}</div>
        <div class="mcs-card-lbl">${escHtml(t('stats.networkNodes'))}</div>
      </div>
      <div class="mcs-card mcs-card-warn">
        <div class="mcs-card-val">${withIss.length}</div>
        <div class="mcs-card-lbl">${escHtml(t('stats.withProblems'))}</div>
      </div>
    </div>`;

  // ── Issue type bar chart ──────────────────────────────────────────────────
  const issuesBarHtml = `
    <div class="mcs-section-title">${escHtml(t('stats.issueTypesTitle'))} <span class="mcs-subtitle">${escHtml(t('stats.issueTypesSub'))}</span></div>
    <div class="mcs-bar-list">
      ${sortedIssues.map(([key, count]) => `
        <div class="mcs-bar-row">
          <div class="mcs-bar-lbl" title="${escHtml(issueShortLabel(key))}">${escHtml(issueShortLabel(key))}</div>
          <div class="mcs-bar-track"><div class="mcs-bar-fill" style="width:${Math.round(count / maxIssueCount * 100)}%"></div></div>
          <div class="mcs-bar-num">${count}</div>
        </div>`).join('')}
    </div>`;

  // ── Severity pie ──────────────────────────────────────────────────────────
  const sevSlices = [
    { label: t('stats.critical'), value: sevCounts.critical, color: '#ef4444' },
    { label: t('stats.high'),     value: sevCounts.high,     color: '#f97316' },
    { label: t('stats.medium'),   value: sevCounts.medium,   color: '#eab308' },
  ].filter(s => s.value > 0);
  const totalIssues = sevSlices.reduce((s, sl) => s + sl.value, 0);

  const sevPieHtml = `
    <div class="mcs-pie-section">
      <div class="mcs-section-title">${escHtml(t('stats.severityTitle'))}</div>
      <div class="mcs-pie-row">
        ${_svgPie(sevSlices)}
        <div class="mcs-pie-legend">
          ${sevSlices.map(s => {
            const pct = Math.round(s.value / totalIssues * 100);
            return `<div class="mcs-pie-item">
              <span class="mcs-pie-dot" style="background:${s.color}"></span>
              <span class="mcs-pie-label">${escHtml(s.label)}</span>
              <span class="mcs-pie-count">${s.value} <span class="mcs-pie-pct">(${pct}%)</span></span>
            </div>`;
          }).join('')}
          <div class="mcs-pie-total">${escHtml(t('stats.issuesTotal', { n: totalIssues }))}</div>
        </div>
      </div>
    </div>`;

  // ── Category pie ──────────────────────────────────────────────────────────
  const catTotal   = groupSlices.reduce((s, sl) => s + sl.value, 0);
  const catPieHtml = `
    <div class="mcs-pie-section">
      <div class="mcs-section-title">${escHtml(t('stats.categoryTitle'))}</div>
      <div class="mcs-pie-row">
        ${_svgPie(groupSlices)}
        <div class="mcs-pie-legend">
          ${groupSlices.map(s => {
            const pct = Math.round(s.value / catTotal * 100);
            return `<div class="mcs-pie-item">
              <span class="mcs-pie-dot" style="background:${s.color}"></span>
              <span class="mcs-pie-label">${escHtml(s.label)}</span>
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
      <div class="mcs-section-title">${escHtml(t('stats.byCCAA'))} <span class="mcs-subtitle">${escHtml(t('stats.byCCAASub'))}</span></div>
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
      <div class="mcs-section-title">${escHtml(t('stats.evolution'))} <span class="mcs-subtitle">${escHtml(t('stats.evolutionSub'))}</span></div>
      ${history.length >= 2
        ? _svgLineChart(history)
        : `<div class="mcs-chart-empty">${escHtml(history.length === 1 ? t('stats.chartEmpty1Day') : t('stats.chartEmptyNoHistory'))}</div>`}
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

// Etiqueta de un issue para chips: traducible por clave, con la etiqueta que
// envía el collector como fallback si la clave no está en el diccionario.
function issueChipLabel(i) {
  return tOr('issueLabels.' + i.key, shortIssueLabel(i.label));
}

function renderIssueChips(issues) {
  if (!issues.length) return '<span class="issue-none">—</span>';
  return issues.map(i =>
    `<span class="issue-chip ${i.severity}">${escHtml(issueChipLabel(i))}</span>`
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
    if (isFixed === null) {
      mobHtml = `<div class="nr-mobility nr-mobility-pending">
        <span class="nr-mob-icon">⏳</span>
        <span>${t('report.mobilityPendingHtml', { checks })}</span>
      </div>`;
    } else {
      mobHtml = `<div class="nr-mobility nr-mobility-${isFixed ? 'fixed' : 'mobile'}">
        <span class="nr-mob-icon">${isFixed ? '📍' : '🚶'}</span>
        <span>${t('report.mobilityHtml', {
          status: escHtml(isFixed ? t('report.nodeFixed') : t('report.nodeMobile')),
          dist: dist >= 1000 ? (dist/1000).toFixed(1)+'km' : dist+'m',
          checks,
        })}</span>
      </div>`;
    }
  }

  // Indicador de hop_start (solo si no está ya en la sección de problemas)
  const hopFlagged = issues.some(i => i.key === 'hop_limit_high');
  let hopHtml = '';
  if (hopStart !== null && !hopFlagged && hopStart < 7) {
    hopHtml = `<div class="nr-hop nr-hop-ok">
      <span class="nr-hop-icon">🔁</span>
      <span>${t('report.hopOkHtml', { hop: hopStart })}</span>
    </div>`;
  }

  // Problemas detectados
  const issuesHtml = issues.length
    ? issues.map(i => {
        const desc = issueDesc(i.key);
        const fix  = issueFix(i.key);
        return `<div class="nr-issue nr-issue-${i.severity}">
          <div class="nr-issue-title">${severityLabel[i.severity] || '●'} ${escHtml(i.label)}</div>
          <div class="nr-issue-desc">${escHtml(desc)}</div>
          ${fix ? `<div class="nr-issue-fix"><strong>${escHtml(t('report.solution'))}</strong> ${escHtml(fix)}</div>` : ''}
        </div>`;
      }).join('')
    : `<div class="nr-no-issues">${escHtml(t('report.noIssues'))}</div>`;

  // Desglose de paquetes (etiquetas desde el i18n; claves estables)
  const PACKET_KEYS = ['position', 'nodeinfo', 'telemetry', 'routing', 'traceroute', 'text', 'range_test', 'neighborinfo'];
  const PACKET_LABELS = Object.fromEntries(PACKET_KEYS.map(k => [k, t('packetLabels.' + k)]));

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
          + (tel.device      ? `<span>${escHtml(t('report.subDevice', { n: tel.device }))}</span>` : '')
          + (tel.environment ? `<span>${escHtml(t('report.subEnvironment', { n: tel.environment }))}</span>` : '')
          + (tel.power       ? `<span>${escHtml(t('report.subPower', { n: tel.power }))}</span>` : '')
          + `</div>`;
      }
      if (k === 'traceroute' && tr) {
        subHtml = `<div class="nr-bar-sub"><span>${escHtml((tr.is_automatic ? t('report.auto') : t('report.manual')) + ' · ' + t('report.everyMin', { n: tr.avg_interval_min }))}</span></div>`;
      }
      if (k === 'nodeinfo' && ni) {
        subHtml = `<div class="nr-bar-sub"><span>${escHtml((ni.is_automatic ? t('report.auto') : t('report.manualRequest')) + ' · ' + t('report.everyMin', { n: ni.avg_interval_min }))}</span></div>`;
      }
      return `<div class="nr-bar-row ${hasIssue ? 'nr-bar-flagged' : ''}">
        <div class="nr-bar-label">${escHtml(label)}</div>
        <div class="nr-bar-col">
          <div class="nr-bar-track"><div class="nr-bar-fill" style="width:${Math.min(pct, 100)}%"></div></div>
          ${subHtml}
        </div>
        <div class="nr-bar-num">${count.toLocaleString(getLocale())} <span class="nr-bar-pct">(${pct}%)</span></div>
      </div>`;
    }).join('');

  document.getElementById('node-report-body').innerHTML = `
    <div class="nr-header">
      <div class="nr-node-name">${name}</div>
      <div class="nr-node-meta">${escHtml(hex)} · ${escHtml(malData.channel)} · ${total.toLocaleString(getLocale())} ${escHtml(t('report.packetsPerDay'))}</div>
    </div>
    ${mobHtml}
    ${hopHtml}
    <div class="nr-section-title">${escHtml(t('report.problemsTitle'))}</div>
    ${issuesHtml}
    <div class="nr-section-title">${escHtml(t('report.breakdownTitle'))}</div>
    <div class="nr-breakdown">${breakdownHtml}</div>
    <div class="nr-meshview">
      <a href="https://meshview.meshtastic.es/node/${malData.node_id}" target="_blank" rel="noopener">${escHtml(t('report.meshviewLink'))}</a>
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

// Las etiquetas cortas de tipo de problema viven en el i18n (issueLabels.<key>);
// se leen con issueShortLabel(key), definido más arriba.

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

function _malUpdatedLabel() {
  if (!malUpdated) return '';
  const diffMin = Math.round((Date.now() / 1000 - malUpdated) / 60);
  const time = new Date(malUpdated * 1000).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  if (diffMin < 1)  return t('malconfig.updated.justNow');
  if (diffMin < 60) return t('malconfig.updated.agoMin', { n: diffMin });
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24)   return t('malconfig.updated.agoHour', { h: diffH, time });
  return t('malconfig.updated.atTime', { time });
}

function openMalConfigModal(preserveFilters) {
  document.getElementById('malconfig-modal').classList.add('open');
  document.getElementById('malconfig-updated').textContent = _malUpdatedLabel();
  renderMalConfigModal(preserveFilters);
}

function closeMalConfigModal() {
  document.getElementById('malconfig-modal').classList.remove('open');
}

function renderMalConfigModal(preserveFilters) {
  if (!preserveFilters) {
    _malCurrentTab    = 'list';
    _malChannelFilter = 'Todos';
    _malCCAAFilter    = '';
    _malIssueFilter   = '';
  }
  document.querySelectorAll('.mc-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === _malCurrentTab);
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
    ${channels.map(ch => `<option value="${escHtml(ch)}" ${ch === _malChannelFilter ? 'selected' : ''}>${escHtml(ch === 'Todos' ? t('malconfig.presetAll') : t('malconfig.presetPrefix', { ch }))}</option>`).join('')}
  </select>`;

  const ccaaHtml = ccaas.length
    ? `<select class="malconfig-filter-select" onchange="switchCCAAFilter(this.value)">
        <option value="" ${_malCCAAFilter === '' ? 'selected' : ''}>${escHtml(t('malconfig.ccaaAll'))}</option>
        ${ccaas.map(c => `<option value="${escHtml(c)}" ${c === _malCCAAFilter ? 'selected' : ''}>${escHtml(c)}</option>`).join('')}
       </select>`
    : '';

  const issueHtml = issueKeys.length
    ? `<select class="malconfig-filter-select" onchange="switchIssueFilter(this.value)">
        <option value="" ${_malIssueFilter === '' ? 'selected' : ''}>${escHtml(t('malconfig.issueAll'))}</option>
        ${issueKeys.map(k => `<option value="${k}" ${k === _malIssueFilter ? 'selected' : ''}>${escHtml(issueShortLabel(k))} (${issueCounts[k]})</option>`).join('')}
       </select>`
    : '';

  document.getElementById('malconfig-tabs').innerHTML = channelHtml + ccaaHtml + issueHtml;

  if (_malCurrentTab === 'stats') {
    document.getElementById('malconfig-tabs').style.display = 'none';
    renderMalConfigStats();
  } else {
    renderMalConfigTable(_filteredMalNodes());
  }
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
    el.innerHTML = `<div class="malconfig-empty">${escHtml(t('malconfig.noData'))}</div>`;
    return;
  }

  el.innerHTML = `
    <table class="malconfig-table">
      <thead>
        <tr>
          <th>${escHtml(t('malconfig.table.rank'))}</th>
          <th>${escHtml(t('malconfig.table.name'))}</th>
          <th>${escHtml(t('malconfig.table.preset'))}</th>
          <th>${escHtml(t('malconfig.table.packets'))}</th>
          <th>${escHtml(t('malconfig.table.problems'))}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${nodes.map((n, i) => {
          const hex    = toHex(n.node_id);
          const issues = detectIssues(n);
          const mob    = n.mobility;
          const mobChip = mob != null
            ? (mob.is_fixed === null
                ? `<span class="mob-chip mob-pending">${escHtml(t('malconfig.mobPending'))}</span>`
                : `<span class="mob-chip ${mob.is_fixed ? 'mob-fixed' : 'mob-mobile'}">${escHtml(mob.is_fixed ? t('malconfig.mobFixed') : t('malconfig.mobMobile'))}</span>`)
            : '';
          return `<tr class="mc-row" onclick="openNodeReport(${n.node_id})">
            <td class="mc-rank">${i + 1}</td>
            <td class="mc-name">
              <div class="mc-longname">${escHtml(n.long_name || n.short_name || hex)} ${mobChip}</div>
              <div class="mc-id">${escHtml(hex)}</div>
            </td>
            <td><span class="mc-preset">${escHtml(n.channel)}</span></td>
            <td class="mc-num">${n.sent.toLocaleString(getLocale())}</td>
            <td class="mc-issues">${renderIssueChips(issues)}</td>
            <td class="mc-action"><button class="mc-link" onclick="event.stopPropagation(); openNodeReport(${n.node_id})">${escHtml(t('malconfig.viewLink'))}</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}
