/* Smooth (continuous, no-step) mouse-wheel zoom for Leaflet 1.9.x.
 *
 * Cualquier intento de mantener sincronizado el estado REAL de Leaflet
 * (setView/setZoomAround, aunque sea con animate:true) en cada frame
 * mientras dura el gesto de scroll acaba disparando recargas de tiles
 * (a lo bruto o encadenadas) — con tiles raster eso siempre da parpadeo u
 * oscurecimiento, o si no, deja de ser continuo (pasos cortos).
 *
 * Así que mientras dura el gesto NO se toca el estado real del mapa en
 * absoluto: solo se aplica una vista previa por CSS transform (scale +
 * transform-origin en el punto del ratón) sobre los panes de Leaflet —
 * fluida, sigue al ratón, cero peticiones de red, cero parpadeo. Las líneas
 * y marcadores se ven "estirados" en vez de recalculados mientras se hace
 * zoom rápido — es el precio de que no haya parpadeo. Solo cuando el
 * usuario para de girar la rueda (tras el debounce) se hace la única
 * llamada real a Leaflet (setZoomAround) que deja el mapa nítido y
 * correcto.
 */
L.Map.mergeOptions({
  scrollWheelZoom: true,
  smoothWheelZoom: true,
  smoothSensitivity: 1,
});

const SMOOTH_ZOOM_PANES = ['tilePane', 'overlayPane', 'markerPane', 'markersPane', 'livePane'];

L.Map.SmoothWheelZoom = L.Handler.extend({
  addHooks() {
    L.DomEvent.on(this._map._container, 'wheel', this._onWheelScroll, this);
  },

  removeHooks() {
    L.DomEvent.off(this._map._container, 'wheel', this._onWheelScroll, this);
  },

  _getPanes() {
    const map = this._map;
    return SMOOTH_ZOOM_PANES.map(name => map.getPane(name)).filter(Boolean);
  },

  _previewTransform(scale, origin) {
    for (const pane of this._getPanes()) {
      pane.style.transformOrigin = `${origin.x}px ${origin.y}px`;
      pane.style.transform = scale === 1 ? '' : `scale(${scale})`;
    }
  },

  _onWheelScroll(e) {
    if (!this._isWheeling) this._onWheelStart(e);
    this._onWheeling(e);
  },

  _onWheelStart(e) {
    const map = this._map;
    this._isWheeling = true;
    this._wheelMousePosition = map.mouseEventToContainerPoint(e);

    if (map._panAnim) map._panAnim.stop();

    this._committedZoom = map.getZoom();
    this._previewZoom = map.getZoom();
    this._goalZoom = map.getZoom();

    this._zoomAnimationId = requestAnimationFrame(this._updateWheelZoom.bind(this));
  },

  _onWheeling(e) {
    const map = this._map;

    this._goalZoom -= e.deltaY * 0.003 * map.options.smoothSensitivity;
    this._goalZoom = map._limitZoom(this._goalZoom);
    this._wheelMousePosition = map.mouseEventToContainerPoint(e);

    clearTimeout(this._timeoutId);
    this._timeoutId = setTimeout(this._onWheelEnd.bind(this), 200);

    L.DomEvent.preventDefault(e);
    L.DomEvent.stopPropagation(e);
  },

  _onWheelEnd() {
    this._isWheeling = false;
    cancelAnimationFrame(this._zoomAnimationId);
    this._previewTransform(1, this._wheelMousePosition);
    this._map.setZoomAround(this._wheelMousePosition, this._goalZoom, { animate: false });
  },

  _updateWheelZoom() {
    const map = this._map;

    this._previewZoom = map._limitZoom(this._previewZoom + (this._goalZoom - this._previewZoom) * 0.3);

    const scale = map.getZoomScale(this._previewZoom, this._committedZoom);
    const origin = this._wheelMousePosition.subtract(map._getMapPanePos());
    this._previewTransform(scale, origin);

    this._zoomAnimationId = requestAnimationFrame(this._updateWheelZoom.bind(this));
  },
});

L.Map.addInitHook('addHandler', 'smoothWheelZoom', L.Map.SmoothWheelZoom);
