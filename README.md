# Fernsurfer (TizenBrew-Modul)

Browser für Samsung-Fernseher mit TizenBrew. Er bringt einen Mauszeiger für die Fernbedienung, einen Popup-Blocker und einen Werbefilter auf Basis der Listen von uBlock Origin mit.
Geschrieben für Tizen 5.0 (Chromium 63).

- **Keine Telemetrie, keine Netzwerkanfragen.** Das Modul lädt keinen fremden Code nach. Die Filterlisten sind fest eingebaut.
- **Quelltext:** [`src/fernsurfer.js`](src/fernsurfer.js), lesbar und ohne Abhängigkeiten. [`dist/userScript.js`](dist/userScript.js) ist dieselbe Datei plus Filterdaten, erzeugt von [`tools/build.py`](tools/build.py).
- **Keine Befehle über die Webadresse:** Webseiten können das Modul nicht fernsteuern.

## So läuft es ab

TizenBrew → **Fernsurfer** auswählen → die Startseite (DuckDuckGo) öffnet sich im Vollbild. Ab dann läuft Fernsurfer auf jeder Seite, die du ansurfst, auch in eingebetteten Playern. Beenden kannst du es mit der Home-Taste.

## Tasten

| Taste | Funktion |
|---|---|
| Pfeiltasten | Zeiger bewegen (gedrückt halten = schneller, am Rand wird gescrollt) |
| Hoch am oberen Rand | Adressleiste (auch bei ausgeschaltetem Zeiger, wenn die Seite ganz oben ist); Runter schließt sie |
| OK | Klicken (Textfelder öffnen die TV-Tastatur) |
| Zurück | Vorherige Seite bzw. Textfeld oder Menü verlassen |
| Rot | Adressleiste: Adresse oder Suchbegriff |
| Grün | Zeiger an/aus (aus = die Seite bekommt die Pfeiltasten selbst) |
| Gelb | Startseite |
| Blau | Menü: neu laden, **Werbeblocker auf dieser Seite aus/an**, Statistik |
| Play/Pause, Stop, Spulen | Steuern das Video auf der Seite (±10 s) |

## Was der Werbefilter kann

Eingebaut sind **EasyList**, **EasyList Germany** und **uBlock filters**, die drei Standardlisten von uBlock Origin für Werbung.

| Funktion | Stand |
|---|---|
| Werbeflächen ausblenden (generisch und seitenspezifisch, mit Ausnahmen) | ✅ ca. 27.000 Regeln. Einfache Regeln (`.klasse`, `#id`) greifen erst, wenn das Element auf der Seite auftaucht, wie bei uBlock Origin. |
| `:style()` und `:remove()` | ✅ |
| Prozedurale Filter (`:has-text`, `:upward`, `:xpath` …) | ❌ werden übersprungen |
| Scriptlets (`##+js(...)`) | ✅ `set-constant`, `abort-on-property-read/-write`, `abort-current-script`, `no-setTimeout-if`, `no-setInterval-if`, `prevent-addEventListener`, `json-prune`, `prevent-fetch`, `prevent-xhr`, `remove-attr`, `remove-class`, `noeval-if` und ihre Kurznamen. Andere Scriptlets werden ignoriert. |
| Popups, Klick-Fallen über Playern, `_blank`-Tricks | ✅ |
| Domain-Sperren (`\|\|host^`) | ⚙️ optional mit `--net`. Das sind 45.000 Hosts und etwa 800 KB mehr. Wirkt nur auf nachgeladene Inhalte. **Unnötig, wenn ein DNS-Filter läuft** (z. B. in der Fritzbox), der das besser erledigt. |
| Anfragen blockieren, die schon im HTML stehen | ❌ geht nur per DNS-Filter oder Browser-Erweiterung |
| Umleitungen im selben Fenster (`location.href = ...`) | ❌ nicht abfangbar; **Zurück** bringt dich zum Video zurück |

**Zeitpunkt:** TizenBrew schleust das Modul ein, sobald eine Seite entsteht. Scriptlets greifen deshalb meistens, aber nicht garantiert vor den Skripten der Seite.

## Filterlisten aktualisieren

Die Listen werden beim Bauen eingebettet. Lade sie neu herunter und bau dann neu:

```
python -I tools/build.py easylist.txt easylistgermany.txt ublock-filters.txt
```

Quellen:
- https://easylist.to/easylist/easylist.txt
- https://easylist.to/easylistgermany/easylistgermany.txt
- https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt

Danach erhöhst du `version` in `package.json` und erstellst einen neuen Tag.

## Installation

1. Leg auf GitHub ein **öffentliches** Repository an, zum Beispiel `fernsurfer`.
2. Lade alles hoch außer `test/userScript.test.js` (siehe `.gitignore`).
3. Erstell ein Release bzw. einen Tag `1.0.1`.
4. Am Fernseher muss die Host PC IP auf `127.0.0.1` stehen. Öffne dann TizenBrew → **grüne Taste** (Modulverwaltung) → Modul hinzufügen → **GitHub** → `DEINNAME/fernsurfer@1.0.1` eintragen.
   - `@1.0.1` friert die Version ein. Wenn TizenBrew das Modul so nicht findet, trag `DEINNAME/fernsurfer` ohne Version ein.
5. Starte **Fernsurfer** in TizenBrew.

## Testen am PC

```
python -I tools/build.py LISTEN... test/test-rules.txt --net --out test/userScript.test.js
python -m http.server 8765 --bind 127.0.0.1
```

- `http://127.0.0.1:8765/test/filters.html`: Filter, Scriptlets, Ausnahmen, Netzwerk-Sperre
- `http://127.0.0.1:8765/test/index.html`: Popups, Klick-Falle, Zeiger, fremder Player im iframe
- `http://127.0.0.1:8765/test/csp.html`: Seite mit Content-Security-Policy und Autofokus (wie DuckDuckGo)
- `http://127.0.0.1:8765/test/tizenbrew-ui/dist/index.html`: Nachbildung der TizenBrew-Oberfläche, dort darf Fernsurfer nichts tun

## Änderungen

- **1.0.1:** Zeiger, Adressleiste und Werbefilter funktionieren auf Seiten mit Content-Security-Policy (z. B. DuckDuckGo). Der Autofokus der Seite wird ignoriert, die Startseite öffnet direkt die Adressleiste. Fernsurfer erscheint nicht mehr in der TizenBrew-Oberfläche. Hoch am oberen Rand öffnet die Adressleiste.
- **1.0.0:** erste Version.

Pfeiltasten, Enter und Esc funktionieren wie die Fernbedienung.

## Lizenzen

- **Code** (`src/`, `tools/`, `test/`): MIT, siehe [LICENSE](LICENSE).
- **Filterdaten** in `dist/userScript.js`:
  - EasyList und EasyList Germany: © The EasyList authors, GPLv3 bzw. CC BY-SA 3.0 (https://easylist.to/pages/licence.html)
  - uBlock filters: © Raymond Hill und Mitwirkende, GPLv3 (https://github.com/uBlockOrigin/uAssets)

  Wer `dist/userScript.js` weitergibt, gibt diese Daten unter ihren Lizenzen weiter.
