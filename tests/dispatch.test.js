// Prueba del despachador declarativo data-on-* de web/js/state.js.
// Uso: node tests/dispatch.test.js   (sin dependencias; DOM simulado)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const listeners = [];
const document = {
  addEventListener: (evt, fn, capture) => listeners.push({ evt, fn, capture: !!capture }),
};
const calls = [];
const sandbox = {
  document, window: {}, localStorage: { getItem: () => null, setItem() {} },
  sessionStorage: { getItem: () => null, setItem() {} },
  console, URLSearchParams, location: { search: '', hostname: 'x', pathname: '/' },
  L: new Proxy({}, { get: () => () => ({}) }),
  navigator: {}, setTimeout, clearTimeout,
};
sandbox.window = sandbox;
['f', 'g', 'h'].forEach(n => { sandbox[n] = (...a) => calls.push([n, ...a]); });
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'state.js'), 'utf8');
try { vm.runInContext(src, sandbox); } catch (e) { console.error('state.js:', e.message); process.exit(1); }

function el(attrs, parent = null, extra = {}) {
  const node = {
    parent, value: extra.value,
    hasAttribute: k => k in attrs,
    getAttribute: k => attrs[k],
    closest(sel) {
      const k = sel.slice(1, -1);
      for (let n = this; n; n = n.parent) if (k in n._attrs) return n;
      return null;
    },
    _attrs: attrs,
  };
  return node;
}
function fire(evt, target, capture = false) {
  const e = { target, stopped: false, stopPropagation() { this.stopped = true; } };
  listeners.filter(l => l.evt === evt && l.capture === capture).forEach(l => l.fn(e));
  return e;
}

// click: argumentos literales y varios statements
let b = el({ 'data-on-click': '[["f",["a",1]],["g",[]]]' });
fire('click', b);
assert.deepStrictEqual(calls.splice(0), [['f', 'a', 1], ['g']]);

// click en hijo sin handler sube al padre con handler
const child = el({}, b);
fire('click', child);
assert.deepStrictEqual(calls.splice(0), [['f', 'a', 1], ['g']]);

// backdrop: solo si el click cae en el propio elemento
const modal = el({ 'data-on-click': '[["h",[]]]', 'data-backdrop': '' });
fire('click', el({}, modal));
assert.deepStrictEqual(calls.splice(0), []);
fire('click', modal);
assert.deepStrictEqual(calls.splice(0), [['h']]);

// data-stop + $event/$el/$value
const sel = el({ 'data-on-change': '[["f",["$value","$el"]]]', 'data-stop': '' }, null, { value: 'v1' });
const ev = fire('change', sel);
assert.strictEqual(ev.stopped, true);
const [name, val, elem] = calls.splice(0)[0];
assert.strictEqual(val, 'v1');
assert.strictEqual(elem, sel);

// eventos que no burbujean: solo el elemento exacto, vía captura
const hov = el({ 'data-on-mouseenter': '[["f",["in"]]]' });
fire('mouseenter', el({}, hov), true);
assert.deepStrictEqual(calls.splice(0), []);
fire('mouseenter', hov, true);
assert.deepStrictEqual(calls.splice(0), [['f', 'in']]);

// función inexistente y JSON corrupto no lanzan
fire('click', el({ 'data-on-click': '[["noExiste",[]]]' }));
fire('click', el({ 'data-on-click': '{roto' }));
console.log('dispatch.test.js OK');
