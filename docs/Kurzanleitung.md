# Kurzanleitung

PROject verbindet Arbeitspakete, Plan, Mail, Doku und Chat auf einem Datenmodell. Diese Seite reicht für den Einstieg; Details stehen im Handbuch, alles zu KI-Agenten im KI-Handbuch (Hilfe › KI-Agenten).

## Begriffe

- **Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task**
- **Arbeitspaket (AP):** ein Ergebnis mit Termin und Zuständigkeit, Kennung wie `WEB-12`.
- **Aufgabe:** zuweisbarer Schritt eines AP mit eigenem Status, Termin und Log.
- **Task:** Punkt der Checkliste eines AP oder einer Aufgabe.
- **Zuständigkeit** wird vererbt: Aufgabe → AP → Teilprojekt → Projektleitung (PL). „Geerbt“ steht dabei.
- **Rollen im Projekt:** PL, Mitglied, Leser; dazu Einzelrechte wie „Projektplan ändern“ oder „Final setzen“.

## Glossar

Fachbegriffe und Anglizismen, wie sie in der Oberfläche vorkommen:

- **Außenbeschreibung:** Text am AP, der festlegt, was Externe über dieses AP erfahren dürfen. KI-Agenten schreiben Externen nur daraus, aus Log-Einträgen „für Externe sichtbar“ und aus freigegebenen Seiten.
- **Außenprüfung:** Prüfung jeder Mail eines Agenten an Nicht-Interne. Das System formuliert sie mit dem Außenkontext neu und sucht danach nach Projektinternem (fremde Kennungen, andere APs, interne Adressen, nicht freigegebene Seiten). Funde halten die Mail als Entwurf an (Postfach › Zur Freigabe, „Außenprüfung angehalten“).
- **Digest:** Sammelmail einmal am Tag mit allen Meldungen, die nicht sofort verschickt werden; Uhrzeit setzt der Mandant (Verwaltung › Benachrichtigungen).
- **Drawer:** die seitliche Maske, die sich öffnet, wenn du ein AP, eine Aufgabe oder ein Teilprojekt anklickst. Esc schließt sie.
- **Essenz:** KI-Vorschlag, der den Kern einer Mail als Log-Eintrag ins AP („Essenz → AP“) oder als Abschnitt auf eine Seite („Essenz → Seite“) bringt; angewendet wird er erst nach Freigabe.
- **Grundmenge:** die Aktionen, die ein Agent immer ohne Rückfrage ausführen darf, auch bei „Rückfrage bei allem“: Log, Tasks, Status außer Erledigt, Aufgaben unter dem eigenen AP, Doku-Entwürfe, interner Chat, Fragen, Lesen, Warten, Blockade, Eskalation.
- **Messenger:** der Chat am Desktop als Fenster unten rechts: Suche oben, Gespräche links, Verlauf rechts.
- **Notaus:** Schalter in Verwaltung › KI, der jede KI im Mandanten sofort abschaltet (Agenten, Assistenz, Chat mit Agenten, Verbindungstests). Steht im Audit.
- **Plus-Code:** die Antwortadresse eines AP oder einer Aufgabe (`projekt-x+t<code>@…`). Antworten an diese Adresse landen automatisch im AP.
- **Policy (Agenten-Policy):** Verhaltensregeln für Agenten je Projekt, Agent und AP: Selbstständigkeit (selbstständig, Rückfrage bei wichtigen Schritten, Rückfrage bei allem), Denktiefe, Reichweite, Überschneidungen, Aufträge im Chat. Die tiefste Angabe gilt, lockern kann keine Ebene über die Obergrenze des Agenten.
- **Regel M:** so heißt im Konzept die Regel für die wirksame Mitgliedschaft, wenn jemand direkt und über Gruppen im Projekt ist: ein Direkteintrag überschreibt alle Gruppen, zwischen Gruppen gilt die höchste Rolle, Einzelrechte addieren sich.
- **Stillstand:** ein AP in einer aktiven Spalte, an dem sich länger nichts getan hat (keine Statusänderung, kein Log). Nach der Frist aus den Eskalationsregeln eskaliert es; „Geplant“, „Wartet“ und „Zurückgestellt“ zählen nicht.
- **Swimlane:** waagerechte Zeile im Board je Teilprojekt; „⚙ Teilprojekt“ im Zeilenkopf öffnet das Teilprojekt. Abschaltbar unter Einstellungen › Planung und Board.
- **Thread:** Antworten auf eine Chat-Nachricht, zusammengefasst direkt unter ihr (aufklappen mit „n Antworten“). Fragen der Agenten sind Thread-Wurzeln; wer im Thread antwortet, beantwortet die Frage.
- **Ursprungsmail:** die Mail, aus der ein AP oder eine Aufgabe entstanden ist. Das AP merkt sie sich; „Ursprungsmail beantworten“ schreibt das Ergebnis als Antwort im selben Mailverlauf.
- **WIP-Limit:** Höchstzahl offener APs je Spalte (Work in Progress); darüber färbt sich die Spalte rot.
- **Spaltengruppe:** mehrere Spalten (z. B. Geplant, Wartet, Zurückgestellt als „Nicht in Arbeit“) als eine Board-Spalte mit Abschnitten untereinander; einstellbar unter Einstellungen › Planung und Board › Spalten bearbeiten.
- **Workflow:** mandantenweite Vorlage für feste Abläufe (AP → Timer → AP → Warten auf Freigabe oder Mail → Mail). Ein Lauf startet isoliert oder in einem Projekt; jeder erledigte Schritt löst den nächsten aus.

## Navigation

