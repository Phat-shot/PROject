# Handbuch

Vollständige Anleitung für alle Benutzer von PROject. Für den schnellen Einstieg reicht die Kurzanleitung (mit Glossar); alles zu KI-Agenten steht ausführlich im KI-Handbuch (Hilfe › KI-Agenten), auf das die Kapitel 11 und 12 verweisen. Installation und Betrieb: `docs/Betrieb.md`.

## 1. Grundbegriffe

**Struktur:** Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task.

- **Arbeitspaket (AP):** ein Ergebnis mit Termin, Priorität und Zuständigkeit. Jedes AP hat eine Kennung aus Projektkürzel und Nummer (`WEB-12`), ein Log, Anhänge, verknüpfte Mails und eine eigene Antwortadresse für Mails.
- **Aufgabe:** zuweisbarer Schritt eines AP (entspricht dem Vorgang nach DIN 69901). Sie hat eigenen Status, Termine, Log, Antwortadresse und kann einem KI-Agenten zugewiesen werden. Aufgaben haben keine weiteren Aufgaben. Das Teilprojekt folgt immer dem AP.
- **Task:** Punkt der Checkliste eines AP oder einer Aufgabe, optional mit eigener Zuständigkeit (auch extern per Mail-Adresse).
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

Ein eingeschränktes Teilprojekt sehen nur PL, Verantwortliche, benannte Benutzer und Gruppen. Das gilt für alles am AP: Log, Tasks, Anhänge, Zeiten, Kopien von Mails, Verschieben, Kopieren und Eskalieren, dazu Agentenläufe, KI-Vorschläge, Aktionspunkte von Besprechungen, Mail-Entwürfe und RAID-Einträge zum AP, Meilensteine, Übersicht, Warnungen sowie Kopieren und Verschieben des ganzen Teilprojekts. Kopien von Mails im AP lesen nur ausdrückliche Mitglieder (direkt oder über Gruppe), nicht die impliziten Leser eines für alle sichtbaren Projekts.

## 2. Navigation

- **PROject** oben links öffnet das Dashboard.
- **Angeheftete Projekte:** bis zu fünf, mit ☆ anheften und ★ lösen (Benutzereinstellung). Ohne eigene Auswahl stehen dort die ersten fünf Projekte.
- **Alle Projekte** klappt die übrigen Projekte aus; dort auch die Projektübersicht mit „Neues Projekt“ (Org-Admin, Projektersteller).
- **Im Projekt:** Ein Klick in der Leiste öffnet das Board. Unter dem geöffneten Projekt zeigt die Leiste die **Doku** des Projekts als Untermenü: Besprechungen, die Ordner (öffnen ihre Ordnerseite) und die zuletzt geänderten Seiten.
- **Reiter im Projekt:** Board, Plan, Doku, Risiken, Zeiten, Auswertung, Einstellungen. Der Kalender des Projekts liegt unter Plan › Kalender, Besprechungen unter Doku › Besprechungen, die KI-Läufe mit offenen Vorschlägen unter Einstellungen › KI-Läufe (nur bei aktiver KI). Alte Adressen leiten weiter. Mails gibt es nur im globalen Postfach (mit Projektfilter).
- **Offen für dich** (Dashboard › Meine Arbeit, unter den Kennzahlen): Fragen, Entscheidungen, Bestätigungen, KI-Vorschläge, Vorschläge der Mail-KI, Mail-Entwürfe zur Freigabe, Seiten in Prüfung, blockierte und eskalierte Arbeitspakete. Die Anzahl steht in der Leiste bei „PROject“ und je Projekt.
- **Global:** Chat, Postfach (vereinigte Sicht aller Postfächer mit Leserecht, jede Mail einmal, Filter nach Postfach und Projekt, oben „Zur Freigabe“ mit den Entwürfen der KI-Agenten; gelesen und Ordner gelten überall gleich; Ansichten pflegt die PL in den Projekteinstellungen), Kalender (alle Projekte), Workflows. Unter „Einstellungen“: Meine Einstellungen und, für Org-Admins und Personen mit Org-Rechten, Verwaltung.
- **Kopfzeile:** Suche über APs, Seiten und Mails (auch nach Kennung), Glocke mit Benachrichtigungen; der Reiter „Offen für dich“ in der Glocke zeigt dieselbe Liste wie das Dashboard. Ein Klick auf eine Meldung öffnet das Ziel und markiert sie als gelesen. Kennungen wie WEB-12 sind im Chat Links aufs AP. KI-Agenten und deaktivierte Benutzer bekommen keine Meldungen.
- **Unten links:** Abmelden, **Tutorial** (jederzeit neu startbar) und **Hilfe** (Kurzanleitung, Handbuch, KI-Agenten, KI-Sheet), dazu die Build-Version.

