// ─── Config ───────────────────────────────────────────────────────────────────
const API_BASE = window.location.pathname.startsWith('/map') ? '/map' : '';

let MAP_AUTO_FIT = true;
let MAP_LAT      = 40.2;
let MAP_LNG      = -3.7;
let MAP_ZOOM     = 8;

// ─── Estado global ────────────────────────────────────────────────────────────
let allNodes       = [];
let nodesById      = new Map(); // node_id → nodo (lookup O(1), se rellena en loadAll)
let allEdges       = [];
let lastStats      = null;   // último stats.json cargado
let markers        = {};     // node_id → Leaflet marker
let firstLoad      = true;
let autoFitDone    = false;
let loadRunning    = false;
let selectedNodeId  = null;
let selOverlay      = null;   // L.marker con animación de pulso
let precisionCircle = null;   // L.circle de incertidumbre de posición
let map;
let edgeGroup;
let markerRenderer;
let searchIndex    = -1;
let markerClicked  = false;  // evita que map.click cierre el panel tras seleccionar un nodo
let spreadGroups   = new Map(); // node_id → { centerLat, centerLng, idx, total }
let clusterMarkers = {};        // groupKey → L.marker (badge de cluster)
let spreadHidden   = new Set(); // node_ids ocultos porque están en cluster
// Clusters abiertos por click del usuario — persisten toda la sesión
const openedClusters = new Set(
  JSON.parse(sessionStorage.getItem('openedClusters') || '[]')
);

const ALL_CATS      = ['gateway', 'router', 'recent', 'active', 'old'];
const FILTER_KEY    = 'mesh_active_filters';
const _saved        = (() => { try { return JSON.parse(localStorage.getItem(FILTER_KEY)); } catch { return null; } })();
const _validSaved   = _saved ? _saved.filter(c => ALL_CATS.includes(c)) : null;
const activeFilters = new Set(_validSaved && _validSaved.length > 0 ? _validSaved : ALL_CATS);

const ALL_EDGE_CATS     = ['neighbor', 'traceroute'];
const EDGE_FILTER_KEY   = 'mesh_active_edge_filters';
const _savedEdge        = (() => { try { return JSON.parse(localStorage.getItem(EDGE_FILTER_KEY)); } catch { return null; } })();
const _validSavedEdge   = _savedEdge ? _savedEdge.filter(c => ALL_EDGE_CATS.includes(c)) : null;
const activeEdgeFilters = new Set(_validSavedEdge !== null ? _validSavedEdge : ['neighbor']);

// ─── Nodos favoritos ("mis nodos") ─────────────────────────────────────────────
// Compartido entre index.html y live.html (ambos cargan state.js) — se marcan
// desde el panel de detalle del mapa o desde el buscador de En directo, y
// sirven para filtrar el feed en directo a "solo mis nodos".
const FAVORITES_KEY = 'mesh_favorite_nodes';
const _savedFavorites = (() => { try { return JSON.parse(localStorage.getItem(FAVORITES_KEY)); } catch { return null; } })();
const favoriteNodes = new Set(Array.isArray(_savedFavorites) ? _savedFavorites : []);

function isFavoriteNode(nodeId) { return !!nodeId && favoriteNodes.has(nodeId); }

function toggleFavoriteNode(nodeId) {
  if (!nodeId) return false;
  if (favoriteNodes.has(nodeId)) favoriteNodes.delete(nodeId);
  else favoriteNodes.add(nodeId);
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favoriteNodes])); } catch {}
  return favoriteNodes.has(nodeId);
}

// ─── Ajustes del mapa (panel de ajustes) ──────────────────────────────────────
const SETTINGS_KEY = 'mesh_map_settings';
const DEFAULT_SETTINGS = {
  theme: 'light',           // 'light' | 'dark'
  markerSize: 'normal',     // 'small' | 'normal' | 'large'
  autoLocate: false,
  showPrecisionCircle: true,
  showMalIcons: true,
  flyToNode: true,
  hideOutsideSpain: false,
};
const _savedSettings = (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch { return null; } })();
const mapSettings = { ...DEFAULT_SETTINGS, ..._savedSettings };
const MARKER_SIZE_MULT = { small: 0.75, normal: 1, large: 1.35 };


// ─── Colores ──────────────────────────────────────────────────────────────────
const C_RECENT  = '#5eead4';
const C_ACTIVE  = '#7dd3fc';
const C_GATEWAY = '#fbbf24';
const C_ROUTER  = '#fb923c';
const C_OLD     = '#64748b';

