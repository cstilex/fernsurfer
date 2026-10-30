# Fernsurfer (TizenBrew-Modul)

Browser für Samsung-Fernseher mit TizenBrew. Er bringt einen Mauszeiger für die Fernbedienung, einen Popup-Blocker und einen Werbefilter auf Basis der Listen von uBlock Origin mit.
Geschrieben für Tizen 5.0 (Chromium 63).

- **Keine Telemetrie, keine Netzwerkanfragen.** Das Modul lädt keinen fremden Code nach. Die Filterlisten sind fest eingebaut.
- **Quelltext:** [`src/fernsurfer.js`](src/fernsurfer.js), lesbar und ohne Abhängigkeiten. [`dist/userScript.js`](dist/userScript.js) ist dieselbe Datei plus Filterdaten, erzeugt von [`tools/build.py`](tools/build.py).
- **Keine Befehle über die Webadresse:** Webseiten können das Modul nicht fernsteuern.

## Installation

Fernsurfer ist ein Modul für [TizenBrew](https://github.com/reisxd/TizenBrew). Wie du TizenBrew auf deinen Fernseher bekommst, steht in der [TizenBrew-Anleitung](https://github.com/reisxd/TizenBrew/blob/main/docs/README.md). Danach installierst du Fernsurfer wie jedes andere TizenBrew-Modul:

1. TizenBrew öffnen → **grüne Taste** (Modulverwaltung) → Modul hinzufügen → **GitHub**.
2. `BENUTZER/fernsurfer` eintragen. Das ist der Name dieses Repositorys, wie er oben auf dieser Seite steht.
3. **Fernsurfer** in der Modulliste auswählen.

Neue Versionen kommen von selbst an. Starte den Fernseher danach einmal neu.

## So läuft es ab

TizenBrew → **Fernsurfer** auswählen → die **Startseite mit deinen Favoriten** öffnet sich im Vollbild. Ab dann läuft Fernsurfer auf jeder Seite, die du ansurfst, auch in eingebetteten Playern. Beenden kannst du es mit der Home-Taste.

Rechts auf dem Bildschirm zeigt eine **Tastenhilfe**, was welche Taste macht. Sie ist für den Abstand vom Sofa gemacht: Alle Größen richten sich nach der Bildhöhe, auf einem 1080er-Bild ist alles 1,5-mal so groß wie auf einem 720er. Mit der **INFO-Taste** oder über **Blau → Tastenhilfe** blendest du sie aus und wieder ein. Solange ein Video läuft oder etwas im Vollbild ist, verschwindet sie von selbst und kommt beim Pausieren wieder. Stumme Hintergrund- und Vorschauvideos, die Seiten von selbst abspielen, zählen dabei nicht.

## Startseite und Favoriten

- Die Startseite ist `https://html.duckduckgo.com/html/?fernsurfer`. Das Merkmal `?fernsurfer` erkennt Fernsurfer und legt seine eigene Oberfläche über die Seite: nur Suchfeld und Favoriten als Kacheln. Normale DuckDuckGo-Suchen bleiben davon unberührt. Landest du auf der leeren DuckDuckGo-Suchseite ohne Merkmal (Logo-Link, Fortsetzen der App), springt Fernsurfer zur Startseite. Suchen über das Suchfeld von DuckDuckGo stehen mit dem Suchbegriff in der Adresse, damit Zurück und Neuladen die Ergebnisse wieder zeigen.
- Kurz nach dem Start von TizenBrew kann DuckDuckGo einen Moment ohne Fernsurfer zu sehen sein. TizenBrew lädt das Modul erst beim ersten Aufruf von jsDelivr. Kommt die Startseite gar nicht, hilft es, TizenBrew neu zu starten.
- Pfeiltasten wählen eine Kachel, OK öffnet sie. Ganz oben ist das Suchfeld.
- **Neuer Favorit auf der Startseite:** Kachel **„+ Favorit hinzufügen“** → Adresse eintippen → OK bzw. „Fertig“. Die Adresse wird direkt als Kachel gespeichert, ohne die Seite zu öffnen.
- **Favorit von einer Seite aus speichern:** auf der Seite Rot drücken (Adressleiste) → mit → zum Knopf **★ Favorit** → OK. Es erscheint eine Nachfrage auf der Startseite, danach geht es zurück zur Seite. Alternativ geht das über Blau → „Zu Favoriten hinzufügen“.
- **Favorit entfernen:** auf der Startseite die Kachel wählen → **Gelb** → mit OK bestätigen. Alternativ geht das über Blau → „Favorit entfernen“.
- Die Favoriten liegen im Speicher dieser Seite (localStorage von `html.duckduckgo.com`) auf dem Fernseher. Die Symbole der Kacheln kommen vom Symbol-Dienst `icons.duckduckgo.com`. Andere Bildquellen erlaubt DuckDuckGo auf seiner Seite nicht. DuckDuckGo erfährt dadurch, welche Domains in deinen Favoriten stehen.

## Tasten

| Taste | Funktion |
|---|---|
| Pfeiltasten | **Freier Zeiger** (Standard): Zeiger bewegen (gedrückt halten = schneller). **Link-Modus:** zum nächsten anklickbaren Element in dieser Richtung springen. Auf der Startseite: Kachel wählen |
| Hoch ganz oben | Adressleiste (in jedem Modus, wenn die Seite ganz oben ist); Runter schließt sie |
| OK | Anklicken (Textfelder öffnen die TV-Tastatur); im Link-Modus auf einem eingebetteten Player: Video starten und hineingehen |
| „Fertig“ der TV-Tastatur | Wie OK bzw. Enter: öffnet die Adresse in der Adressleiste und schickt Suchfelder auf Webseiten ab |
| Zurück | Beendet das Vollbild, verlässt einen Player, Textfelder und Menüs, sonst vorherige Seite |
| Rot | Adressleiste (Details siehe unten): „Fertig“ öffnet, bei geschlossener Tastatur → zum Knopf **★ Favorit** |
| Grün | Wechselt zwischen **freiem Zeiger** und **Link-Modus** (die Wahl bleibt gespeichert) |
| Gelb | Startseite (Favoriten); auf der Startseite: gewählte Kachel entfernen |
| Blau | Menü: Video als Vollbild, Favorit hinzufügen, Tastenhilfe, Zeiger aus/an, erkannte Elemente zeigen, neu laden, **Werbeblocker auf dieser Seite aus/an** |
| INFO | Tastenhilfe aus- und einblenden |
| Play/Pause, Stop, Spulen | Steuern das laufende Video (±10 s), auch in eingebetteten Playern |
| Im Vollbild | ← → spulen ±10 s, OK = Play/Pause, Zurück beendet das Vollbild |

## Adressleiste

Rot (oder Hoch ganz oben) öffnet die Leiste, und die Bildschirmtastatur geht gleich mit auf.

- **Tastatur offen:** Die Pfeiltasten der Fernbedienung bedienen die Bildschirmtastatur. Den Textcursor bewegst du mit den Pfeilen *in* der Bildschirmtastatur, Fernsurfer greift hier nicht ein. **„Fertig“** öffnet die Adresse. **Zurück** bzw. „Abbrechen“ schließt nur die Tastatur, die Leiste bleibt ausgewählt.
- **Tastatur zu, Leiste ausgewählt:**
  - Im **Link-Modus** springt → zum **★ Favorit** und ← zurück zum Eingabefeld. OK auf dem Eingabefeld öffnet die Tastatur wieder, OK auf dem Stern speichert die Seite als Favorit. Runter oder Zurück schließt die Leiste.
  - Mit dem **freien Zeiger** bewegen die Pfeile ganz normal den Zeiger. OK auf dem Eingabefeld öffnet die Tastatur, OK auf dem Stern speichert den Favoriten. Ein Klick außerhalb der Leiste schließt sie und klickt dort. Zurück schließt die Leiste.

## Link-Modus

Wie im Link-Modus des Samsung-Browsers springen die Pfeiltasten von Element zu Element. Einschalten kannst du ihn mit **Grün**. Das gewählte Element bekommt einen blauen Rahmen, und der Zeiger springt in dessen Mitte.

- **Ziele** sind Links, Knöpfe, Eingabefelder, Videos und eingebettete Player, außerdem Elemente, die die Seite als anklickbar kennzeichnet (Rolle „Button“, „Hand“-Mauszeiger, Klick-Funktion). Auch Knöpfe in Web-Komponenten (offenes Shadow DOM) werden gefunden. Verdeckte Elemente, etwa hinter einem Dialog, werden übersprungen.
- Gesprungen wird zum nächsten Ziel in der gedrückten Richtung, bevorzugt in derselben Zeile bzw. Spalte. Der erste Sprung beginnt oben links.
- Liegt das nächste Ziel außerhalb des Bildschirms, scrollt die Seite zuerst ein Stück. So wird längerer Text dazwischen nicht übersprungen.
- **Video auf der Seite:** Der **ganze Player** (Video und Bedienleiste) ist ein Ziel, OK = Play/Pause. Springst du von außen hinein, wird immer zuerst der ganze Player umrahmt. Runter führt zu den Knöpfen des Players, Hoch zurück zum ganzen Player. Liegt der Player über der ganzen Seite (etwa nach „Abspielen“ bei ZDF), erreichst du nur seine Knöpfe, nicht die verdeckte Seite dahinter. Damit eingeblendete Knöpfe erscheinen und sichtbar bleiben, simuliert Fernsurfer Mausbewegungen. Knöpfe im Player werden auch dann erkannt, wenn sie nur an ihrem Namen erkennbar sind (etwa `vjs-play-control`), wenn eine durchsichtige Klick-Schicht darüber liegt oder wenn der Player in einem anklickbaren Rahmen steckt.
- **Eingebetteter Player (iframe):** Von außen ist der Player ein einziges Ziel. OK startet das Video und geht hinein, danach springen die Pfeiltasten zwischen den Knöpfen im Player. Zurück oder ein Sprung über den Rand hinaus verlässt ihn wieder.
- **Fehlt etwas?** Blau → „Erkannte Elemente zeigen“ umrahmt einige Sekunden lang alles, was der Link-Modus anspringen kann, gelb gestrichelt. Was dort nicht umrahmt ist, erreichst du mit dem freien Zeiger (Grün). Die Play-, Pause- und Spultasten funktionieren immer.

## Videoplayer

- Liegt eine unsichtbare Klick-Schicht über dem Player, die beim Klick ein Popup öffnen will, räumt Fernsurfer sie beim ersten OK weg und reicht den Klick an den Player durch.
- Reagiert ein Player nicht auf OK, startet Fernsurfer das Video direkt.
- Ein Vollbild-Knopf, der in TizenBrew nichts tut, legt das Video bzw. den eingebetteten Player stattdessen über den ganzen Bildschirm.
- **Im Vollbild** sind Zeiger und Rahmen ausgeblendet, ← → spulen, OK pausiert. **Zurück** beendet jedes Vollbild (auch das echte der Seite), ohne die Seite zu verlassen. Danach sind Zeiger bzw. Rahmen wieder da, wo sie vorher waren.

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

## Für Entwickler

### Filterlisten aktualisieren

Die Listen werden beim Bauen eingebettet. Lade sie neu herunter und bau dann neu:

```
python -I tools/build.py easylist.txt easylistgermany.txt ublock-filters.txt
```

Optional setzt `--start URL` eine andere Startseite in das Modul und in `package.json` (`websiteURL`) ein.

Quellen:
- https://easylist.to/easylist/easylist.txt
- https://easylist.to/easylistgermany/easylistgermany.txt
- https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt

Danach erhöhst du `version` in `package.json` und lädst die geänderten Dateien hoch. TizenBrew holt sie über jsDelivr, das einige Stunden zwischenspeichert.

## Änderungen

- **1.3.5:** Weniger Speicher und Rechenzeit bei langen Videos. TizenBrew schleust Fernsurfer in jeden iframe ein, auch in jede Werbefläche. Jeder Rahmen gibt die kompletten Filterlisten jetzt nach dem Einrichten wieder frei, statt sie bis zum Schluss zu behalten. Die Filterdaten werden schneller eingelesen (als JSON). Entfernte iframes und Elemente hält Fernsurfer nicht mehr fest. Der Werbefilter reagiert nicht mehr auf jede Änderung der Zeitanzeige im Player. Im Vollbild ruhen Rahmen und Maus-Simulation.
- **1.3.4:** Im Vollbild ist der Zeiger ausgeblendet. Zurück beendet jetzt auch das echte Vollbild einer Seite, statt die Seite zu verlassen. Startseite abgesichert: Die leere DuckDuckGo-Suchseite springt zur Startseite, und Suchen über das DuckDuckGo-Formular behalten den Suchbegriff in der Adresse.
- **1.3.3:** Klicks und Zeigerbewegungen sehen für Webseiten jetzt wie von einer echten Maus aus. Vorher ignorierte z. B. ZDF den Knopf „Abspielen“, und manche Player blendeten ihre Leiste nicht ein. Link-Modus: Beim Hineinspringen wird zuerst der ganze Player umrahmt. Ein Player über der ganzen Seite hält den Link-Modus bei sich, statt in die verdeckte Seite dahinter zu springen. Außerdem wird kein Rahmen mehr ohne Höhe als Player erkannt (ZDF), und unsichtbare Menüs (Lautstärke-Regler bei arte), Symbole in Knöpfen (d.tube) und gesperrte Knöpfe werden nicht mehr angesprungen.
- **1.3.2:** Link-Modus: Links mit einem großen Bild darin werden mit der ganzen Bildfläche umrahmt und angesprungen (vorher nur eine Textzeile hoch).
- **1.3.1:** Adressleiste mit zwei Zuständen (Tastatur offen / zu), → erreicht den Stern bei geschlossener Tastatur. Die Leiste erzwingt die Schreibrichtung links nach rechts und das Eingabefeld kann nicht mehr zusammenfallen (mögliche Ursachen für den Stern links). „Abbrechen“ der Bildschirmtastatur schließt nur die Tastatur.
- **1.3.0:** Freier Zeiger wieder Standard, im Link-Modus springt der Zeiger mit in die Mitte des Rahmens. Link-Modus erkennt ganze Player und ihre Knöpfe deutlich besser (versteckte Leisten, Klick-Schichten, unbeschriftete Knöpfe, Shadow DOM, anklickbare Rahmen), dazu Blau → „Erkannte Elemente zeigen“. Adressleiste ohne „Öffnen“-Knopf, „Fertig“ der TV-Tastatur bestätigt überall, auch in Suchfeldern auf Webseiten. Neue Favoriten über die „+“-Kachel werden direkt gespeichert, Gelb entfernt eine Kachel. Größere Tastenhilfe und Oberfläche, abhängig von der Bildhöhe.
- **1.2.0:** Link-Modus wie im Samsung-Browser (Standard). Grün wechselt zum freien Zeiger. Eingebettete Player lassen sich betreten und verlassen, im Vollbild spulen ← →, OK pausiert. Zeiger aus/an über das Menü.
- **1.1.0:** Favoriten-Startseite (auf DuckDuckGo) mit Kacheln und ★-Knopf in der Adressleiste. Adressleiste mit Knopf **▶ Öffnen**; „Fertig“ auf der TV-Tastatur öffnet die Adresse. Tastenhilfe rechts (INFO-Taste), die bei laufendem Video und im Vollbild verschwindet. Videoplayer: Klick-Schichten werden weggeräumt, Video startet per OK, eigenes Vollbild; Play/Pause trifft das laufende Video, auch in eingebetteten Playern.
- **1.0.1:** Zeiger, Adressleiste und Werbefilter funktionieren auf Seiten mit Content-Security-Policy (z. B. DuckDuckGo). Der Autofokus der Seite wird ignoriert, die Startseite öffnet direkt die Adressleiste. Fernsurfer erscheint nicht mehr in der TizenBrew-Oberfläche. Hoch am oberen Rand öffnet die Adressleiste.
- **1.0.0:** erste Version.

## Lizenzen

- **Code** (`src/`, `tools/`): MIT, siehe [LICENSE](LICENSE).
- **Filterdaten** in `dist/userScript.js`:
  - EasyList und EasyList Germany: © The EasyList authors, GPLv3 bzw. CC BY-SA 3.0 (https://easylist.to/pages/licence.html)
  - uBlock filters: © Raymond Hill und Mitwirkende, GPLv3 (https://github.com/uBlockOrigin/uAssets)

  Wer `dist/userScript.js` weitergibt, gibt diese Daten unter ihren Lizenzen weiter.
