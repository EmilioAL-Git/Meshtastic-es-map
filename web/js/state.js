// ─── Config ───────────────────────────────────────────────────────────────────
const API_BASE = window.location.pathname.startsWith('/map') ? '/map' : '';

let MAP_AUTO_FIT = true;
let MAP_LAT      = 40.2;
let MAP_LNG      = -3.7;
let MAP_ZOOM     = 8;

// ─── Estado global ────────────────────────────────────────────────────────────
let allNodes       = [];
let allEdges       = [];
let markers        = {};     // node_id → Leaflet circleMarker
let firstLoad      = true;
let selectedNodeId = null;
let selOverlay     = null;   // L.marker con animación de pulso
let map;
let edgeGroup;
let searchIndex    = -1;
let markerClicked  = false;  // evita que map.click cierre el panel tras seleccionar un nodo

const activeFilters = new Set(['gateway', 'recent', 'active', 'old']);
const ALL_CATS      = ['gateway', 'recent', 'active', 'old'];

// ─── Colores ──────────────────────────────────────────────────────────────────
const C_RECENT  = '#5eead4';
const C_ACTIVE  = '#7dd3fc';
const C_GATEWAY = '#fbbf24';
const C_OLD     = '#64748b';

// ─── Estilos de edge ─────────────────────────────────────────────────────────
const EDGE_STYLE = {
  neighbor:   { color: '#1d4ed8', weight: 2,   opacity: 0,    dashArray: null  },
  traceroute: { color: '#dc2626', weight: 1.5, opacity: 0,    dashArray: '6 5' },
};
const EDGE_STYLE_HI = {
  neighbor:   { color: '#1d4ed8', weight: 2,   opacity: 0.85, dashArray: null  },
  traceroute: { color: '#dc2626', weight: 1.5, opacity: 0.75, dashArray: '6 5' },
};

// ─── Renderer SVG compartido ──────────────────────────────────────────────────
const canvasRenderer = L.svg({ padding: 0.5 });

// ─── Utilidades ───────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function row(k, v) {
  return `<tr>
    <td style="color:#64748b;padding:2px 8px 2px 0;white-space:nowrap">${k}</td>
    <td style="color:#e2e8f0;text-align:right">${v}</td>
  </tr>`;
}
