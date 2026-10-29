// Video aus einem Canvas-Stream (kein Netz noetig) und typische Werbetricks
window.results = { popupTries: 0, playClicks: 0 };
(function () {
  var c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  var ctx = c.getContext('2d');
  var n = 0;
  setInterval(function () { ctx.fillStyle = 'hsl(' + (n++ % 360) + ',70%,50%)'; ctx.fillRect(0, 0, 160, 90); }, 50);
  var stream = c.captureStream(20);
  var vids = document.getElementsByTagName('video');
  for (var i = 0; i < vids.length; i++) vids[i].srcObject = stream;
})();

// Klick-Schicht: will bei JEDEM Klick ein Popup oeffnen und bleibt liegen
var cjs = document.querySelectorAll('.clickjack');
for (var i = 0; i < cjs.length; i++) {
  cjs[i].addEventListener('click', function () {
    window.results.popupTries++;
    window.open('https://ads.example.net/video', '_blank');
  });
}
// Popunder auf der ganzen Seite bei jedem Klick (darf Bedienelemente nicht kaputt machen)
document.addEventListener('click', function () { window.open('https://ads.example.net/any', '_blank'); });

var pp = document.getElementById('pp1');
if (pp) pp.addEventListener('click', function () { window.results.playClicks++; });

if (window.top !== window) {
  window.addEventListener('message', function (ev) {
    if (ev.data === 'report') {
      var v = document.getElementById('v2');
      parent.postMessage({ testReport: { paused: v.paused, popupTries: window.results.popupTries,
        overlayHidden: getComputedStyle(document.getElementById('cj2')).display === 'none',
        videoPosition: getComputedStyle(v).position } }, '*');
    }
  });
}
