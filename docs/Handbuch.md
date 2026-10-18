# Handbuch

Vollständige Anleitung für alle Benutzer von PROject, einschließlich der Arbeit mit KI-Agenten. Für den schnellen Einstieg reicht die Kurzanleitung.

## 1. Grundbegriffe

**Struktur:** Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task.

- **Arbeitspaket (AP):** ein Ergebnis mit Termin, Priorität und Zuständigkeit. Jedes AP hat eine Kennung aus Projektkürzel und Nummer (`WEB-12`), ein Log, Anhänge, verknüpfte Mails und eine eigene Antwortadresse für Mails.
- **Aufgabe:** zuweisbarer Schritt eines AP (entspricht dem Vorgang nach DIN 69901). Sie hat eigenen Status, Termine, Log, Antwortadresse und kann einem KI-Agenten zugewiesen werden. Aufgaben haben keine weiteren Aufgaben. Das Teilprojekt folgt immer dem AP.
- **Task:** Punkt der Checkliste eines AP oder einer Aufgabe, optional mit eigener Zuständigkeit (auch extern per Mail-Adresse).
- **Teilprojekt:** Gruppe von APs mit Verantwortlichem und Zeitraum; kann eingeschränkt sichtbar sein (nur PL, Verantwortliche, benannte Benutzer und Gruppen).
- **Meilenstein:** Termin im Plan, optional einem Teilprojekt zugeordnet.

**Zuständigkeit:** ausdrücklich gesetzt oder geerbt in der Reihenfolge Aufgabe → AP → Teilprojekt → Projektleitung. Geerbte Zuständigkeit ist überall als „geerbt“ markiert. Zuständig sein können Mitglieder, KI-Agenten (nur durch die PL) und externe Kontakte per Mail-Adresse.

**Rollen im Projekt:** Projektleitung (PL, optional zweite PL als Stellvertretung), Mitglied, Leser. Einzelrechte: Projektplan ändern, Freigeben, Final setzen, KI nutzen, KI-Vorschläge freigeben. Mandantenweit gibt es Org-Admins und Projektersteller. Org-Admins sehen Projektinhalte nur, wenn sie Mitglied sind.

## 2. Navigation

- **PROject** oben links öffnet das Dashboard.
- **Angeheftete Projekte:** bis zu fünf, mit ☆ anheften und ★ lösen (Benutzereinstellung). Ohne eigene Auswahl stehen dort die ersten fünf Projekte.
- **Alle Projekte** klappt die übrigen Projekte aus; dort auch die Projektübersicht mit „Neues Projekt“ (Org-Admin, Projektersteller).
- **Im Projekt:** Arbeitspakete (Board, Plan, Kalender, Besprechungen, Zeiten, Auswertung), Postfach, Doku, Risiken, KI, Einstellungen (nur PL).
- **Global:** Postfach (alle Mail-Ansichten mit Leserecht), Kalender (alle Projekte), Workflows, Chat.
- **Kopfzeile:** Suche über APs, Seiten und Mails (auch nach Kennung), Glocke mit Benachrichtigungen.
- **Tutorial** und **Hilfe** unten links.

## 3. Dashboard

Das Dashboard gibt es nur global; oben lässt es sich nach einem Projekt filtern.

- **Meine Arbeit:** offene, überfällige und bald fällige APs und Aufgaben, Blockaden und Eskalationen, Soll/Ist je Projekt, nächste Termine, was auf dich wartet (Mail-Entwürfe zur Freigabe, Seiten in Prüfung), Meldungen. Darunter die geklammerte Sicht Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task mit allem, was dir zugewiesen oder vererbt ist. Tasks lassen sich dort direkt abhaken.
- **Projekte:** alle Projekte mit Ampel (von der PL gesetzt oder berechnet), Fortschritt, Verzug, Blockaden, roten Risiken, nächstem Meilenstein, Budget; Auslastung je Person und gebuchte Zeiten über Projekte (CSV).
- **Alle Arbeitspakete:** Liste über alle Projekte mit Filtern (nur meine, überfällig, fällig in 7 Tagen, blockiert/eskaliert/Konflikt, ohne Termin).
- **Mit Projektfilter** zeigt „Meine Arbeit“ das Projekt-Dashboard: Kennzahlen, Fortschritt je Teilprojekt, Überfälliges, Konflikte, Meilensteine, Auslastung, Risiken, offene Freigaben, Aktivität, danach die eigene Arbeit im Projekt.

