# Handbuch

Vollständige Anleitung für alle Benutzer von PROject. Für den schnellen Einstieg reicht die Kurzanleitung (mit Glossar); alles zu KI-Agenten steht ausführlich im KI-Handbuch (Hilfe › KI-Agenten), auf das die Kapitel 11 und 12 verweisen. Installation und Betrieb: `docs/Betrieb.md`.

## 1. Grundbegriffe

**Struktur:** Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Checklistenpunkt. Checklisten gehören zu Aufgaben; letzter Punkt erledigt → Aufgabe erledigt; alle Aufgaben erledigt → Arbeitspaket erledigt (beides abschaltbar).

- **Arbeitspaket (AP):** ein Ergebnis mit Termin, Priorität und Zuständigkeit. Jedes AP hat eine Kennung aus Projektkürzel und Nummer (`WEB-12`), ein Log, Anhänge, verknüpfte Mails und eine eigene Antwortadresse für Mails.
- **Aufgabe:** zuweisbarer Schritt eines AP (entspricht dem Vorgang nach DIN 69901). Sie hat eigenen Status, Termine, Log, Antwortadresse und kann einem KI-Agenten zugewiesen werden. Aufgaben haben keine weiteren Aufgaben. Das Teilprojekt folgt immer dem AP.
- **Checklistenpunkt** (früher „Task“): Punkt der Checkliste einer Aufgabe, optional mit eigener Zuständigkeit (auch extern per Mail-Adresse). Ein AP hat keine eigene Checkliste mehr; ältere Punkte am AP stehen dort als „Checkliste (Altbestand)“ und lassen sich in eine Aufgabe überführen.
- **Teilprojekt:** Gruppe von APs mit Verantwortlichem und Zeitraum; kann eingeschränkt sichtbar sein (siehe unten).
- **Meilenstein:** Termin im Plan, optional einem Teilprojekt zugeordnet.

### Zuständigkeit

Ausdrücklich gesetzt oder geerbt in der Reihenfolge Aufgabe → AP → Teilprojekt → Projektleitung. Geerbte Zuständigkeit ist überall als „geerbt“ markiert. Zuständig sein können Mitglieder, KI-Agenten (nur durch die PL) und externe Kontakte per Mail-Adresse.

### Rollen im Projekt

Projektleitung (PL, optional zweite PL als Stellvertretung, optional ein KI-Agent als **Projektagent**), Mitglied, Leser. Einzelrechte: Projektplan ändern, Freigeben (KI-Vorschläge, Workflow-Schritte, Bestätigungen), Final setzen, KI nutzen. „KI nutzen“ ist überall gleich vorbelegt: an für Mitglieder, aus für Leser (Einladung, Formular, Gruppe). Leser mit „KI nutzen“ stellen nur Fragen ans Projekt und fragen Agenten im Chat (nur Auskunft).

Die verantwortliche PL übergibt ihre Rolle nur selbst; die Stellvertretung kann sich nicht selbst dazu machen und ändert die Mitgliedschaft der verantwortlichen PL nicht. Zusätzlich kann der Org-Admin die verantwortliche PL neu bestimmen (Verwaltung › Personen), ohne Inhalte zu sehen und nie sich selbst; die bisherige PL wird Stellvertretung und bekommt eine Meldung.

Mandantenweit gibt es Org-Admins und Projektersteller, dazu einzelne Org-Rechte (KI verwalten, Gruppen verwalten, Ressourcen-Pool). Org-Admins sehen Projektinhalte nur, wenn sie Mitglied sind.

### Gruppen im Projekt

Die PL nimmt Berechtigungsgruppen als Mitglied oder Leser auf, mit Einzelrechten (Projekt › Einstellungen › Personen › Gruppe hinzufügen). Deren Personen stehen mit Herkunft „über Gruppe“ in der Mitgliederliste. Es gilt (Regel M): Ein Direkteintrag überschreibt alle Gruppen („überschreibt Elektro-Team (Mitglied)“, zurück mit „Gruppenrechte übernehmen“); zwischen mehreren Gruppen zählt die höchste Rolle, Einzelrechte addieren sich. Wer über eine Gruppe Mitglied ist, wird in der Gruppe entfernt oder per „Rolle“ direkt eingetragen.

PL und Stellvertretung sind immer einzelne Personen; KI-Agenten werden nie Gruppenmitglied; persönliche Projekte nehmen keine Gruppen auf. Änderungen an Gruppen, SSO-Abgleich und Deaktivieren wirken sofort im Projekt. Unter **Deine Rechte** (Einstellungen › KI) stehen die eigene Rolle, die Einzelrechte und je KI-Funktion „erlaubt“ oder der Grund der Sperre.

### Eingeschränkte Teilprojekte

Ein eingeschränktes Teilprojekt sehen nur PL, Verantwortliche, benannte Benutzer und Gruppen. Das gilt für alles am AP: Log, Checklistenpunkte, Anhänge, Zeiten, Kopien von Mails, Verschieben, Kopieren und Eskalieren, dazu Agentenläufe, KI-Vorschläge, Aktionspunkte von Besprechungen, Mail-Entwürfe und RAID-Einträge zum AP, Meilensteine, Übersicht, Warnungen sowie Kopieren und Verschieben des ganzen Teilprojekts. Kopien von Mails im AP lesen nur ausdrückliche Mitglieder (direkt oder über Gruppe), nicht die impliziten Leser eines für alle sichtbaren Projekts.

## 2. Navigation

- **PROject** oben links öffnet das Dashboard.
- **Angeheftete Projekte:** bis zu fünf, mit ☆ anheften und ★ lösen (Benutzereinstellung). Ohne eigene Auswahl stehen dort die ersten fünf Projekte.
- **Alle Projekte** klappt die übrigen Projekte aus; dort auch die Projektübersicht mit „Neues Projekt“ (Org-Admin, Projektersteller).
- **Im Projekt:** Ein Klick in der Leiste öffnet das Board. Unter dem geöffneten Projekt zeigt die Leiste die **Doku** des Projekts als Untermenü: Besprechungen, die Ordner (öffnen ihre Ordnerseite) und die zuletzt geänderten Seiten.
- **Reiter im Projekt:** Board, Plan, Doku, Risiken, Zeiten, Auswertung, Einstellungen. Der Kalender des Projekts liegt unter Plan › Kalender, Besprechungen unter Doku › Besprechungen, die KI-Läufe mit offenen Vorschlägen unter Einstellungen › KI-Läufe (nur bei aktiver KI). Alte Adressen leiten weiter. Mails gibt es nur im globalen Postfach (mit Projektfilter).
- **Offen für dich** (Dashboard › Meine Arbeit, unter den Kennzahlen): Fragen, Entscheidungen, Bestätigungen, KI-Vorschläge, Vorschläge der Mail-KI, Mail-Entwürfe zur Freigabe, Seiten und Arbeitspakete, die du prüfen sollst, blockierte und eskalierte Arbeitspakete. Die Anzahl steht in der Leiste bei „PROject“ und je Projekt.
- **Global:** Chat, Postfach (vereinigte Sicht aller Postfächer mit Leserecht, jede Mail einmal, Filter nach Postfach und Projekt, oben „Zur Freigabe“ mit den Entwürfen der KI-Agenten; gelesen und Ordner gelten überall gleich; Ansichten pflegt die PL in den Projekteinstellungen), Kalender (alle Projekte), Workflows. Unter „Einstellungen“: Meine Einstellungen und, für Org-Admins und Personen mit Org-Rechten, Verwaltung.
- **Kopfzeile:** Suche über APs, Seiten und Mails (auch nach Kennung), Glocke mit Benachrichtigungen; der Reiter „Offen für dich“ in der Glocke zeigt dieselbe Liste wie das Dashboard. Ein Klick auf eine Meldung öffnet das Ziel und markiert sie als gelesen. Kennungen wie WEB-12 sind im Chat Links aufs AP. KI-Agenten und deaktivierte Benutzer bekommen keine Meldungen.
- **Brotkrumen:** Über dem Projekttitel steht „Projekte › Projekt › Bereich“, im Kopf eines Arbeitspakets „Projekt › Teilprojekt › Arbeitspaket › Aufgabe“, auf einer Doku-Seite „Projekt › Doku › Ordner › Oberseite › Seite“ und in den Dateien „Projekt › Doku › Dateien › Einbindung › Ordner“. Jede Ebene außer der letzten ist klickbar (das Teilprojekt öffnet seine Maske, das Arbeitspaket führt aus der Aufgabe zurück). Am Handy stehen nur die letzten zwei Ebenen da; „…“ klappt die übrigen auf.
- **Datumsfelder:** Alle Datumsfelder zeigen TT.MM.JJJJ und lassen sich tippen: „12.11.“ (dieses Jahr), „12.11.26“, „heute“, „morgen“, „+3“ (in drei Tagen), „+2w“, „Fr“ (nächster Freitag), „KW 47“ (Montag der Woche). Übernommen wird mit Enter oder beim Verlassen; Pfeil hoch/runter ändert um einen Tag. Das Kalendersymbol öffnet einen Kalender mit Kalenderwochen, „Heute“ und „Löschen“; darin Pfeiltasten, Bild auf/ab (Monat), Pos1/Ende (Wochenanfang/-ende), Enter wählt, Esc schließt nur den Kalender.
- **Unten links:** Abmelden, **Tutorial** (jederzeit neu startbar) und **Hilfe** (Kurzanleitung, Handbuch, KI-Agenten, KI-Sheet), dazu die Build-Version.