## 3. Dashboard

Das Dashboard gibt es nur global; oben lässt es sich nach einem Projekt filtern.

- **Meine Arbeit:** offene, überfällige und bald fällige APs und Aufgaben, Blockaden und Eskalationen, Soll/Ist je Projekt, nächste Termine, was auf dich wartet (Mail-Entwürfe zur Freigabe, Seiten in Prüfung), Meldungen (ein Klick öffnet das Ziel und markiert sie als gelesen, wie in der Glocke).
- **Geklammerte Sicht** darunter: Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task mit allem, was dir zugewiesen oder vererbt ist. Tasks lassen sich dort direkt abhaken.
- **Projekte:** alle Projekte mit Ampel (von der PL gesetzt oder berechnet), Fortschritt, Verzug, Blockaden, roten Risiken, nächstem Meilenstein, Budget; Auslastung je Person und gebuchte Zeiten über Projekte (CSV).
- **Alle Arbeitspakete:** Liste über alle Projekte mit Filtern (nur meine, überfällig, fällig in 7 Tagen, blockiert/eskaliert/Konflikt, ohne Termin).
- **Mit Projektfilter** zeigt „Meine Arbeit“ das Projekt-Dashboard: Kennzahlen, Fortschritt je Teilprojekt, Überfälliges, Konflikte, Meilensteine, Auslastung, Risiken, offene Freigaben, Aktivität, danach die eigene Arbeit im Projekt.

## 4. Projekte und Planung

- **Neues Projekt:** Kürzel, Name, Beschreibung, optional eine Vorlage (Spalten, Teilprojekte, Meilensteine, Labels, Doku-Ordner, Termine relativ zum Projektstart). Wer anlegt, wird PL.
- **Einstellungen (PL):** Allgemein (Name, Beschreibung, Sichtbarkeit, Ampel, Zeiterfassung, Budget, als Vorlage speichern, archivieren), Personen (Mitglieder, Gruppen, Einladungen, Kontakte), Mail (Konten, Ansichten, Mail-Rückfrage, Außenkommunikation), Benachrichtigungen, KI (Agenten, Projektagent, Agenten-Policy).
- **Weitere Reiter:** Fristen und Berichte (Eskalation, Reporting), Planung und Board (Teilprojekte, Meilensteine, Spalten, WIP-Limits, Labels, Ressourcen), Daten (Papierkorb, Audit-Log), KI-Läufe (Kapitel 13).
- **Plan:** Balken von Start bis Deadline, Punkt bei reiner Deadline, Sammelbalken je Teilprojekt, Meilensteine, Abhängigkeiten Ende → Anfang. Aufgaben stehen eingerückt unter ihrem AP. Balken ziehen verschiebt, die rechte Kante ändert die Deadline. Unterreiter **Kalender** zeigt Deadlines, Meilensteine, Besprechungen und Belegungen des Projekts.
- **Konflikte** (Deadline nach Teilprojekt-Ende, Start vor Ende des Vorgängers) werden markiert; nichts verschiebt sich automatisch. „Nachfolger verschieben“ zeigt eine Vorschau und informiert die Betroffenen.
- **Termine ändern** dürfen die PL, wer „Projektplan ändern“ hat, und die zuständige Person.

