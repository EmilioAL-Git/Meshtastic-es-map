// ─── Motor de internacionalización (i18n) ─────────────────────────────────────
// Sistema ligero sin dependencias. Los diccionarios viven en js/i18n/<code>.js
// y se registran en window.I18N[code]. El español (es) es la fuente de verdad y
// el fallback: cualquier clave ausente en otro idioma cae a español.
//
// Uso desde el resto del código:
//   t('header.nodes')                     → cadena traducida
//   t('toast.nodeNotFound', { node: id }) → con interpolación {node}
//   tp('detail.neighbors', n, { n })      → plural (usa Intl.PluralRules)
//   tOr('issueDefs.x.desc', '')           → con fallback explícito si falta
//   getLocale()                           → 'es-ES' / 'en-GB' para Intl/toLocale*
//
// En el HTML estático se marcan los textos con atributos:
//   <span data-i18n="header.nodes">Nodos</span>          → textContent
//   <span data-i18n-html="cookie.text">…</span>          → innerHTML (permite <strong>)
//   <input data-i18n-placeholder="header.search">        → atributo placeholder
//   <button data-i18n-title="…" data-i18n-aria-label="…">→ cualquier atributo

window.I18N = window.I18N || {};

// Idiomas disponibles en el selector. Añadir aquí un idioma nuevo (y su
// diccionario en js/i18n/<code>.js) es todo lo necesario para ofrecerlo.
const I18N_LANGS = [
  { code: 'es', label: 'Español',  locale: 'es-ES' },
  { code: 'gl', label: 'Galego',   locale: 'gl-ES' },
];
const I18N_DEFAULT   = 'es';
const I18N_STORE_KEY = 'mesh_lang';

function _i18nSupported(code) {
  return I18N_LANGS.some(l => l.code === code);
}

// Detección de idioma: ?lang=xx  →  localStorage  →  navigator.language  →  es
function _detectLang() {
  try {
    const url = new URLSearchParams(location.search).get('lang');
    if (url && _i18nSupported(url)) return url;
  } catch {}
  try {
    const saved = localStorage.getItem(I18N_STORE_KEY);
    if (saved && _i18nSupported(saved)) return saved;
  } catch {}
  const nav = (navigator.language || '').slice(0, 2).toLowerCase();
  if (_i18nSupported(nav)) return nav;
  return I18N_DEFAULT;
}

let I18N_LANG = _detectLang();

function getLang()   { return I18N_LANG; }
function getLocale() {
  return (I18N_LANGS.find(l => l.code === I18N_LANG) || {}).locale || 'es-ES';
}

// Acceso a una clave con notación por puntos: _get(obj, 'a.b.c')
function _i18nGet(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function _interp(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? params[k] : m));
}

// Traducción básica. Si no existe en el idioma activo ni en español, devuelve la
// propia clave (útil para detectar cadenas sin traducir durante el desarrollo).
function t(key, params) {
  let s = _i18nGet(window.I18N[I18N_LANG], key);
  if (s == null) s = _i18nGet(window.I18N[I18N_DEFAULT], key);
  if (s == null) return key;
  return _interp(String(s), params);
}

// Como t() pero con un fallback explícito cuando la clave no existe en ningún
// idioma (para textos construidos a partir de datos, p. ej. claves de issue).
function tOr(key, fallback, params) {
  const s = t(key, params);
  return s === key ? (fallback != null ? fallback : '') : s;
}

// Plural. La clave debe apuntar a un objeto { one, other, ... } con las
// categorías de Intl.PluralRules del idioma. Ej: { one: '{n} vecino', other: '{n} vecinos' }
let _pluralRules = null;
function tp(key, n, params) {
  if (!_pluralRules) {
    try { _pluralRules = new Intl.PluralRules(getLocale()); } catch { _pluralRules = null; }
  }
  const cat = _pluralRules ? _pluralRules.select(n) : (n === 1 ? 'one' : 'other');
  const bag = _i18nGet(window.I18N[I18N_LANG], key) || _i18nGet(window.I18N[I18N_DEFAULT], key);
  if (bag == null) return key;
  const tmpl = bag[cat] != null ? bag[cat] : bag.other;
  return _interp(String(tmpl != null ? tmpl : key), params);
}

