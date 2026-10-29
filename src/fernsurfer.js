/*
 * Fernsurfer - TizenBrew-Modul
 * TV-Browser mit Mauszeiger, Popup-Blocker und Werbefilter (EasyList, EasyList Germany, uBlock filters).
 * Keine Telemetrie, keine Netzwerkanfragen, kein Nachladen von fremdem Code.
 * Geschrieben fuer Chromium 63 (Tizen 5.0): kein ?., kein ??, keine Klassenfelder.
 *
 * Quelltext: src/fernsurfer.js. dist/userScript.js wird von tools/build.py erzeugt
 * und enthaelt zusaetzlich die Filterdaten.
 * Lizenz Code: MIT. Lizenz Filterdaten: siehe README (GPLv3 / CC BY-SA 3.0).
 */
(function () {
  'use strict';

  var W = window;
  if (W.__fernsurferLoaded) return;
  try {
    Object.defineProperty(W, '__fernsurferLoaded', { value: true, configurable: false });
  } catch (e) {
    W.__fernsurferLoaded = true;
  }

  // Originale sichern, bevor Scriptlets sie umbiegen - sonst koennte eine Regel
  // wie "prevent-addEventListener" auch unsere eigenen Listener treffen.
  var ADD = EventTarget.prototype.addEventListener;
  var ST = W.setTimeout;
  var SI = W.setInterval;
  function on(target, type, fn, capture) { ADD.call(target, type, fn, capture); }
  function later(fn, ms) { return ST.call(W, fn, ms); }
  function every(fn, ms) { return SI.call(W, fn, ms); }

  var VERSION = '1.0.1';
  var FILTERS = /*@@FILTERS@@*/null;
  var HOME = 'https://html.duckduckgo.com/html/';
  var SEARCH = 'https://html.duckduckgo.com/html/?q=';
  var IS_TOP = W.top === W;
  var HOST = (location.hostname || '').toLowerCase();
  var OFF_KEY = 'fernsurfer:off';

  // TizenBrew schleust das Modul in jede Seite seines Fensters ein - auch in die
  // eigene Oberflaeche, wenn man den Browser verlaesst. Dort hat es nichts zu suchen.
  if (!/^https?:$/.test(location.protocol) || /tizenbrew-ui/i.test(location.pathname) ||
      ((HOST === '127.0.0.1' || HOST === 'localhost') && location.port === '8081')) {
    return;
  }

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, ESC: 27,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412
  };

  // Gesamter Zustand steht oben, damit spaetere "var"-Zeilen nichts zuruecksetzen.
  var ownClick = false;   // true, solange der eigene Zeiger klickt
  var stats = { popups: 0, net: 0 };
  var knownFrames = [];
  var pendingFrame = null;
  var lastHover = null;
  var ui = null;
  var cursorOn = true;
  var barOpen = false;
  var menu = null;        // { items, index }
  var cx = -1;
  var cy = -1;
  var lastMove = 0;
  var speed = 1;
  var toastTimer = null;
  var userActed = false;  // erste Taste gedrueckt?

  var DISABLED = (function () {
    try { return W.localStorage.getItem(OFF_KEY) === '1'; } catch (e) { return false; }
  })();

  /* ------------------------------------------------------------------ */
  /* Hilfsfunktionen                                                     */
  /* ------------------------------------------------------------------ */

  // Alle Schluessel, unter denen Regeln fuer diesen Host stehen koennen:
  // Host, Elterndomains und uBO-"Entity"-Formen wie "example.*".
  function hostKeys(host) {
    var keys = [];
    if (!host) return keys;
    var labels = host.split('.');
    for (var i = 0; i < labels.length; i++) {
      var suffix = labels.slice(i).join('.');
      keys.push(suffix);
      if (i < labels.length - 1) {
        keys.push(labels.slice(i, labels.length - 1).join('.') + '.*');
      }
    }
    return keys;
  }
  var KEYS = hostKeys(HOST);

  function collect(map) {
    var out = [];
    if (!map) return out;
    for (var i = 0; i < KEYS.length; i++) {
      var list = map[KEYS[i]];
      if (list) out = out.concat(list);
    }
    return out;
  }

  // Nadel im uBO-Format: "text", "/regex/flags", "!negiert"
  function needle(n) {
    if (n === undefined || n === null || n === '') return function () { return true; };
    var neg = false;
    if (n.charAt(0) === '!') { neg = true; n = n.slice(1); }
    var re = null;
    var m = /^\/(.+)\/([imsu]*)$/.exec(n);
    if (m) {
      try { re = new RegExp(m[1], m[2]); } catch (e) { return function () { return false; }; }
    }
    return function (s) {
      s = String(s);
      var r = re ? re.test(s) : s.indexOf(n) >= 0;
      return neg ? !r : r;
    };
  }

  function onReady(fn) {
    if (document.readyState === 'loading') on(document, 'DOMContentLoaded', fn);
    else fn();
  }

  function report(kind) {
    if (kind === 'popup') stats.popups++;
    else stats.net++;
    if (IS_TOP) {
      if (kind === 'popup') toast('Popup blockiert (' + stats.popups + ')');
    } else {
      try { W.top.postMessage({ __tb: 'blocked', kind: kind }, '*'); } catch (e) {}
    }
  }

  /* ------------------------------------------------------------------ */
  /* Scriptlets (Teilmenge von uBlock Origin)                            */
  /* ------------------------------------------------------------------ */

  var MAGIC = 'Fernsurfer-' + Math.random().toString(36).slice(2);

  // Fehler, die wir absichtlich werfen, nicht in der Konsole/Fehlerbehandlung der Seite zeigen
  on(W, 'error', function (ev) {
    if (ev && typeof ev.message === 'string' && ev.message.indexOf(MAGIC) >= 0) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  }, true);

  function trapChain(chain, onLeaf) {
    var parts = String(chain).split('.');
    function trap(obj, i) {
      var prop = parts[i];
      if (i === parts.length - 1) { onLeaf(obj, prop); return; }
      var v;
      try { v = obj[prop]; } catch (e) { return; }
      if (v !== null && (typeof v === 'object' || typeof v === 'function')) { trap(v, i + 1); return; }
      var stored = v;
      try {
        Object.defineProperty(obj, prop, {
          configurable: true,
          get: function () { return stored; },
          set: function (nv) {
            stored = nv;
            if (nv !== null && (typeof nv === 'object' || typeof nv === 'function')) trap(nv, i + 1);
          }
        });
      } catch (e) {}
    }
    trap(W, parts[0] === 'window' ? 1 : 0);
  }

  var SKIP = {};
  function constValue(raw) {
    switch (raw) {
      case 'undefined': return undefined;
      case 'false': return false;
      case 'true': return true;
      case 'null': return null;
      case "''": case 'emptyStr': case '': return '';
      case 'emptyArr': return [];
      case 'emptyObj': return {};
      case 'noopFunc': return function () {};
      case 'trueFunc': return function () { return true; };
      case 'falseFunc': return function () { return false; };
      case 'noopCallbackFunc': return function () { return function () {}; };
      case 'yes': case 'no': case 'on': case 'off': return raw;
    }
    if (/^-?\d+(\.\d+)?$/.test(raw) && Math.abs(Number(raw)) <= 0x7FFF) return Number(raw);
    if (/^'.*'$/.test(raw)) return raw.slice(1, -1);
    return SKIP;
  }

  function currentScriptMatches(test) {
    var s = document.currentScript;
    if (!s) return false;
    var text = s.src ? s.src : (s.textContent || '');
    return test(text);
  }

  function wrapTimer(name, args) {
    var test = needle(args[0]);
    var delayArg = args[1];
    var orig = W[name];
    if (typeof orig !== 'function') return;
    W[name] = function (fn, delay) {
      var dm = true;
      if (delayArg) {
        var neg = delayArg.charAt(0) === '!';
        var d = parseInt(neg ? delayArg.slice(1) : delayArg, 10);
        dm = (Number(delay) === d) !== neg;
      }
      if (dm && test(fn)) return 0;
      return orig.apply(this, arguments);
    };
  }

  function pruneJson(obj, paths) {
    paths.forEach(function (path) {
      var parts = path.split('.');
      (function walk(o, i) {
        if (o === null || typeof o !== 'object') return;
        var p = parts[i];
        if (p === '[]' || p === '[-]' || p === '*') {
          if (i === parts.length - 1) return;
          for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) walk(o[k], i + 1); }
          return;
        }
        if (i === parts.length - 1) { delete o[p]; return; }
        walk(o[p], i + 1);
      })(obj, 0);
    });
  }

  function hasPath(obj, path) {
    var parts = path.split('.');
    var o = obj;
    for (var i = 0; i < parts.length; i++) {
      if (o === null || typeof o !== 'object' || !(parts[i] in o)) return false;
      o = o[parts[i]];
    }
    return true;
  }

  function attrCleaner(kind, names, selector) {
    var list = String(names || '').split(/\s*\|\s*/).filter(Boolean);
    if (!list.length) return;
    var sel = selector || list.map(function (n) { return kind === 'attr' ? '[' + n + ']' : '.' + n; }).join(',');
    function run() {
      var els;
      try { els = document.querySelectorAll(sel); } catch (e) { return; }
      for (var i = 0; i < els.length; i++) {
        for (var j = 0; j < list.length; j++) {
          if (kind === 'attr') els[i].removeAttribute(list[j]);
          else els[i].classList.remove(list[j]);
        }
      }
    }
    var timer = null;
    onReady(function () {
      run();
      new MutationObserver(function () {
        if (timer) return;
        timer = later(function () { timer = null; run(); }, 100);
      }).observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  var SCRIPTLETS = {
    'set-constant': function (a) {
      var value = constValue(a[1]);
      if (!a[0] || value === SKIP) return;
      trapChain(a[0], function (obj, prop) {
        try {
          Object.defineProperty(obj, prop, {
            configurable: true,
            get: function () { return value; },
            set: function () {}
          });
        } catch (e) {}
      });
    },
    'abort-on-property-read': function (a) {
      if (!a[0]) return;
      trapChain(a[0], function (obj, prop) {
        try {
          Object.defineProperty(obj, prop, {
            configurable: true,
            get: function () { throw new ReferenceError(MAGIC); },
            set: function () {}
          });
        } catch (e) {}
      });
    },
    'abort-on-property-write': function (a) {
      if (!a[0]) return;
      trapChain(a[0], function (obj, prop) {
        try {
          Object.defineProperty(obj, prop, {
            configurable: true,
            get: function () { return undefined; },
            set: function () { throw new ReferenceError(MAGIC); }
          });
        } catch (e) {}
      });
    },
    'abort-current-script': function (a) {
      if (!a[0]) return;
      var test = needle(a[1]);
      trapChain(a[0], function (obj, prop) {
        var value;
        try { value = obj[prop]; } catch (e) {}
        try {
          Object.defineProperty(obj, prop, {
            configurable: true,
            get: function () {
              if (currentScriptMatches(test)) throw new ReferenceError(MAGIC);
              return value;
            },
            set: function (v) {
              if (currentScriptMatches(test)) throw new ReferenceError(MAGIC);
              value = v;
            }
          });
        } catch (e) {}
      });
    },
    'no-setTimeout-if': function (a) { wrapTimer('setTimeout', a); },
    'no-setInterval-if': function (a) { wrapTimer('setInterval', a); },
    'prevent-addEventListener': function (a) {
      var typeTest = needle(a[0]);
      var fnTest = needle(a[1]);
      var proto = EventTarget.prototype;
      var orig = proto.addEventListener;
      proto.addEventListener = function (type, handler) {
        var src = handler && typeof handler === 'object' && handler.handleEvent ? handler.handleEvent : handler;
        if (typeTest(type) && fnTest(src)) return;
        return orig.apply(this, arguments);
      };
    },
    'json-prune': function (a) {
      var paths = String(a[0] || '').split(/\s+/).filter(Boolean);
      var needles = String(a[1] || '').split(/\s+/).filter(Boolean);
      if (!paths.length) return;
      var orig = JSON.parse;
      JSON.parse = function () {
        var r = orig.apply(this, arguments);
        try {
          if (!needles.length || needles.every(function (p) { return hasPath(r, p); })) pruneJson(r, paths);
        } catch (e) {}
        return r;
      };
    },
    'prevent-fetch': function (a) {
      var test = needle(a[0]);
      var orig = W.fetch;
      if (typeof orig !== 'function') return;
      W.fetch = function (input) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (test(url)) return Promise.resolve(new Response('', { status: 200 }));
        return orig.apply(this, arguments);
      };
    },
    'prevent-xhr': function (a) {
      var test = needle(a[0]);
      var X = XMLHttpRequest.prototype;
      var open = X.open;
      var send = X.send;
      X.open = function (method, url) {
        this.__tbFake = test(url);
        return open.apply(this, arguments);
      };
      X.send = function () {
        if (!this.__tbFake) return send.apply(this, arguments);
        var xhr = this;
        try {
          Object.defineProperty(xhr, 'readyState', { value: 4 });
          Object.defineProperty(xhr, 'status', { value: 200 });
          Object.defineProperty(xhr, 'responseText', { value: '' });
          Object.defineProperty(xhr, 'response', { value: '' });
        } catch (e) {}
        later(function () {
          ['readystatechange', 'load', 'loadend'].forEach(function (t) {
            try { xhr.dispatchEvent(new Event(t)); } catch (e) {}
          });
        }, 0);
      };
    },
    'remove-attr': function (a) { attrCleaner('attr', a[0], a[1]); },
    'remove-class': function (a) { attrCleaner('class', a[0], a[1]); },
    'noeval-if': function (a) {
      var test = needle(a[0]);
      var orig = W.eval;
      W.eval = function (code) {
        if (test(code)) return undefined;
        return orig.apply(this, arguments);
      };
    }
  };

  var ALIASES = {
    'set': 'set-constant',
    'aopr': 'abort-on-property-read',
    'aopw': 'abort-on-property-write',
    'acs': 'abort-current-script',
    'acis': 'abort-current-script',
    'abort-current-inline-script': 'abort-current-script',
    'nostif': 'no-setTimeout-if',
    'prevent-setTimeout': 'no-setTimeout-if',
    'setTimeout-defuser': 'no-setTimeout-if',
    'nosiif': 'no-setInterval-if',
    'prevent-setInterval': 'no-setInterval-if',
    'setInterval-defuser': 'no-setInterval-if',
    'aeld': 'prevent-addEventListener',
    'addEventListener-defuser': 'prevent-addEventListener',
    'no-fetch-if': 'prevent-fetch',
    'no-xhr-if': 'prevent-xhr',
    'ra': 'remove-attr',
    'rc': 'remove-class',
    'noeval-if': 'noeval-if',
    'prevent-eval-if': 'noeval-if'
  };

  function runScriptlets() {
    if (!FILTERS) return;
    var excluded = collect(FILTERS.jsx).concat((FILTERS.jsx && FILTERS.jsx['*']) || []);
    if (excluded.indexOf('*') >= 0) return;
    var seen = {};
    collect(FILTERS.js).forEach(function (args) {
      var name = ALIASES[args[0]] || args[0];
      if (excluded.indexOf(args[0]) >= 0 || excluded.indexOf(name) >= 0) return;
      var key = args.join('\u0001');
      if (seen[key]) return;
      seen[key] = true;
      var fn = SCRIPTLETS[name];
      if (fn) {
        try { fn(args.slice(1)); } catch (e) {}
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Nachgeladene Inhalte von Werbe-Hosts blockieren                     */
  /* ------------------------------------------------------------------ */

  var netSet = null;
  var SITE = HOST.split('.').slice(-2).join('.');

  function isBlockedUrl(url) {
    if (!FILTERS || !FILTERS.net || !url) return false;
    var host;
    try { host = new URL(url, location.href).hostname.toLowerCase(); } catch (e) { return false; }
    if (!host || host === HOST || host === SITE || host.slice(-SITE.length - 1) === '.' + SITE) return false;
    if (!netSet) {
      netSet = new Set(FILTERS.net.split(' '));
    }
    var labels = host.split('.');
    for (var i = 0; i < labels.length - 1; i++) {
      if (netSet.has(labels.slice(i).join('.'))) return true;
    }
    return false;
  }

  function installNetBlock() {
    if (!FILTERS || !FILTERS.net) return;

    var origFetch = W.fetch;
    if (typeof origFetch === 'function') {
      W.fetch = function (input) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (isBlockedUrl(url)) {
          report('net');
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return origFetch.apply(this, arguments);
      };
    }

    var X = XMLHttpRequest.prototype;
    var xOpen = X.open;
    var xSend = X.send;
    X.open = function (method, url) {
      this.__tbBlocked = isBlockedUrl(url);
      return xOpen.apply(this, arguments);
    };
    X.send = function () {
      if (this.__tbBlocked) {
        report('net');
        var xhr = this;
        later(function () {
          try { xhr.dispatchEvent(new Event('error')); } catch (e) {}
          try { xhr.dispatchEvent(new Event('loadend')); } catch (e) {}
        }, 0);
        return;
      }
      return xSend.apply(this, arguments);
    };

    if (navigator.sendBeacon) {
      var beacon = navigator.sendBeacon;
      navigator.sendBeacon = function (url) {
        if (isBlockedUrl(url)) { report('net'); return true; }
        return beacon.apply(this, arguments);
      };
    }

    // src von Skripten, iframes und Bildern abfangen, bevor der Browser laedt
    [HTMLScriptElement, HTMLIFrameElement, HTMLImageElement].forEach(function (Ctor) {
      var proto = Ctor.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'src');
      if (!desc || !desc.set) return;
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (v) {
          if (isBlockedUrl(v)) {
            report('net');
            if (this.tagName === 'IFRAME') desc.set.call(this, 'about:blank');
            return;
          }
          desc.set.call(this, v);
        }
      });
    });

    var setAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (typeof name === 'string' && name.toLowerCase() === 'src') {
        var tag = this.tagName;
        if ((tag === 'SCRIPT' || tag === 'IFRAME' || tag === 'IMG') && isBlockedUrl(value)) {
          report('net');
          if (tag === 'IFRAME') return setAttr.call(this, name, 'about:blank');
          return;
        }
      }
      return setAttr.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Werbeflaechen ausblenden (kosmetische Filter)                       */
  /* ------------------------------------------------------------------ */

  function installCosmetics() {
    if (!FILTERS) return;
    var sel = FILTERS.sel;
    var unhide = {};
    collect(FILTERS.unhide).forEach(function (i) { unhide[sel[i]] = true; });

    var rules = [];
    var i;
    for (i = 0; i < FILTERS.gc; i++) {
      if (!unhide[sel[i]]) rules.push(sel[i]);
    }
    collect(FILTERS.spec).forEach(function (id) {
      if (!unhide[sel[id]]) rules.push(sel[id]);
    });

    var styled = collect(FILTERS.style).filter(function (pair) { return !unhide[pair[0]]; });

    // Jede Regel einzeln, damit ein Selektor, den Chromium 63 nicht kennt,
    // nicht die ganze Gruppe ungueltig macht. "html{}" dient als Probe, ob die
    // Seite eingebettete Stylesheets per Content-Security-Policy verbietet.
    var css = ['html{}'].concat(rules.map(function (s) { return s + '{display:none!important}'; }));
    styled.forEach(function (pair) { css.push(pair[0] + '{' + pair[1] + '!important}'); });

    var style = document.createElement('style');
    style.setAttribute('data-fernsurfer', 'filters');
    style.textContent = css.join('\n');

    // Ersatzweg fuer Seiten mit CSP: Elemente direkt per Skript ausblenden.
    // CSSOM-Aenderungen an element.style erlaubt die CSP weiterhin.
    var jsMode = false;
    var jsRules = rules.slice();
    var jsTimer = null;

    function declarations(text) {
      return String(text).split(';').map(function (d) {
        var k = d.indexOf(':');
        return k > 0 ? [d.slice(0, k).trim(), d.slice(k + 1).replace(/!important/i, '').trim()] : null;
      }).filter(Boolean);
    }
    var styledDecls = styled.map(function (pair) { return [pair[0], declarations(pair[1])]; });

    function jsHide() {
      jsTimer = null;
      for (var k = 0; k < jsRules.length; k++) {
        var els;
        try { els = document.querySelectorAll(jsRules[k]); } catch (e) { jsRules.splice(k--, 1); continue; }
        for (var n = 0; n < els.length; n++) {
          if (els[n].style.getPropertyValue('display') !== 'none') els[n].style.setProperty('display', 'none', 'important');
        }
      }
      styledDecls.forEach(function (pair) {
        var els;
        try { els = document.querySelectorAll(pair[0]); } catch (e) { return; }
        for (var n = 0; n < els.length; n++) {
          pair[1].forEach(function (d) { els[n].style.setProperty(d[0], d[1], 'important'); });
        }
      });
    }
    function scheduleJsHide() {
      if (jsMode && !jsTimer) jsTimer = later(jsHide, 250);
    }

    // Einfache generische Selektoren (.klasse, #id) nur anwenden, wenn sie auf
    // der Seite vorkommen - so macht es uBlock Origin auch; spart Rechenzeit.
    var simple = new Set();
    if (FILTERS.gs) {
      FILTERS.gs.split(' ').forEach(function (s) { if (!unhide[s]) simple.add(s); });
    }
    var matched = {};
    var found = [];
    var dyn = document.createElement('style');
    dyn.setAttribute('data-fernsurfer', 'generic');

    function test(s) {
      if (!matched[s] && simple.has(s)) { matched[s] = true; found.push(s); }
    }
    function check(el) {
      if (el.id) test('#' + el.id);
      var cl = el.classList;
      if (cl) for (var k = 0; k < cl.length; k++) test('.' + cl[k]);
    }
    function survey(root) {
      if (!root || root.nodeType !== 1) return;
      check(root);
      var els = root.querySelectorAll('[id],[class]');
      for (var k = 0; k < els.length; k++) check(els[k]);
    }
    function flush() {
      if (!found.length) return;
      if (jsMode) {
        jsRules = jsRules.concat(found);
        scheduleJsHide();
      } else {
        dyn.appendChild(document.createTextNode(found.map(function (s) {
          return s + '{display:none!important}';
        }).join('\n') + '\n'));
      }
      found = [];
    }

    var queue = [];
    var timer = null;
    function processQueue() {
      timer = null;
      var q = queue;
      queue = [];
      for (var k = 0; k < q.length; k++) survey(q[k]);
      flush();
    }

    var probed = false;
    function attach() {
      if (jsMode) return true;
      var parent = document.head || document.documentElement;
      if (!parent) return false;
      if (!style.parentNode) parent.appendChild(style);
      if (!dyn.parentNode) parent.appendChild(dyn);
      if (!probed) {
        probed = true;
        var ok = false;
        try { ok = !!style.sheet && style.sheet.cssRules.length > 0; } catch (e) {}
        if (!ok) {
          jsMode = true;
          if (style.parentNode) style.parentNode.removeChild(style);
          if (dyn.parentNode) dyn.parentNode.removeChild(dyn);
          scheduleJsHide();
        }
      }
      return true;
    }

    if (!attach()) {
      new MutationObserver(function (m, obs) {
        if (attach()) obs.disconnect();
      }).observe(document, { childList: true, subtree: true });
    }

    onReady(function () {
      attach();
      survey(document.documentElement);
      flush();
      new MutationObserver(function (muts) {
        for (var k = 0; k < muts.length; k++) {
          var m = muts[k];
          if (m.type === 'attributes') queue.push(m.target);
          else for (var n = 0; n < m.addedNodes.length; n++) queue.push(m.addedNodes[n]);
        }
        if (!timer && queue.length) timer = later(processQueue, 50);
        scheduleJsHide();
      }).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id']
      });
    });

    // Seiten, die ihren head austauschen, verlieren sonst die Filter
    every(attach, 2000);
  }

  /* ------------------------------------------------------------------ */
  /* Popup-Blocker                                                       */
  /* ------------------------------------------------------------------ */

  function fakeWindow() {
    var noop = function () {};
    var fw = {
      closed: false, opener: null, name: '',
      focus: noop, blur: noop, postMessage: noop, moveTo: noop, resizeTo: noop,
      close: function () { fw.closed = true; },
      location: { href: 'about:blank', assign: noop, replace: noop, reload: noop },
      document: { write: noop, writeln: noop, open: noop, close: noop, body: null }
    };
    return fw;
  }

  function patchOpen(win) {
    try {
      if (!win || win.__fernsurferOpen) return;
      var blockedOpen = function open() {
        report('popup');
        return fakeWindow();
      };
      Object.defineProperty(win, 'open', {
        get: function () { return blockedOpen; },
        set: function () {},
        configurable: false
      });
      Object.defineProperty(win, '__fernsurferOpen', { value: true });
    } catch (e) {
      // Fremde Origins duerfen wir nicht anfassen - dort laeuft unser Skript selbst.
    }
  }

  function wrapGetter(proto, prop, after) {
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.get) return;
      var orig = desc.get;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          var value = orig.call(this);
          try { after(value); } catch (e) {}
          return value;
        }
      });
    } catch (e) {}
  }

  function opensNewWindow(el) {
    var t = (el.getAttribute('target') || '').toLowerCase();
    if (!t || t === '_self') return false;
    // Aus einem iframe heraus ist auch _top/_parent ein beliebter Werbetrick.
    if ((t === '_top' || t === '_parent') && IS_TOP) return false;
    return true;
  }

  function isOtherSite(href) {
    try {
      var u = new URL(href, location.href);
      return u.hostname !== location.hostname && /^https?:$/.test(u.protocol);
    } catch (e) {
      return false;
    }
  }

  function looksInvisible(el, cs) {
    if (parseFloat(cs.opacity) < 0.2 || cs.visibility === 'hidden') return true;
    if ((el.textContent || '').trim()) return false;
    if (el.querySelector('img,video,svg,canvas,picture')) return false;
    var bg = cs.backgroundColor;
    var transparentBg = bg === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(bg);
    return transparentBg && cs.backgroundImage === 'none';
  }

  // Ueberlagernde Links auf fremde Seiten sind fast immer Klick-Fallen ueber
  // dem Videoplayer: unsichtbar ab 3 % der Bildflaeche, sichtbar ab 25 %.
  function isOverlayAdLink(a) {
    if (!isOtherSite(a.href)) return false;
    var cs = W.getComputedStyle(a);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    var r = a.getBoundingClientRect();
    var area = Math.max(0, r.width) * Math.max(0, r.height);
    var vp = W.innerWidth * W.innerHeight;
    if (vp <= 0) return false;
    if (area >= vp * 0.25) return true;
    return area >= vp * 0.03 && looksInvisible(a, cs);
  }

  function installPopupBlock() {
    patchOpen(W);

    // Werbeskripte holen sich gern ein "sauberes" window.open aus einem frischen
    // about:blank-iframe. Diese Fenster patchen wir beim Zugriff.
    wrapGetter(HTMLIFrameElement.prototype, 'contentWindow', patchOpen);
    wrapGetter(HTMLIFrameElement.prototype, 'contentDocument', function (doc) {
      if (doc) patchOpen(doc.defaultView);
    });

    // Klicks auf Links: Klick-Fallen blockieren, synthetische "_blank"-Klicks
    // blockieren, echte "_blank"-Links im selben Fenster oeffnen (der TV hat keine Tabs).
    on(W, 'click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a) return;
      var userIntent = ev.isTrusted || ownClick;

      if (isOverlayAdLink(a)) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (a.parentNode) a.parentNode.removeChild(a);
        report('popup');
        return;
      }
      if (!opensNewWindow(a)) return;

      ev.preventDefault();
      if (!userIntent) {
        ev.stopImmediatePropagation();
        report('popup');
        return;
      }
      var href = a.href;
      if (/^https?:/i.test(href)) {
        try { W.top.location.href = href; } catch (e) { location.href = href; }
      }
    }, true);

    // a.click() und a.dispatchEvent(click) auf losgeloesten Links erreichen den
    // Listener oben nicht - darum direkt am Prototyp abfangen.
    var A = HTMLAnchorElement.prototype;
    var origClick = A.click;
    A.click = function () {
      if (!ownClick && opensNewWindow(this) && !document.contains(this)) {
        report('popup');
        return;
      }
      return origClick.apply(this, arguments);
    };
    var origDispatch = EventTarget.prototype.dispatchEvent;
    A.dispatchEvent = function (event) {
      if (event && event.type === 'click' && !ownClick && opensNewWindow(this) && !document.contains(this)) {
        report('popup');
        return false;
      }
      return origDispatch.apply(this, arguments);
    };
    var F = HTMLFormElement.prototype;
    var origSubmit = F.submit;
    F.submit = function () {
      if (!ownClick && opensNewWindow(this)) {
        report('popup');
        return;
      }
      return origSubmit.apply(this, arguments);
    };
  }

  // Reihenfolge: Scriptlets zuerst, damit sie vor den Skripten der Seite greifen.
  if (!DISABLED) {
    try { runScriptlets(); } catch (e) {}
    try { installNetBlock(); } catch (e) {}
    try { installPopupBlock(); } catch (e) {}
    try { installCosmetics(); } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* Kommunikation zwischen Frames                                       */
  /* ------------------------------------------------------------------ */

  function frameForWindow(win) {
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === win) return frames[i];
    }
    return null;
  }

  function isFocusedChild(win) {
    var ae = document.activeElement;
    return !!ae && ae.tagName === 'IFRAME' && ae.contentWindow === win;
  }

  on(W, 'message', function (ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object' || typeof d.__tb !== 'string') return;

    switch (d.__tb) {
      case 'hello':
        if (frameForWindow(ev.source) && knownFrames.indexOf(ev.source) < 0) knownFrames.push(ev.source);
        break;
      case 'ping':
        if (ev.source === W.parent) W.parent.postMessage({ __tb: 'hello' }, '*');
        break;
      case 'blocked':
        if (IS_TOP) {
          if (d.kind === 'popup') { stats.popups++; toast('Popup blockiert (' + stats.popups + ')'); }
          else stats.net++;
        }
        break;
      case 'click':
        // Nur der direkte Elternframe darf hier klicken lassen.
        if (ev.source === W.parent && typeof d.x === 'number' && typeof d.y === 'number') clickAt(d.x, d.y);
        break;
      case 'hover':
        if (ev.source === W.parent && typeof d.x === 'number' && typeof d.y === 'number') hoverAt(d.x, d.y);
        break;
      case 'media':
        if (ev.source === W.parent && typeof d.key === 'number') mediaKey(d.key);
        break;
      case 'key':
        // Tasten aus einem iframe, der gerade den Fokus hat, nach oben weiterreichen.
        if (typeof d.keyCode === 'number' && isFocusedChild(ev.source)) {
          if (IS_TOP) handleKey(d.keyCode, null);
          else W.parent.postMessage({ __tb: 'key', keyCode: d.keyCode }, '*');
        }
        break;
    }
  });

  if (!IS_TOP) {
    try { W.parent.postMessage({ __tb: 'hello' }, '*'); } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* Klicken, Hovern, Medien                                             */
  /* ------------------------------------------------------------------ */

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    var type = (el.type || 'text').toLowerCase();
    return ['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file', 'range', 'color'].indexOf(type) < 0;
  }

  function fire(el, type, x, y, Ctor) {
    var init = {
      bubbles: true, cancelable: true, view: W,
      clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: type.indexOf('down') >= 0 ? 1 : 0
    };
    var event;
    try {
      event = new (Ctor || MouseEvent)(type, init);
    } catch (e) {
      event = new MouseEvent(type, init);
    }
    el.dispatchEvent(event);
  }

  function forwardToFrame(frame, type, x, y) {
    var r = frame.getBoundingClientRect();
    frame.contentWindow.postMessage({ __tb: type, x: x - r.left - frame.clientLeft, y: y - r.top - frame.clientTop }, '*');
  }

  function clickAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return;

    if (el.tagName === 'IFRAME' && el.contentWindow) {
      var win = el.contentWindow;
      if (knownFrames.indexOf(win) >= 0) {
        try { el.focus(); } catch (e) {}
        forwardToFrame(el, 'click', x, y);
        return;
      }
      // Laeuft unser Skript im iframe (noch) nicht? Kurz nachfragen.
      win.postMessage({ __tb: 'ping' }, '*');
      later(function () {
        if (knownFrames.indexOf(win) >= 0) {
          try { el.focus(); } catch (e) {}
          forwardToFrame(el, 'click', x, y);
        } else if (IS_TOP && el.src && /^https?:/i.test(el.src)) {
          if (pendingFrame === el) {
            location.href = el.src;
          } else {
            pendingFrame = el;
            toast('Eingebetteter Inhalt - nochmal OK, um ihn direkt zu oeffnen');
            later(function () { if (pendingFrame === el) pendingFrame = null; }, 4000);
          }
        }
      }, 200);
      return;
    }

    if (isEditable(el)) {
      el.focus();
      try { el.click(); } catch (e) {}
      return;
    }

    ownClick = true;
    try {
      var P = W.PointerEvent || MouseEvent;
      fire(el, 'pointerdown', x, y, P);
      fire(el, 'mousedown', x, y);
      if (el.focus) { try { el.focus({ preventScroll: true }); } catch (e) {} }
      fire(el, 'pointerup', x, y, P);
      fire(el, 'mouseup', x, y);
      fire(el, 'click', x, y);
    } finally {
      ownClick = false;
    }
  }

  function hoverAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return;
    if (el.tagName === 'IFRAME' && knownFrames.indexOf(el.contentWindow) >= 0) forwardToFrame(el, 'hover', x, y);
    if (el !== lastHover) {
      if (lastHover) { fire(lastHover, 'mouseout', x, y); fire(lastHover, 'mouseleave', x, y); }
      fire(el, 'mouseover', x, y);
      fire(el, 'mouseenter', x, y);
      lastHover = el;
    }
    fire(el, 'mousemove', x, y);
  }

  function mediaKey(code) {
    var videos = document.getElementsByTagName('video');
    var v = null;
    for (var i = 0; i < videos.length; i++) {
      if (videos[i].readyState > 0 || !v) v = videos[i];
    }
    if (!v) {
      var ae = document.activeElement;
      if (ae && ae.tagName === 'IFRAME' && ae.contentWindow) {
        ae.contentWindow.postMessage({ __tb: 'media', key: code }, '*');
      } else {
        var frames = document.getElementsByTagName('iframe');
        for (var j = 0; j < frames.length; j++) {
          if (knownFrames.indexOf(frames[j].contentWindow) >= 0) {
            frames[j].contentWindow.postMessage({ __tb: 'media', key: code }, '*');
          }
        }
      }
      return;
    }
    switch (code) {
      case KEY.PLAYPAUSE: if (v.paused) v.play(); else v.pause(); break;
      case KEY.PLAY: v.play(); break;
      case KEY.PAUSE: case KEY.STOP: v.pause(); break;
      case KEY.FF: v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10); break;
      case KEY.RW: v.currentTime = Math.max(0, v.currentTime - 10); break;
    }
  }

  function isMediaKey(code) {
    return code === KEY.PLAYPAUSE || code === KEY.PLAY || code === KEY.PAUSE ||
      code === KEY.STOP || code === KEY.FF || code === KEY.RW;
  }

  /* ------------------------------------------------------------------ */
  /* Tasten in iframes: nach oben weiterreichen                          */
  /* ------------------------------------------------------------------ */

  if (!IS_TOP) {
    on(W, 'keydown', function (ev) {
      if (isEditable(document.activeElement) && ev.keyCode !== KEY.BACK) return;
      W.parent.postMessage({ __tb: 'key', keyCode: ev.keyCode }, '*');
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
    return;
  }

  /* ------------------------------------------------------------------ */
  /* Ab hier nur im obersten Fenster: Zeiger, Adressleiste, Menue        */
  /* ------------------------------------------------------------------ */

  try {
    if (W.tizen && W.tizen.tvinputdevice) {
      ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'MediaPlayPause',
        'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind'].forEach(function (k) {
        try { W.tizen.tvinputdevice.registerKey(k); } catch (e) {}
      });
    }
  } catch (e) {}

  // Kein <style>-Element: Seiten wie DuckDuckGo verbieten eingebettete Stylesheets
  // per Content-Security-Policy. Stile direkt am Element (CSSOM) bleiben erlaubt.
  var TOP_Z = '2147483647';
  var STYLE = {
    cursor: {
      position: 'fixed', left: '0', top: '0', width: '28px', height: '28px', margin: '-3px 0 0 -3px',
      'pointer-events': 'none', 'z-index': TOP_Z, transition: 'opacity .2s', display: 'block'
    },
    svg: { width: '100%', height: '100%', display: 'block', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.6))' },
    toast: {
      position: 'fixed', right: '32px', bottom: '32px', 'max-width': '60%', padding: '12px 20px',
      'border-radius': '10px', background: 'rgba(20,20,24,.92)', color: '#fff',
      font: '600 20px/1.3 sans-serif', 'pointer-events': 'none', 'z-index': TOP_Z, opacity: '0',
      transition: 'opacity .25s'
    },
    bar: {
      position: 'fixed', left: '0', right: '0', top: '0', display: 'none', 'align-items': 'center',
      padding: '16px 24px', background: 'rgba(20,20,24,.96)', 'z-index': TOP_Z, font: '20px sans-serif',
      color: '#fff', 'box-shadow': '0 4px 16px rgba(0,0,0,.5)', 'box-sizing': 'border-box'
    },
    input: {
      flex: '1', 'min-width': '0', font: '22px sans-serif', padding: '10px 14px', 'border-radius': '8px',
      border: '2px solid #4a90e2', background: '#fff', color: '#111', outline: 'none'
    },
    hint: { 'margin-left': '16px', 'font-size': '16px', color: '#bbb', 'white-space': 'nowrap' },
    menu: {
      position: 'fixed', right: '32px', top: '32px', 'min-width': '420px', display: 'none', padding: '12px 0',
      'border-radius': '12px', background: 'rgba(20,20,24,.96)', color: '#fff', font: '20px/1.3 sans-serif',
      'z-index': TOP_Z, 'box-shadow': '0 8px 24px rgba(0,0,0,.5)'
    },
    title: { padding: '4px 24px 12px', 'font-size': '16px', color: '#bbb' },
    item: { padding: '12px 24px' }
  };

  function css(el, props) {
    for (var k in props) {
      if (Object.prototype.hasOwnProperty.call(props, k)) el.style.setProperty(k, props[k], 'important');
    }
    return el;
  }

  var CURSOR_SVG = '<svg viewBox="0 0 24 24"><path d="M3 2l17 10-7.5 1.6L9 21z" fill="#fff" stroke="#111" ' +
    'stroke-width="1.5" stroke-linejoin="round"/></svg>';

  function ensureCursorPos() {
    // Startposition erst setzen, wenn der Viewport eine Groesse hat
    // (beim fruehen Einschleusen ist innerWidth oft noch 0).
    if (cx < 0 && W.innerWidth > 0) {
      cx = W.innerWidth / 2;
      cy = W.innerHeight / 2;
    }
  }

  function buildUi() {
    if (ui || !document.documentElement) return;
    var host = document.createElement('div');
    host.setAttribute('data-fernsurfer', VERSION);
    // Seiten-CSS darf den Container nicht verstecken oder verschieben.
    host.style.cssText = 'all:initial !important;display:block !important;position:fixed !important;' +
      'left:0 !important;top:0 !important;width:0 !important;height:0 !important;z-index:2147483647 !important;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;

    var cursor = css(document.createElement('div'), STYLE.cursor);
    cursor.innerHTML = CURSOR_SVG;
    if (cursor.firstChild) css(cursor.firstChild, STYLE.svg);
    root.appendChild(cursor);

    var t = css(document.createElement('div'), STYLE.toast);
    root.appendChild(t);

    var bar = css(document.createElement('div'), STYLE.bar);
    var input = css(document.createElement('input'), STYLE.input);
    input.type = 'text';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.placeholder = 'Adresse oder Suchbegriff';
    var hint = css(document.createElement('span'), STYLE.hint);
    hint.textContent = 'OK = Los   Zurueck = Schliessen';
    bar.appendChild(input);
    bar.appendChild(hint);
    root.appendChild(bar);

    var menuEl = css(document.createElement('div'), STYLE.menu);
    root.appendChild(menuEl);

    on(input, 'keydown', function (ev) {
      if (ev.keyCode === KEY.ENTER) {
        ev.preventDefault();
        go(input.value);
      } else if (ev.keyCode === KEY.BACK || ev.keyCode === KEY.ESC || ev.keyCode === KEY.DOWN) {
        ev.preventDefault();
        closeBar();
      }
      ev.stopPropagation();
    });

    (document.body || document.documentElement).appendChild(host);
    ui = { host: host, root: root, cursor: cursor, toast: t, bar: bar, input: input, menu: menuEl };
    drawCursor();
  }

  // Seiten, die ihr body austauschen, sollen den Zeiger nicht verlieren.
  every(function () {
    if (ui && !document.documentElement.contains(ui.host)) {
      (document.body || document.documentElement).appendChild(ui.host);
    }
  }, 1500);

  function toast(text) {
    if (!ui) buildUi();
    if (!ui) return;
    ui.toast.textContent = text;
    css(ui.toast, { opacity: '1' });
    clearTimeout(toastTimer);
    toastTimer = later(function () { css(ui.toast, { opacity: '0' }); }, 2200);
  }

  function drawCursor() {
    if (!ui) return;
    ensureCursorPos();
    css(ui.cursor, {
      transform: 'translate(' + Math.round(cx) + 'px,' + Math.round(cy) + 'px)',
      opacity: cursorOn ? '1' : '0'
    });
  }

  function scrollableParent(el, dx, dy) {
    while (el && el !== document.body && el !== document.documentElement) {
      var cs = W.getComputedStyle(el);
      if (dy && /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) {
        if ((dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight) || (dy < 0 && el.scrollTop > 0)) return el;
      }
      if (dx && /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth) {
        if ((dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth) || (dx < 0 && el.scrollLeft > 0)) return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function moveCursor(dx, dy) {
    ensureCursorPos();
    var now = Date.now();
    speed = now - lastMove < 180 ? Math.min(speed + 0.35, 4) : 1;
    lastMove = now;
    var step = Math.max(8, Math.round(W.innerWidth / 110)) * speed;
    var margin = 4;
    var wasAtTop = cy <= margin;
    var nx = cx + dx * step;
    var ny = cy + dy * step;

    var sx = 0, sy = 0;
    if (nx < margin) { sx = nx - margin; nx = margin; }
    if (nx > W.innerWidth - margin) { sx = nx - (W.innerWidth - margin); nx = W.innerWidth - margin; }
    if (ny < margin) { sy = ny - margin; ny = margin; }
    if (ny > W.innerHeight - margin) { sy = ny - (W.innerHeight - margin); ny = W.innerHeight - margin; }
    cx = nx;
    cy = ny;

    if (sx || sy) {
      var amount = Math.round(W.innerHeight / 6);
      var target = scrollableParent(document.elementFromPoint(cx, cy), sx, sy);
      // Schon oben am Rand und die Seite ist ganz oben: weiter nach oben = Adressleiste
      if (sy < 0 && !sx && wasAtTop && !target && W.scrollY <= 0) {
        drawCursor();
        openBar();
        return;
      }
      var bx = sx ? (sx > 0 ? amount : -amount) : 0;
      var by = sy ? (sy > 0 ? amount : -amount) : 0;
      if (target) target.scrollBy(bx, by);
      else W.scrollBy(bx, by);
    }
    drawCursor();
    hoverAt(cx, cy);
  }

  function go(text) {
    var v = (text || '').trim();
    if (!v) return;
    var url;
    if (/^https?:\/\//i.test(v)) url = v;
    else if (/^[^\s]+\.[a-z]{2,}(\/.*)?$/i.test(v) || /^localhost(:\d+)?(\/.*)?$/i.test(v)) url = 'https://' + v;
    else url = SEARCH + encodeURIComponent(v);
    closeBar();
    location.href = url;
  }

  function openBar() {
    buildUi();
    if (!ui) return;
    barOpen = true;
    css(ui.bar, { display: 'flex' });
    ui.input.value = /^https?:/.test(location.href) && location.href.indexOf(HOME) !== 0 ? location.href : '';
    later(function () { ui.input.focus(); ui.input.select(); }, 0);
  }

  function closeBar() {
    if (!ui) return;
    barOpen = false;
    css(ui.bar, { display: 'none' });
    ui.input.blur();
  }

  /* --- Menue (blaue Taste) --- */

  function setSiteDisabled(off) {
    try {
      if (off) W.localStorage.setItem(OFF_KEY, '1');
      else W.localStorage.removeItem(OFF_KEY);
    } catch (e) {
      toast('Einstellung kann auf dieser Seite nicht gespeichert werden');
      return;
    }
    location.reload();
  }

  function openMenu() {
    buildUi();
    if (!ui) return;
    var items = [
      { label: 'Seite neu laden', run: function () { location.reload(); } },
      {
        label: DISABLED ? 'Werbeblocker hier einschalten' : 'Werbeblocker hier ausschalten',
        run: function () { setSiteDisabled(!DISABLED); }
      },
      { label: 'Zur Startseite', run: function () { location.href = HOME; } },
      { label: 'Schliessen', run: function () {} }
    ];
    menu = { items: items, index: 0 };
    renderMenu();
  }

  function renderMenu() {
    var el = ui.menu;
    el.textContent = '';
    var title = css(document.createElement('div'), STYLE.title);
    title.textContent = 'Fernsurfer ' + VERSION + ' - ' + (HOST || 'Seite') + ' - ' +
      (DISABLED ? 'Werbeblocker AUS' : stats.popups + ' Popups, ' + stats.net + ' Anfragen blockiert');
    el.appendChild(title);
    menu.items.forEach(function (it, i) {
      var row = css(document.createElement('div'), STYLE.item);
      css(row, { background: i === menu.index ? '#4a90e2' : 'transparent' });
      row.textContent = it.label;
      el.appendChild(row);
    });
    css(el, { display: 'block' });
  }

  function closeMenu() {
    menu = null;
    if (ui) css(ui.menu, { display: 'none' });
  }

  function menuKey(code) {
    if (code === KEY.UP) menu.index = (menu.index + menu.items.length - 1) % menu.items.length;
    else if (code === KEY.DOWN) menu.index = (menu.index + 1) % menu.items.length;
    else if (code === KEY.ENTER) {
      var it = menu.items[menu.index];
      closeMenu();
      it.run();
      return;
    } else if (code === KEY.BACK || code === KEY.BLUE) {
      closeMenu();
      return;
    } else {
      return;
    }
    renderMenu();
  }

  // ev ist null, wenn die Taste aus einem iframe weitergereicht wurde.
  function handleKey(code, ev) {
    function consume() {
      if (ev) { ev.preventDefault(); ev.stopImmediatePropagation(); }
    }

    if (barOpen) return; // die Adressleiste behandelt ihre Tasten selbst
    if (code === KEY.ESC) code = KEY.BACK; // PC-Tastatur zum Testen

    if (menu) { consume(); menuKey(code); return; }

    switch (code) {
      case KEY.RED: consume(); openBar(); return;
      case KEY.GREEN:
        consume();
        cursorOn = !cursorOn;
        drawCursor();
        toast(cursorOn ? 'Zeiger an' : 'Zeiger aus - Pfeiltasten steuern die Seite');
        return;
      case KEY.YELLOW: consume(); location.href = HOME; return;
      case KEY.BLUE: consume(); openMenu(); return;
    }

    if (isMediaKey(code)) { consume(); mediaKey(code); return; }

    var ae = document.activeElement;
    if (ev && isEditable(ae)) {
      // In Textfeldern tippt der Nutzer; nur Zurueck verlaesst das Feld.
      if (code === KEY.BACK) { consume(); ae.blur(); }
      return;
    }

    if (code === KEY.BACK) {
      consume();
      if (history.length > 1) history.back();
      else toast('Keine vorherige Seite');
      return;
    }

    if (!cursorOn) return;

    switch (code) {
      case KEY.LEFT: consume(); moveCursor(-1, 0); return;
      case KEY.RIGHT: consume(); moveCursor(1, 0); return;
      case KEY.UP: consume(); moveCursor(0, -1); return;
      case KEY.DOWN: consume(); moveCursor(0, 1); return;
      case KEY.ENTER: consume(); clickAt(cx, cy); return;
    }
  }

  on(W, 'keydown', function (ev) {
    userActed = true;
    if (!ui) buildUi();
    handleKey(ev.keyCode, ev);
  }, true);

  // Zeiger aus: "nach oben" am Seitenanfang fuehrt in die Adressleiste. Dieser
  // Listener laeuft als letzter (Bubble-Phase am window), die Seite hatte also
  // schon die Chance, die Taste selbst zu verwenden.
  on(W, 'keydown', function (ev) {
    if (cursorOn || barOpen || menu || ev.keyCode !== KEY.UP || ev.defaultPrevented) return;
    if (W.scrollY > 0) return;
    var ae = document.activeElement;
    if (isEditable(ae)) return;
    if (ae && ae !== document.body && ae !== document.documentElement) {
      var r = ae.getBoundingClientRect();
      if (r.top > W.innerHeight * 0.2) return;
    }
    ev.preventDefault();
    openBar();
  }, false);

  // Seiten wie DuckDuckGo setzen per "autofocus" den Fokus in ihr Suchfeld; dann
  // landen die Pfeiltasten dort statt beim Zeiger. Vor der ersten Taste loesen.
  function dropAutofocus() {
    if (userActed || barOpen) return;
    var ae = document.activeElement;
    if (ae && ae !== document.body && isEditable(ae)) ae.blur();
  }
  // Chromium setzt "autofocus" teils erst, wenn die Seite sichtbar wird - also
  // jeden Fokus abfangen, der vor der ersten Taste in ein Eingabefeld springt.
  // (Fokus in unserer eigenen Adressleiste kommt hier als Host-Element an.)
  on(W, 'focusin', function (ev) {
    if (userActed || barOpen) return;
    if (isEditable(ev.target)) { try { ev.target.blur(); } catch (e) {} }
  }, true);

  function isHomePage() {
    return location.href.indexOf(HOME) === 0 && !!document.getElementById('search_form_input_homepage');
  }

  on(W, 'resize', function () {
    ensureCursorPos();
    cx = Math.min(cx, W.innerWidth - 4);
    cy = Math.min(cy, W.innerHeight - 4);
    drawCursor();
  });

  onReady(function () {
    buildUi();
    dropAutofocus();
    later(dropAutofocus, 300);
    // Auf der Startseite gleich in die eigene Adressleiste
    if (isHomePage() && !userActed) openBar();
  });
  on(W, 'load', dropAutofocus);
})();