## 3. Dashboard

Das Dashboard gibt es nur global; oben lässt es sich nach einem Projekt filtern.

- **Meine Arbeit:** offene, überfällige und bald fällige APs und Aufgaben, Blockaden und Eskalationen, Soll/Ist je Projekt, nächste Termine, was auf dich wartet (Mail-Entwürfe zur Freigabe, Seiten in Prüfung), Meldungen (ein Klick öffnet das Ziel und markiert sie als gelesen, wie in der Glocke).
- **Geklammerte Sicht** darunter: Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Checklistenpunkt mit allem, was dir zugewiesen oder vererbt ist. Checklistenpunkte lassen sich dort direkt abhaken.
- **Projekte:** alle Projekte mit Ampel (von der PL gesetzt oder berechnet), Fortschritt, Verzug, Blockaden, roten Risiken, nächstem Meilenstein, Budget; Auslastung je Person und gebuchte Zeiten über Projekte (CSV).
- **Alle Arbeitspakete:** Liste über alle Projekte mit Filtern (nur meine, überfällig, fällig in 7 Tagen, blockiert/eskaliert/Konflikt, ohne Termin).
- **Mit Projektfilter** zeigt „Meine Arbeit“ das Projekt-Dashboard: Kennzahlen, Fortschritt je Teilprojekt, Überfälliges, Konflikte, Meilensteine, Auslastung, Risiken, offene Freigaben, Aktivität, danach die eigene Arbeit im Projekt.

## 4. Projekte und Planung

- **Neues Projekt:** Kürzel, Name, Beschreibung, optional eine Vorlage (Spalten, Teilprojekte, Meilensteine, Labels, Doku-Ordner, Termine relativ zum Projektstart). Wer anlegt, wird PL.
- **Einstellungen (PL):** Allgemein (Name, Beschreibung, Sichtbarkeit, Ampel, Zeiterfassung, Budget, Automatik „erledigt“ für Arbeitspakete und Aufgaben, als Vorlage speichern, archivieren), Personen (Mitglieder, Gruppen, Einladungen, Kontakte), Mail (Konten, Ansichten, Mail-Rückfrage, Außenkommunikation), Benachrichtigungen, KI (Agenten, Projektagent, Agenten-Policy).
- **Weitere Reiter:** Fristen und Berichte (Eskalation, Reporting), Planung und Board (Teilprojekte, Meilensteine mit „automatisch erreichen“, Spalten, „Prüfer erforderlich“, WIP-Limits, Labels, Ressourcen), Daten (CSV-Import, Papierkorb, Audit-Log), KI-Läufe (Kapitel 13).
- **Meilensteine** haben einen Status: **offen** oder **erreicht** (mit Datum und wer bestätigt hat). Im Meilenstein-Formular (Plan › Liste „Meilensteine“ › „Bearbeiten“, Klick auf die Zeile im Gantt oder Einstellungen › Planung und Board) wählst du die **Arbeitspakete**, die zum Meilenstein gehören (Suche nach Titel oder Kennung); im Arbeitspaket steht dasselbe unter „Einstellungen“ › **Meilenstein** (mehrere möglich). Sind alle verknüpften Arbeitspakete erledigt, schlägt der Meilenstein „erreicht“ vor: die PL bekommt eine Meldung „Meilenstein erreicht?“ und bestätigt mit „Erreicht bestätigen“. Mit der Projekteinstellung „Meilenstein automatisch erreichen …“ geschieht das ohne Rückfrage. Öffnet sich ein verknüpftes Arbeitspaket wieder, fällt der Vorschlag weg; ein bestätigter Meilenstein bleibt erreicht, bis ihn jemand mit Planrecht „wieder öffnet“. Ändern dürfen PL und „Projektplan ändern“.
- **Meilensteine im Gantt:** eine Raute, leer solange offen, gefüllt wenn erreicht; gestrichelte Linien führen vom Ende jedes verknüpften Arbeitspakets zur Raute. Die Projektübersicht im Dashboard zeigt offene (auch überfällige) und in den letzten 30 Tagen erreichte Meilensteine, der Report-Block „Meilensteine“ nennt „Erreicht“ nach dem Datum der Bestätigung und „Überfällig, nicht erreicht“.
- **Plan:** Balken von Start bis Deadline, Punkt bei reiner Deadline, Sammelbalken je Teilprojekt, Meilensteine, Abhängigkeiten Ende → Anfang. Aufgaben stehen eingerückt unter ihrem AP. Balken ziehen verschiebt, die rechte Kante ändert die Deadline. Unterreiter **Kalender** zeigt Deadlines, Meilensteine, Besprechungen und Belegungen des Projekts.
- **Konflikte** (Deadline nach Teilprojekt-Ende, Start vor Ende des Vorgängers) werden markiert; nichts verschiebt sich automatisch. „Nachfolger verschieben“ zeigt eine Vorschau und informiert die Betroffenen.
- **Termine ändern** dürfen die PL, wer „Projektplan ändern“ hat, und die zuständige Person.

## 5. Arbeitspakete, Aufgaben und Checklisten

### Board

- **Spaltenarten:** Geplant, aktive Spalten (z. B. Offen, In Arbeit), **In Prüfung**, **Wartet**, Zurückgestellt, Erledigt. Nur aktive Spalten und „In Prüfung“ zählen als Stillstand für die Eskalation. Bestehende Spalten mit dem Namen „In Prüfung“ haben die Art „In Prüfung“ bekommen.
- Swimlanes je Teilprojekt (abschaltbar), Spalten einklappen, WIP-Limit je Spalte. Leere Swimlanes sind eingeklappt; „+ Arbeitspaket“ steht nur in der ersten aktiven Spalte.
- **Spaltengruppen:** Spalten mit gleicher Gruppe (Einstellungen › Planung und Board › Spalten bearbeiten, Feld „Gruppe“) erscheinen im Board als **eine** Spalte mit Abschnitten untereinander; die Gruppe steht an der Position ihrer vordersten Spalte. Jeder Abschnitt ist eine eigene Spalte: eigener Kopf mit Art, Zähler und WIP-Limit, eigenes Ziel beim Ziehen, eigene Schnellanlage, einklappbar (auch die ganze Gruppe, dann nur die Gesamtzahl). Neue Projekte gruppieren **Geplant, Wartet und Zurückgestellt als „Nicht in Arbeit“**; bestehende Projekte bleiben, wie sie sind – der Knopf „Geplant, Wartet und Zurückgestellt zu „Nicht in Arbeit“ zusammenfassen“ im Spaltenformular setzt die Gruppe bei allen Spalten dieser Arten. Status-Menü „→“, Sammelaktionen und Vorlagen nennen weiterhin die einzelnen Spalten. Am Handy bleibt die Gruppe eine Spalte, die Abschnitte stehen untereinander.
- **Filter:** Text, Person, Label, Priorität, nur meine, überfällig, Konflikte, blockiert/eskaliert, Archiv. Personenfilter treffen ein AP auch über seine offenen Aufgaben.
- **Tastatur:** `n` neues AP, `f` filtern, `q` nur meine, `x` Filter löschen, `Esc` Auswahl aufheben.
- „Auswählen“ (oder Strg/Cmd+Klick) für Sammelaktionen. Erledigte einer Spalte lassen sich gesammelt archivieren.
- Karten zeigen Fälligkeit (farbig), Labels, Zuständige und den Fortschritt (☑ erledigt/gesamt aus Aufgaben und Checkliste, mit Balken).
- **Status ohne Ziehen:** „→“ auf der Karte öffnet die Spaltenwahl mit „✓ Erledigt“ (geht auch am Handy); im AP steht „✓ Erledigt“ oben. Ziehen bleibt möglich, „Hier ablegen“ erscheint nur beim Ziehen.

### Spalte „Wartet“

Wer ein AP nach „Wartet“ zieht (oder per „→“ bzw. Status setzt), gibt an, worauf und bis wann gewartet wird; die Karte zeigt „⏳ Grund · bis Datum“. Wartet ein KI-Agent (wait), stellt das System das AP selbst dorthin und nach der Antwort zurück in die Spalte davor. Läuft die Frist ohne Lösung ab, wandert das AP nach „Zurückgestellt“, mit Log-Eintrag und Meldung (Klasse Eskalation) an wartende Person, Zuständige, Auftraggeber und PL; kommt die Antwort später, geht es zurück. Bestehende Projekte haben die Spalte vor „Zurückgestellt“ bekommen.

### Spalte „In Prüfung“ (benannte prüfende Person)

Wer ein AP in eine Spalte der Art „In Prüfung“ zieht (oder per „→“ bzw. Status setzt), wählt die **prüfende Person** (aktives Mitglied, keine Leser, keine KI-Agenten). Mit der Projekteinstellung **„Prüfer erforderlich“** (Einstellungen › Planung und Board) ist die Auswahl Pflicht, sonst geht es auch ohne. Die Person bekommt eine Meldung (Klasse Prüfung/Freigabe) und sieht das AP unter **Offen für dich**; die Karte zeigt „Prüfung: Name“. Im AP steht oben „In Prüfung bei …“ mit **Freigeben** (AP geht in die Erledigt-Spalte) und **Zurückweisen …** (Kommentar Pflicht; das AP geht in die Spalte vor der Prüfung zurück, der Kommentar steht im Log, die Zuständigen werden informiert). Entscheiden dürfen die prüfende Person und die PL; den Prüfer wechseln alle, die das AP bearbeiten dürfen. Wer das AP von Hand aus der Prüfspalte zieht, beendet die Prüfung.

