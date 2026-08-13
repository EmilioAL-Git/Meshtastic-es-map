// ─── Persistencia ─────────────────────────────────────────────────────────────
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(mapSettings)); } catch {}
}

// ─── Panel de ajustes ─────────────────────────────────────────────────────────
function toggleSettingsPanel() {
  const open = document.getElementById('settings-switch').classList.toggle('open');
  if (open) syncSettingsPanel();
}

function closeSettingsPanel() {
  document.getElementById('settings-switch').classList.remove('open');
  closeSettingInfo();
}

// ─── Popover de información (click en el icono ⓘ) ─────────────────────────────
function toggleSettingInfo(event, key) {
  const popover = document.getElementById('settings-info-popover');
  const icon    = event.currentTarget;
  if (popover.classList.contains('open') && popover.dataset.key === key) {
    closeSettingInfo();
    return;
  }
  popover.textContent = t(key);
  popover.dataset.key = key;
  popover.classList.add('open');

  const panelRect   = document.getElementById('settings-panel').getBoundingClientRect();
  const iconRect    = icon.getBoundingClientRect();
  const maxLeft     = panelRect.width - popover.offsetWidth;
  const desiredLeft = iconRect.left - panelRect.left - 90;
  popover.style.top  = (iconRect.bottom - panelRect.top + 6) + 'px';
  popover.style.left = Math.min(Math.max(0, desiredLeft), Math.max(0, maxLeft)) + 'px';
}

function closeSettingInfo() {
  const popover = document.getElementById('settings-info-popover');
  popover.classList.remove('open');
  delete popover.dataset.key;
}

function syncSettingsPanel() {
  document.querySelectorAll('[data-theme]').forEach(el =>
    el.classList.toggle('active', el.dataset.theme === mapSettings.theme)
  );
  document.querySelectorAll('[data-marker-size]').forEach(el =>
    el.classList.toggle('active', el.dataset.markerSize === mapSettings.markerSize)
  );
  document.querySelectorAll('[data-setting-toggle]').forEach(el =>
    el.classList.toggle('active', !!mapSettings[el.dataset.settingToggle])
  );
}

// ─── Ajustes individuales ─────────────────────────────────────────────────────
function setTheme(theme) {
  mapSettings.theme = theme;
  applyMapTheme(theme);
  saveSettings();
  syncSettingsPanel();
}

function setMarkerSize(size) {
  mapSettings.markerSize = size;
  saveSettings();
  updateMarkerSizes();
  syncSettingsPanel();
}

function toggleMapSetting(key) {
  mapSettings[key] = !mapSettings[key];
  saveSettings();
  syncSettingsPanel();
  if (key === 'showMalIcons') renderNodes(allNodes);
  if (key === 'showPrecisionCircle') refreshPrecisionCircle();
  if (key === 'hideOutsideSpain') { renderNodes(allNodes); applyFilters(); }
  // Al activarlo a mitad de sesión, centra ya mismo (si no, solo se nota
  // la próxima vez que se cargue la página, ver app.js boot)
  if (key === 'autoLocate' && mapSettings.autoLocate) {
    locateUser({ onError: () => showToast(t('map.locationError')) });
  }
}