// ─── Filtro geográfico "solo España" (ajuste opcional, no destructivo) ────────
// Un cuadro delimitador simple no vale para la península: Portugal está
// DENTRO de cualquier caja que cubra Galicia-Cataluña, así que hace falta
// seguir la frontera real por el lado oeste (aprox., no catastral) — el
// resto del contorno (costas, Pirineos) sí se deja con margen generoso,
// porque ahí un poco de mar/Francia de más no genera confusión con otro
// país. Baleares, Canarias, Ceuta y Melilla son enclaves no contiguos con
// la península, así que van aparte como cajas sueltas. Es solo un filtro de
// visualización en el mapa (mapSettings.hideOutsideSpain) — nunca se borra
// nada de la BD.
// Frontera con Portugal: vértices ajustados (ver isNodeInSpainBounds), poco
// margen a propósito. Todo lo demás (costas, Pirineos) lleva un margen
// amplio — un par de cientos de metros de más ahí no confunde con otro
// país, pero demasiado poco sí dejaba fuera nodos costeros reales por el
// "corte recto" entre dos vértices lejanos (un cabo/península que sobresale
// más que la línea que lo aproxima).
const MAINLAND_SPAIN_POLYGON = [
  [44.20, -9.60],  // buffer NO, más allá de la costa de Galicia
  [41.88, -9.10],  // buffer de mar frente a la desembocadura del Miño
  [41.88, -8.87],  // desembocadura del Miño: esquina NO de la frontera con Portugal
  [41.50, -6.80],  // Trás-os-Montes / Zamora
  [40.15, -6.75],  // Salamanca / Beira
  [39.65, -6.90],  // Cáceres / Portalegre
  [38.95, -7.05],  // Badajoz / Elvas
  [37.95, -7.30],  // Huelva / Algarve (aproximación)
  [37.15, -7.40],  // desembocadura del Guadiana: esquina SO de la frontera
  [35.70, -7.00],  // buffer sur, costa atlántica de Cádiz/Huelva
  [35.60, -5.50],  // buffer sur de Tarifa/Gibraltar
  [35.70, -3.00],  // buffer sur, costa de Málaga/Almería
  [37.30, -0.50],  // buffer, costa de Murcia
  [39.20,  0.50],  // buffer, costa de Valencia
  [40.90,  2.60],  // buffer, costa de Barcelona/Tarragona
  [42.60,  3.80],  // buffer NE, más allá de Cap de Creus (frontera con Francia)
  [43.20,  0.60],  // buffer, Pirineos centrales
  [43.85, -1.95],  // buffer, Pirineos occidentales / costa vasca
  [44.10, -5.20],  // buffer, costa cantábrica
  [44.20, -9.60],  // cierre del polígono
];

// Cajas para territorios no contiguos con la península (islas y ciudades
// autónomas en el norte de África) — no tiene sentido un polígono ahí, con
// una caja generosa por enclave sobra.
const SPAIN_EXTRA_BOUNDS = [
  { latMin: 38.60, latMax: 40.15, lonMin:  1.00, lonMax:  4.40 }, // Baleares
  { latMin: 27.00, latMax: 29.50, lonMin: -18.50, lonMax: -13.00 }, // Canarias
  { latMin: 35.85, latMax: 35.92, lonMin:  -5.40, lonMax:  -5.28 }, // Ceuta
  { latMin: 35.26, latMax: 35.32, lonMin:  -2.98, lonMax:  -2.90 }, // Melilla
];

// Ray casting estándar — funciona para el polígono simple (sin agujeros) de
// arriba.
function _pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lonI] = polygon[i];
    const [latJ, lonJ] = polygon[j];
    const intersects = ((lonI > lon) !== (lonJ > lon)) &&
      (lat < (latJ - latI) * (lon - lonI) / (lonJ - lonI) + latI);
    if (intersects) inside = !inside;
  }
  return inside;
}

function isNodeInSpainBounds(node) {
  if (node.latitude == null || node.longitude == null) return true; // sin posición: no es asunto de este filtro
  if (_pointInPolygon(node.latitude, node.longitude, MAINLAND_SPAIN_POLYGON)) return true;
  return SPAIN_EXTRA_BOUNDS.some(b =>
    node.latitude >= b.latMin && node.latitude <= b.latMax &&
    node.longitude >= b.lonMin && node.longitude <= b.lonMax
  );
}

// ─── Roles considerados router ────────────────────────────────────────────────
const ROUTER_ROLES = new Set(['ROUTER', 'ROUTER_CLIENT', 'REPEATER']);
function isRouter(n) { return n.role && ROUTER_ROLES.has(n.role.toUpperCase()); }

// ─── Estilos de edge ─────────────────────────────────────────────────────────
const EDGE_STYLE_HI = {
  neighbor:   { color: '#1d4ed8', weight: 2,   opacity: 0.85, dashArray: null  },
  traceroute: { color: '#dc2626', weight: 1.5, opacity: 0.75, dashArray: '6 5' },
};

// ─── Nodos mal configurados ───────────────────────────────────────────────────
let MAL_CONFIG_URL = null; // se rellena desde config.json (mal_config_url)
const malConfigurados = new Map();      // !hexvalue → { avg, sent, seen, packets, ... }
let malHistory = [];                    // historial diario de top-nodos.json
let malUpdated = null;                  // timestamp unix (s) del último análisis


// ─── Renderer SVG de las líneas de edges (overlayPane, z-index 400) ───────────
const edgeRenderer = L.svg({ padding: 0.5 });

// ─── Utilidades ───────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function row(k, v) {
  return `<tr>
    <td style="color:#64748b;padding:2px 8px 2px 0;white-space:nowrap">${k}</td>
    <td style="color:#e2e8f0;text-align:right">${escHtml(String(v))}</td>
  </tr>`;
}