### Anlegen, überall gleich

Knopf klicken, Titel eingeben (Enter), danach öffnet die Maske mit allen Feldern; leer oder Esc legt nichts an. Arbeitspakete: „+ Arbeitspaket“ in jeder Spalte jeder Swimlane (außer Wartet und Erledigt), `n` öffnet das Feld der ersten aktiven Spalte. Aufgaben im AP. Teilprojekte: „+ Teilprojekt“ unter den Swimlanes, in der Liste im Plan und in den Einstellungen. Meilensteine brauchen dazu ein Datum; Checklistenpunkte entstehen inline im AP.

### Teilprojekt-Maske

„⚙ Teilprojekt“ oder Klick auf den Namen im Kopf der Swimlane, auf die Zeile im Plan oder in den Einstellungen. Wie beim AP: Kopf mit Name, Kopieren, Verschieben, Löschen (PL; mit Haken „Auch zugeordnete Arbeitspakete löschen“ gehen sie samt Aufgaben in den Papierkorb, sonst stehen sie unter „Ohne Teilprojekt“); Verantwortlich, Start, Ende; **Beschreibung** (Ziel, Abgrenzung; auch Kontext für die Agenten); Sichtbarkeit (PL); Meilensteine; Arbeitspakete mit Status, Termin und Zuständigen, neues AP direkt im Teilprojekt.

### Arbeitspaket öffnen

- Alle Felder direkt editierbar: Status, Teilprojekt, Zuständig (Mitglied, Agent, externer Kontakt), Priorität, Labels, Start, Deadline, Schätzung, Beschreibung (Markdown).
- **Außenbeschreibung (für Externe):** was Externe zu diesem AP erfahren dürfen; KI-Agenten schreiben Externen nur daraus, aus Log-Einträgen „für Externe sichtbar“ und aus freigegebenen Seiten (KI-Handbuch Kapitel 7). Pflegen PL und „Projektplan ändern“.
- **Aufgaben:** neue Aufgabe mit Titel und optional Zuständigem (danach öffnet ihre Maske, zurück über den Link zum AP); Häkchen setzt auf Erledigt bzw. zurück. Klick auf den Titel klappt die Aufgabe im AP auf (Termin, Beschreibung, Checkliste, Log), „Alle Details“ öffnet sie ganz.
- **Checkliste** (Checklistenpunkte) **gehört zu Aufgaben:** In der Aufgabe Punkte mit eigener Zuständigkeit anlegen, neuer Punkt mit Enter; bei externer Zuständigkeit „Nachfragen“ per Mail, die Antwort erscheint beim Punkt. Am AP gibt es kein Eingabefeld für Checklistenpunkte („Checklistenpunkte gehören zu Aufgaben – lege oben eine Aufgabe an.“).
- **Automatisch erledigt:** Ist der letzte Checklistenpunkt einer Aufgabe abgehakt, wandert die Aufgabe in die Erledigt-Spalte (Kennzeichen „automatisch erledigt“, Hinweis „Aufgabe automatisch erledigt“, Meldung an die Zuständigen); ein wieder geöffneter oder neuer offener Punkt holt sie in die vorherige Spalte zurück. Sind alle Aufgaben erledigt, ist auch das AP erledigt. Vorgabe je Projekt unter Einstellungen › Allgemein, je AP bzw. Aufgabe unter „Einstellungen“ › „Automatisch erledigt“ (wie im Projekt / an / aus).
- **Checkliste (Altbestand):** Punkte, die noch direkt am AP hängen, bleiben abhakbar und löschbar. „In Aufgabe überführen“ macht daraus eine neue Aufgabe (Titel abgefragt, Vorgabe „Checkliste“) mit genau diesen Punkten; einzelne Punkte lassen sich auch in eine Aufgabe umwandeln oder in eine andere Aufgabe verschieben.
- **Vorgänger** (Ende → Anfang) und **Wiederholung** (täglich, wöchentlich, monatlich, n-ter Wochentag; nächste Instanz nach Erledigung oder vor Fälligkeit).
- **Blockiert melden** mit Grund; **eskalieren** eine Stufe höher (Zuständige, Teilprojekt-Verantwortliche, PL); die PL setzt Eskalationen zurück.
- **Mails:** „Mail aus Arbeitspaket schreiben“, „Stand nachfragen“; Antworten an die Antwortadresse (Plus-Code) landen automatisch im AP. Ist das AP aus einer Mail entstanden, steht oben „Entstanden aus Mail von …“ und nach Erledigung „Ursprungsmail beantworten“ (KI-Handbuch Kapitel 3).
- **Log und Kommentare:** `@Name` benachrichtigt die Person. Systemeinträge (Status, Eskalation, Agent, Mail) stehen im selben Log. Das Häkchen **„für Externe sichtbar“** beim Kommentieren macht den Eintrag Teil des Außenkontexts (Kennzeichen am Eintrag). Nachträglich umschalten („für Externe freigeben“ / „nur intern“) dürfen PL und „Projektplan ändern“, bei eigenen Einträgen auch die verfassende Person.
- **Agent am AP:** „Jetzt laufen lassen“, „Agent pausieren“ (PL), Wartezustand, offene Fragen, Freigaben, Quellen, verwandte Arbeitspakete, Ressourcen, Berichtswunsch und Selbstständigkeit je AP (KI-Handbuch Kapitel 4 und 9).
- **Kopieren / Verschieben …** Das Menü „Verschieben …“ hält die Struktur beweglich, alles im selben Projekt mit Log-Eintrag an Quelle und Ziel, Audit und Meldung an die Zuständigen:
  - **Aufgabe:** „In anderes Arbeitspaket …“ (Ziel per Kennung oder Titel suchen; Checkliste, Anhänge, Log und Zeiten gehen mit, das Teilprojekt folgt dem Ziel), „Zum Arbeitspaket machen …“ (eigene Karte in der Spalte des bisherigen AP, Teilprojekt wählbar), „Zu Checklistenpunkt machen …“ (die Aufgabe wird Punkt einer anderen Aufgabe desselben AP: Ziel-Aufgabe wählen, bei genau einer ist sie vorausgewählt; ohne andere Aufgabe nicht möglich; nur ohne Zeitbuchungen, verknüpfte Mails und offene Fragen; Log und Kommentare werden als ein Eintrag an der Ziel-Aufgabe zusammengefasst, Anhänge und Checkliste wandern dorthin; danach öffnet die Ziel-Aufgabe). Die Aufgabe selbst landet im **Papierkorb** (30 Tage) und ist **umkehrbar**: „Rückgängig“ im Hinweis unten rechts oder „Wiederherstellen“ unter Einstellungen › Daten › Papierkorb entfernt den Checklistenpunkt wieder (auch wenn er inzwischen umbenannt wurde), holt Checkliste und Anhänge zurück und stellt die Aufgabe mit Status, Termin, Beschreibung und Log am alten AP wieder her.
  - **Arbeitspaket:** „Teilprojekt ändern …“ (Aufgaben folgen) und „In anderes Projekt …“ (bisheriger Dialog mit Auswahl, was mitgeht; PL oder „Projektplan ändern“). Auch in der Teilprojekt-Maske steht je AP eine Auswahl des Teilprojekts.
  - **Checklistenpunkt:** Menü je Punkt mit „In Aufgabe umwandeln …“ (Titel, Termin, Zuständigkeit; der Punkt entfällt, Mails dazu bleiben an der Quelle), „In andere Aufgabe verschieben …“ (Ziel ist immer eine Aufgabe, kein Arbeitspaket) und „Löschen“.
  - **Ziehen:** Aufgaben aus der Aufgabenliste des AP oder aus der aufgeklappten Karte lassen sich auf eine andere AP-Karte im Board ziehen (gestrichelter Rahmen = Ziel); das hängt sie um, der Status bleibt. Ziehen in eine Spalte setzt wie bisher den Status.
  - **Archivieren**, **Löschen** (PL; Papierkorb 30 Tage, Aufgaben gehen mit). Im Chat erledigt der KI-Agent dasselbe mit dem Befehl `move` (KI-Handbuch Kapitel 4).

### Eskalationsregelwerk

Einstellungen › Fristen und Berichte: Verzug, Stillstand und Blockaden eskalieren automatisch entlang Zuständig → Teilprojekt-Verantwortung → PL → Eskalationskontakt. Kritikalität (Priorität, Nachfolger, naher Meilenstein, Blockade) halbiert die Fristen. Jede Stufe erzeugt Benachrichtigung und Log-Eintrag.

## 6. Kommunikation: Chat und Mail

**Grundregel:** Zwischen Projektbeteiligten wird gechattet, nach außen gemailt. Was für ein AP gilt, gehört zusätzlich ins Log des AP.

### Chat

