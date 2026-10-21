# Kurzanleitung

PROject verbindet Arbeitspakete, Plan, Mail, Doku und Chat auf einem Datenmodell. Diese Seite reicht für den Einstieg; Details stehen im Handbuch.

## Begriffe

- **Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task**
- **Arbeitspaket (AP):** ein Ergebnis mit Termin und Zuständigkeit, Kennung wie `WEB-12`.
- **Aufgabe:** zuweisbarer Schritt eines AP mit eigenem Status, Termin und Log.
- **Task:** Punkt der Checkliste eines AP oder einer Aufgabe.
- **Zuständigkeit** wird vererbt: Aufgabe → AP → Teilprojekt → Projektleitung (PL). „Geerbt“ steht dabei.
- **Rollen im Projekt:** PL, Mitglied, Leser; dazu Einzelrechte wie „Projektplan ändern“ oder „Final setzen“.

## Navigation

- **PROject** (oben links) öffnet das **Dashboard**: Meine Arbeit, Projekte, Alle Arbeitspakete. Oben nach einem Projekt filtern, dann zeigt es das Dashboard dieses Projekts.
- Darunter bis zu **fünf angeheftete Projekte** (☆ anheften, ★ lösen); **Alle Projekte** klappt die übrigen aus.
- Ein Klick auf ein Projekt öffnet das **Board**; oben als Reiter Plan, Kalender, Besprechungen, Doku, Risiken, Zeiten, Auswertung, KI und Einstellungen (alle lesen, die PL ändert).
- Was auf dich wartet, steht im Dashboard unter **Offen für dich**; die Zahl zeigt die Leiste bei „PROject“ und je Projekt.
- Global: **Postfach** (alle Postfächer, Filter nach Projekt, „Zur Freigabe“ für KI-Entwürfe), **Kalender** (mit Modus **Belegung** für Ressourcen und Personen), **Workflows**, **Chat**.
- Oben in jeder Seite: Suche (auch nach Kennung wie `WEB-12`) und die Glocke mit Benachrichtigungen.

## Täglich arbeiten

1. **Dashboard › Meine Arbeit** zeigt alles, was dir zugewiesen oder vererbt ist, und was auf dich wartet.
2. **Board:** Karte ziehen oder „→“ auf der Karte = Status ändern (auch am Handy). „+ Arbeitspaket“ in der Spalte bzw. `n` (Titel genügt, dann öffnet die Maske), „⚙ Teilprojekt“ im Swimlane-Kopf konfiguriert das Teilprojekt, „Wartet“ fragt nach Grund und Frist, `f` filtern, `q` nur meine, `x` Filter löschen.
3. **Karte öffnen:** Felder direkt ändern, Aufgaben und Checkliste anlegen, „✓ Erledigt“ oben, Log schreiben (`@Name` erwähnt jemanden).
4. **Blockiert?** „Als blockiert melden“ mit Grund; die Teilprojekt-Verantwortung wird informiert.
5. **Stand festhalten:** jede Entscheidung und Rückmeldung ins Log des AP. Das Log ist die gemeinsame Quelle.

## Kommunikation

- **Intern: Chat.** Knopf unten rechts (mobil: Chat in der Leiste). Projektkanal je Projekt mit Threads, Direktnachrichten mit Personen und KI-Agenten, Suche oben.
- **Extern: Mail** über das Projektkonto. „Stand nachfragen“ im AP schreibt eine vorbelegte Mail; die Antwort landet über die Antwortadresse automatisch im AP.
- **Doku:** Protokolle, Konzepte, Berichte als Seiten. Status Entwurf → In Prüfung → Final; finale Seiten lassen sich als PDF an den Verteiler des Ordners senden.

## Mit KI-Agenten arbeiten

- Ein **Agent** ist ein Benutzer ohne Login. Der Org-Admin legt ihn an (Verwaltung › KI: LLM, Einsatz, Persona, Unterschrift) oder die PL legt einen eigenen für ihr Projekt an (wenn freigegeben). Er läuft nur in Projekten, die sein Einsatz umfasst und in denen sein LLM freigegeben ist. Die PL nimmt ihn als Mitglied oder **stellvertretende PL** auf und macht ihn **zuständig**: für Arbeitspakete, Aufgaben oder ein ganzes Teilprojekt (geerbt).
- Der Agent arbeitet sofort los: Log schreiben, nachfragen, Tasks abhaken, Status setzen, **planen** (Aufgaben und APs mit Terminen anlegen, zuweisen, Termine in den Kalender), warten und nachfassen, an die PL eskalieren. Projekte legt er nie an.
- **Gute Zuweisung:** klares Ziel in der Beschreibung, Termin, Tasks als Checkliste, externe Ansprechpartner als Kontakt.
- **Informieren:** Kommentar ins Log oder Chat an den Agenten. Im Projektkanal mit `@Name`.
- **Kontrolle:** Projekt › KI zeigt jeden Lauf mit Begründung und Aktionen; die PL kann den Agenten je AP pausieren. Mails ohne Senderecht landen als Entwurf in den Freigaben.
- **Externe** erfahren vom Agenten nur, was zu ihrer Aufgabe gehört: Außenbeschreibung des AP, Log-Einträge „für Externe sichtbar“, freigegebene Seiten, externes Profil (Einstellungen › Außenkommunikation). Seine Mails nach außen formuliert das System damit neu und prüft sie; Auffälliges und der erste Kontakt zu einer neuen Adresse warten in Mail › Freigaben.

## Mail und KI

- **Ursprungsmail:** Aus einer Mail entstandene APs merken sich die Mail. Erledigt? „Ursprungsmail beantworten“ im AP schreibt das Ergebnis als Antwort (nicht ins Log).
- **Ordner „KI Bearbeiten“:** Mail dort ablegen (oder „Bearbeiten lassen“ an der Mail): Der Agent legt als stellv. PL AP/Aufgabe, Termin und Antwortentwurf an, weist passend auch Agenten zu und legt die Mail ab („Archiv“ oder „In Arbeit“).
- **Agent betreut eine Ansicht:** Er schlägt für neue Mails Aktionen vor; annehmen mit einem Klick an der Mail oder unter Projekt › KI.
- **Persönliches Projekt:** nur du und KI-Agenten, als Assistent mit eigenem Postfach und KI-Ordner.