## 5. Arbeitspakete, Aufgaben und Tasks

### Board

- **Spaltenarten:** Geplant, aktive Spalten (z. B. Offen, In Arbeit, In Prüfung), **Wartet**, Zurückgestellt, Erledigt. Nur aktive Spalten zählen als Stillstand für die Eskalation.
- Swimlanes je Teilprojekt (abschaltbar), Spalten einklappen, WIP-Limit je Spalte. Leere Swimlanes sind eingeklappt; „+ Arbeitspaket“ steht nur in der ersten aktiven Spalte.
- **Filter:** Text, Person, Label, Priorität, nur meine, überfällig, Konflikte, blockiert/eskaliert, Archiv. Personenfilter treffen ein AP auch über seine offenen Aufgaben.
- **Tastatur:** `n` neues AP, `f` filtern, `q` nur meine, `x` Filter löschen, `Esc` Auswahl aufheben.
- „Auswählen“ (oder Strg/Cmd+Klick) für Sammelaktionen. Erledigte einer Spalte lassen sich gesammelt archivieren.
- Karten zeigen Fälligkeit (farbig), Labels, Zuständige und den Fortschritt (☑ erledigt/gesamt aus Aufgaben und Checkliste, mit Balken).
- **Status ohne Ziehen:** „→“ auf der Karte öffnet die Spaltenwahl mit „✓ Erledigt“ (geht auch am Handy); im AP steht „✓ Erledigt“ oben. Ziehen bleibt möglich, „Hier ablegen“ erscheint nur beim Ziehen.

### Spalte „Wartet“

Wer ein AP nach „Wartet“ zieht (oder per „→“ bzw. Status setzt), gibt an, worauf und bis wann gewartet wird; die Karte zeigt „⏳ Grund · bis Datum“. Wartet ein KI-Agent (wait), stellt das System das AP selbst dorthin und nach der Antwort zurück in die Spalte davor. Läuft die Frist ohne Lösung ab, wandert das AP nach „Zurückgestellt“, mit Log-Eintrag und Meldung (Klasse Eskalation) an wartende Person, Zuständige, Auftraggeber und PL; kommt die Antwort später, geht es zurück. Bestehende Projekte haben die Spalte vor „Zurückgestellt“ bekommen.

### Anlegen, überall gleich

Knopf klicken, Titel eingeben (Enter), danach öffnet die Maske mit allen Feldern; leer oder Esc legt nichts an. Arbeitspakete: „+ Arbeitspaket“ in jeder Spalte jeder Swimlane (außer Wartet und Erledigt), `n` öffnet das Feld der ersten aktiven Spalte. Aufgaben im AP. Teilprojekte: „+ Teilprojekt“ unter den Swimlanes, in der Liste im Plan und in den Einstellungen. Meilensteine brauchen dazu ein Datum; Checklistenpunkte entstehen inline im AP.

### Teilprojekt-Maske

„⚙ Teilprojekt“ oder Klick auf den Namen im Kopf der Swimlane, auf die Zeile im Plan oder in den Einstellungen. Wie beim AP: Kopf mit Name, Kopieren, Verschieben, Löschen (PL; mit Haken „Auch zugeordnete Arbeitspakete löschen“ gehen sie samt Aufgaben in den Papierkorb, sonst stehen sie unter „Ohne Teilprojekt“); Verantwortlich, Start, Ende; **Beschreibung** (Ziel, Abgrenzung; auch Kontext für die Agenten); Sichtbarkeit (PL); Meilensteine; Arbeitspakete mit Status, Termin und Zuständigen, neues AP direkt im Teilprojekt.

### Arbeitspaket öffnen