- Desktop: Knopf unten rechts oder „Chat“ in der Leiste öffnet den Messenger. Oben die Suche über Gespräche und Nachrichten, links alle Gespräche nach letzter Aktivität, rechts der Verlauf. Mobil öffnet sich der Chat als Seite mit fester Kopf- und Eingabezeile.
- **Projektkanal** je Projekt, Antworten als Thread, `@Name` benachrichtigt. Schreiben dürfen eingetragene Mitglieder (auch Leser); ist ein Projekt für alle Benutzer des Mandanten sichtbar, lesen die übrigen nur mit. Die PL kann Nachrichten löschen.
- **Threads** klappen direkt unter ihrer Nachricht auf („n Antworten“, ▾ schließt); dort stehen Frage-Kopf, Antworten und das Antwortfeld. Gehört ein Thread zu einer älteren Nachricht, erst „Ältere laden“.
- **Direktnachrichten** mit jeder Person des Mandanten und mit KI-Agenten („+ Neu“); Antworten auch dort als Thread.
- **Archivieren:** Jedes Gespräch außer dem angepinnten Assistenten lässt sich archivieren (Knopf am Gespräch); es wandert in die eingeklappte Gruppe unten und kommt mit der nächsten Nachricht von selbst zurück. Die Suche findet auch archivierte Gespräche.

### Offene Fragen

Offene Fragen sind ein eigenes Objekt: Stellt ein Agent (oder das System) eine Frage, Entscheidung oder Bestätigung, entsteht sie als Thread-Wurzel im Chat (Direktnachricht an den Adressaten oder im Projektkanal), als Meldung mit Bezug (Glocke › „Offen für dich“, Dashboard) und als Log-Eintrag am AP. Antwort im Thread, im AP (Block „Offene Fragen“, Kommentar oder Auswahl-Knöpfe) oder auf anderem Weg (Termin bestätigt, Antwort per Mail) erledigt alle Stellen zugleich: Meldungen gelten als erledigt, der Thread bekommt eine Systemnachricht, der Agent läuft mit der Antwort weiter.

Adressat ist die Kette (Zuständige des Über-AP, Teilprojekt-Verantwortung, PL mit Stellvertretung, Eskalationskontakt, Projektkanal); nach der Frist aus den Kommunikationsregeln erinnert das System im Thread und gibt an die nächste Stufe weiter. Erledigt sich das AP, erledigen sich seine Fragen. Ein Klick auf die Meldung springt zur Nachricht im Chat, hebt sie hervor und setzt den Fokus ins Antwortfeld. Wie Agenten fragen und was als Antwort zählt: KI-Handbuch Kapitel 2.

### Mail: vier Arten von Postfächern

Spalte „Art“ in Meine Einstellungen › Mail, Verwaltung › Mail bzw. Projekt › Einstellungen › Mail:

- **Org-Postfach** (genau eines): Systemmails wie Einladungen, Digest, Passwort; nur der Org-Admin; keine Projekte, keine Ansichten.
- **Zentrale Postfächer** der Organisation für mehrere Projekte: der Org-Admin pflegt sie; er bietet sie einzelnen Projekten an oder setzt „für alle Projekte wählbar“, dann holt jede PL sie selbst in ihr normales Projekt; nie automatisch Standard.
- **Projektpostfächer**, die genau einem Projekt gehören: die PL legt sie an und pflegt Zugangsdaten, Ordner, Ansichten; an andere Projekte bindet sie niemand.
- **Persönliche Konten** („Meine Konten“): Ansichten teilst nur du, senden darfst nur du; als PL holst du sie in dein Projekt.

Je Projekt ist ein Postfach **Standard-Ausgangskonto** (Antwortadresse mit Plus-Code, Absender für Agenten, Einladungen, Erinnerungen, Berichte, Workflows), das die PL unter Einstellungen › Mail setzt. Der Org-Admin kann die Art ändern (Organisation = zentral, Projekt = Projektpostfach, Person = persönlich); wird ein Konto Projektpostfach, lösen sich Bindungen an andere Projekte. Eine PL setzt nie „Org-Postfach“.

### Ansichten, Rechte, Aktionen

- Geteilt werden nie ganze Konten, sondern **Ansichten** mit Filtern (Ordner, Absender/Domain, Empfänger, Betreff, Stichwort, ab Datum). Gespeichert werden nur Treffer. Jede Ansicht besteht über eine Verwendung: über die Projektbindung gelten Rollenrechte, über die persönliche Bindung die Eigentümerregeln.
- Rechte je Ansicht: Lesen, Entwurf, Senden, KI, Aufgabe erzeugen. Über eine persönliche Bindung sendet nur der Eigentümer.
- Aktionen an einer Mail in vier Reihen: *Mail* (Antworten, Archivieren, Löschen, Verschieben), *Projekt* ohne KI (mit AP verknüpfen oder kopieren, ins Log übernehmen, AP anpassen mit Mail als Beleg, AP erstellen, in Doku ablegen oder an eine Seite anhängen), *Agent schlägt vor* und *Agent übernimmt* (KI-Handbuch Kapitel 3).
- Postfach mit Ordnern (Posteingang, Gesendet, Archiv, Papierkorb, Unterordner), synchron mit dem Mailserver. **Ungelesen:** Mails, die du noch nicht geöffnet hast, stehen fett mit Punkt in der Liste; die Zahl steht am Menüpunkt Postfach (je Person, auch bei geteilten Postfächern). Öffnen gilt als gelesen.

### Freigaben

- Entwürfe ohne Senderecht gehen in **Postfach › Zur Freigabe**; die PL sendet sie. Entwürfe aus persönlichen Konten sieht und sendet nur der Eigentümer. Entwürfe eines KI-Agenten am Projektkonto ändert, sendet oder lehnt ab, wer das Konto verwaltet (PL). Eine Ablehnung steht im Log des AP, und der Agent läuft daraufhin erneut.
- **Außenprüfung angehalten** (oben in den Freigaben): Agenten-Mails an Externe, in denen die Prüfung Projektinternes gefunden hat. Was die Außenprüfung ist, wer entscheiden darf und wie sie für eigene Mails an Externe wirkt (nur Hinweis, kein Block): KI-Handbuch Kapitel 7.

### Benachrichtigungen und Kommunikationsregeln

- **Kanäle:** Jede Meldung erscheint immer in der App (Glocke, Dashboard). Ob sie zusätzlich per **Chat** (Systembeitrag im Thread der Sache oder im Projektkanal), per **Mail** (Standard: Tages-Digest; sofort nur, wenn eine Regel es sagt) und im **Log** des AP ankommt und ob Entscheidungen auf der Doku-Seite **„Entscheidungen und Meldungen“** stehen, regeln Kommunikationsregeln.
- **Ereignisklassen:** Frage, Entscheidung, Bestätigung, Zuweisung, Blockiert, Eskalation, Prüfung und Freigabe, Fälligkeit, Zwischenstand, Mail am AP, Chat, Buchung, Information und weitere; je Klasse eine Regel.
- **Vererbung:** Verwaltung › Benachrichtigungen (Org) → Projekt › Einstellungen › Benachrichtigungen (PL) → Arbeitspaket → Meine Einstellungen › Benachrichtigungen (für alle Projekte oder je Projekt). Jede Ebene erbt und darf je Feld abweichen.
- **Sperren:** Org und PL können ein Feld sperren (🔒), dann gilt es für alle darunter. Chat „Projektkanal“ gilt nie bei eingeschränkten Teilprojekten und persönlichen Projekten.
- **Empfänger** je Klasse als Rollen (Zuständige, Verantwortung des Teilprojekts, verantwortliche PL, Stellvertretung, Auftraggeber, Freigabeberechtigte, Erwähnte, Gruppe …), optional „sonst“ als Ersatz für den letzten Eintrag. Die PL sieht unter „Wer bekommt was?“ je Klasse, welche Personen mit welchem Mail-Modus erreicht werden.
- **Fristen** je Klasse: Nachfassen, Weitergabe an die nächste Stufe und Verfall in Stunden; bei Zwischenständen die Häufigkeit (jeder Schritt, Meilensteine, täglich, nur Abschluss).
- **Voreinstellung für Benutzer:** oben **Wenig** (nur Fragen, Entscheidungen, Bestätigungen und Eskalationen, im Tages-Digest), **Standard** (was die Org vorgibt) oder **Alles** (jede Meldung sofort); gesperrte Klassen bleiben unberührt. „Erweitert“ öffnet die Matrix.
- **Stummschalten:** Benutzer stellen nur Chat und Mail ein; „stummschalten“ nimmt ein Projekt aus Mail und Chat (In-App bleibt, Sperren der Org oder PL gelten weiter).
- **Berichtswunsch am AP:** Oben im AP legst du fest, wie oft du Zwischenstände eines Agenten willst (für dich; als PL oder zuständige Person auch für das AP mit Empfängern). Zwischenstände schreibt das System aus den ausgeführten Aktionen, der Agent schickt keine eigenen Berichte.
- **Tages-Digest:** Stunde je Mandant (Verwaltung › Benachrichtigungen, Europe/Berlin); er enthält, was vor dieser Stunde entstand, spätere Digest-Meldungen warten bis zum nächsten Tag. Gelesene Meldungen werden nicht mehr verschickt. Lieferungen mit Seitenbezug (z. B. eine Entscheidungsvorlage) hängen das PDF an, nur für interne Empfänger mit Leserecht.
- **Mail am AP:** Jede neue Zuordnung einer Mail zu einem Arbeitspaket (von Hand, über die Antwortadresse, durch die Mail-KI oder aus einer angenommenen Änderung) ist ein Ereignis dieser Klasse: Standard ist ein Log-Eintrag im AP, Empfänger (z. B. Zuständige) legt die Regel fest; wer zuordnet, bekommt keine Meldung.
- **Doku-Seite:** „Entscheidungen und Meldungen“ legt die PL in den Projekteinstellungen einmal an; nach Aus- und wieder Einschalten wird dieselbe Seite weiterverwendet.