- **PROject** (oben links) öffnet das **Dashboard**: Meine Arbeit, Projekte, Alle Arbeitspakete. Oben nach einem Projekt filtern, dann zeigt es das Dashboard dieses Projekts.
- Darunter bis zu **fünf angeheftete Projekte** (☆ anheften, ★ lösen); **Alle Projekte** klappt die übrigen aus.
- Ein Klick auf ein Projekt öffnet das **Board**; darunter zeigt die Leiste die Doku des Projekts (Besprechungen, Ordner, zuletzt geänderte Seiten). Oben als Reiter: **Board, Plan, Doku, Risiken, Zeiten, Auswertung, Einstellungen** (alle lesen, die PL ändert). Der Kalender des Projekts steht unter Plan › Kalender, Besprechungen unter Doku › Besprechungen, die KI-Läufe unter Einstellungen › KI-Läufe.
- Was auf dich wartet, steht im Dashboard unter **Offen für dich**; die Zahl zeigt die Leiste bei „PROject“ und je Projekt.
- Global: **Chat**, **Postfach** (alle Postfächer, Filter nach Projekt, „Zur Freigabe“ für KI-Entwürfe), **Kalender** (mit Modus **Belegung** für Ressourcen und Personen), **Workflows**; unter Einstellungen **Meine Einstellungen** und (für Org-Admins und Org-Rechte) **Verwaltung**.
- Oben in jeder Seite: Suche (auch nach Kennung wie `WEB-12`) und die Glocke mit Benachrichtigungen. Unten links: Abmelden, Tutorial, Hilfe.

## Täglich arbeiten

1. **Dashboard › Meine Arbeit** zeigt alles, was dir zugewiesen oder vererbt ist, und was auf dich wartet.
2. **Board:** Karte ziehen oder „→“ auf der Karte = Status ändern (auch am Handy). „+ Arbeitspaket“ in der Spalte bzw. `n` (Titel genügt, dann öffnet die Maske), „⚙ Teilprojekt“ im Swimlane-Kopf konfiguriert das Teilprojekt, „Wartet“ fragt nach Grund und Frist, `f` filtern, `q` nur meine, `x` Filter löschen.
3. **Karte öffnen:** Felder direkt ändern, Aufgaben und Checkliste anlegen, „✓ Erledigt“ oben, Log schreiben (`@Name` erwähnt jemanden).
4. **Blockiert?** „Als blockiert melden“ mit Grund; die Teilprojekt-Verantwortung wird informiert.
5. **Stand festhalten:** jede Entscheidung und Rückmeldung ins Log des AP. Das Log ist die gemeinsame Quelle.

## Kommunikation

- **Intern: Chat.** Knopf unten rechts oder „Chat“ in der Leiste (mobil als Seite). Projektkanal je Projekt mit Threads direkt unter der Nachricht, Direktnachrichten mit Personen und KI-Agenten, Suche oben. Gespräche lassen sich archivieren; sie kommen mit der nächsten Nachricht zurück.
- **Extern: Mail** über das Projektkonto. „Stand nachfragen“ im AP schreibt eine vorbelegte Mail; die Antwort landet über die Antwortadresse (Plus-Code) automatisch im AP.
- **Doku:** Protokolle, Konzepte, Berichte als Seiten. Status Entwurf → In Prüfung → Final; finale Seiten lassen sich als PDF an den Verteiler des Ordners senden.
- **Management-Report:** Die PL stellt den Bericht unter Einstellungen › Fristen und Berichte aus Blöcken zusammen (Vorlage wählen, Vorschau, PDF); über alle Projekte gibt es ihn unter Dashboard › Projekte › „Management-Report“.

## Mit KI-Agenten arbeiten

Ausführlich im KI-Handbuch (Hilfe › KI-Agenten). Kurz:

- Ein **Agent** ist ein Benutzer ohne Login. Der Verwalter seines LLM legt ihn an (Verwaltung › KI; oder die PL beim eigenen LLM ihres Projekts). Die PL nimmt ihn als Mitglied oder **stellvertretende PL** auf (Projekt › Einstellungen › KI) und macht ihn **zuständig**: für Arbeitspakete, Aufgaben oder ein ganzes Teilprojekt (geerbt).
- Der Agent arbeitet sofort los: Log schreiben, nachfragen, Tasks abhaken, Status setzen, **planen** (Aufgaben und APs mit Terminen anlegen, zuweisen, Termine vorläufig in den Kalender), warten und nachfassen, an die PL eskalieren. Projekte legt er nie an, Termine sagt er nie selbst zu.
- **Gute Zuweisung:** klares Ziel in der Beschreibung, Termin, Tasks als Checkliste, externe Ansprechpartner als Kontakt.
- **Informieren:** Kommentar ins Log oder Chat an den Agenten. Im Projektkanal mit `@Name`.
- **Kontrolle:** Projekt › Einstellungen › KI-Läufe zeigt jeden Lauf mit Begründung und Aktionen; die PL kann den Agenten je AP pausieren. Mails ohne Senderecht landen als Entwurf unter Postfach › Zur Freigabe.
- **Externe** erfahren vom Agenten nur, was zu ihrer Aufgabe gehört (Außenbeschreibung, Log „für Externe sichtbar“, freigegebene Seiten, externes Profil); jede Mail nach außen durchläuft die Außenprüfung.
- **Mail und KI:** Aus einer Mail entstandene APs merken sich die **Ursprungsmail**; eine Mail im Ordner **„KI Bearbeiten“** (oder „Bearbeiten lassen“ an der Mail) bearbeitet der Agent sofort. **Persönliches Projekt:** nur du und KI-Agenten, als Assistent mit eigenem Postfach und KI-Ordner; sein Gespräch ist im Chat angepinnt.