- Alle Felder direkt editierbar: Status, Teilprojekt, Zuständig (Mitglied, Agent, externer Kontakt), Priorität, Labels, Start, Deadline, Schätzung, Beschreibung (Markdown).
- **Außenbeschreibung (für Externe):** was Externe zu diesem AP erfahren dürfen; KI-Agenten schreiben Externen nur daraus, aus Log-Einträgen „für Externe sichtbar“ und aus freigegebenen Seiten (KI-Handbuch Kapitel 7). Pflegen PL und „Projektplan ändern“.
- **Aufgaben:** neue Aufgabe mit Titel und optional Zuständigem (danach öffnet ihre Maske, zurück über den Link zum AP); Häkchen setzt auf Erledigt bzw. zurück. Klick öffnet die Aufgabe mit allen Feldern und eigenem Log.
- **Checkliste** (Tasks): Punkte mit eigener Zuständigkeit, neuer Punkt mit Enter; bei externer Zuständigkeit „Nachfragen“ per Mail, die Antwort erscheint beim Task.
- **Vorgänger** (Ende → Anfang) und **Wiederholung** (täglich, wöchentlich, monatlich, n-ter Wochentag; nächste Instanz nach Erledigung oder vor Fälligkeit).
- **Blockiert melden** mit Grund; **eskalieren** eine Stufe höher (Zuständige, Teilprojekt-Verantwortliche, PL); die PL setzt Eskalationen zurück.
- **Mails:** „Mail aus Arbeitspaket schreiben“, „Stand nachfragen“; Antworten an die Antwortadresse (Plus-Code) landen automatisch im AP. Ist das AP aus einer Mail entstanden, steht oben „Entstanden aus Mail von …“ und nach Erledigung „Ursprungsmail beantworten“ (KI-Handbuch Kapitel 3).
- **Log und Kommentare:** `@Name` benachrichtigt die Person. Systemeinträge (Status, Eskalation, Agent, Mail) stehen im selben Log. Das Häkchen **„für Externe sichtbar“** beim Kommentieren macht den Eintrag Teil des Außenkontexts (Kennzeichen am Eintrag). Nachträglich umschalten („für Externe freigeben“ / „nur intern“) dürfen PL und „Projektplan ändern“, bei eigenen Einträgen auch die verfassende Person.
- **Agent am AP:** „Jetzt laufen lassen“, „Agent pausieren“ (PL), Wartezustand, offene Fragen, Freigaben, Quellen, verwandte Arbeitspakete, Ressourcen, Berichtswunsch und Selbstständigkeit je AP (KI-Handbuch Kapitel 4 und 9).
- **Kopieren / Verschieben …** Das Menü „Verschieben …“ hält die Struktur beweglich, alles im selben Projekt mit Log-Eintrag an Quelle und Ziel, Audit und Meldung an die Zuständigen:
  - **Aufgabe:** „In anderes Arbeitspaket …“ (Ziel per Kennung oder Titel suchen; Checkliste, Anhänge, Log und Zeiten gehen mit, das Teilprojekt folgt dem Ziel), „Zum Arbeitspaket machen …“ (eigene Karte in der Spalte des bisherigen AP, Teilprojekt wählbar), „Zu Checklistenpunkt machen“ (nur ohne Zeitbuchungen, verknüpfte Mails und offene Fragen; Log und Kommentare werden als ein Eintrag am AP zusammengefasst, Anhänge und Checkliste wandern dorthin; Status, Termin, Beschreibung und Labels entfallen, mit Rückfrage).
  - **Arbeitspaket:** „Teilprojekt ändern …“ (Aufgaben folgen) und „In anderes Projekt …“ (bisheriger Dialog mit Auswahl, was mitgeht; PL oder „Projektplan ändern“). Auch in der Teilprojekt-Maske steht je AP eine Auswahl des Teilprojekts.
  - **Checklistenpunkt:** Menü je Punkt mit „In Aufgabe umwandeln …“ (Titel, Termin, Zuständigkeit; der Punkt entfällt, Mails dazu bleiben am AP), „Verschieben nach …“ (anderes AP oder andere Aufgabe) und „Löschen“.
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
- **Vorlagen:** Besprechungsprotokoll, Statusbericht, Konzept, RAID-Log, Änderungsantrag, Kickoff, Lessons Learned (Vorlagen-Editor in der Verwaltung).
- **Freigabe per Link** an eine Mail-Adresse, lesend oder schreibend, mit Ablauf und widerrufbar; externe Änderungen werden versioniert und gemeldet.
- **Agentenzugriff je Ordner** (Ordner bearbeiten): schreiben, nur lesen oder kein Zugriff; vererbt an Unterordner.
- Faustregel: Was länger gilt als ein Log-Eintrag (Protokoll, Konzept, Entscheidung), gehört auf eine Seite; ins Log kommt die Kurzfassung.

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
3. **Projekt › Einstellungen › KI** (PL): Agent einladen, einschränken, Projektagent setzen, Agenten-Policy, eigenes LLM (wenn der Mandant es erlaubt), Deine Rechte.

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
2. **Was er tut:** liest das AP, schreibt Log, setzt Status, hakt Tasks ab, plant Aufgaben und Termine (vorläufig), fragt Projektbeteiligte per Chat (offene Frage), Externe per Mail (nur Außenkontext, Außenprüfung), wartet, fasst nach, eskaliert an die PL, beantwortet zum Abschluss die Ursprungsmail. Nie Projekte, Mitglieder, Einstellungen; nie Zusagen.
3. **Steuern:** Agenten-Policy (Selbstständigkeit, Bestätigungen, Denktiefe), Einschränken im Projekt, Pause je AP, Befehle im Chat (Auftrag, note, pause, approve, policy, report, refer).
4. **Kontrollieren:** Projekt › Einstellungen › KI-Läufe, das Log des AP, Postfach › Zur Freigabe, KI-Log und Feedback in der Verwaltung.