### Mail und KI

Ursprungsmail, Ordner „KI Bearbeiten“, Agent an einer Ansicht, Projektagent mit Mail-Modus, Mail-Rückfrage, autonomer Versand und Abschluss sind im **KI-Handbuch Kapitel 3** beschrieben; die Agenten-Policy, Denktiefe, Bestätigungen, Steuerung im Chat, Online-Recherche, Arbeitszeitfenster, Projektwissen, Überschneidungen, Ressourcenbuchung, Projektdurchlauf, Ordnerzugriff und Workflow-Schritte in den Kapiteln 4 bis 8.

## 7. Doku

- Ordner mit Verteiler, Seitenbaum mit Unterseiten. Eine Seite kann Oberseite sein (Besprechungsreihe, Teilprojekt, Berichte) und gibt Vorlage, Teilnehmer und PDF-Layout an ihre Unterseiten weiter. Die Leiste zeigt unter dem Projekt die Ordner und die zuletzt geänderten Seiten.
- Editor mit Überschriften, Listen, Tabellen, Bildern, Links. Jede Änderung erzeugt eine Version; veraltete Stände werden nicht überschrieben.
- **Status:** Entwurf → In Prüfung → Final. Final sperrt die Seite. Finale Seiten lassen sich als PDF an den Verteiler des Ordners senden; die PDF wird an der Seite abgelegt.
- **Prüfung einer Seite:** Beim Wechsel auf „In Prüfung“ fragt das Status-Menü, **wer prüft** (Pflicht mit „Prüfer erforderlich“). Mit benannter Person geht die Meldung nur an sie und die Seite steht nur bei ihr unter „Offen für dich“; ohne an PL und „Final setzen“. Neben dem Status steht „Prüfung: Name“ mit „ändern“. Die prüfende Person (auch ohne das Recht „Final setzen“), die PL und „Final setzen“ sehen **Freigeben** (Seite wird final) und **Zurückweisen …** (Kommentar Pflicht, Seite zurück auf Entwurf, der Kommentar geht an die verfassende Person).
- **Vorlagen:** Besprechungsprotokoll, Statusbericht, Konzept, RAID-Log, Änderungsantrag, Kickoff, Lessons Learned (Vorlagen-Editor in der Verwaltung).
- **Freigabe per Link** an eine Mail-Adresse, lesend oder schreibend, mit Ablauf und widerrufbar; externe Änderungen werden versioniert und gemeldet.
- **Agentenzugriff je Ordner** (Ordner bearbeiten): schreiben, nur lesen oder kein Zugriff; vererbt an Unterordner.
- Faustregel: Was länger gilt als ein Log-Eintrag (Protokoll, Konzept, Entscheidung), gehört auf eine Seite; ins Log kommt die Kurzfassung.

### Dateiquellen (Nextcloud, WebDAV)

Pläne, Verträge und Protokolle, die in einer Nextcloud oder einem anderen WebDAV-Speicher liegen, erscheinen unter **Doku › Dateien**, ohne sie hochzuladen. Das Tool liest nur: es legt nichts an, ändert und löscht nichts in der Cloud.

- **Quelle:** entweder ein **Freigabelink** (`https://cloud.example.de/s/AbC123`, bei geschützten Links mit Passwort) oder ein **Konto** (WebDAV-Adresse `https://cloud.example.de/remote.php/dav/files/<benutzer>/` bzw. nur `https://cloud.example.de`, dazu Benutzername und **App-Passwort**; in Nextcloud unter Einstellungen › Sicherheit › „Neues App-Passwort erstellen“, nie das Anmeldepasswort). Optional ein Startordner, ab dem gelesen wird. Beim Speichern prüft das Tool die Verbindung.
- **Quellen der Organisation** legt der Org-Admin an (Verwaltung › Dateiquellen) und gibt sie frei wie LLMs: für alle Projekte, ausgewählte oder keine; für **persönliche Projekte** getrennt (keine, alle, ausgewählte Personen; Standard keine).
- **Einbinden (PL):** Einstellungen › Dateien zeigt verfügbare Quellen; „Einbinden“ mit Ordnerwahl (Unterordner) und Anzeigename, z. B. „Pläne Halle 3“. Dieselbe Quelle kann mehrfach (anderer Unterordner) und in mehreren Projekten eingebunden sein; gelesen und durchsucht wird sie trotzdem nur einmal. Eine **eigene Quelle** des Projekts legt die PL dort selbst an; sie gilt nur in diesem Projekt. „Lösen“ entfernt die Einbindung, eine eigene Quelle verschwindet danach samt Index.
- **Lesen:** Wer im Projekt mindestens Leserecht hat, sieht die eingebundenen Ordner mit Unterordnern und Dateien, öffnet den Textauszug und lädt die Datei (sie kommt live aus der Cloud, nichts wird im Tool gespeichert außer Name, Größe, Datum und Textauszug). Dateien außerhalb des eingebundenen Unterordners sieht man nicht.
- **Aktualität:** Das Tool gleicht die Quellen alle 15 Minuten ab (Betrieb: `FILE_SYNC_INTERVAL_MS`), „Jetzt synchronisieren“ sofort. Neu und geändert erkennt es am ETag; gelöschte Dateien verschwinden. Ein Fehler (Passwort geändert, Link abgelaufen) steht an der Quelle.
- **Suche und Agenten:** Für .txt, .md, .csv, .html, .pdf und .docx wird ein Textauszug gespeichert (bis 20 MB je Datei, Text bis 200 kB); andere Dateien findet man über den Namen. **Gescannte PDFs** (ohne Textebene) und **Bilder** (png, jpg, tiff) liest das Tool per **Texterkennung (OCR)**, Deutsch und Englisch, höchstens 30 Seiten je Datei; der Auszug trägt den Hinweis „per Texterkennung (OCR)“. OCR braucht Rechenzeit: je Abgleich kommen höchstens 20 Dateien dran, der Rest folgt im nächsten Lauf. Agenten durchsuchen die Dateien des Projekts und lesen Auszüge (KI-Handbuch Kapitel 5); der Projektagent sieht im Durchlauf „Neue Dateien seit letztem Lauf“.
- **Quellen für den Agenten:** Ob KI-Agenten eine Einbindung durchsuchen und lesen dürfen, schaltet die PL unter Einstellungen › KI › „Quellen für den Agenten“ (Standard an); Einstellungen › Dateien zeigt es je Einbindung als Badge „KI: an“/„KI: aus“. Für Menschen ändert sich nichts.

**Bedienschritte**

1. **Quelle der Organisation anlegen (Org-Admin):** Verwaltung › Dateiquellen › „Quelle anlegen“. Name und Adresse eintragen (Freigabelink oder WebDAV-Adresse), beim Konto Benutzer und App-Passwort, beim Freigabelink ggf. dessen Passwort. „Ordner wählen“ öffnet die Ordnerliste der Quelle: Ordner anklicken, „hoch“ oder den Pfad darüber nutzen; der angezeigte Ordner wird Startordner. Projektfreigabe (alle, ausgewählte mit Suche, keine) und persönliche Projekte (gesperrt, alle, bestimmte Personen) festlegen, „Speichern“. „Jetzt synchronisieren“ gleicht sofort ab und meldet Dateien, neu, geändert, entfernt und Textauszüge. Darunter stehen die eigenen Quellen der Projekte zur Ansicht.
2. **Einbinden (PL, auch im persönlichen Projekt):** Projekt › Einstellungen › Dateien › „Freigegebene Quelle einbinden“: Quelle wählen, mit „Ordner wählen“ einen Unterordner bestimmen (oder die ganze Quelle), Anzeigenamen eintragen, „Einbinden“. Alternativ „Eigene Quelle anlegen“ (dieselben Felder wie oben, ohne Freigaben). Nach dem Einbinden gleicht das Tool die Quelle sofort ab. „Entfernen“ löst die Einbindung.
3. **Lesen:** In der Doku-Leiste erscheinen die eingebundenen Ordner unter **Dateien** (auch in der Seitenleiste unter dem Projekt). Ordner anklicken navigiert, der Pfad oben führt zurück. Eine Datei öffnet die Vorschau: PDF und Bilder direkt, Text und Markdown als Textauszug; „Herunterladen“ holt das Original. Das Badge „durchsuchbar“/„nicht durchsuchbar“ zeigt, ob ein Textauszug vorliegt (Grund im Tooltip). Ist die Quelle nicht erreichbar, steht der Fehler über der Liste; angezeigt wird der zuletzt bekannte Stand.

## 8. Besprechungen und Kalender

- **Besprechung** (Doku › Besprechungen, auch in der Leiste unter dem Projekt): Termin, Ort, Agenda, Teilnehmer (Mitglieder, Kontakte, freie Adressen), Zuordnung zu einer Besprechungsreihe.
- **Protokollseite** aus der Vorlage der Reihe; Aktionspunkte direkt als APs mit Zuständigem und Termin.
- **Einladung** mit Kalendereintrag (ICS) über das Projektkonto; Änderungen werden nachgesendet.
- **Vorläufige Termine** (von KI eingetragen) tragen das Kennzeichen „vorläufig“; ein Mitglied bestätigt sie mit „Bestätigen“, vorher keine Einladung und keine Kalenderübernahme.
- **Kalender** je Projekt (Plan › Kalender) und global: Deadlines, Meilensteine, Besprechungen, Belegungen (▭); ICS-Abo und Eintragen in Microsoft 365, Google oder CalDAV (Meine Einstellungen › Kalender).

