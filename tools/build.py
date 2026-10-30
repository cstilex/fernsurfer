"""
Baut dist/userScript.js aus src/fernsurfer.js und Filterlisten im Adblock-Format.

    python -I tools/build.py LISTE.txt [LISTE.txt ...] [--out dist/userScript.js] [--net] [--start URL]

--start URL setzt die Adresse der Favoriten-Startseite (start.html ueber GitHub Pages,
z. B. https://NAME.github.io/fernsurfer/start.html) und traegt sie als websiteURL in
package.json ein.

Uebernommen werden:
  - kosmetische Filter (##, #@#) inkl. :style() und :remove()
  - Scriptlets (##+js(...), #@#+js(...))
  - mit --net: einfache Netzwerkregeln ||host^ fuer dynamisch nachgeladene Inhalte
    (macht die Datei ca. 800 KB groesser; ueberfluessig, wenn ein DNS-Filter laeuft)
Prozedurale Filter (:has-text, :upward, :xpath ...) und HTML-Filter werden uebersprungen.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "fernsurfer.js"
PLACEHOLDER = "/*@@FILTERS@@*/null"

# Umgebung fuer !#if-Bloecke der uBO-Listen: Chromium, kein Mobilgeraet,
# keine Erweiterungs-Faehigkeiten (HTML-Filter, User-Stylesheets).
ENV = {"env_chromium": True, "env_legacy": True}

UNSUPPORTED_SELECTOR = re.compile(
    r":(-abp-|has|has-text|contains|upward|xpath|matches-css|matches-css-before|matches-css-after|"
    r"min-text-length|watch-attr|others|matches-path|matches-attr|matches-prop|matches-media|"
    r"remove-attr|remove-class|nth-ancestor|if|if-not|shadow)\b"
)
SIMPLE_SELECTOR = re.compile(r"^[.#][A-Za-z_][\w-]*$")
HOST_RULE = re.compile(r"^\|\|([a-z0-9][a-z0-9.-]*[a-z0-9])\^(?:\$(.*))?$")
OK_NET_OPTIONS = {
    "", "third-party", "3p", "script", "image", "xmlhttprequest", "xhr", "subdocument", "frame",
    "popup", "all", "ping", "media", "other", "object", "stylesheet", "css", "font", "websocket", "important",
}


def eval_condition(expr):
    tokens = re.findall(r"!|&&|\|\||\(|\)|[A-Za-z_][\w]*", expr)
    out = []
    for t in tokens:
        if t == "!":
            out.append("not")
        elif t == "&&":
            out.append("and")
        elif t == "||":
            out.append("or")
        elif t in "()":
            out.append(t)
        else:
            out.append("True" if ENV.get(t, False) else "False")
    try:
        return bool(eval(" ".join(out) or "False", {"__builtins__": {}}, {}))
    except Exception:
        return False


def split_args(s):
    """Argumente von +js(...) trennen; ',' mit Backslash ist literal."""
    args, cur, i = [], "", 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s) and s[i + 1] == ",":
            cur += ","
            i += 2
            continue
        if c == ",":
            args.append(cur.strip())
            cur = ""
        else:
            cur += c
        i += 1
    args.append(cur.strip())
    return args


def parse_domains(part):
    inc, exc = [], []
    for d in part.split(","):
        d = d.strip().lower()
        if not d or d.startswith("/"):
            continue
        if d.startswith("~"):
            exc.append(d[1:])
        else:
            inc.append(d)
    return inc, exc


class Builder:
    def __init__(self):
        self.sel_index = {}
        self.selectors = []
        self.generic = set()
        self.generic_unhide = set()
        self.spec = {}
        self.unhide = {}
        self.style = {}
        self.js = {}
        self.jsx = {}
        self.net = set()
        self.net_allow = set()
        self.skipped = 0

    def sid(self, sel):
        if sel not in self.sel_index:
            self.sel_index[sel] = len(self.selectors)
            self.selectors.append(sel)
        return self.sel_index[sel]

    def add_list(self, text):
        stack = []
        for raw in text.splitlines():
            line = raw.strip()
            if line.startswith("!#if"):
                stack.append(eval_condition(line[4:]))
                continue
            if line.startswith("!#else"):
                if stack:
                    stack[-1] = not stack[-1]
                continue
            if line.startswith("!#endif"):
                if stack:
                    stack.pop()
                continue
            if not line or line.startswith("!") or line.startswith("["):
                continue
            if not all(stack):
                continue
            self.add_rule(line)

    def add_rule(self, line):
        for sep in ("#@#+js(", "##+js("):
            if sep in line:
                dom, rest = line.split(sep, 1)
                if not rest.endswith(")"):
                    self.skipped += 1
                    return
                args = split_args(rest[:-1]) if rest[:-1].strip() else []
                if args:
                    args[0] = re.sub(r"\.js$", "", args[0])
                inc, exc = parse_domains(dom)
                if sep == "##+js(":
                    if not args or not inc:
                        self.skipped += 1
                        return
                    for d in inc:
                        self.js.setdefault(d, []).append(args)
                    for d in exc:
                        self.jsx.setdefault(d, []).append(args[0])
                else:
                    name = args[0] if args else "*"
                    for d in inc or ["*"]:
                        self.jsx.setdefault(d, []).append(name)
                return

        m = re.match(r"^([^#]*)(##|#@#)(.+)$", line)
        if m and not line.startswith("||") and "#?#" not in line and "#$#" not in line and "#%#" not in line:
            dom, sep, sel = m.group(1), m.group(2), m.group(3).strip()
            if sel.startswith("^") or sel.startswith("+"):
                self.skipped += 1
                return
            inc, exc = parse_domains(dom)
            style_decl = None
            sm = re.match(r"^(.*):style\((.*)\)$", sel)
            if sm:
                sel, style_decl = sm.group(1).strip(), sm.group(2).strip()
            elif sel.endswith(":remove()"):
                sel = sel[: -len(":remove()")].strip()
            if not sel or UNSUPPORTED_SELECTOR.search(sel) or "{" in sel or "}" in sel:
                self.skipped += 1
                return
            if sep == "#@#":
                if style_decl:
                    return
                if inc:
                    for d in inc:
                        self.unhide.setdefault(d, set()).add(self.sid(sel))
                else:
                    self.generic_unhide.add(sel)
                return
            if style_decl is not None:
                if not inc or re.search(r"url\(|expression|@import|\\", style_decl, re.I):
                    self.skipped += 1
                    return
                for d in inc:
                    self.style.setdefault(d, []).append([sel, style_decl])
                return
            if inc:
                i = self.sid(sel)
                for d in inc:
                    self.spec.setdefault(d, set()).add(i)
                for d in exc:
                    self.unhide.setdefault(d, set()).add(i)
            else:
                self.generic.add(sel)
                if exc:
                    i = self.sid(sel)
                    for d in exc:
                        self.unhide.setdefault(d, set()).add(i)
            return

        if line.startswith("@@||"):
            hm = HOST_RULE.match(line[2:])
            if hm:
                self.net_allow.add(hm.group(1))
            return
        hm = HOST_RULE.match(line)
        if hm:
            opts = [o.strip() for o in (hm.group(2) or "").split(",")]
            if all(o.lstrip("~") in OK_NET_OPTIONS and not o.startswith("~") for o in opts):
                self.net.add(hm.group(1))
                return
        self.skipped += 1

    def build(self):
        generic = sorted(self.generic - self.generic_unhide)
        simple = [s for s in generic if SIMPLE_SELECTOR.match(s)]
        complex_ = [s for s in generic if not SIMPLE_SELECTOR.match(s)]
        # Generische Selektoren nach vorn, damit sie ueber Indizes adressierbar bleiben
        complex_set = set(complex_)
        order = complex_ + [s for s in self.selectors if s not in complex_set]
        remap = {}
        new_list = []
        for s in order:
            if s not in remap:
                remap[s] = len(new_list)
                new_list.append(s)

        def remap_ids(ids):
            return sorted(remap[self.selectors[i]] for i in ids)

        net = sorted(h for h in self.net if h not in self.net_allow)
        return {
            "v": 1,
            "sel": new_list,
            "gc": len(complex_),
            "gs": " ".join(simple),
            "spec": {d: remap_ids(ids) for d, ids in sorted(self.spec.items())},
            "unhide": {d: remap_ids(ids) for d, ids in sorted(self.unhide.items())},
            "style": dict(sorted(self.style.items())),
            "js": dict(sorted(self.js.items())),
            "jsx": {d: sorted(set(v)) for d, v in sorted(self.jsx.items())},
            "net": " ".join(net),
        }


def main(argv):
    out = ROOT / "dist" / "userScript.js"
    lists = []
    with_net = False
    start_url = None
    i = 0
    while i < len(argv):
        if argv[i] == "--out":
            out = Path(argv[i + 1]).resolve()
            i += 2
            continue
        if argv[i] == "--net":
            with_net = True
            i += 1
            continue
        if argv[i] == "--start":
            start_url = argv[i + 1]
            i += 2
            continue
        lists.append(Path(argv[i]))
        i += 1
    if not lists:
        print(__doc__)
        return 2

    b = Builder()
    for p in lists:
        b.add_list(p.read_text(encoding="utf-8", errors="replace"))
    data = b.build()
    if not with_net:
        data["net"] = ""

    src = SRC.read_text(encoding="utf-8")
    if PLACEHOLDER not in src:
        print("Platzhalter fehlt in src/fernsurfer.js")
        return 1
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    # Als JSON-Text in einem JS-String mit einfachen Anfuehrungszeichen (das Modul liest
    # ihn mit JSON.parse). Kein '</script>' und keine Zeilentrenner, die alte JS-Engines stoeren.
    payload = payload.replace("\\", "\\\\").replace("'", "\\'")
    payload = payload.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    src = src.replace(PLACEHOLDER, "'" + payload + "'")
    if start_url:
        if not re.match(r"^https?://[^\s'\"\\]+$", start_url):
            print("Ungueltige --start-Adresse:", start_url)
            return 1
        src = re.sub(r"/\*@@START@@\*/'[^']*'", lambda m: json.dumps(start_url), src, count=1)
        if out == ROOT / "dist" / "userScript.js":
            pkg_path = ROOT / "package.json"
            pkg = json.loads(pkg_path.read_text(encoding="utf-8"))
            pkg["websiteURL"] = start_url
            pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(src, encoding="utf-8")

    print("Ausgabe:            ", out)
    print("Groesse:             %.0f KB" % (out.stat().st_size / 1024))
    print("Selektoren gesamt:  ", len(data["sel"]))
    print("  generisch komplex:", data["gc"])
    print("  generisch einfach:", len(data["gs"].split()) if data["gs"] else 0)
    print("Domains (spezif.):  ", len(data["spec"]))
    print("Ausnahmen-Domains:  ", len(data["unhide"]))
    print(":style-Domains:     ", len(data["style"]))
    print("Scriptlet-Domains:  ", len(data["js"]))
    print("Netzwerk-Hosts:     ", len(data["net"].split()) if data["net"] else 0)
    print("uebersprungen:      ", b.skipped)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
