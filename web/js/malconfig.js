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
    desc: 'A partir del firmware 2.7.18, el rol CLIENT_BASE se comporta como ROUTER_LATE: el nodo espera antes de reemitir paquetes, lo que ralentiza la propagación de mensajes en la red. Se recomienda no usar este rol.',
    fix:  'Config → Dispositivo → Rol → cambiar a CLIENT o CLIENT_MUTE si el nodo no necesita enrutar',
  },
};

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
  if (hopStart !== null && !hopFlagged) {
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

// ─── Modal: Nodos mal configurados ────────────────────────────────────────────
let _malChannelFilter = 'Todos';
let _malCCAAFilter    = '';

function _filteredMalNodes() {
  return [...malConfigurados.values()]
    .filter(n => detectIssues(n).length > 0)
    .filter(n => _malChannelFilter === 'Todos' || n.channel === _malChannelFilter)
    .filter(n => !_malCCAAFilter || n.ccaa === _malCCAAFilter)
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
  _malChannelFilter = 'Todos';
  _malCCAAFilter    = '';

  const all      = [...malConfigurados.values()].filter(n => detectIssues(n).length > 0);
  const channels = ['Todos', ...[...new Set(all.map(n => n.channel))].sort()];
  const ccaas    = [...new Set(all.map(n => n.ccaa).filter(Boolean))].sort();

  const channelHtml = `<select class="malconfig-filter-select" onchange="switchChannelFilter(this.value)">
    ${channels.map(ch => `<option value="${escHtml(ch)}">Preset: ${escHtml(ch)}</option>`).join('')}
  </select>`;

  const ccaaHtml = ccaas.length
    ? `<select class="malconfig-filter-select" onchange="switchCCAAFilter(this.value)">
        <option value="">CCAA: Todas</option>
        ${ccaas.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('')}
       </select>`
    : '';

  document.getElementById('malconfig-tabs').innerHTML = channelHtml + ccaaHtml;
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