## 4. Projekte und Planung

- **Neues Projekt:** Kürzel, Name, Beschreibung, optional eine Vorlage (Spalten, Teilprojekte, Meilensteine, Labels, Doku-Ordner, Termine relativ zum Projektstart). Wer anlegt, wird PL.
- **Einstellungen (PL):** Allgemein (Name, Beschreibung, Sichtbarkeit), Mitglieder (Rollen, Rechte, Einladungen), Kontakte (externe Ansprechpartner), Planung (Teilprojekte, Meilensteine), Board (Spalten, WIP-Limits, Labels), Projekt (Ampel, Zeiterfassung, Budget, Projekt-KI, als Vorlage speichern, archivieren), Eskalation, Reporting, Mail-Ansichten, Papierkorb, Audit-Log.
- **Plan:** Balken von Start bis Deadline, Punkt bei reiner Deadline, Sammelbalken je Teilprojekt, Meilensteine, Abhängigkeiten Ende → Anfang. Aufgaben stehen eingerückt unter ihrem AP. Balken ziehen verschiebt, die rechte Kante ändert die Deadline.
- **Konflikte** (Deadline nach Teilprojekt-Ende, Start vor Ende des Vorgängers) werden markiert; nichts verschiebt sich automatisch. „Nachfolger verschieben“ zeigt eine Vorschau und informiert die Betroffenen.
- **Termine ändern** dürfen die PL, wer „Projektplan ändern“ hat, und die zuständige Person.

## 5. Arbeitspakete, Aufgaben und Tasks

**Board**
- Spaltenarten: Geplant, aktive Spalten (z. B. Offen, In Arbeit, In Prüfung), Zurückgestellt, Erledigt. Nur aktive Spalten zählen als Stillstand für die Eskalation.
- Swimlanes je Teilprojekt (abschaltbar), Spalten einklappen, WIP-Limit je Spalte.
- Filter: Text, Person, Label, Priorität, nur meine, überfällig, Konflikte, blockiert/eskaliert, Archiv. Personenfilter treffen ein AP auch über seine offenen Aufgaben.
- Tastatur: `n` neues AP, `f` filtern, `q` nur meine, `x` Filter löschen, `Esc` Auswahl aufheben.
- „Auswählen“ (oder Strg/Cmd+Klick) für Sammelaktionen. Erledigte einer Spalte lassen sich gesammelt archivieren.
- Karten zeigen Fälligkeit (farbig), Labels, Aufgaben erledigt/gesamt (▤), Checkliste (☑), Kommentare, Anhänge, Mails.

**Arbeitspaket öffnen**
- Alle Felder direkt editierbar: Status, Teilprojekt, Zuständig (Mitglied, Agent, externer Kontakt), Priorität, Labels, Start, Deadline, Schätzung, Beschreibung (Markdown).
- **Aufgaben:** neue Aufgabe mit Titel und optional Zuständigem; Häkchen setzt auf Erledigt bzw. zurück. Klick öffnet die Aufgabe mit allen Feldern und eigenem Log.
- **Tasks:** Checkliste mit eigener Zuständigkeit; bei externer Zuständigkeit „Nachfragen“ per Mail, die Antwort erscheint beim Task.
- **Vorgänger** (Ende → Anfang) und **Wiederholung** (täglich, wöchentlich, monatlich, n-ter Wochentag; nächste Instanz nach Erledigung oder vor Fälligkeit).
- **Blockiert melden** mit Grund; **eskalieren** eine Stufe höher (Zuständige, Teilprojekt-Verantwortliche, PL); die PL setzt Eskalationen zurück.
- **Mails:** „Mail aus Arbeitspaket schreiben“, „Stand nachfragen“; Antworten an die Antwortadresse landen automatisch im AP.
- **Log und Kommentare:** `@Name` benachrichtigt die Person. Systemeinträge (Status, Eskalation, Agent, Mail) stehen im selben Log.
- **Kopieren / Verschieben** (auch in andere Projekte, wählbar was mitgeht; Aufgaben gehen beim Verschieben immer mit), **Archivieren**, **Löschen** (PL; Papierkorb 30 Tage, Aufgaben gehen mit).

