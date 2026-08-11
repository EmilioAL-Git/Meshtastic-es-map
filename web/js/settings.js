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

  const panelRect = document.getElementById('settings-panel').getBoundingClientRect();
  const iconRect  = icon.getBoundingClientRect();
  popover.style.top  = (iconRect.bottom - panelRect.top + 6) + 'px';
  popover.style.left = Math.max(0, iconRect.left - panelRect.left - 90) + 'px';
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
  // Al activarlo a mitad de sesión, centra ya mismo (si no, solo se nota
  // la próxima vez que se cargue la página, ver app.js boot)
  if (key === 'autoLocate' && mapSettings.autoLocate) {
    locateUser({ onError: () => showToast(t('map.locationError')) });
  }
}

// ─── Modo kiosko ──────────────────────────────────────────────────────────────
function makeKioskPulseIcon(color) {
  return L.divIcon({
    html: `<div class="kiosk-pulse-marker">
        <div class="kiosk-pulse" style="border-color:${color}"></div>
        <div class="kiosk-pulse kiosk-pulse2" style="border-color:${color}"></div>
      </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    className: '',
  });
}

function refreshKioskPulses() {
  if (!kioskActive) return;
  if (kioskPulseGroup) kioskPulseGroup.clearLayers();
  else kioskPulseGroup = L.layerGroup().addTo(map);

  allNodes.forEach(n => {
    if (!n.is_recent || n.latitude == null || n.longitude == null) return;
    L.marker([n.latitude, n.longitude], {
      icon: makeKioskPulseIcon(nodeColor(n)),
      interactive: false,
      zIndexOffset: -100,
    }).addTo(kioskPulseGroup);
  });
}

function enterKioskMode() {
  closeSettingsPanel();
  document.getElementById('filter-panel').classList.remove('open');
  document.getElementById('filter-toggle-btn').classList.remove('active');
  if (selectedNodeId) closeDetail();

  document.body.classList.add('kiosk-mode');
  map.stop();
  fitAllNodes();

  kioskActive = true;
  refreshKioskPulses();
  document.getElementById('kiosk-exit-btn').classList.add('visible');
}

function exitKioskMode() {
  kioskActive = false;
  if (kioskPulseGroup) { map.removeLayer(kioskPulseGroup); kioskPulseGroup = null; }
  document.body.classList.remove('kiosk-mode');
  document.getElementById('kiosk-exit-btn').classList.remove('visible');
}
