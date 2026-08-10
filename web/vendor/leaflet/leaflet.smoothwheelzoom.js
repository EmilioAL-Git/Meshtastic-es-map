/* Smooth (continuous, no-step) mouse-wheel zoom for Leaflet 1.9.x.
 * Reemplaza el handler nativo scrollWheelZoom: en vez de calcular UN salto
 * de zoom tras un debounce (lo que provoca los "saltos" al desplazar rápido
 * la rueda), interpola el zoom hacia un valor objetivo en cada frame con
 * requestAnimationFrame, igual que el zoom de Google Maps.
 */
L.Map.mergeOptions({
  scrollWheelZoom: true,
  smoothWheelZoom: true,
  smoothSensitivity: 1,
});

L.Map.SmoothWheelZoom = L.Handler.extend({
  addHooks() {
    L.DomEvent.on(this._map._container, 'wheel', this._onWheelScroll, this);
  },

  removeHooks() {
    L.DomEvent.off(this._map._container, 'wheel', this._onWheelScroll, this);
  },

  _onWheelScroll(e) {
    if (!this._isWheeling) this._onWheelStart(e);
    this._onWheeling(e);
  },

  _onWheelStart(e) {
    const map = this._map;
    this._isWheeling = true;
    this._wheelMousePosition = map.mouseEventToContainerPoint(e);
    this._centerPoint = map.getSize()._divideBy(2);
    this._wheelStartLatLng = map.containerPointToLatLng(this._wheelMousePosition);

    map._stop();
    if (map._panAnim) map._panAnim.stop();

    this._goalZoom = map.getZoom();
    this._prevCenter = map.getCenter();
    this._prevZoom = map.getZoom();

    this._zoomAnimationId = requestAnimationFrame(this._updateWheelZoom.bind(this));
  },

  _onWheeling(e) {
    const map = this._map;

    this._goalZoom -= e.deltaY * 0.003 * map.options.smoothSensitivity;
    this._goalZoom = map._limitZoom(this._goalZoom);
    this._wheelMousePosition = map.mouseEventToContainerPoint(e);
    this._wheelStartLatLng = map.containerPointToLatLng(this._wheelMousePosition);

    clearTimeout(this._timeoutId);
    this._timeoutId = setTimeout(this._onWheelEnd.bind(this), 200);

    L.DomEvent.preventDefault(e);
    L.DomEvent.stopPropagation(e);
  },

  _onWheelEnd() {
    this._isWheeling = false;
    cancelAnimationFrame(this._zoomAnimationId);
    this._map._moveEnd(true);
  },

  _updateWheelZoom() {
    const map = this._map;

    if (!map.getCenter().equals(this._prevCenter) || map.getZoom() !== this._prevZoom) return;

    this._zoom = map.getZoom() + (this._goalZoom - map.getZoom()) * 0.3;
    this._zoom = Math.floor(this._zoom * 100) / 100;

    const delta = this._wheelMousePosition.subtract(this._centerPoint);
    if (delta.x === 0 && delta.y === 0) return;

    const center = map.unproject(
      map.project(this._wheelStartLatLng, this._zoom).subtract(delta),
      this._zoom
    );

    map._move(center, this._zoom);

    this._prevCenter = map.getCenter();
    this._prevZoom = map.getZoom();

    this._zoomAnimationId = requestAnimationFrame(this._updateWheelZoom.bind(this));
  },
});

L.Map.addInitHook('addHandler', 'smoothWheelZoom', L.Map.SmoothWheelZoom);