**Eskalationsregelwerk** (Einstellungen › Eskalation): Verzug, Stillstand und Blockaden eskalieren automatisch entlang Zuständig → Teilprojekt-Verantwortung → PL → Eskalationskontakt. Kritikalität (Priorität, Nachfolger, naher Meilenstein, Blockade) halbiert die Fristen. Jede Stufe erzeugt Benachrichtigung und Log-Eintrag.

## 6. Kommunikation: Chat und Mail

**Grundregel:** Zwischen Projektbeteiligten wird gechattet, nach außen gemailt. Was für ein AP gilt, gehört zusätzlich ins Log des AP.

**Chat**
- Desktop: Knopf unten rechts oder „Chat“ in der Leiste öffnet den Messenger. Oben die Suche über Gespräche und Nachrichten, links alle Gespräche nach letzter Aktivität, rechts der Verlauf. Mobil öffnet sich der Chat als Seite.
- **Projektkanal** je Projekt für alle Mitglieder, Antworten als Thread, `@Name` benachrichtigt. Die PL kann Nachrichten löschen.
- **Direktnachrichten** mit jeder Person des Mandanten und mit KI-Agenten („+ Neu“).

**Mail**
- Konten: persönlich, Projektkonto oder Organisationskonto (Konfiguration). Geteilt werden nie ganze Konten, sondern **Ansichten** mit Filtern (Ordner, Absender/Domain, Empfänger, Betreff, Stichwort, ab Datum). Gespeichert werden nur Treffer.
- Rechte je Ansicht: Lesen, Entwurf, Senden, KI, Aufgabe erzeugen. Aus persönlichen Konten sendet nur der Eigentümer.
- Aktionen an einer Mail: mit AP verknüpfen oder kopieren, ins Log übernehmen, AP anpassen (Mail als Beleg), AP erstellen, in Doku ablegen oder an eine Seite anhängen.
- Entwürfe ohne Senderecht gehen in die **Freigaben** des Projekts; die PL sendet sie.
- Postfach mit Ordnern (Posteingang, Gesendet, Archiv, Papierkorb, Unterordner), synchron mit dem Mailserver.

## 7. Doku

- Ordner mit Verteiler, Seitenbaum mit Unterseiten. Eine Seite kann Oberseite sein (Besprechungsreihe, Teilprojekt, Berichte) und gibt Vorlage, Teilnehmer und PDF-Layout an ihre Unterseiten weiter.
- Editor mit Überschriften, Listen, Tabellen, Bildern, Links. Jede Änderung erzeugt eine Version; veraltete Stände werden nicht überschrieben.
- **Status:** Entwurf → In Prüfung → Final. Final sperrt die Seite. Finale Seiten lassen sich als PDF an den Verteiler des Ordners senden; die PDF wird an der Seite abgelegt.
- **Vorlagen:** Besprechungsprotokoll, Statusbericht, Konzept, RAID-Log, Änderungsantrag, Kickoff, Lessons Learned (Vorlagen-Editor in der Verwaltung).
- **Freigabe per Link** an eine Mail-Adresse, lesend oder schreibend, mit Ablauf und widerrufbar; externe Änderungen werden versioniert und gemeldet.
- Faustregel: Was länger gilt als ein Log-Eintrag (Protokoll, Konzept, Entscheidung), gehört auf eine Seite; ins Log kommt die Kurzfassung.