### Ressourcen

Räume, Geräte, Gerüste, Fahrzeuge, externe Personen wie der Elektriker, Sonstiges. Der **Pool** des Mandanten (Verwaltung › Planung und Board › Ressourcen-Pool; Org-Admin oder Org-Recht „Ressourcen-Pool verwalten“) steht allen Projekten offen, **Projektressourcen** (Einstellungen › Planung und Board) legt jedes Mitglied an, die PL löscht oder deaktiviert sie. Kontakte lassen sich mit „buchbar“ als Person-Ressource führen. Jede Ressource ist eine Einheit; Mengen gibt es nicht.

### Buchen

Ab Mitglied: im Kalender-Modus **Belegung** (Zeilen je Ressource oder Person, Spalten je Tag; vorläufig gestrichelt, Konflikt rot, fremde Projekte nur „belegt“), am Arbeitspaket (Abschnitt „Ressourcen“, ganztägig mit „folgt dem Arbeitspaket“: verschiebt sich das AP, wandert die Belegung mit) oder an der Besprechung (Ressourcen mit Ampel frei / vorläufig / belegt; ein Raum wird zum Ort, eine externe Person zum Teilnehmer; Zeitänderung und Bestätigung der Besprechung gelten auch für die Belegungen). Auch Mitglieder lassen sich einplanen (Meldung „Eingeplant“).

### Konflikte und Abwesenheiten

Eine bestätigte Überschneidung lehnt das System ab und zeigt die Belegungen; wer buchen will, kann stattdessen **vorläufig anfragen** oder, als PL oder mit „Projektplan ändern“, **übersteuern** (wird festgehalten und den Betroffenen gemeldet). Vorläufige Überschneidungen sind erlaubt und werden angezeigt. Indirekte Verschiebungen (Besprechung, AP) blockieren nicht, sondern melden den Konflikt. Pool-Ressourcen mit **Freigabegruppe** bucht nur die Gruppe direkt; alle anderen fragen vorläufig an, die Gruppe bestätigt oder lehnt ab. Vorläufige Belegungen, die in drei Tagen beginnen, erinnern den Ersteller (sonst die PL).

**Abwesenheiten** (Meine Einstellungen › Kalender): Urlaub oder Schulung zählen als belegt, wenn jemand dich einplant oder ein Agent Termine prüft; andere sehen nur „abwesend“. Sperrzeiten einer Ressource setzen Verwaltung bzw. Freigabegruppe (Pool) oder die PL (Projektressource).

**ICS:** das Gesamt-Abo enthält eigene Belegungen und Abwesenheiten, das Projekt-Abo die Belegungen des Projekts; je Ressource gibt es einen eigenen Feed (`/api/ics/<Schlüssel>/ressource/<id>.ics`, für Fremde nur „belegt“). In Einladungen stehen Räume als Ressourcen-Teilnehmer. Wie Agenten buchen: KI-Handbuch Kapitel 8.

## 9. Workflows

- Vorlagen für feste Abläufe (Org-Admin, Projektersteller): Arbeitspaket → Timer → Arbeitspaket → Warten auf Ereignis (Freigabe oder Mail) → Mail.
- Ein Lauf startet isoliert (eigenes Mini-Projekt), unter Workflows im gefilterten Projekt oder im Board über „+ Workflow“. Jeder Schritt löst den nächsten aus; wird ein AP eines Laufs erledigt, folgt der nächste Schritt.
- Der Projektfilter zeigt die Läufe eines Projekts. Schritte an KI-Agenten: KI-Handbuch Kapitel 4.

## 10. Zeiten, Auswertung, Reporting, Risiken

- **Zeiterfassung** (optional je Projekt, mandantenweit abschaltbar): Buchung je AP oder frei, Schätzung, Budget, Auswertung je Person und Teilprojekt, CSV. Mitglieder sehen eigene Buchungen, die PL alle, Leser keine; das gilt auch für die Zeiten im AP.
- **Auswertung:** Durchsatz je Woche, Durchlaufzeit, Verzug nach Alter, Eskalationen, je Teilprojekt; CSV.
- **Reporting** (Einstellungen › Fristen und Berichte): Management-Report aus Blöcken im festen Rhythmus, als Entwurf zur Prüfung oder direkt als PDF an den Empfängerkreis.

**Aufbau des Berichts.** Die PL stellt den Bericht aus Blöcken zusammen, die untereinander im Bericht erscheinen: Gesamtstand (Ampel, Fortschritt Soll/Ist, Kennzahlen), Änderungen im Zeitraum, Überfällig, Blockiert und eskaliert, Meilensteine, Teilprojekte, Risiken und Entscheidungen (RAID), Gebuchte Zeit, Entscheidungen und Meldungen, Ausblick, Management-Summary (KI) und Freitext. Jeder Block hat eine eigene Überschrift und nur die Optionen, die zu ihm passen: Zeitraum (seit dem letzten Bericht, letzte Woche, letzter Monat, letztes Quartal oder n Tage), Diagramm, maximale Einträge, Ausblick-Tage oder Freitext in Markdown. Blöcke lassen sich verschieben, duplizieren und entfernen, auch mit der Tastatur. „Aufbau wählen“ setzt eine Vorlage: Management-Report (Standard), Kurzstatus, Monatsbericht oder Leer.

**Texte und Grafik.** Über den Blöcken stehen zwei Schalter: „Texte“ regelbasiert oder KI (die Projekt-KI formuliert die Management-Summary aus den Zahlen der anderen Blöcke; ohne Agenten mit Berichtsrecht fällt der Bericht auf den Regeltext zurück) und „Grafisch ausarbeiten“ (Diagramme als Vektorgrafik in Seite und PDF; der Schalter je Block greift nur, wenn er an ist).

**Vorschau.** „Vorschau“ zeigt den Bericht mit dem aktuellen, noch nicht gespeicherten Aufbau als Seite im Dialog; „Als PDF“ öffnet dieselbe Fassung als PDF im neuen Tab. Erst „Speichern“ legt den Aufbau in der Policy ab, „Jetzt erzeugen“ speichert und erstellt die Berichtsseite sofort. Wer den Aufbau nicht ändern darf, sieht ihn als eine Zeile zusammengefasst. Berichtsseiten in der Doku behalten ihre Diagramme beim Öffnen und Bearbeiten.

**Portfolio-Report.** Unter Dashboard › Projekte erzeugt „Management-Report“ einen Bericht über alle sichtbaren Projekte oder eine Auswahl: Gesamtübersicht mit Ampel, Fortschritt, Verzug und nächstem Meilenstein, dazu je Projekt die gewählten Zusatzblöcke (Änderungen, Meilensteine, Ausblick, Überfällig, Blockiert, Risiken) im Zeitraum Woche, Monat, Quartal oder n Tage. Vorschau im Dialog, PDF im neuen Tab.
- **Risiken (RAID):** Risiken mit Wahrscheinlichkeit und Auswirkung, Annahmen, Issues und Entscheidungen mit Verantwortlichen und Terminen.

## 11. KI im Projekt

Grundsatz: Regel vor KI. Regeln (Eskalation, Reporting, Erinnerungen) laufen ohne KI; KI macht Vorschläge oder handelt als Agent nur in zugewiesener Arbeit. Die ausführliche Anleitung ist das **KI-Handbuch** (Hilfe › KI-Agenten); hier steht nur, wo was eingestellt wird.

### Einrichtung: vom LLM bis zum Agenten im Projekt

1. **Verwaltung › KI** (Org-Admin oder Org-Recht **KI verwalten**; Personen mit diesem Recht sehen unter Verwaltung nur den Reiter KI) mit den Karten Ablauf in drei Schritten, **LLMs und ihre Agenten** und **Grenzen und Vorgaben** (Notaus, Tagesbudget je Agent, eigenes LLM in Projekten, Online-Recherche). Außenprüfung und Arbeitszeitfenster stehen unter Verwaltung › Mail.
2. **LLM anlegen**, dann **Agenten am LLM anlegen und berechtigen** (Persona, Unterschrift, Tagesbudget, Rechte, Obergrenze): KI-Handbuch Kapitel 2.
3. **Projekt › Einstellungen › KI** (PL): Agent einladen, einschränken, Projektagent setzen, Agenten-Policy, eigenes LLM (wenn der Mandant es erlaubt), Quellen für den Agenten, Deine Rechte.
   - **Quellen für den Agenten:** je **Doku-Ordner** derselbe Agent-Zugriff wie in der Doku (schreiben, nur lesen, kein Zugriff; gilt samt Unterordnern, die strengste Angabe gewinnt), je eingebundenem **Dateiquellen-Ordner** und für die **Mails** des Projekts ein Schalter „für KI-Agenten“ (Standard an). Ausgeschlossenes sieht ein Agent gar nicht: nicht in der Suche, nicht beim Lesen (Seite, Datei, Mail), nicht im Projektdurchlauf und auch keine Titel. Menschen sehen alles wie bisher. Bei Mails gelten zusätzlich die Rechte der Ansichten (Lesen und KI). Ändern darf nur die PL; im persönlichen Projekt steht der Abschnitt in der Karte „Dein Assistent“.

