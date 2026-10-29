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

  var VERSION = '1.2.0';
  var FILTERS = /*@@FILTERS@@*/null;
  var SEARCH = 'https://html.duckduckgo.com/html/?q=';
  // Startseite mit den Favoriten: die DuckDuckGo-HTML-Seite mit dem Merkmal
  // "?fernsurfer". Fernsurfer legt dort seine eigene Oberflaeche ueber die Seite;
  // die Favoriten liegen im localStorage dieser Seite. tools/build.py kann die
  // Adresse ersetzen (--start), z. B. fuer Tests.
  var START = /*@@START@@*/'https://html.duckduckgo.com/html/?fernsurfer';
  var IS_TOP = W.top === W;
  var HOST = (location.hostname || '').toLowerCase();
  var OFF_KEY = 'fernsurfer:off';
  var IS_START = IS_TOP && (function () {
    try {
      var s = new URL(START);
      if (location.hostname !== s.hostname || location.pathname !== s.pathname) return false;
      // Suchergebnisse liegen unter derselben Adresse - das Merkmal muss dabei sein
      var want = s.search.replace(/^\?/, '').split('&').filter(Boolean);
      var have = location.search.replace(/^\?/, '').split('&');
      return want.every(function (p) { return have.indexOf(p) >= 0; });
    } catch (e) {
      return false;
    }
  })();

  // TizenBrew schleust das Modul in jede Seite seines Fensters ein - auch in die
  // eigene Oberflaeche, wenn man den Browser verlaesst. Dort hat es nichts zu suchen.
  if (!/^https?:$/.test(location.protocol) || /tizenbrew-ui/i.test(location.pathname) ||
      ((HOST === '127.0.0.1' || HOST === 'localhost') && location.port === '8081')) {
    return;
  }

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, ESC: 27,
    RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, INFO: 457,
    PLAYPAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413, FF: 417, RW: 412,
    // "Fertig" und "Abbrechen" der Samsung-Bildschirmtastatur
    IME_DONE: 65376, IME_CANCEL: 65385
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
  var lastForward = null; // { win, time } - letzter Klick, der an einen iframe ging
  var fsState = null;     // Pseudo-Vollbild: { el, css }
  var childPlaying = [];  // iframes (Fenster), die ein laufendes Video melden
  var reportedPlaying = false;
  var lastUserMedia = 0;  // Zeitpunkt des letzten Klicks/der letzten Medientaste
  var userStarted = typeof WeakSet === 'function' ? new WeakSet() : null;

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
      case 'fs':
        // Ein Player im iframe will Vollbild. Nur erlauben, wenn der Nutzer gerade
        // in genau diesen iframe geklickt hat - sonst koennte sich Werbung aufblasen.
        if (lastForward && lastForward.win === ev.source && Date.now() - lastForward.time < 2000) {
          var fr = frameForWindow(ev.source);
          if (fr) {
            enterPseudoFullscreen(fr);
            if (!IS_TOP) W.parent.postMessage({ __tb: 'fs' }, '*');
          }
        }
        break;
      case 'fsoff':
        if (ev.source === W.parent) exitPseudoFullscreen();
        break;
      case 'mstate':
        // Ein iframe meldet, ob darin gerade ein Video laeuft
        if (typeof d.playing === 'boolean' && frameForWindow(ev.source)) {
          var at = childPlaying.indexOf(ev.source);
          if (d.playing && at < 0) childPlaying.push(ev.source);
          if (!d.playing && at >= 0) childPlaying.splice(at, 1);
          updateMediaState();
        }
        break;
      // Link-Modus im eingebetteten Player, gesteuert vom Elternfenster
      case 'jenter':
        if (ev.source === W.parent && typeof d.x === 'number' && typeof d.y === 'number') {
          frameJump = true;
          var t = targetAt(d.x, d.y);
          if (t) selectJump(t); else reportSel(true, '');
        }
        break;
      case 'jump':
        if (ev.source === W.parent && frameJump && DIRS.indexOf(d.dir) >= 0) {
          if (jumpKey(d.dir) === 'none') reportSel(true, d.dir);
        }
        break;
      case 'jok':
        if (ev.source === W.parent && frameJump) jumpActivate();
        break;
      case 'jleave':
        if (ev.source === W.parent) { frameJump = false; jumpSel = null; }
        break;
      case 'jsel':
        if (IS_TOP) onFrameSel(ev.source, d);
        break;
      case 'fsinner':
        // Der Elternframe hat diesen iframe vergroessert: Video darin mitziehen
        if (ev.source === W.parent) enterPseudoFullscreen(biggestVideo());
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
    if (type === 'click') lastForward = { win: frame.contentWindow, time: Date.now() };
    frame.contentWindow.postMessage({ __tb: type, x: x - r.left - frame.clientLeft, y: y - r.top - frame.clientTop }, '*');
  }

  /* --- Videoplayer --- */

  function videoAt(x, y) {
    var videos = document.getElementsByTagName('video');
    for (var i = 0; i < videos.length; i++) {
      var r = videos[i].getBoundingClientRect();
      if (r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return videos[i];
    }
    return null;
  }

  function biggestVideo() {
    var best = null, area = 0;
    var videos = document.getElementsByTagName('video');
    for (var i = 0; i < videos.length; i++) {
      var r = videos[i].getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = videos[i]; }
    }
    return best;
  }

  function hasControls(el) {
    return !!el.querySelector('button,input,select,a[href],[role="button"],[role="slider"],svg,img,video');
  }

  // Unsichtbare Klick-Schicht ueber dem Player suchen, die beim Klick ein Popup
  // oeffnen wollte. Echte Bedienelemente (mit Symbolen/Buttons) bleiben unberuehrt.
  function overlayFor(el, x, y) {
    var vid = videoAt(x, y);
    var vr = vid ? vid.getBoundingClientRect() : null;
    var node = el;
    for (var depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) return null;
      if (node.tagName === 'VIDEO' || node.querySelector('video')) return null;
      var cs = W.getComputedStyle(node);
      if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
      if (hasControls(node)) return null;
      var r = node.getBoundingClientRect();
      var coversVideo = vr && r.width * r.height >= vr.width * vr.height * 0.6;
      if (coversVideo || looksInvisible(node, cs)) return node;
    }
    return null;
  }

  function looksLikeFullscreenControl(el) {
    for (var i = 0, n = el; n && i < 4; i++, n = n.parentElement) {
      var s = [n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className,
        n.id, n.getAttribute && n.getAttribute('aria-label'), n.getAttribute && n.getAttribute('title')].join(' ');
      if (/full\s*-?screen|vollbild/i.test(s)) return true;
    }
    return false;
  }

  function isNativeFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.webkitIsFullScreen);
  }

  // TizenBrew erlaubt kein echtes Vollbild aus eingebetteten Playern; stattdessen
  // wird das Video bzw. der iframe ueber die ganze Seite gelegt.
  function enterPseudoFullscreen(el) {
    if (!el) return;
    if (fsState) exitPseudoFullscreen();
    fsState = { el: el, css: el.style.cssText };
    var props = {
      position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', 'max-width': 'none',
      'max-height': 'none', margin: '0', border: '0', 'z-index': '2147483640', background: '#000'
    };
    if (el.tagName === 'VIDEO') props['object-fit'] = 'contain';
    for (var k in props) el.style.setProperty(k, props[k], 'important');
    if (IS_TOP) toast('Vollbild - Zurueck beendet es');
    mediaChanged();
  }

  function exitPseudoFullscreen() {
    if (!fsState) return false;
    fsState.el.style.cssText = fsState.css;
    var el = fsState.el;
    fsState = null;
    if (el.tagName === 'IFRAME' && el.contentWindow) el.contentWindow.postMessage({ __tb: 'fsoff' }, '*');
    mediaChanged();
    return true;
  }

  function requestFullscreenFor(vid) {
    if (IS_TOP) enterPseudoFullscreen(vid || biggestVideo());
    else {
      if (vid) enterPseudoFullscreen(vid);
      W.parent.postMessage({ __tb: 'fs' }, '*');
    }
  }

  function dispatchClick(el, x, y) {
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

  function clickAt(x, y) {
    lastUserMedia = Date.now();
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

    var vid = videoAt(x, y);
    var wasPaused = vid ? vid.paused : false;
    var popupsBefore = stats.popups;
    var wantsFullscreen = looksLikeFullscreenControl(el);

    dispatchClick(el, x, y);

    // Hat der Klick nur ein (blockiertes) Werbe-Popup ausgeloest, lag eine
    // Klick-Schicht ueber dem Player: wegraeumen und den Klick durchreichen.
    for (var tries = 0; tries < 3 && stats.popups > popupsBefore; tries++) {
      var ov = overlayFor(el, x, y);
      if (!ov) break;
      ov.style.setProperty('display', 'none', 'important');
      popupsBefore = stats.popups;
      var below = document.elementFromPoint(x, y);
      if (!below || below === el) break;
      el = below;
      if (el.tagName === 'IFRAME') { clickAt(x, y); return; }
      dispatchClick(el, x, y);
    }

    // Player, die auf synthetische Klicks nicht reagieren: Video direkt starten
    if (vid && wasPaused && !wantsFullscreen) {
      later(function () {
        if (vid.paused) {
          try { var p = vid.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
        }
      }, 300);
    }
    // Vollbild-Knopf ohne Wirkung (in TizenBrew ueblich): eigenes Vollbild
    if (wantsFullscreen) {
      later(function () {
        if (!isNativeFullscreen()) requestFullscreenFor(vid || biggestVideo());
      }, 300);
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
    lastUserMedia = Date.now();
    var videos = document.getElementsByTagName('video');
    var v = null;
    var i;
    // Zuerst das Video, das gerade laeuft - hier oder in einem eingebetteten Player
    for (i = 0; i < videos.length; i++) {
      if (!videos[i].paused && !videos[i].ended) { v = videos[i]; break; }
    }
    if (!v) {
      var target = childPlaying[0] || null;
      var focused = document.activeElement;
      if (!target && focused && focused.tagName === 'IFRAME' && knownFrames.indexOf(focused.contentWindow) >= 0) {
        target = focused.contentWindow;
      }
      if (target) { target.postMessage({ __tb: 'media', key: code }, '*'); return; }
      for (i = 0; i < videos.length; i++) {
        if (videos[i].readyState > 0 || !v) v = videos[i];
      }
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

  /* --- Laeuft gerade ein Video? (Tastenhilfe ausblenden) --- */

  // Zaehlt als "Video schauen": laeuft und ist hoerbar und gross genug - oder wurde
  // vom Nutzer gestartet, oder ist im Vollbild. Stumme Hintergrund- und
  // Vorschauvideos, die Seiten von selbst abspielen, zaehlen nicht.
  function videoCounts(v) {
    if (v.paused || v.ended) return false;
    if (fsState && (fsState.el === v || (fsState.el.contains && fsState.el.contains(v)))) return true;
    if (userStarted && userStarted.has(v)) return true;
    if (v.muted || v.volume === 0) return false;
    var r = v.getBoundingClientRect();
    return r.width * r.height >= W.innerWidth * W.innerHeight * 0.1;
  }

  function updateMediaState() {
    var playing = false;
    var vids = document.getElementsByTagName('video');
    for (var i = 0; i < vids.length && !playing; i++) playing = videoCounts(vids[i]);
    childPlaying = childPlaying.filter(function (w) { return !!frameForWindow(w); });
    var any = playing || childPlaying.length > 0;
    if (any === reportedPlaying) return;
    reportedPlaying = any;
    if (IS_TOP) onMediaActivity();
    else {
      try { W.parent.postMessage({ __tb: 'mstate', playing: any }, '*'); } catch (e) {}
    }
  }

  function mediaChanged() {
    updateMediaState();
    if (IS_TOP) onMediaActivity();
  }

  // Medien-Ereignisse blubbern nicht hoch, kommen aber in der Capture-Phase an.
  ['play', 'playing', 'pause', 'ended', 'emptied', 'volumechange'].forEach(function (type) {
    on(document, type, function (ev) {
      var v = ev.target;
      if ((type === 'play' || type === 'playing') && userStarted && v && v.tagName === 'VIDEO' &&
          Date.now() - lastUserMedia < 2000) {
        userStarted.add(v);
      }
      later(updateMediaState, 0);
    }, true);
  });
  // Videos, die einfach aus der Seite verschwinden, melden kein "pause"
  every(function () { if (reportedPlaying) updateMediaState(); }, 2000);

  /* ------------------------------------------------------------------ */
  /* Link-Modus: mit den Pfeiltasten von Element zu Element springen     */
  /* ------------------------------------------------------------------ */

  // Laeuft in jedem Frame: oben fuer die Seite, in eingebetteten Playern fuer deren
  // Knoepfe (dann gesteuert per Nachricht vom Elternfenster).

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

  var JUMP_SEL_STRICT = 'a[href],area[href],button,input,select,textarea,summary,video,iframe,' +
    '[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],' +
    '[role="switch"],[role="slider"],[role="option"],[onclick]';
  var JUMP_SEL = JUMP_SEL_STRICT + ',[tabindex]';
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, HEAD: 1, NOSCRIPT: 1, TEMPLATE: 1, BR: 1, HTML: 1, BODY: 1, path: 1
  };
  var DIRS = ['up', 'down', 'left', 'right'];
  var jumpSel = null;     // ausgewaehltes Element in diesem Frame
  var frameJump = false;  // (nur im iframe) wird gerade vom Elternfenster gesteuert

  function centerOf(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function rectOk(r) { return r.width >= 4 && r.height >= 4; }
  function onScreen(r) { return r.bottom > 0 && r.top < W.innerHeight && r.right > 0 && r.left < W.innerWidth; }

  // Alles, was man anklicken kann: Links, Knoepfe, Felder, Videos, eingebettete
  // Player - und Elemente mit "Hand"-Mauszeiger (div mit Klick-Funktion).
  function jumpTargets() {
    var vw = W.innerWidth, vh = W.innerHeight, vp = vw * vh;
    var out = [];
    var mark = typeof Set === 'function' ? new Set() : null;
    function add(el) { out.push(el); if (mark) mark.add(el); }
    function has(el) { return mark ? mark.has(el) : out.indexOf(el) >= 0; }

    var list = document.querySelectorAll(JUMP_SEL);
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el.disabled || (el.tagName === 'INPUT' && el.type === 'hidden')) continue;
      if (el.getAttribute('tabindex') === '-1' && !el.matches(JUMP_SEL_STRICT)) continue;
      var r = el.getBoundingClientRect();
      // Nur in der Naehe des Bildschirms; seitlich ausserhalb = versteckte Karussell-Teile
      if (!rectOk(r) || r.bottom < -vh * 2 || r.top > vh * 3 || r.right <= 0 || r.left >= vw) continue;
      var cs = W.getComputedStyle(el);
      if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue;
      add(el);
    }

    // Nur im sichtbaren Bereich und mit Obergrenze, damit es auf dem TV schnell bleibt
    var all = document.body ? document.body.getElementsByTagName('*') : [];
    var limit = Math.min(all.length, 4000);
    for (var k = 0; k < limit; k++) {
      var e2 = all[k];
      if (SKIP_TAGS[e2.tagName] || has(e2)) continue;
      var r2 = e2.getBoundingClientRect();
      if (r2.width < 8 || r2.height < 8 || !onScreen(r2) || r2.width * r2.height > vp * 0.5) continue;
      if (W.getComputedStyle(e2).cursor !== 'pointer') continue;
      var p = e2.parentElement;
      if (p && p !== document.body && W.getComputedStyle(p).cursor === 'pointer') continue;
      if (e2.closest(JUMP_SEL_STRICT)) continue;
      add(e2);
    }

    // Behaelter, die selbst Ziele enthalten, nicht anspringen - ausser Links,
    // Knoepfen, Videos und Playern
    var KEEP = { A: 1, BUTTON: 1, VIDEO: 1, IFRAME: 1 };
    out = out.filter(function (el) {
      if (KEEP[el.tagName]) return true;
      for (var j = 0; j < out.length; j++) {
        if (out[j] !== el && el.contains(out[j])) return false;
      }
      return true;
    });

    // Verdeckte Elemente (z. B. hinter einem Dialog) weglassen. Videos und Player
    // bleiben, auch wenn eine Klick-Schicht darueber liegt - die raeumt OK weg.
    return out.filter(function (el) {
      if (el.tagName === 'VIDEO' || el.tagName === 'IFRAME') return true;
      var c = centerOf(el.getBoundingClientRect());
      if (c.x < 0 || c.y < 0 || c.x >= vw || c.y >= vh) return true;
      var hit = document.elementFromPoint(c.x, c.y);
      return !hit || hit === el || el.contains(hit) || hit.contains(el);
    });
  }

  // Bestes Ziel in Richtung dir: moeglichst nah, moeglichst in derselben Zeile/Spalte
  function pickNext(from, dir, cands, exclude) {
    var fc = centerOf(from);
    var horiz = dir === 'left' || dir === 'right';
    var sign = dir === 'right' || dir === 'down' ? 1 : -1;
    var best = null, bestScore = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (el === exclude) continue;
      var r = el.getBoundingClientRect();
      var c = centerOf(r);
      var d = horiz ? (c.x - fc.x) * sign : (c.y - fc.y) * sign;
      if (d <= 2) continue;
      var gap = horiz ? (sign > 0 ? r.left - from.right : from.left - r.right)
                      : (sign > 0 ? r.top - from.bottom : from.top - r.bottom);
      if (gap < 0) {
        // Liegt ganz innerhalb (Knopf im Video): zuerst dorthin; sonst ueberlappend
        var inside = r.left >= from.left && r.right <= from.right && r.top >= from.top && r.bottom <= from.bottom;
        gap = d * (inside ? 0.1 : 0.3);
      }
      var overlap = horiz ? Math.min(r.bottom, from.bottom) - Math.max(r.top, from.top)
                          : Math.min(r.right, from.right) - Math.max(r.left, from.left);
      var side = overlap > 0 ? 0 : (horiz ? Math.abs(c.y - fc.y) : Math.abs(c.x - fc.x));
      var score = gap + side * 2.5;
      // Seitlich nicht zurueck in das umschliessende Element (Video um seine Knoepfe)
      var encloses = r.left <= from.left && r.right >= from.right && r.top <= from.top && r.bottom >= from.bottom;
      if (horiz && encloses) score += 100000;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  // Ohne Auswahl beginnt "runter" oben, "hoch" unten, "rechts" links, "links" rechts
  function initialRect(dir) {
    var vw = W.innerWidth, vh = W.innerHeight;
    if (dir === 'down') return { left: 0, right: vw, top: -1, bottom: -1, width: vw, height: 0 };
    if (dir === 'up') return { left: 0, right: vw, top: vh + 1, bottom: vh + 1, width: vw, height: 0 };
    if (dir === 'right') return { left: -1, right: -1, top: 0, bottom: vh, width: 0, height: vh };
    return { left: vw + 1, right: vw + 1, top: 0, bottom: vh, width: 0, height: vh };
  }

  function scrollInDir(dir) {
    var horiz = dir === 'left' || dir === 'right';
    var sign = dir === 'right' || dir === 'down' ? 1 : -1;
    var amount = Math.round((horiz ? W.innerWidth : W.innerHeight) * 0.6) * sign;
    var probe = jumpSel || document.elementFromPoint(W.innerWidth / 2, W.innerHeight / 2);
    var box = scrollableParent(probe, horiz ? sign : 0, horiz ? 0 : sign);
    if (box) {
      var before = horiz ? box.scrollLeft : box.scrollTop;
      if (horiz) box.scrollLeft += amount; else box.scrollTop += amount;
      return (horiz ? box.scrollLeft : box.scrollTop) !== before;
    }
    var bx = W.scrollX, by = W.scrollY;
    W.scrollBy(horiz ? amount : 0, horiz ? 0 : amount);
    return W.scrollX !== bx || W.scrollY !== by;
  }

  function selectJump(el) {
    jumpSel = el;
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
    var c = centerOf(el.getBoundingClientRect());
    // Mausbewegung simulieren: Player blenden dann ihre Knoepfe ein
    hoverAt(c.x, c.y);
    jumpChanged();
  }

  function jumpChanged() {
    if (IS_TOP) {
      if (jumpSel) {
        var c = centerOf(jumpSel.getBoundingClientRect());
        cx = c.x;
        cy = c.y;
      }
      drawRing();
    } else if (frameJump) {
      reportSel(false, '');
    }
  }

  // Ergebnis: 'moved' (neues Ziel), 'scrolled' (Seite bewegt) oder 'none'
  function jumpKey(dir) {
    if (jumpSel && (!document.documentElement.contains(jumpSel) || !rectOk(jumpSel.getBoundingClientRect()))) {
      jumpSel = null;
    }
    var from = jumpSel ? jumpSel.getBoundingClientRect() : initialRect(dir);
    var next = pickNext(from, dir, jumpTargets(), jumpSel);
    // Liegt das naechste Ziel ausserhalb des Bildschirms, erst ein Stueck scrollen,
    // damit Text dazwischen nicht uebersprungen wird.
    if (next && onScreen(next.getBoundingClientRect())) { selectJump(next); return 'moved'; }
    if (scrollInDir(dir)) {
      later(function () {
        var f2 = jumpSel ? jumpSel.getBoundingClientRect() : initialRect(dir);
        var n2 = pickNext(f2, dir, jumpTargets(), jumpSel);
        if (n2 && onScreen(n2.getBoundingClientRect())) selectJump(n2);
        else jumpChanged();
      }, 180);
      return 'scrolled';
    }
    if (next) { selectJump(next); return 'moved'; }
    return 'none';
  }

  // OK im Link-Modus
  function jumpActivate() {
    if (!jumpSel || !document.documentElement.contains(jumpSel)) return false;
    var el = jumpSel;
    var c = centerOf(el.getBoundingClientRect());
    var hit = document.elementFromPoint(c.x, c.y);
    var direct = hit && (hit === el || el.contains(hit) || hit.contains(el));
    if (direct || el.tagName === 'VIDEO' || el.tagName === 'IFRAME') {
      clickAt(c.x, c.y);          // inkl. Klick-Schichten wegraeumen, Video starten
    } else if (isEditable(el)) {
      el.focus();
      try { el.click(); } catch (e) {}
    } else {
      // Etwas liegt teilweise darueber (z. B. eine feste Kopfzeile): direkt anklicken
      lastUserMedia = Date.now();
      dispatchClick(el, c.x, c.y);
    }
    later(jumpChanged, 350);       // Layout kann sich nach dem Klick aendern
    return true;
  }

  // Element an einem Punkt (beim Betreten eines Players): das kleinste, das ihn enthaelt
  function targetAt(x, y) {
    var cands = jumpTargets();
    var best = null, bestArea = Infinity, near = null, nearD = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var r = cands[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width * r.height < bestArea) {
        bestArea = r.width * r.height;
        best = cands[i];
      }
      var c = centerOf(r);
      var dd = Math.abs(c.x - x) + Math.abs(c.y - y);
      if (dd < nearD) { nearD = dd; near = cands[i]; }
    }
    return best || near;
  }

  // (iframe) Auswahl ans Elternfenster melden, das den Rahmen zeichnet
  function reportSel(none, dir) {
    var msg = { __tb: 'jsel', none: !!none, dir: dir || '' };
    if (jumpSel && !none) {
      var r = jumpSel.getBoundingClientRect();
      msg.x = r.left; msg.y = r.top; msg.w = r.width; msg.h = r.height;
    }
    try { W.parent.postMessage(msg, '*'); } catch (e) {}
  }

  if (!IS_TOP) {
    var selTimer = null;
    on(W, 'scroll', function () {
      if (!frameJump || !jumpSel || selTimer) return;
      selTimer = later(function () { selTimer = null; reportSel(false, ''); }, 60);
    }, true);
  }

  // Liegt die Auswahl ueber einem Video, regelmaessig "Maus bewegen", damit die
  // Knoepfe des Players nicht wieder verschwinden.
  every(function () {
    if (!jumpSel || (!IS_TOP && !frameJump)) return;
    if (IS_TOP && (!settings || settings.mode !== 'jump' || !cursorOn)) return;
    var r = jumpSel.getBoundingClientRect();
    var vids = document.getElementsByTagName('video');
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i].getBoundingClientRect();
      if (v.right > r.left && v.left < r.right && v.bottom > r.top && v.top < r.bottom) {
        var c = centerOf(r);
        hoverAt(c.x, c.y);
        return;
      }
    }
  }, 1500);

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
  /* Ab hier nur im obersten Fenster: Zeiger, Adressleiste, Startseite,  */
  /* Menue und Tastenhilfe                                               */
  /* ------------------------------------------------------------------ */

  try {
    if (W.tizen && W.tizen.tvinputdevice) {
      ['ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info', 'MediaPlayPause',
        'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind'].forEach(function (k) {
        try { W.tizen.tvinputdevice.registerKey(k); } catch (e) {}
      });
    }
  } catch (e) {}

  /* --- Einstellungen ueber Seitenwechsel hinweg --- */

  // window.name bleibt beim Wechsel auf andere Seiten im selben Fenster erhalten
  // (Chromium 63). Darin stehen nur harmlose Schalter, keine Favoriten.
  var NAME_PREFIX = 'fernsurfer:';
  var settings = { help: true, mode: 'jump' };  // mode: 'jump' (Link-Modus) oder 'free' (freier Zeiger)
  var flash = null;
  (function () {
    var raw = null;
    try {
      if (typeof W.name === 'string' && W.name.indexOf(NAME_PREFIX) === 0) raw = W.name.slice(NAME_PREFIX.length);
    } catch (e) {}
    if (!raw && IS_START) {
      try { raw = W.localStorage.getItem('fernsurfer:settings'); } catch (e) {}
    }
    try {
      var o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') {
        if (typeof o.help === 'boolean') settings.help = o.help;
        if (o.mode === 'jump' || o.mode === 'free') settings.mode = o.mode;
        if (typeof o.flash === 'string') flash = o.flash.slice(0, 120);
      }
    } catch (e) {}
  })();

  function saveSettings(extra) {
    var o = { help: settings.help, mode: settings.mode };
    if (extra) for (var k in extra) o[k] = extra[k];
    try { W.name = NAME_PREFIX + JSON.stringify(o); } catch (e) {}
    if (IS_START) {
      try {
        W.localStorage.setItem('fernsurfer:settings', JSON.stringify({ help: settings.help, mode: settings.mode }));
      } catch (e) {}
    }
  }

  /* --- Aussehen --- */

  // Kein <style>-Element: Seiten wie DuckDuckGo verbieten eingebettete Stylesheets
  // per Content-Security-Policy. Stile direkt am Element (CSSOM) bleiben erlaubt.
  var TOP_Z = '2147483647';
  var FONT = '"Segoe UI", Roboto, "Samsung One", Arial, sans-serif';
  var ACCENT = '#4a90e2';
  var STYLE = {
    cursor: {
      position: 'fixed', left: '0', top: '0', width: '28px', height: '28px', margin: '-3px 0 0 -3px',
      'pointer-events': 'none', 'z-index': TOP_Z, transition: 'opacity .2s', display: 'block'
    },
    svg: { width: '100%', height: '100%', display: 'block', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.6))' },
    toast: {
      position: 'fixed', right: '32px', bottom: '32px', 'max-width': '60%', padding: '12px 20px',
      'border-radius': '10px', background: 'rgba(20,20,24,.92)', color: '#fff',
      font: '600 20px/1.3 ' + FONT, 'pointer-events': 'none', 'z-index': TOP_Z, opacity: '0',
      transition: 'opacity .25s'
    },
    bar: {
      position: 'fixed', left: '0', right: '0', top: '0', display: 'none', 'align-items': 'center',
      padding: '16px 24px', background: 'rgba(20,20,24,.97)', 'z-index': TOP_Z, font: '20px ' + FONT,
      color: '#fff', 'box-shadow': '0 4px 16px rgba(0,0,0,.5)', 'box-sizing': 'border-box'
    },
    input: {
      flex: '1', 'min-width': '0', font: '22px ' + FONT, padding: '10px 14px', 'border-radius': '8px',
      border: '2px solid ' + ACCENT, background: '#fff', color: '#111', outline: 'none'
    },
    btn: {
      'margin-left': '12px', padding: '10px 18px', 'border-radius': '8px', border: '2px solid #555',
      background: '#2b2f3a', color: '#fff', font: '600 20px ' + FONT, outline: 'none', cursor: 'pointer',
      'white-space': 'nowrap'
    },
    btnFocus: { background: ACCENT, 'border-color': '#fff', color: '#fff' },
    hint: { 'margin-left': '16px', 'font-size': '15px', color: '#aaa', 'white-space': 'nowrap' },
    menu: {
      position: 'fixed', right: '32px', top: '32px', 'min-width': '440px', display: 'none', padding: '12px 0',
      'border-radius': '14px', background: 'rgba(20,20,24,.97)', color: '#fff', font: '20px/1.3 ' + FONT,
      'z-index': TOP_Z, 'box-shadow': '0 8px 24px rgba(0,0,0,.5)'
    },
    title: { padding: '4px 24px 12px', 'font-size': '15px', color: '#aaa' },
    item: { padding: '12px 24px' },
    help: {
      position: 'fixed', right: '24px', top: '50%', transform: 'translateY(-50%)', width: '310px',
      padding: '18px 18px 14px', 'border-radius': '18px', background: 'rgba(16,18,28,.9)', color: '#fff',
      font: '17px/1.3 ' + FONT, 'z-index': '2147483645', 'box-shadow': '0 10px 30px rgba(0,0,0,.5)',
      border: '1px solid rgba(255,255,255,.12)', 'pointer-events': 'none', 'box-sizing': 'border-box'
    },
    helpTab: {
      position: 'fixed', right: '0', top: '50%', transform: 'translateY(-50%)', padding: '14px 8px',
      'border-radius': '10px 0 0 10px', background: 'rgba(16,18,28,.8)', color: '#fff',
      font: '600 15px ' + FONT, 'z-index': '2147483645', 'pointer-events': 'none',
      'writing-mode': 'vertical-rl', 'letter-spacing': '1px', border: '1px solid rgba(255,255,255,.15)',
      'border-right': '0'
    },
    // Rahmen um das gewaehlte Element im Link-Modus
    ring: {
      position: 'fixed', display: 'none', left: '0', top: '0', width: '0', height: '0',
      border: '3px solid ' + ACCENT, 'border-radius': '8px', 'box-sizing': 'border-box',
      'box-shadow': '0 0 0 3px rgba(255,255,255,.9), 0 0 22px 4px rgba(74,144,226,.75)',
      'pointer-events': 'none', 'z-index': '2147483644',
      transition: 'left .12s, top .12s, width .12s, height .12s'
    },
    start: {
      position: 'fixed', left: '0', top: '0', right: '0', bottom: '0', 'z-index': '2147483630',
      background: 'linear-gradient(135deg, #0f1220 0%, #1b2340 55%, #2a1f3d 100%)', color: '#fff',
      font: '18px/1.3 ' + FONT, overflow: 'hidden', padding: '48px 64px', 'box-sizing': 'border-box'
    }
  };

  function css(el, props) {
    for (var k in props) {
      if (Object.prototype.hasOwnProperty.call(props, k)) el.style.setProperty(k, props[k], 'important');
    }
    return el;
  }
  function make(tag, props, text) {
    var el = css(document.createElement(tag), props || {});
    if (text !== undefined) el.textContent = text;
    return el;
  }

  var CURSOR_SVG = '<svg viewBox="0 0 24 24"><path d="M3 2l17 10-7.5 1.6L9 21z" fill="#fff" stroke="#111" ' +
    'stroke-width="1.5" stroke-linejoin="round"/></svg>';

  /* --- Symbole fuer die Tastenhilfe --- */

  function iconBox(child) {
    var box = make('div', {
      width: '44px', height: '34px', display: 'flex', 'align-items': 'center', 'justify-content': 'center',
      'flex-shrink': '0', 'margin-right': '12px'
    });
    box.appendChild(child);
    return box;
  }
  function svgIcon(markup, w, h) {
    var d = make('div', { width: (w || 32) + 'px', height: (h || 32) + 'px' });
    d.innerHTML = markup;
    if (d.firstChild) css(d.firstChild, { width: '100%', height: '100%', display: 'block' });
    return d;
  }
  function colorKey(color) {
    return make('div', {
      width: '30px', height: '20px', 'border-radius': '6px', background: color,
      'box-shadow': 'inset 0 -3px 0 rgba(0,0,0,.25), 0 0 0 2px rgba(255,255,255,.25)'
    });
  }
  function keyCap(text, round) {
    return make('div', {
      'min-width': round ? '30px' : '38px', height: '30px', padding: round ? '0' : '0 4px',
      'border-radius': round ? '50%' : '7px', border: '2px solid rgba(255,255,255,.85)',
      display: 'flex', 'align-items': 'center', 'justify-content': 'center', font: '700 11px ' + FONT,
      color: '#fff', 'box-sizing': 'border-box'
    }, text);
  }
  var ICON = {
    dpad: function () {
      return svgIcon('<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="none" stroke="#fff" ' +
        'stroke-opacity=".85" stroke-width="2"/><path d="M16 5l4 5h-8zM16 27l-4-5h8zM5 16l5-4v8zM27 16l-5 4v-8z" ' +
        'fill="#fff"/></svg>');
    },
    ok: function () { return keyCap('OK', true); },
    back: function () {
      return svgIcon('<svg viewBox="0 0 32 32"><path d="M12 8l-6 6 6 6" fill="none" stroke="#fff" ' +
        'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 14h12a7 7 0 0 1 0 14h-5" ' +
        'fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>');
    },
    play: function () {
      return svgIcon('<svg viewBox="0 0 40 24"><path d="M3 3l12 9-12 9z" fill="#fff"/>' +
        '<rect x="22" y="3" width="5" height="18" rx="1" fill="#fff"/><rect x="31" y="3" width="5" height="18" ' +
        'rx="1" fill="#fff"/></svg>', 40, 24);
    },
    red: function () { return colorKey('#e53935'); },
    green: function () { return colorKey('#43a047'); },
    yellow: function () { return colorKey('#fdd835'); },
    blue: function () { return colorKey('#1e88e5'); },
    info: function () { return keyCap('INFO'); }
  };

  /* --- Oberflaeche aufbauen --- */

  function ensureCursorPos() {
    // Startposition erst setzen, wenn der Viewport eine Groesse hat
    // (beim fruehen Einschleusen ist innerWidth oft noch 0).
    if (cx < 0 && W.innerWidth > 0) {
      cx = W.innerWidth / 2;
      cy = W.innerHeight / 2;
    }
  }

  function barButton(label) {
    var b = make('button', STYLE.btn, label);
    b.type = 'button';
    on(b, 'focus', function () { css(b, STYLE.btnFocus); });
    on(b, 'blur', function () { css(b, STYLE.btn); });
    return b;
  }

  function buildUi() {
    if (ui || !document.documentElement) return;
    var host = document.createElement('div');
    host.setAttribute('data-fernsurfer', VERSION);
    // Seiten-CSS darf den Container nicht verstecken oder verschieben.
    host.style.cssText = 'all:initial !important;display:block !important;position:fixed !important;' +
      'left:0 !important;top:0 !important;width:0 !important;height:0 !important;z-index:2147483647 !important;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;

    var start = IS_START ? buildStart(root) : null;

    var help = make('div', STYLE.help);
    var helpTab = make('div', STYLE.helpTab, 'INFO  ·  Tastenhilfe');
    root.appendChild(help);
    root.appendChild(helpTab);

    var cursor = make('div', STYLE.cursor);
    cursor.innerHTML = CURSOR_SVG;
    if (cursor.firstChild) css(cursor.firstChild, STYLE.svg);
    root.appendChild(cursor);
    var ring = make('div', STYLE.ring);
    root.appendChild(ring);

    var t = make('div', STYLE.toast);
    root.appendChild(t);

    var bar = make('div', STYLE.bar);
    var input = make('input', STYLE.input);
    input.type = 'text';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.placeholder = 'Adresse oder Suchbegriff';
    var goBtn = barButton('▶  Öffnen');
    var starBtn = barButton('★  Favorit');
    var hint = make('span', STYLE.hint, 'OK = Los  ·  → = Knöpfe  ·  Zurück = Schließen');
    bar.appendChild(input);
    bar.appendChild(goBtn);
    bar.appendChild(starBtn);
    bar.appendChild(hint);
    root.appendChild(bar);

    var menuEl = make('div', STYLE.menu);
    root.appendChild(menuEl);

    function barKeys(ev, handlers) {
      var fn = handlers[ev.keyCode];
      if (!fn && (ev.keyCode === KEY.BACK || ev.keyCode === KEY.ESC || ev.keyCode === KEY.DOWN)) fn = closeBar;
      if (fn) { ev.preventDefault(); fn(); }
      ev.stopPropagation();
    }
    var submit = function () { go(input.value); };
    on(input, 'keydown', function (ev) {
      var h = {};
      h[KEY.ENTER] = submit;
      h[KEY.IME_DONE] = submit;
      // Pfeil rechts am Textende springt zu den Knoepfen
      if (ev.keyCode === KEY.RIGHT && input.selectionStart === input.value.length &&
          input.selectionEnd === input.value.length) {
        h[KEY.RIGHT] = function () { goBtn.focus(); };
      }
      barKeys(ev, h);
    });
    on(goBtn, 'keydown', function (ev) {
      var h = {};
      h[KEY.ENTER] = submit;
      h[KEY.LEFT] = function () { input.focus(); };
      h[KEY.RIGHT] = function () { starBtn.focus(); };
      h[KEY.UP] = function () {};
      barKeys(ev, h);
    });
    on(starBtn, 'keydown', function (ev) {
      var h = {};
      h[KEY.ENTER] = addFavorite;
      h[KEY.LEFT] = function () { goBtn.focus(); };
      h[KEY.RIGHT] = function () {};
      h[KEY.UP] = function () {};
      barKeys(ev, h);
    });

    (IS_START ? document.documentElement : (document.body || document.documentElement)).appendChild(host);
    ui = {
      host: host, root: root, cursor: cursor, toast: t, bar: bar, input: input, goBtn: goBtn, starBtn: starBtn,
      menu: menuEl, help: help, helpTab: helpTab, start: start, ring: ring
    };
    drawCursor();
    renderHelp();
    if (IS_START) renderStart();
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
    toastTimer = later(function () { css(ui.toast, { opacity: '0' }); }, 2400);
  }

  function drawCursor() {
    if (!ui) return;
    ensureCursorPos();
    css(ui.cursor, {
      transform: 'translate(' + Math.round(cx) + 'px,' + Math.round(cy) + 'px)',
      opacity: cursorOn && settings.mode === 'free' && !IS_START ? '1' : '0'
    });
  }

  /* --- Tastenhilfe --- */

  function helpRow(icon, label, sub) {
    var row = make('div', { display: 'flex', 'align-items': 'center', padding: '6px 0' });
    row.appendChild(iconBox(icon));
    var text = make('div', { 'min-width': '0' });
    text.appendChild(make('div', { 'font-weight': '600' }, label));
    if (sub) text.appendChild(make('div', { 'font-size': '13px', color: '#aab' }, sub));
    row.appendChild(text);
    return row;
  }

  function renderHelp() {
    if (!ui) return;
    var p = ui.help;
    p.textContent = '';
    p.appendChild(make('div', {
      font: '700 13px ' + FONT, 'letter-spacing': '2px', color: '#9ab', 'margin-bottom': '8px'
    }, 'FERNBEDIENUNG'));
    var rows;
    if (IS_START) {
      rows = [
        [ICON.dpad(), 'Kachel wählen'],
        [ICON.ok(), 'Öffnen'],
        [ICON.red(), 'Adresse oder Suche', 'dort mit ★ als Favorit speichern'],
        [ICON.blue(), 'Menü', 'Favorit entfernen']
      ];
    } else if (!cursorOn) {
      rows = [
        [ICON.dpad(), 'Seite steuern', 'am Seitenanfang ↑ = Adressleiste'],
        [ICON.ok(), 'Auswählen'],
        [ICON.back(), 'Zurück'],
        [ICON.red(), 'Adresse oder Suche', 'dort mit ★ als Favorit speichern'],
        [ICON.green(), 'Zeiger einschalten'],
        [ICON.yellow(), 'Startseite', 'deine Favoriten'],
        [ICON.blue(), 'Menü', 'Vollbild, Favorit, Werbeblocker'],
        [ICON.play(), 'Video', 'Play / Pause, Spulen']
      ];
    } else if (settings.mode === 'jump') {
      rows = [
        [ICON.dpad(), 'Zum nächsten Element', 'ganz oben ↑ = Adressleiste'],
        [ICON.ok(), 'Auswählen', 'Player: hinein, Zurück = hinaus'],
        [ICON.back(), 'Zurück', 'beendet auch das Vollbild'],
        [ICON.red(), 'Adresse oder Suche', 'dort mit ★ als Favorit speichern'],
        [ICON.green(), 'Freier Zeiger', 'für Stellen ohne Element'],
        [ICON.yellow(), 'Startseite', 'deine Favoriten'],
        [ICON.blue(), 'Menü', 'Vollbild, Favorit, Zeiger aus'],
        [ICON.play(), 'Video', 'im Vollbild ← → spulen, OK = Pause']
      ];
    } else {
      rows = [
        [ICON.dpad(), 'Zeiger bewegen', 'ganz oben weiter ↑ = Adressleiste'],
        [ICON.ok(), 'Klicken'],
        [ICON.back(), 'Zurück', 'beendet auch das Vollbild'],
        [ICON.red(), 'Adresse oder Suche', 'dort mit ★ als Favorit speichern'],
        [ICON.green(), 'Springen (Link-Modus)', 'von Element zu Element'],
        [ICON.yellow(), 'Startseite', 'deine Favoriten'],
        [ICON.blue(), 'Menü', 'Vollbild, Favorit, Zeiger aus'],
        [ICON.play(), 'Video', 'im Vollbild ← → spulen, OK = Pause']
      ];
    }
    rows.forEach(function (r) { p.appendChild(helpRow(r[0], r[1], r[2])); });
    var foot = make('div', {
      display: 'flex', 'align-items': 'center', 'margin-top': '10px', 'padding-top': '10px',
      'border-top': '1px solid rgba(255,255,255,.15)', 'font-size': '13px', color: '#cfd8e3'
    });
    foot.appendChild(iconBox(ICON.info()));
    foot.appendChild(make('div', {}, 'Hilfe ausblenden: INFO-Taste oder Blau → Tastenhilfe'));
    p.appendChild(foot);

    applyHelpVisibility();
  }

  // Waehrend ein Video laeuft oder etwas im Vollbild ist, stoert die Hilfe nur.
  function helpSuppressed() {
    return reportedPlaying || !!fsState || isNativeFullscreen();
  }

  function applyHelpVisibility() {
    if (!ui) return;
    var hidden = helpSuppressed();
    var shown = settings.help && !hidden;
    css(ui.help, { display: shown ? 'block' : 'none' });
    css(ui.helpTab, { display: !settings.help && !hidden ? 'block' : 'none' });
    ui.host.setAttribute('data-fernsurfer-help', shown ? 'an' : 'aus');
  }

  function onMediaActivity() {
    applyHelpVisibility();
    drawRing();
  }

  on(document, 'fullscreenchange', applyHelpVisibility);
  on(document, 'webkitfullscreenchange', applyHelpVisibility);

  function toggleHelp() {
    settings.help = !settings.help;
    saveSettings();
    renderHelp();
    if (settings.help && helpSuppressed()) toast('Tastenhilfe kommt wieder, sobald das Video pausiert');
    else toast(settings.help ? 'Tastenhilfe eingeblendet' : 'Tastenhilfe ausgeblendet - INFO zeigt sie wieder');
  }

  /* --- Freier Zeiger --- */

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

  /* --- Link-Modus im Hauptfenster: Rahmen, Player betreten, Vollbild --- */

  var innerFrame = null;  // eingebetteter Player, in dem gerade gesprungen wird
  var frameRect = null;   // dortige Auswahl, relativ zum iframe

  function fsActive() { return !!fsState || isNativeFullscreen(); }

  function drawRing() {
    if (!ui) return;
    var r = null;
    if (cursorOn && settings.mode === 'jump' && !IS_START && !fsActive()) {
      if (innerFrame && document.documentElement.contains(innerFrame)) {
        var fr = innerFrame.getBoundingClientRect();
        r = frameRect
          ? { left: fr.left + innerFrame.clientLeft + frameRect.x, top: fr.top + innerFrame.clientTop + frameRect.y,
              width: frameRect.w, height: frameRect.h }
          : fr;
      } else if (jumpSel && document.documentElement.contains(jumpSel)) {
        r = jumpSel.getBoundingClientRect();
      }
    }
    if (!r || r.width <= 0 || r.height <= 0) {
      css(ui.ring, { display: 'none' });
      ui.host.removeAttribute('data-fernsurfer-ring');
      return;
    }
    var pad = 4;
    css(ui.ring, {
      display: 'block', left: (r.left - pad) + 'px', top: (r.top - pad) + 'px',
      width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px'
    });
    ui.host.setAttribute('data-fernsurfer-ring',
      [r.left, r.top, r.width, r.height].map(function (n) { return Math.round(n); }).join(','));
  }

  var ringTimer = null;
  on(W, 'scroll', function () {
    if (ringTimer) return;
    ringTimer = later(function () { ringTimer = null; drawRing(); }, 40);
  }, true);
  every(function () { if (jumpSel || innerFrame) drawRing(); }, 500);

  function enterFrame(frame) {
    innerFrame = frame;
    frameRect = null;
    var r = frame.getBoundingClientRect();
    frame.contentWindow.postMessage({
      __tb: 'jenter', x: r.width / 2 - frame.clientLeft, y: r.height / 2 - frame.clientTop
    }, '*');
    drawRing();
  }

  function leaveFrame() {
    if (!innerFrame) return false;
    try { innerFrame.contentWindow.postMessage({ __tb: 'jleave' }, '*'); } catch (e) {}
    jumpSel = innerFrame;
    innerFrame = null;
    frameRect = null;
    jumpChanged();
    return true;
  }

  // Antwort des Players: neue Auswahl - oder "in dieser Richtung nichts mehr"
  function onFrameSel(src, d) {
    if (!innerFrame || src !== innerFrame.contentWindow) return;
    if (d.none) {
      var dir = DIRS.indexOf(d.dir) >= 0 ? d.dir : '';
      leaveFrame();
      if (dir) jumpKeyTop(dir);
      return;
    }
    if ([d.x, d.y, d.w, d.h].some(function (n) { return typeof n !== 'number' || !isFinite(n); })) return;
    frameRect = { x: d.x, y: d.y, w: d.w, h: d.h };
    var fr = innerFrame.getBoundingClientRect();
    cx = fr.left + d.x + d.w / 2;
    cy = fr.top + d.y + d.h / 2;
    drawRing();
  }

  function jumpKeyTop(dir) {
    if (innerFrame) {
      if (document.documentElement.contains(innerFrame) && innerFrame.contentWindow) {
        innerFrame.contentWindow.postMessage({ __tb: 'jump', dir: dir }, '*');
        return;
      }
      innerFrame = null;
    }
    // Noch nichts gewaehlt und Seite ganz oben: "hoch" heisst Adressleiste
    if (dir === 'up' && W.scrollY <= 0 && (!jumpSel || !document.documentElement.contains(jumpSel))) {
      openBar();
      return;
    }
    var res = jumpKey(dir);
    if (res === 'none' && dir === 'up' && W.scrollY <= 0) openBar();
  }

  function jumpOkTop() {
    if (innerFrame) {
      innerFrame.contentWindow.postMessage({ __tb: 'jok' }, '*');
      return;
    }
    if (!jumpSel || !document.documentElement.contains(jumpSel)) {
      toast('Erst mit den Pfeiltasten ein Element wählen');
      return;
    }
    var el = jumpSel;
    jumpActivate();
    // OK auf einem eingebetteten Player: Video starten und hineingehen
    if (el.tagName === 'IFRAME' && knownFrames.indexOf(el.contentWindow) >= 0) enterFrame(el);
  }

  // Im Vollbild wie am Fernseher: links/rechts spulen, OK = Play/Pause
  function fullscreenKey(code) {
    if (code === KEY.LEFT) { mediaKey(KEY.RW); return true; }
    if (code === KEY.RIGHT) { mediaKey(KEY.FF); return true; }
    if (code === KEY.ENTER) { mediaKey(KEY.PLAYPAUSE); return true; }
    return code === KEY.UP || code === KEY.DOWN;
  }

  function setMode(mode) {
    settings.mode = mode;
    saveSettings();
    if (mode === 'jump') {
      // Dort weitermachen, wo der freie Zeiger stand
      ensureCursorPos();
      var t = targetAt(cx, cy);
      if (t) selectJump(t);
    } else {
      leaveFrame();
    }
    drawCursor();
    drawRing();
    renderHelp();
    toast(mode === 'jump' ? 'Link-Modus: Pfeiltasten springen von Element zu Element'
      : 'Freier Zeiger: Pfeiltasten bewegen den Zeiger');
  }

  function setCursorOn(onNow) {
    cursorOn = onNow;
    if (!onNow) leaveFrame();
    drawCursor();
    drawRing();
    renderHelp();
    toast(onNow ? 'Zeiger an' : 'Zeiger aus - Pfeiltasten steuern die Seite');
  }

  /* --- Adressleiste --- */

  function normalizeUrl(text) {
    var v = (text || '').trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    if (/^[^\s]+\.[a-z]{2,}(\/.*)?$/i.test(v) || /^localhost(:\d+)?(\/.*)?$/i.test(v)) return 'https://' + v;
    return SEARCH + encodeURIComponent(v);
  }

  function go(text) {
    var url = normalizeUrl(text);
    if (!url) return;
    closeBar();
    location.href = url;
  }

  function openBar() {
    buildUi();
    if (!ui) return;
    barOpen = true;
    css(ui.bar, { display: 'flex' });
    ui.input.value = IS_START ? '' : location.href;
    later(function () { ui.input.focus(); ui.input.select(); }, 0);
  }

  function closeBar() {
    if (!ui) return;
    barOpen = false;
    css(ui.bar, { display: 'none' });
    ui.input.blur();
    ui.goBtn.blur();
    ui.starBtn.blur();
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
  }

  // Favoriten liegen auf der Startseite. Von anderen Seiten aus geht es dorthin;
  // die Startseite fragt nach und kehrt danach zur Seite zurueck.
  function addFavorite() {
    if (IS_START) {
      var typed = normalizeUrl(ui.input.value);
      if (!typed || typed.indexOf(SEARCH) === 0) {
        toast('Erst eine Adresse eingeben, dann ★');
        return;
      }
      closeBar();
      askAddFavorite({ u: typed, t: hostOf(typed) }, false);
      return;
    }
    var fav = { u: location.href, t: (document.title || HOST).trim().slice(0, 80) || HOST };
    closeBar();
    location.href = START + '#add=' + encodeURIComponent(JSON.stringify(fav));
  }

  /* --- Startseite mit Favoriten --- */

  var FAV_KEY = 'fernsurfer:favs';
  var DEFAULT_FAVS = [
    { u: 'https://html.duckduckgo.com/html/', t: 'DuckDuckGo' }
  ];
  var TILE_COLORS = ['#e53935', '#8e24aa', '#3949ab', '#039be5', '#00897b', '#7cb342', '#f4511e', '#6d4c41'];
  var favs = [];
  var startSel = -1;      // -1 = Suchfeld, sonst Kachel
  var pendingAdd = null;  // { fav, back } - Favorit wartet auf Bestaetigung

  function validFav(f) {
    return !!f && typeof f.u === 'string' && /^https?:\/\//i.test(f.u) && f.u.length < 2000 && typeof f.t === 'string';
  }
  function loadFavs() {
    try {
      var raw = W.localStorage.getItem(FAV_KEY);
      if (raw) {
        var a = JSON.parse(raw);
        if (Array.isArray(a)) return a.filter(validFav).slice(0, 60);
      }
    } catch (e) {}
    return DEFAULT_FAVS.slice();
  }
  function saveFavs() {
    try { W.localStorage.setItem(FAV_KEY, JSON.stringify(favs)); return true; } catch (e) {
      toast('Favoriten konnten nicht gespeichert werden');
      return false;
    }
  }

  function buildStart(root) {
    favs = loadFavs();
    // Aufruf von einer anderen Seite ueber den Stern: "#add=..."
    var m = /#add=(.+)$/.exec(location.hash);
    if (m) {
      try {
        var f = JSON.parse(decodeURIComponent(m[1]));
        if (validFav(f)) pendingAdd = { fav: { u: f.u, t: f.t.slice(0, 80) }, back: true };
      } catch (e) {}
      try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    }
    var el = make('div', STYLE.start);
    root.appendChild(el);
    return el;
  }

  function startCols() {
    var avail = W.innerWidth - 128 - 340;  // Rand und Platz fuer die Tastenhilfe
    if (!settings.help) avail += 340;
    return Math.max(2, Math.floor((avail + 20) / (220 + 20)));
  }

  // Der Symbol-Dienst kennt meist nur die Hauptdomain (duckduckgo.com statt
  // html.duckduckgo.com); bei Endungen wie co.uk drei Teile behalten.
  function iconHost(host) {
    var l = host.split('.');
    if (l.length <= 2) return host;
    var keep = l[l.length - 1].length === 2 && l[l.length - 2].length <= 3 ? 3 : 2;
    return l.slice(-keep).join('.');
  }

  function tileIcon(f, i) {
    var wrap = make('div', {
      width: '56px', height: '56px', 'border-radius': '14px', background: TILE_COLORS[i % TILE_COLORS.length],
      display: 'flex', 'align-items': 'center', 'justify-content': 'center', font: '700 26px ' + FONT,
      color: '#fff', overflow: 'hidden', 'margin-bottom': '12px'
    }, (hostOf(f.u).charAt(0) || '?').toUpperCase());
    // Favicon ueber den Symbol-Dienst von DuckDuckGo: Die Startseite liegt auf
    // DuckDuckGo, dessen Sicherheitsregel nur Bilder von DuckDuckGo-Adressen erlaubt.
    // Klappt das nicht, bleibt der farbige Anfangsbuchstabe.
    try {
      var img = make('img', { width: '40px', height: '40px', display: 'none' });
      on(img, 'load', function () {
        if (img.naturalWidth > 1) {
          wrap.textContent = '';
          css(wrap, { background: '#fff' });
          css(img, { display: 'block' });
          wrap.appendChild(img);
        }
      });
      img.src = 'https://icons.duckduckgo.com/ip3/' + encodeURIComponent(iconHost(new URL(f.u).hostname)) + '.ico';
    } catch (e) {}
    return wrap;
  }

  function renderStart() {
    if (!ui || !ui.start) return;
    var el = ui.start;
    el.textContent = '';

    var head = make('div', { display: 'flex', 'align-items': 'baseline', 'margin-bottom': '28px' });
    head.appendChild(make('div', { font: '700 40px ' + FONT, 'letter-spacing': '1px' }, 'Fernsurfer'));
    var now = new Date();
    head.appendChild(make('div', { 'margin-left': '24px', font: '300 28px ' + FONT, color: '#aab' },
      ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2)));
    el.appendChild(head);

    var searchSel = startSel === -1 && !pendingAdd;
    var search = make('div', {
      display: 'flex', 'align-items': 'center', width: '640px', 'max-width': '100%', padding: '16px 22px',
      'border-radius': '40px', background: searchSel ? '#fff' : 'rgba(255,255,255,.12)',
      color: searchSel ? '#111' : '#dde', font: '22px ' + FONT, 'margin-bottom': '36px',
      'box-shadow': searchSel ? '0 0 0 4px ' + ACCENT : 'none', 'box-sizing': 'border-box'
    });
    search.appendChild(svgIcon('<svg viewBox="0 0 24 24"><circle cx="10" cy="10" r="6.5" fill="none" stroke="' +
      (searchSel ? '#111' : '#dde') + '" stroke-width="2.4"/><path d="M15 15l6 6" stroke="' +
      (searchSel ? '#111' : '#dde') + '" stroke-width="2.4" stroke-linecap="round"/></svg>', 26, 26));
    search.appendChild(make('div', { 'margin-left': '14px' }, 'Suchen oder Adresse eingeben'));
    el.appendChild(search);

    el.appendChild(make('div', {
      font: '700 14px ' + FONT, 'letter-spacing': '2px', color: '#9ab', 'margin-bottom': '14px'
    }, 'FAVORITEN'));

    var grid = make('div', { display: 'flex', 'flex-wrap': 'wrap', width: (startCols() * 240) + 'px' });
    var items = favs.concat([{ plus: true }]);
    items.forEach(function (f, i) {
      var sel = i === startSel && !pendingAdd;
      var tile = make('div', {
        width: '220px', height: '160px', margin: '0 20px 20px 0', 'border-radius': '18px', padding: '18px',
        'box-sizing': 'border-box', background: sel ? ACCENT : 'rgba(255,255,255,.08)',
        'box-shadow': sel ? '0 0 0 4px #fff, 0 12px 28px rgba(0,0,0,.45)' : 'none',
        transform: sel ? 'scale(1.06)' : 'none', transition: 'transform .12s', display: 'flex',
        'flex-direction': 'column', 'justify-content': 'flex-end', overflow: 'hidden'
      });
      if (f.plus) {
        tile.appendChild(make('div', { font: '300 52px/1 ' + FONT, 'margin-bottom': '14px', color: '#cde' }, '+'));
        tile.appendChild(make('div', { 'font-weight': '600' }, 'Favorit hinzufügen'));
        tile.appendChild(make('div', { 'font-size': '13px', color: sel ? '#eef' : '#aab' }, 'Adresse eingeben, dann ★'));
      } else {
        tile.appendChild(tileIcon(f, i));
        tile.appendChild(make('div', {
          'font-weight': '600', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis'
        }, f.t || hostOf(f.u)));
        tile.appendChild(make('div', {
          'font-size': '13px', color: sel ? '#eef' : '#aab', 'white-space': 'nowrap', overflow: 'hidden',
          'text-overflow': 'ellipsis'
        }, hostOf(f.u)));
      }
      grid.appendChild(tile);
      if (sel) later(function () { try { tile.scrollIntoView({ block: 'nearest' }); } catch (e) {} }, 0);
    });
    var scroller = make('div', { 'max-height': (W.innerHeight - 330) + 'px', 'overflow-y': 'auto', padding: '6px' });
    scroller.appendChild(grid);
    el.appendChild(scroller);

    if (pendingAdd) el.appendChild(renderConfirm());
  }

  function renderConfirm() {
    var f = pendingAdd.fav;
    var exists = favs.some(function (x) { return x.u === f.u; });
    var shade = make('div', {
      position: 'fixed', left: '0', top: '0', right: '0', bottom: '0', background: 'rgba(0,0,0,.6)',
      display: 'flex', 'align-items': 'center', 'justify-content': 'center'
    });
    var card = make('div', {
      width: '560px', padding: '28px 32px', 'border-radius': '20px', background: '#1d2233',
      'box-shadow': '0 20px 50px rgba(0,0,0,.6)', border: '1px solid rgba(255,255,255,.15)'
    });
    card.appendChild(make('div', { font: '700 26px ' + FONT, 'margin-bottom': '18px' },
      exists ? 'Schon in deinen Favoriten' : '★  Als Favorit speichern?'));
    var row = make('div', { display: 'flex', 'align-items': 'center', 'margin-bottom': '24px' });
    row.appendChild(tileIcon(f, favs.length));
    var txt = make('div', { 'margin-left': '16px', 'min-width': '0' });
    txt.appendChild(make('div', { 'font-weight': '600', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' }, f.t));
    txt.appendChild(make('div', { 'font-size': '14px', color: '#aab', 'word-break': 'break-all' }, f.u.slice(0, 120)));
    row.appendChild(txt);
    card.appendChild(row);
    var keys = make('div', { display: 'flex', 'align-items': 'center', color: '#cfd8e3' });
    keys.appendChild(iconBox(ICON.ok()));
    keys.appendChild(make('div', { 'margin-right': '28px' }, exists ? 'Zurück zur Seite' : 'Speichern'));
    if (!exists) {
      keys.appendChild(iconBox(ICON.back()));
      keys.appendChild(make('div', {}, 'Abbrechen'));
    }
    card.appendChild(keys);
    shade.appendChild(card);
    return shade;
  }

  function askAddFavorite(fav, back) {
    pendingAdd = { fav: fav, back: back };
    renderStart();
  }

  function finishAdd(save) {
    var p = pendingAdd;
    pendingAdd = null;
    var exists = favs.some(function (x) { return x.u === p.fav.u; });
    if (save && !exists) {
      favs.push(p.fav);
      if (saveFavs()) {
        if (p.back) {
          saveSettings({ flash: '★ Favorit gespeichert' });
          location.replace(p.fav.u);
          return;
        }
        toast('★ Favorit gespeichert');
        startSel = favs.length - 1;
      }
    } else if (p.back) {
      if (save) { location.replace(p.fav.u); return; }
      if (history.length > 1) { history.back(); return; }
    }
    renderStart();
  }

  function startKey(code) {
    if (pendingAdd) {
      if (code === KEY.ENTER) finishAdd(true);
      else if (code === KEY.BACK) finishAdd(false);
      return;
    }
    var n = favs.length + 1;  // plus "Favorit hinzufuegen"
    var cols = startCols();
    var i = startSel;
    switch (code) {
      case KEY.LEFT: if (i > 0) i--; break;
      case KEY.RIGHT: if (i < 0) i = 0; else if (i < n - 1) i++; break;
      case KEY.UP: i = i < cols ? -1 : i - cols; break;
      case KEY.DOWN:
        if (i < 0) i = 0;
        else if (i + cols < n) i += cols;
        else if (Math.floor(i / cols) < Math.floor((n - 1) / cols)) i = n - 1;
        break;
      case KEY.ENTER:
        if (i < 0 || i === n - 1) openBar();
        else location.href = favs[i].u;
        return;
      case KEY.BACK:
        toast('Das ist die Startseite');
        return;
      default:
        return;
    }
    startSel = i;
    renderStart();
  }

  function removeFavorite(i) {
    if (i < 0 || i >= favs.length) return;
    var f = favs.splice(i, 1)[0];
    saveFavs();
    startSel = Math.min(i, favs.length);
    toast('Entfernt: ' + (f.t || hostOf(f.u)));
    renderStart();
  }

  if (IS_START) {
    try { document.documentElement.style.setProperty('background', '#0f1220', 'important'); } catch (e) {}
    every(function () { if (ui && ui.start && !pendingAdd && !menu) renderStart(); }, 30000);
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

  function fullscreenFromMenu() {
    var v = biggestVideo();
    if (v) { enterPseudoFullscreen(v); return; }
    // Kein Video auf der Seite selbst: groessten eingebetteten Player nehmen
    var best = null, area = 0;
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) {
      var r = frames[i].getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = frames[i]; }
    }
    if (best && area > W.innerWidth * W.innerHeight * 0.05) {
      enterPseudoFullscreen(best);
      if (best.contentWindow) best.contentWindow.postMessage({ __tb: 'fsinner' }, '*');
    } else {
      toast('Kein Video auf dieser Seite gefunden');
    }
  }

  function openMenu() {
    buildUi();
    if (!ui) return;
    var helpItem = {
      label: settings.help ? 'Tastenhilfe ausblenden' : 'Tastenhilfe einblenden', run: toggleHelp
    };
    var items;
    if (IS_START) {
      items = [];
      if (startSel >= 0 && startSel < favs.length) {
        var idx = startSel;
        items.push({ label: 'Favorit entfernen: ' + (favs[idx].t || hostOf(favs[idx].u)), run: function () { removeFavorite(idx); } });
      }
      items.push(helpItem, { label: 'Schließen', run: function () {} });
    } else {
      items = [
        { label: 'Video als Vollbild', run: fullscreenFromMenu },
        { label: '★ Zu Favoriten hinzufügen', run: function () { addFavorite(); } },
        helpItem,
        {
          label: cursorOn ? 'Zeiger ausschalten (Seite steuert selbst)' : 'Zeiger einschalten',
          run: function () { setCursorOn(!cursorOn); }
        },
        { label: 'Seite neu laden', run: function () { location.reload(); } },
        {
          label: DISABLED ? 'Werbeblocker hier einschalten' : 'Werbeblocker hier ausschalten',
          run: function () { setSiteDisabled(!DISABLED); }
        },
        { label: 'Zur Startseite', run: function () { location.href = START; } },
        { label: 'Schließen', run: function () {} }
      ];
    }
    menu = { items: items, index: 0 };
    renderMenu();
  }

  function renderMenu() {
    var el = ui.menu;
    el.textContent = '';
    var title = make('div', STYLE.title);
    title.textContent = 'Fernsurfer ' + VERSION + (IS_START ? ' - Startseite' : ' - ' + (HOST || 'Seite') + ' - ' +
      (DISABLED ? 'Werbeblocker AUS' : stats.popups + ' Popups, ' + stats.net + ' Anfragen blockiert'));
    el.appendChild(title);
    menu.items.forEach(function (it, i) {
      var row = make('div', STYLE.item, it.label);
      css(row, { background: i === menu.index ? ACCENT : 'transparent' });
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

  /* --- Tasten --- */

  // ev ist null, wenn die Taste aus einem iframe weitergereicht wurde.
  function handleKey(code, ev) {
    function consume() {
      if (ev) { ev.preventDefault(); ev.stopImmediatePropagation(); }
    }

    if (barOpen) return; // die Adressleiste behandelt ihre Tasten selbst
    if (code === KEY.ESC) code = KEY.BACK; // PC-Tastatur zum Testen

    if (menu) { consume(); menuKey(code); return; }

    if (code === KEY.INFO) { consume(); toggleHelp(); return; }

    switch (code) {
      case KEY.RED: consume(); openBar(); return;
      case KEY.GREEN:
        consume();
        if (IS_START) { toast('Auf der Startseite wählst du mit den Pfeiltasten'); return; }
        // Gruen wechselt zwischen Link-Modus und freiem Zeiger; ist der Zeiger aus, geht er an
        if (!cursorOn) setCursorOn(true);
        else setMode(settings.mode === 'jump' ? 'free' : 'jump');
        return;
      case KEY.YELLOW: consume(); if (!IS_START) location.href = START; return;
      case KEY.BLUE: consume(); openMenu(); return;
    }

    if (IS_START) {
      if ([KEY.LEFT, KEY.RIGHT, KEY.UP, KEY.DOWN, KEY.ENTER, KEY.BACK].indexOf(code) >= 0) consume();
      startKey(code);
      return;
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
      if (exitPseudoFullscreen()) return;
      if (leaveFrame()) return;  // aus dem Player zurueck auf die Seite
      if (history.length > 1) history.back();
      else toast('Keine vorherige Seite');
      return;
    }

    if (!cursorOn) return;

    if (fsActive() && fullscreenKey(code)) { consume(); return; }

    if (settings.mode === 'jump') {
      switch (code) {
        case KEY.LEFT: consume(); jumpKeyTop('left'); return;
        case KEY.RIGHT: consume(); jumpKeyTop('right'); return;
        case KEY.UP: consume(); jumpKeyTop('up'); return;
        case KEY.DOWN: consume(); jumpKeyTop('down'); return;
        case KEY.ENTER: consume(); jumpOkTop(); return;
      }
      return;
    }

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
    if (IS_START || cursorOn || barOpen || menu || ev.keyCode !== KEY.UP || ev.defaultPrevented) return;
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

  on(W, 'resize', function () {
    ensureCursorPos();
    cx = Math.min(cx, W.innerWidth - 4);
    cy = Math.min(cy, W.innerHeight - 4);
    drawCursor();
    if (IS_START) renderStart();
  });

  onReady(function () {
    if (IS_START) {
      try {
        if (document.body) while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
        document.title = 'Fernsurfer';
      } catch (e) {}
    }
    buildUi();
    dropAutofocus();
    later(dropAutofocus, 300);
    if (flash) {
      toast(flash);
      flash = null;
      saveSettings();
    }
  });
  on(W, 'load', dropAutofocus);
})();