## 8. Besprechungen und Kalender

- **Besprechung** (Arbeitspakete › Besprechungen): Termin, Ort, Agenda, Teilnehmer (Mitglieder, Kontakte, freie Adressen), Zuordnung zu einer Besprechungsreihe.
- **Protokollseite** aus der Vorlage der Reihe; Aktionspunkte direkt als APs mit Zuständigem und Termin.
- **Einladung** mit Kalendereintrag (ICS) über das Projektkonto; Änderungen werden nachgesendet.
- **Kalender** je Projekt und global: Deadlines, Meilensteine, Besprechungen; ICS-Abo und Eintragen in Microsoft 365, Google oder CalDAV (Benutzereinstellungen).

## 9. Workflows

- Vorlagen für feste Abläufe (Org-Admin, Projektersteller): Arbeitspaket → Timer → Arbeitspaket → Warten auf Ereignis (Freigabe oder Mail) → Mail.
- Ein Lauf startet isoliert (eigenes Mini-Projekt), unter Workflows im gefilterten Projekt oder im Board über „+ Workflow“. Jeder Schritt löst den nächsten aus; wird ein AP eines Laufs erledigt, folgt der nächste Schritt.
- Der Projektfilter zeigt die Läufe eines Projekts.

## 10. Zeiten, Auswertung, Reporting, Risiken

- **Zeiterfassung** (optional je Projekt, mandantenweit abschaltbar): Buchung je AP oder frei, Schätzung, Budget, Auswertung je Person und Teilprojekt, CSV. Mitglieder sehen eigene Buchungen, die PL alle.
- **Auswertung:** Durchsatz je Woche, Durchlaufzeit, Verzug nach Alter, Eskalationen, je Teilprojekt; CSV.
- **Reporting** (Einstellungen › Reporting): Statusbericht aus Vorlage im festen Rhythmus, mit Kennzahlen, als Entwurf zur Prüfung oder direkt als PDF an den Empfängerkreis.
- **Risiken (RAID):** Risiken mit Wahrscheinlichkeit und Auswirkung, Annahmen, Issues und Entscheidungen mit Verantwortlichen und Terminen.

## 11. KI im Projekt

Grundsatz: Regel vor KI. Regeln (Eskalation, Reporting, Erinnerungen) laufen ohne KI; KI macht Vorschläge oder handelt als Agent nur in zugewiesener Arbeit.

**Einrichtung (Org-Admin, Verwaltung › KI-Profile)**
- Ein **KI-Profil** ist eine KI: lokales LLM mit OpenAI-kompatibler API (vLLM, Ollama, LM Studio, llama.cpp) oder Anthropic.
- **Denkmodus aus** (nur lokal): für Modelle mit Thinking wie Qwen. Schneller, weniger Token, keine abgeschnittenen Antworten.
- **Tagesbudget** je Agent (Läufe pro Tag) und Standardprofil für neue Agenten.
- Projekte bekommen ihr Profil für die Projekt-KI in den Projekteinstellungen (PL); ohne Profil ist die KI dort aus.

**Projekt-KI (Projekt › KI und Postfach)**
- Mail zusammenfassen, Essenz einer Mail als Vorschlag für ein AP oder eine Seite; Vorschläge gibt frei, wer „KI-Vorschläge freigeben“ hat.
- Frage ans Projekt: Antwort aus APs, Seiten und lesbaren Mails mit Quellenangabe (Stichwortsuche).
- Statusbericht-Entwurf aus Kennzahlen, Risiken und Log.

## 12. Mit KI-Agenten arbeiten

**Was ein Agent ist:** ein Benutzer ohne Login, nie PL oder Org-Admin, im Projekt Mitglied mit Stellvertretung. Er arbeitet nur an APs und Aufgaben, die ihm die PL direkt zuweist, und nur im Rahmen seiner Rechte.