### Prüfung und Notaus

Jede KI-Aktion prüft in dieser Reihenfolge: **Notaus** → **Rechte des Agenten** (Verwalter des LLM) → **Einschränkung im Projekt** (PL) → **LLM** (aktiv, eingesetzt, nicht gesperrt) → **Tagesbudget**. Der **Notaus** (Verwaltung › KI) schaltet jede KI im Mandanten sofort ab und steht im Audit. Personen brauchen für Assistenz und Chat „KI nutzen“ und eine ausdrückliche Mitgliedschaft. Details, übersprungene Läufe und Tagesbudget: KI-Handbuch Kapitel 4.

### KI-Assistenz (Postfach, AP, Einstellungen › KI-Läufe)

- Ausgeführt von einem Agenten des Projekts mit dem passenden Recht: dem Projektagenten, sonst dem einzigen geeigneten; sind es mehrere ohne Projektagent, wählt man ihn neben dem Knopf. Ausgelöst von Personen mit „KI nutzen“; Läufe zählen in das Tagesbudget des Agenten.
- Mail zusammenfassen, Essenz einer Mail als Vorschlag für ein AP oder eine Seite; Vorschläge gibt frei, wer das Recht „Freigeben“ hat (Einstellungen › KI-Läufe › Offene Vorschläge, mit Bearbeitung vor dem Anwenden).
- Frage ans Projekt: Antwort aus APs, Seiten und lesbaren Mails mit Quellenangabe (Stichwortsuche). Fragen dürfen auch Leser mit „KI nutzen“.
- Statusbericht-Entwurf aus Kennzahlen, Risiken und Log.
- **Feedback und KI-Log** (Verwaltung › KI, nur KI-Verwaltung): KI-Handbuch Kapitel 9.

## 12. Mit KI-Agenten arbeiten

Vollständig im **KI-Handbuch**. In Kürze:

1. **Einrichten:** Verwalter des LLM legt den Agenten an (Persona, Unterschrift, Rechte, Obergrenze, Tagesbudget); die PL lädt ihn ein (Mitglied oder stellvertretende PL, „darf Mails senden“) und weist AP, Aufgabe oder Teilprojekt zu. Der erste Lauf startet sofort.
2. **Was er tut:** liest das AP, schreibt Log, setzt Status, hakt Checklistenpunkte ab, plant Aufgaben und Termine (vorläufig), fragt Projektbeteiligte per Chat (offene Frage), Externe per Mail (nur Außenkontext, Außenprüfung), wartet, fasst nach, eskaliert an die PL, beantwortet zum Abschluss die Ursprungsmail. Nie Projekte, Mitglieder, Einstellungen; nie Zusagen.
3. **Steuern:** Agenten-Policy (Selbstständigkeit, Bestätigungen, Denktiefe), Einschränken im Projekt, Pause je AP, Befehle im Chat (Auftrag, note, pause, approve, policy, report, refer).
4. **Kontrollieren:** Projekt › Einstellungen › KI-Läufe, das Log des AP, Postfach › Zur Freigabe, KI-Log und Feedback in der Verwaltung.

**Beispiel:** Teilprojekt „Elektrik“ dem Agenten geben, darin ein AP „Teilprojekt durchplanen, Fragen an die PL“. Der Agent legt Aufgaben mit Terminen an, weist Handwerksarbeit Personen zu, trägt Besichtigungen vorläufig in den Kalender (die PL bestätigt) und klärt Fragen per Chat mit der PL.

## 13. Einstellungen und Verwaltung

Drei Einstellungsseiten mit denselben Reitern in derselben Reihenfolge (Konzept: docs/Konzept-Einstellungen.md): **Meine Einstellungen** (jede Person), **Projekt › Einstellungen** (alle Mitglieder lesen, die PL ändert) und **Verwaltung** (Org-Admin; Org-Rechte sehen ihre Reiter). Jeder Reiter hat eine eigene Adresse. Vererbbare Werte zeigen „erbt: Wert (Ebene)“, Sperren ein 🔒 mit der Ebene, Policies ohne Vorgabe ein „Standard“-Badge mit Zurücksetzen.

| Reiter | Meine Einstellungen | Projekt › Einstellungen | Verwaltung |
| --- | --- | --- | --- |
| Allgemein | Name, Theme, Bestätigungskarten im Chat, Telefonnummer (für Anrufe beim KI-Agenten), angeheftete Projekte | Name, Kürzel, Beschreibung, Sichtbarkeit, Status, Ampel, Zeiterfassung, Budget, „Arbeitspaket automatisch erledigt …“ und „Aufgabe automatisch erledigt, wenn alle Checklistenpunkte erledigt sind“; als Vorlage speichern, archivieren | Firma, Akzentfarbe, Fußzeile (PDF), Module: Zeiterfassung, persönliche Projekte |
| Personen | – | Mitglieder (Personen, Gruppen; Agenten mit LLM und Kurzfassung ihrer Rechte, verwaltet unter KI), Einladungen, Kontakte und Stakeholder (mit „nach außen“), Steckbrief | Benutzer, Einladungen, Gruppen, verantwortliche PL je Projekt |
| Mail | eigene Konten (IMAP, Microsoft 365, Google) | Postfächer des Projekts (Bindung, Standard, neu), Ansichten und Filter (Ordner „KI Bearbeiten“, Agent je Ansicht), Mail-Rückfrage (erbt vom Mandanten), Außenkommunikation, Erinnerungen an Externe | Org-Postfach und zentrale Postfächer, Vorgaben (Mail-Rückfrage, Außenprüfung, Arbeitszeitfenster), Übersicht aller Konten |
| Benachrichtigungen | Chat und Mail je Ereignisklasse, je Projekt abweichen, stummschalten | Regelmatrix mit Sperren, Doku-Seite, „Wer bekommt was?“ | Tages-Digest, Regelmatrix mit Sperren |
| KI | – | Agenten im Projekt (einladen, einschränken), Projektagent mit Mail-Modus, Agenten-Policy, eigenes LLM mit seinen Agenten, Deine Rechte | LLMs und ihre Agenten (anlegen, berechtigen, Obergrenze), Grenzen und Vorgaben (Notaus, Budget, eigenes LLM, Online-Recherche), KI-Log, Feedback |
| Fristen und Berichte | – | Eskalationsregeln, Reporting | – |
| Planung und Board | – | **Planungstiefe** (Aufgabe oder Checklistenpunkt: Automatisch nach Regel, Immer Aufgaben, Immer Checklistenpunkte; verbindlich für KI-Agenten, Leitlinie fürs Team), Teilprojekte, Meilensteine, Spalten, Labels, Ressourcen des Projekts | Ressourcen-Pool, Projektvorlagen, Doku-Vorlagen |
| Telefonie | – | – | Schlüssel, Rufnummern (Projekt, Agent, KI-Profil, Begrüßung), Webhook-URLs, Anruf-Log (`docs/Telefonie.md`) |
| Kalender | Kalender-Abo (ICS), CalDAV, Abwesenheiten | – | – |
| Sicherheit | Passwort, zweiter Faktor (Authenticator-App) | – | Stand von Single Sign-on (OIDC) und OAuth2 |
| Daten | – | CSV-Import, Papierkorb, Audit-Log | Audit-Export |
| KI-Läufe | – | Agenten-Läufe, offene Vorschläge, Mail-KI (nur bei aktiver KI) | – |

- **CSV-Import** (Projekt › Einstellungen › Daten, PL oder „Projektplan ändern“): CSV-Datei wählen (Excel: „CSV UTF-8“; Trennzeichen Semikolon, Komma oder Tab), Spalten zuordnen (Titel, Beschreibung, Teilprojekt, Zuständig per E-Mail oder Name, Start, Deadline, Priorität, Labels, Status, Kennung, Übergeordnet, Ebene, Art), dann zeigt ein **Trockenlauf** jede Zeile mit Art, Bezug und Fehlern bzw. Hinweisen. Die Ebene kommt aus „Art“ (Arbeitspaket, Aufgabe, Checklistenpunkt), „Ebene“ (1, 2, 3 oder Gliederung 1.2.3) oder „Übergeordnet“ (Kennung einer Zeile weiter oben oder eines bestehenden AP wie `WEB-12`); ohne Angabe gehört eine Aufgabe zum AP darüber. Fehlende Teilprojekte und Labels werden angelegt, unbekannte E-Mail-Adressen werden externe Zuständigkeit. „Importieren“ geht erst ohne Fehler und legt alles in einem Schritt an (Transaktion, Audit `project.import`). Der CSV-Export von Board (mit Spalte „Übergeordnet“) und Plan lässt sich so wieder einlesen; Meilenstein-Zeilen des Plans werden übersprungen. „Beispieldatei“ lädt eine Vorlage.
- **Mail-Konten** liegen bei der Ebene, der sie gehören: persönliche unter Meine Einstellungen, Projektpostfächer im Projekt, Org-Postfach und zentrale Postfächer in der Verwaltung (dort auch die Übersicht aller Konten mit Art und Verwalter). Wird eine Person deaktiviert, verschwinden ihre nur persönlich genutzten Konten; Konten mit Projekt- oder Org-Verwendung gehen an das Projekt bzw. die Organisation.
- **Wer legt was fest:** Der Mandant setzt je Feld eine Vorgabe (Projekt darf abweichen), eine Grenze (nur enger) oder eine Sperre (nur lesen). Personen ändern nur ihre Kanäle (Chat, Mail). Arbeitspaket und Agent haben keine eigene Einstellungsseite; ihre Abweichungen (Selbstständigkeit, Denktiefe, Zwischenstände) stehen inline im Arbeitspaket bzw. in der Agentenzeile, mit wirksamem Wert.
- **Verwaltung mit Org-Rechten:** „KI verwalten“ sieht nur den Reiter KI, „Gruppen verwalten“ und Verwalter einer Gruppe nur die Gruppen unter Personen, „Ressourcen-Pool“ nur den Pool unter Planung und Board. Den eigenen Zugang deaktiviert man nicht selbst, der letzte aktive Org-Admin bleibt erhalten.
- **Anmeldung:** Passwort mit optionalem zweiten Faktor oder Single Sign-on (OIDC), falls eingerichtet. Ein TOTP-Code gilt nur einmal; nach fünf falschen Codes neu anmelden. Nach einem Passwort-Reset mit aktivem zweiten Faktor meldest du dich mit neuem Passwort und Code an.

