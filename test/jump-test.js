// Klicks protokollieren; Kacheln haben nur einen Klick-Handler, kein Attribut
window.results = { clicked: [] };
document.querySelectorAll('.card').forEach(function (c) {
  c.addEventListener('click', function () { window.results.clicked.push(c.id); });
});
document.querySelectorAll('nav a, #far, #last, #pp1').forEach(function (a) {
  a.addEventListener('click', function (ev) { ev.preventDefault(); window.results.clicked.push(a.id); });
});
(function () {
  var c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  var ctx = c.getContext('2d'), n = 0;
  setInterval(function () { ctx.fillStyle = 'hsl(' + (n++ % 360) + ',70%,50%)'; ctx.fillRect(0, 0, 160, 90); }, 50);
  document.getElementById('v1').srcObject = c.captureStream(20);
})();

// Hilfen fuer den Test: welches Element umrahmt Fernsurfer gerade?
window.selected = function () {
  var host = document.querySelector('div[data-fernsurfer]');
  var a = host && host.getAttribute('data-fernsurfer-ring');
  if (!a) return null;
  var p = a.split(',').map(Number);
  var cands = document.querySelectorAll('a, button, input, video, iframe, .card');
  for (var i = 0; i < cands.length; i++) {
    var r = cands[i].getBoundingClientRect();
    if (Math.abs(r.left - p[0]) < 2 && Math.abs(r.top - p[1]) < 2 && Math.abs(r.width - p[2]) < 2) return cands[i].id || cands[i].tagName;
  }
  return 'rahmen:' + a;
};
window.key = function (code) {
  var e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'keyCode', { get: function () { return code; } });
  window.dispatchEvent(e);
};
window.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