**Einrichten**
1. Org-Admin: Verwaltung › KI-Agenten › Agent anlegen. KI-Profil wählen (sonst Standard), **Persona** als eine Zeile Schreibstil (z. B. „freundlich, knapp, duzt das Team, siezt Externe“), **Denkmodus** wie Profil, aus oder an.
2. PL: Projekteinstellungen › Mitglieder › Agent aufnehmen; „darf Mails senden“ festlegen (sonst gehen Mails als Entwurf in die Freigabe), optional „Final setzen“.
3. PL: AP oder Aufgabe dem Agenten zuweisen. Der erste Lauf startet sofort.

**Was der Agent tut**
- Liest das AP mit Beschreibung, Aufgaben, Tasks, Log, Mails, Doku-Seitenliste und Mitgliedern.
- Handelt: Log schreiben, Status setzen, Tasks abhaken, ergänzen oder umformulieren, Mails schreiben (höchstens drei je Lauf), Doku-Seiten lesen, anlegen, ändern und als PDF senden, Blockade melden, an die PL eskalieren.
- **Wartet** auf Rückmeldung, Termin, Erledigung durch andere oder Information und setzt sich dafür eine Wiedervorlage. Bei Rückmeldungen fasst er nach Frist nach und eskaliert danach an die PL. Der Hintergrunddienst prüft das jede Minute.
- Läuft erneut bei neuem Kommentar, neuer Mail, Änderungen durch Menschen, Wiedervorlage, naher Fälligkeit und spätestens alle drei Tage.
- Ändert nie Termine, erfindet keine Fakten, pflegt keine Risiken, Zeiten oder Einstellungen.

**Mit dem Agenten sprechen**
- Kommentar ins Log des AP: Der Agent liest ihn beim nächsten Lauf (sofort angestoßen).
- Chat: Direktnachricht an den Agenten oder `@Name` im Projektkanal; er antwortet im Thread. Auskunft gibt er nur über eigene APs, die die fragende Person sehen darf. Informationen zu einem AP schreibt er dort ins Log.

**Gute Arbeitspakete für Agenten**
- Ziel und Ergebnis in der Beschreibung („Angebot bis 30.10. freigegeben, Lizenzfrage geklärt“), nicht nur ein Stichwort.
- Termin setzen; Tasks als überprüfbare Schritte.
- Externe Ansprechpartner als Projektkontakt mit Mail-Adresse; das Projektkonto muss angebunden sein.
- Klare Grenzen: was der Agent nicht entscheiden soll, gehört in die Beschreibung („Preise nur nach Rücksprache mit der PL“).
- Ein Agent je Thema; große Pakete in Aufgaben teilen und die Aufgaben zuweisen.

**Kontrolle**
- Projekt › KI › Agenten-Läufe: jeder Lauf mit Anlass, Begründung, Aktionen, Token und Fehlern.
- Im AP: „Jetzt laufen lassen“, „Agent pausieren“ (PL), Wartezustand mit nächster Prüfung, Nachfassen und Eskalation.
- Freigaben: Mail-Entwürfe des Agenten ohne Senderecht.
- Audit-Log und Tagesbudget begrenzen und belegen alles.

## 13. Einstellungen und Verwaltung

- **Benutzereinstellungen:** Name, Theme, Sprache, Mail-Benachrichtigungen (aus, sofort, täglich), Passwort, zweiter Faktor (Authenticator-App), Kalender-Abo und Kalender schreiben.
- **Konfiguration:** Mail-Konten (persönlich, Projekt, Organisation; Microsoft 365 und Google per OAuth).
- **Verwaltung (Org-Admin):** Benutzer einladen und deaktivieren, Gruppen, PDF-Stil, Module (Zeiterfassung), KI-Profile, KI-Agenten, Projekt- und Doku-Vorlagen, Audit-Export.
- **Anmeldung:** Passwort mit optionalem zweiten Faktor oder Single Sign-on (OIDC), falls eingerichtet.