// Cambia el idioma, lo persiste y recarga para re-renderizar toda la UI
// (buena parte del contenido se genera dinámicamente). ?node= / ?report= /
// los filtros en localStorage se conservan a través de la recarga.
function setLang(code) {
  if (!_i18nSupported(code) || code === I18N_LANG) return;
  try { localStorage.setItem(I18N_STORE_KEY, code); } catch {}
  const url = new URL(location.href);
  url.searchParams.delete('lang'); // evita que ?lang= pise la preferencia guardada
  location.assign(url.toString());
}

// ¿El usuario fijó explícitamente el idioma? (via ?lang= o el selector guardado)
function hasExplicitLangPreference() {
  try { if (new URLSearchParams(location.search).get('lang')) return true; } catch {}
  try { if (localStorage.getItem(I18N_STORE_KEY)) return true; } catch {}
  return false;
}

// Cambia el idioma en caliente (sin recarga): re-traduce el HTML estático y
// reconstruye el selector. Lo usa el idioma por defecto que llega en config.json.
function applyLanguage(code) {
  if (!_i18nSupported(code) || code === I18N_LANG) return;
  I18N_LANG = code;
  _pluralRules = null; // se reconstruye con el nuevo locale
  document.documentElement.lang = code;
  applyStaticTranslations();
  _buildLangSelector();
}

// Aplica el idioma por defecto del sitio (config.json → default_lang) solo si el
// usuario no eligió idioma explícitamente. Debe llamarse antes de renderizar el
// contenido dinámico (loadAll), para que este salga ya en el idioma correcto.
function applyDefaultLang(code) {
  if (!code || !_i18nSupported(code)) return;
  if (hasExplicitLangPreference()) return;
  applyLanguage(code);
}

// Aplica las traducciones a los nodos marcados con data-i18n* del HTML estático.
function applyStaticTranslations(root) {
  root = root || document;
  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  // Atributos: data-i18n-placeholder, data-i18n-title, data-i18n-aria-label, …
  root.querySelectorAll('*').forEach(el => {
    for (const attr of el.attributes) {
      const m = attr.name.match(/^data-i18n-(placeholder|title|aria-label|value|alt)$/);
      if (m) el.setAttribute(m[1], t(attr.value));
    }
  });
}

// Cierra el menú de idioma.
function _closeLangMenu() {
  const sw  = document.getElementById('lang-switch');
  const btn = document.getElementById('lang-btn');
  if (sw)  sw.classList.remove('open');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// Construye el menú de idioma (botón-icono + desplegable) en la cabecera.
function _buildLangSelector() {
  const menu = document.getElementById('lang-menu');
  const btn  = document.getElementById('lang-btn');
  if (!menu || !btn) return;

  menu.innerHTML = I18N_LANGS.map(l =>
    `<button type="button" class="lang-option${l.code === I18N_LANG ? ' active' : ''}" role="menuitemradio" aria-checked="${l.code === I18N_LANG}" data-code="${l.code}">${l.label}</button>`
  ).join('');
  menu.querySelectorAll('.lang-option').forEach(el => {
    el.onclick = () => { _closeLangMenu(); setLang(el.dataset.code); };
  });

  // Listeners del botón y de cierre: solo una vez (el menú se reconstruye al cambiar de idioma)
  if (!btn._wired) {
    btn._wired = true;
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const open = document.getElementById('lang-switch').classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('#lang-switch')) _closeLangMenu();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') _closeLangMenu();
    });
  }
}

// Arranque: fija <html lang>, traduce el estático y monta el selector.
document.documentElement.lang = I18N_LANG;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    applyStaticTranslations();
    _buildLangSelector();
  });
} else {
  applyStaticTranslations();
  _buildLangSelector();
}
