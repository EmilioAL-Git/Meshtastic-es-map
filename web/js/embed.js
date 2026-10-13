// Marca el body como "embed" (iframe o ?embed) y adelanta el estado de cookies
// antes del primer pintado. Va como script externo (la CSP no permite inline).
if (new URLSearchParams(location.search).has('embed') || window.self !== window.top) {
  document.body.classList.add('embed-mode');
}
try { if (localStorage.getItem('mesh_cookie_ok') === '1') document.body.dataset.cookieOk = '1'; } catch {}