## 14. Persönliches Projekt (Assistent)

Ein persönliches Projekt ist ein normales Projekt (Board, Plan, Doku, Besprechungen, Kalender, Workflows, Zeiten, Agenten, Regeln) mit genau diesen Abweichungen:

1. Anlegen unter Projekte mit „Persönlich“: Projektersteller immer, alle anderen, wenn der Org-Admin es erlaubt (Verwaltung › Allgemein); KI-Agenten nie.
2. Mitglieder: nur der Ersteller (PL) und KI-Agenten; weitere Personen, Gruppen und Einladungen sind gesperrt.
3. Sichtbar nur für Mitglieder („Organisation“ ist nicht wählbar).
4. Der Org-Admin hat keinen Inhaltszugriff, verwaltet die Projektkonten nicht, sieht das Projekt nicht in der Verwaltungsliste, bestimmt keine neue PL und bekommt im Audit-Export Aktion, Person und Zeit, aber keine Details.
5. Postfächer: nur eigene (persönlich gebundene des Eigentümers, Projektkonten dieses Projekts, dazu ausdrücklich vom Org-Admin angebotene Konten); Workflow-Mailschritte fallen nicht auf das Organisationspostfach zurück.
6. KI: eigenes LLM je Mandantenschalter; Org-Profile nur mit Freigabe (siehe unten).
7. Meldungen schreiben keine Systembeiträge in den Projektkanal (der Kanal selbst bleibt für Agenten-Gespräche).
8. Startet leer: keine Standardordner, keine Vorlage.
9. In Org-Sichten (KI-Agenten, KI-Regeln, Audit) heißt es nur „persönlich (Name)“.

- **Nur eigenes oder freigegebenes LLM:** LLMs des Mandanten stehen im persönlichen Projekt nur bereit, wenn der Org-Admin sie dafür freigibt (je LLM „Persönliche Projekte“: nicht, alle, nur ausgewählte Personen; oder Auswahl des Projekts); Agenten der Org laufen dort nur mit einem solchen LLM. Das eigene LLM gilt, wenn der Mandant es erlaubt.
- **Nur eigene Postfächer:** Ansichten, Verknüpfungen, Kopien, APs, Log-Einträge und Doku aus Mails gibt es nur aus deinen persönlichen Konten und dem Projektkonto dieses Projekts. Das Organisationspostfach und Mails aus anderen Projekten bleiben draußen, auch per Plus-Adresse; Entwürfe gehen nicht über das Organisationspostfach. Eine Ansicht auf das Organisationspostfach legt in normalen Projekten nur der Org-Admin an.
- **Freigabe je Person:** Wer per Einladung ohne Projekt ins Tool kommt, bekommt sein persönliches Projekt beim Annehmen der Einladung automatisch (Haken „persönliches Projekt freigeben“ in der Einladung, Standard an; Kürzel aus Initialen plus Nummer, Name „Persönlich – Name“), auch wenn der Mandantenschalter aus ist. Die Verwaltung setzt die Freigabe je Person nachträglich unter Verwaltung › Personen („persönliches Projekt“: freigegeben, gesperrt, nach Mandant): „freigegeben“ legt das Projekt an, falls keines da ist; „gesperrt“ lässt das Projekt stehen, sperrt aber jede KI darin (Assistent und Agenten antworten mit „Persönliche KI für diese Person gesperrt (Verwaltung)“). Der Mandantenschalter „Persönliche Projekte“ bleibt die Vorgabe für alle, die keine eigene Freigabe haben.
- **Schlank:** Ein persönliches Projekt startet mit zwei Spalten („Offen“, „Erledigt“), dem Ordner „Notizen“, Planungstiefe „Immer Checklistenpunkte“ und ohne Eskalation und Reporting. Die Reiter Plan, Risiken, Zeiten und Auswertung sind ausgeblendet, bis du in Projekt › Einstellungen „Alle Bereiche anzeigen“ einschaltest; Teilprojekte, Arbeitspakete, Aufgaben und Checklisten stehen jederzeit vollständig bereit. Erinnerungen sind Aufgaben oder Checklistenpunkte mit Termin („Erinnere mich morgen an …“ legt der Assistent so an).
- **Assistent:** Deinen Assistenten legst du im persönlichen Projekt selbst an (Projekt › Einstellungen › KI › Assistent): Name, Persona und ein LLM, das für dich frei ist (ein vom Org-Admin für persönliche Projekte freigegebenes LLM des Mandanten oder ein eigenes LLM des Projekts). Ohne freies LLM zeigt die Seite den Grund (kein LLM, Notaus, Sperre durch die Verwaltung). Es gibt höchstens einen Assistenten je persönlichem Projekt; er ist dort stellvertretende PL und Projektagent, hat die Standardrechte eines Agenten und das Tagesbudget des Mandanten. Im Chat steht er angepinnt (Kennzeichen „Assistent“; am Desktop öffnet der Chat ihn von selbst). Er arbeitet nur in deinem persönlichen Projekt, lässt sich in kein anderes Projekt einladen, antwortet nur auf Direktnachrichten (Erwähnungen in Projektkanälen ignoriert er) und schreibt Mails nur über deine eigenen Konten. Details: KI-Handbuch Kapitel 2 und 3.
- **Typischer Aufbau:** Assistent anlegen, eigenes Postfach als persönliches Konto, Ansicht ins Projekt, **Ordner „KI Bearbeiten“** einrichten (weitere Agenten gibt es im persönlichen Projekt nicht; der Assistent ist der einzige). Mails in den Ordner legen: Der Agent macht daraus Aufgaben und Termine und übernimmt, was er selbst erledigen kann; zum Abschluss beantwortet er die Ursprungsmail als Entwurf, den du freigibst.

**Bedienung in der Weboberfläche (kurz):**

1. **Einladen** (Verwaltung › Personen › Benutzer einladen): Haken „Persönliches Projekt freigeben (Assistent)“ ist an; offene Einladungen mit diesem Haken tragen das Kennzeichen „persönlich“. Die Annahmeseite kündigt das persönliche Projekt an und öffnet es nach dem Anlegen des Kontos direkt.
2. **Freigabe je Person** (Verwaltung › Personen, Spalte „Persönliches Projekt“): „Mandantenregel“, „frei“ oder „gesperrt“; der Tooltip zeigt die wirksame Regel. Bei „frei“ steht ein Link auf das angelegte Projekt, bei „gesperrt“ erscheint der Hinweis als Meldung.
3. **LLM freigeben** (Verwaltung › KI › LLM bearbeiten): „Für persönliche Projekte“: gesperrt (Standard), alle oder bestimmte Personen (Auswahl mit Suchfeld).
4. **Assistent anlegen** (im persönlichen Projekt: Einstellungen › KI, Karte „Dein Assistent“; das Board weist beim ersten Öffnen darauf hin): Name (vorbelegt „Assistent“), LLM (gekennzeichnet „eigenes LLM“ oder „Mandant“), Persona optional, „Assistent anlegen“. Ohne freies LLM stehen die Gründe da; dann unter Einstellungen › KI › Eigenes LLM ein eigenes LLM eintragen oder den Admin um Freigabe bitten. Danach: „Chat öffnen“, „Bearbeiten“ (Name, LLM, Persona, Tagesbudget), „Pausieren“/„Aktivieren“. In derselben Karte stehen „Selbstständigkeit“ (Policy des Assistenten) und „Eigenes LLM“; Agentenverwaltung, Projektagent-Auswahl und „Deine Rechte“ gibt es im persönlichen Projekt nicht. Agenten aus der Zeit vor dem Assistenten stehen, falls vorhanden, unter „Weitere Agenten“ und lassen sich nur noch entfernen.
5. **Schlank:** Das persönliche Projekt zeigt nur Board, Doku und Einstellungen (dazu „KI“, sobald ein Agent da ist). Einstellungen › Allgemein › „Alle Bereiche anzeigen (Plan, Risiken, Zeiten, Auswertung)“ blendet die übrigen Reiter ein. In der Seitenleiste trägt das Projekt das Kennzeichen „persönlich“.
6. **Chat:** Der Assistent steht im Chat ganz oben unter „Dein Assistent“.
