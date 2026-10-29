// Spaet nachgeladene Werbung auf einer Seite mit CSP
setTimeout(function () {
  var ad = document.createElement('div');
  ad.id = 'late';
  ad.className = 'adsbygoogle-box';
  ad.textContent = 'spaet nachgeladen: soll unsichtbar sein';
  document.getElementById('slot').appendChild(ad);
}, 300);