**Beispiel:** Teilprojekt „Elektrik“ dem Agenten geben, darin ein AP „Teilprojekt durchplanen, Fragen an die PL“. Der Agent legt Aufgaben mit Terminen an, weist Handwerksarbeit Personen zu, trägt Besichtigungen vorläufig in den Kalender (die PL bestätigt) und klärt Fragen per Chat mit der PL.

## 13. Einstellungen und Verwaltung

Drei Einstellungsseiten mit denselben Reitern in derselben Reihenfolge (Konzept: docs/Konzept-Einstellungen.md): **Meine Einstellungen** (jede Person), **Projekt › Einstellungen** (alle Mitglieder lesen, die PL ändert) und **Verwaltung** (Org-Admin; Org-Rechte sehen ihre Reiter). Jeder Reiter hat eine eigene Adresse. Vererbbare Werte zeigen „erbt: Wert (Ebene)“, Sperren ein 🔒 mit der Ebene, Policies ohne Vorgabe ein „Standard“-Badge mit Zurücksetzen.

| Reiter | Meine Einstellungen | Projekt › Einstellungen | Verwaltung |
| --- | --- | --- | --- |
| Allgemein | Name, Theme, Bestätigungskarten im Chat, Telefonnummer (für Anrufe beim KI-Agenten), angeheftete Projekte | Name, Kürzel, Beschreibung, Sichtbarkeit, Status, Ampel, Zeiterfassung, Budget; als Vorlage speichern, archivieren | Firma, Akzentfarbe, Fußzeile (PDF), Module: Zeiterfassung, persönliche Projekte |
| Personen | – | Mitglieder (Personen, Gruppen; Agenten mit LLM und Kurzfassung ihrer Rechte, verwaltet unter KI), Einladungen, Kontakte und Stakeholder (mit „nach außen“), Steckbrief | Benutzer, Einladungen, Gruppen, verantwortliche PL je Projekt |
| Mail | eigene Konten (IMAP, Microsoft 365, Google) | Postfächer des Projekts (Bindung, Standard, neu), Ansichten und Filter (Ordner „KI Bearbeiten“, Agent je Ansicht), Mail-Rückfrage (erbt vom Mandanten), Außenkommunikation, Erinnerungen an Externe | Org-Postfach und zentrale Postfächer, Vorgaben (Mail-Rückfrage, Außenprüfung, Arbeitszeitfenster), Übersicht aller Konten |
| Benachrichtigungen | Chat und Mail je Ereignisklasse, je Projekt abweichen, stummschalten | Regelmatrix mit Sperren, Doku-Seite, „Wer bekommt was?“ | Tages-Digest, Regelmatrix mit Sperren |
| KI | – | Agenten im Projekt (einladen, einschränken), Projektagent mit Mail-Modus, Agenten-Policy, eigenes LLM mit seinen Agenten, Deine Rechte | LLMs und ihre Agenten (anlegen, berechtigen, Obergrenze), Grenzen und Vorgaben (Notaus, Budget, eigenes LLM, Online-Recherche), KI-Log, Feedback |
| Fristen und Berichte | – | Eskalationsregeln, Reporting | – |
| Planung und Board | – | **Planungstiefe** (Aufgabe oder Checklistenpunkt: Automatisch nach Regel, Immer Aufgaben, Immer Checklistenpunkte; verbindlich für KI-Agenten, Leitlinie fürs Team), Teilprojekte, Meilensteine, Spalten, Labels, Ressourcen des Projekts | Ressourcen-Pool, Projektvorlagen, Doku-Vorlagen |
| Telefonie | – | – | Schlüssel, Rufnummern (Projekt, Agent, KI-Profil, Begrüßung), Webhook-URLs, Anruf-Log (`docs/Telefonie.md`) |
| Kalender | Kalender-Abo (ICS), CalDAV, Abwesenheiten | – | – |
| Sicherheit | Passwort, zweiter Faktor (Authenticator-App) | – | Stand von Single Sign-on (OIDC) und OAuth2 |
| Daten | – | Papierkorb, Audit-Log | Audit-Export |
| KI-Läufe | – | Agenten-Läufe, offene Vorschläge, Mail-KI (nur bei aktiver KI) | – |

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

- **Nur eigenes LLM:** Org-Profile stehen im persönlichen Projekt nur bereit, wenn der Org-Admin sie dafür freigibt („auch in persönlichen Projekten“ oder Auswahl); Agenten der Org laufen dort nur mit einem solchen Profil. Das eigene LLM gilt, wenn der Mandant es erlaubt.
- **Nur eigene Postfächer:** Ansichten, Verknüpfungen, Kopien, APs, Log-Einträge und Doku aus Mails gibt es nur aus deinen persönlichen Konten und dem Projektkonto dieses Projekts. Das Organisationspostfach und Mails aus anderen Projekten bleiben draußen, auch per Plus-Adresse; Entwürfe gehen nicht über das Organisationspostfach. Eine Ansicht auf das Organisationspostfach legt in normalen Projekten nur der Org-Admin an.
- **Assistent:** Der Agent im persönlichen Projekt ist im Chat angepinnt (Kennzeichen „Assistent“; am Desktop öffnet der Chat ihn von selbst). Details: KI-Handbuch Kapitel 2 und 3.
- **Typischer Aufbau:** eigenes Postfach als persönliches Konto, Ansicht ins Projekt, **Ordner „KI Bearbeiten“** einrichten, eigenen Agenten anlegen (oder aufnehmen) und als stellv. PL einsetzen. Mails in den Ordner legen: Der Agent macht daraus Aufgaben und Termine und übernimmt, was er selbst erledigen kann; zum Abschluss beantwortet er die Ursprungsmail als Entwurf, den du freigibst.
