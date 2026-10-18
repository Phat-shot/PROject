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
- Entwürfe ohne Senderecht gehen in die **Freigaben** des Projekts; die PL sendet sie. Entwürfe aus persönlichen Konten sieht und sendet nur der Eigentümer.
- Postfach mit Ordnern (Posteingang, Gesendet, Archiv, Papierkorb, Unterordner), synchron mit dem Mailserver.

**Ursprungsmail**
- Entsteht ein AP oder eine Aufgabe aus einer Mail, ist diese Mail als **Ursprung** markiert (im AP unter Mails umschaltbar). An der Mail stehen die daraus entstandenen APs und Aufgaben, auch aus anderen Projekten, soweit man sie sehen darf; ein Klick springt hin.
- Oben im AP steht „Entstanden aus Mail von …“. Ist das AP erledigt und die Mail noch unbeantwortet, bietet es **„Ursprungsmail beantworten“** an: ein Entwurf mit dem aufbereiteten Ergebnis (erledigte Aufgaben und Tasks, Offenes), optional **„Mit KI formulieren“** (Projekt-KI fasst Ergebnis und Log für den Absender zusammen). Die Antwort geht aus dem Konto der Mail, im selben Mail-Verlauf, hängt danach als Mail am AP und wird kein Log-Eintrag.

**Mail-KI**
- **Ordner „KI Bearbeiten“** (Einstellungen › Mail-Ansichten › Ordner einrichten; Eigentümer eines persönlichen Kontos oder die PL für das Projektkonto, nur mit Projekt-KI): Jede Mail, die du dort ablegst (im Mailprogramm oder hier mit „KI bearbeiten“), bearbeitet die Projekt-KI sofort in deinem Auftrag und mit deinen Rechten: AP oder Aufgabe mit Ursprungsmail und Tasks, Zuweisung (auch an KI-Agenten, die dann sofort loslegen), Termin im Projektkalender (nur wenn nicht schon durch einen Termin des AP abgedeckt), Antwortentwurf, danach Ablage nach „Archiv“ oder „In Arbeit“. Der Inhalt wird als Kopie am AP für die Projektmitglieder sichtbar.
- **Agent betreut eine Ansicht** (Einstellungen › Mail-Ansichten › KI): Für jede neue Mail der Ansicht schlägt der Agent dieselben Aktionen vor; Antworten auf eigene Nachfragen (Antwortadresse) gehen an ihm vorbei. Vorschläge stehen an der Mail und unter Projekt › KI › Mail-KI: einzeln oder alle annehmen oder verwerfen. Ausgeführt wird mit den Rechten der annehmenden Person.
- Jede Mail wird je Projekt einmal bearbeitet; Läufe zählen gegen das Tagesbudget (Projekt-KI je Projekt, Agent je Agent) und stehen im Audit.

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
- **Vorläufige Termine** (von KI eingetragen) tragen das Kennzeichen „vorläufig“; ein Mitglied bestätigt sie mit „Bestätigen“, vorher keine Einladung und keine Kalenderübernahme.
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
- **Freigabe je Profil:** für alle Projekte, für ausgewählte Projekte oder für keins (dann nur für Agenten des Org-Admins). Gilt für normale und persönliche Projekte.
- **Eigenes LLM:** Der Org-Admin erlaubt es nicht, nur in persönlichen Projekten (Standard) oder in allen Projekten. Dann bindet die PL unter Einstellungen › Eigenes LLM ein eigenes LLM nur für ihr Projekt ein (Schlüssel verschlüsselt). Der Org-Admin sieht unter Verwaltung › Eigene LLMs der Projekte Name, Anbieter, Adresse und Verbrauch, nicht Schlüssel oder Inhalte, und kann sperren.
- Die PL wählt die Projekt-KI aus den im Projekt verfügbaren LLMs (Projekteinstellungen); ohne Auswahl ist die KI dort aus. Wird eine Freigabe entzogen oder ein LLM gesperrt, ist die Projekt-KI aus, bis die PL ein anderes wählt.
- Neue Projekte, auch persönliche, haben keinen Agenten. Die PL nimmt Agenten des Org-Admins auf oder legt eigene an; eigene Agenten laufen nur auf den im Projekt verfügbaren LLMs.

**Projekt-KI (Projekt › KI und Postfach)**
- Mail zusammenfassen, Essenz einer Mail als Vorschlag für ein AP oder eine Seite; Vorschläge gibt frei, wer „KI-Vorschläge freigeben“ hat.
- Frage ans Projekt: Antwort aus APs, Seiten und lesbaren Mails mit Quellenangabe (Stichwortsuche).
- Statusbericht-Entwurf aus Kennzahlen, Risiken und Log.

## 12. Mit KI-Agenten arbeiten

**Was ein Agent ist:** ein Benutzer ohne Login, nie verantwortliche PL oder Org-Admin, im Projekt **Mitglied** oder **stellvertretende PL**. Er arbeitet an APs und Aufgaben, für die er zuständig ist: direkt zugewiesen oder geerbt (z. B. als Verantwortung eines Teilprojekts: dann alle APs darin ohne eigene Zuständigkeit, und Aufgaben eines seiner APs). Projekte legt er nie an.

**Einrichten**
1. Org-Admin: Verwaltung › KI-Agenten › Agent anlegen. KI-Profil wählen (sonst Standard), **Persona** als eine Zeile Schreibstil (z. B. „freundlich, knapp, duzt das Team, siezt Externe“), **Denkmodus** wie Profil, aus oder an.
   Oder die PL legt einen **eigenen Agenten** für ihr Projekt an (Einstellungen › Eigene KI-Agenten), wenn der Org-Admin das unter Verwaltung › KI freigegeben hat: nur freigegebene KI-Profile, Tagesbudget höchstens der Deckel, nur in diesem Projekt einsetzbar und per Chat nur für dessen Mitglieder erreichbar. Der Org-Admin sieht solche Agenten und kann sie deaktivieren, aber keine Inhalte.
2. PL: Projekteinstellungen › Mitglieder › Agent aufnehmen, Rolle **Mitglied** oder **stellvertretende PL**; „darf Mails senden“ festlegen (sonst gehen Mails als Entwurf in die Freigabe), optional „Final setzen“. **Unterschrift** frei je Agent (Verwaltung bzw. eigene Agenten), leer = „Name (KI-Agent, Projekt KEY)“.
3. PL: AP, Aufgabe oder Teilprojekt dem Agenten zuweisen. Der erste Lauf startet sofort bzw. beim nächsten Takt (geerbte Zuständigkeit).

**Was der Agent tut**
- Liest das AP mit Beschreibung, Aufgaben, Tasks, Log, Mails, Doku-Seitenliste und Mitgliedern.
- **Fragt per Chat:** Fragen an Projektbeteiligte stellt er immer als Direktnachricht (oder im Projektkanal), nie per Mail; Eskalationen an die PL kommen zusätzlich zur Benachrichtigung per Chat. Die Frage steht im Log („Per Chat an …“). Wer direkt darauf antwortet (im Thread zur Frage; in der Direktnachricht die erste Antwort und was binnen zwei Stunden folgt), dessen Antwort landet automatisch als „Rückmeldung per Chat“ im Log des AP (Kennzeichen „aus Chat“), und der Agent läuft sofort am AP weiter.
- **Ansprechpartner:** für Rückfragen und Terminzusagen die Zuständigen des übergeordneten AP, sonst die Verantwortung des Teilprojekts, sonst die verantwortliche PL (immer eine Person). Deren Termine aus anderen Projekten sieht er nur als „belegt“, ohne Titel.
- Handelt: Log schreiben, Status setzen, Tasks abhaken, ergänzen oder umformulieren, Mails schreiben (höchstens drei je Lauf), Doku-Seiten lesen, anlegen, ändern und als PDF senden, Blockade melden, an die PL eskalieren.
- **Plant:** Aufgaben unter seinem AP (bzw. in seinen Teilprojekten) und APs in seinen Teilprojekten anlegen, mit Start, Termin, Zuständigkeit und Tasks; zuweisen (Agenten nur als stellv. PL); Start/Termin bei eigener oder noch terminloser Arbeit setzen; Termine mit Uhrzeit in den Projektkalender, aber nur **vorläufig** (siehe unten). Als **stellvertretende PL** oder mit „Projektplan ändern“ im ganzen Projekt, dazu Teilprojekte und Meilensteine. Höchstens 15 Anlagen je Lauf, jede steht im Log. Mitglieder, Rechte und Einstellungen nie.
- **Ursprungsmail:** Ist sein AP aus einer Mail entstanden, beantwortet er sie zum Abschluss mit dem Ergebnis, aus dem Konto dieser Mail (Projektkonto direkt, wenn erlaubt; sonst Entwurf; persönliches Konto: nur der Eigentümer gibt frei). Ohne Projektkonto gehen seine Mails als Entwurf über das Konto einer Projektansicht.
- **Wartet** auf Rückmeldung, Termin, Erledigung durch andere oder Information und setzt sich dafür eine Wiedervorlage. Bei Rückmeldungen fasst er nach Frist nach und eskaliert danach an die PL. Der Hintergrunddienst prüft das jede Minute.
- Läuft erneut bei neuem Kommentar, neuer Mail, Änderungen durch Menschen, Wiedervorlage, naher Fälligkeit und spätestens alle drei Tage.
- **Termine sagt er nie selbst zu.** Schlägt ein Externer einen Termin vor, prüft er Projektkalender, Belegt-Zeiten, Wochenenden und Sperrzeiten, fragt den Ansprechpartner per Chat und wartet; erst nach dessen Bestätigung sagt er dem Externen zu. Seine Kalendereinträge sind **vorläufig** (Kennzeichen in Besprechungen und Kalender, im ICS als „tentative“): Ein Mitglied bestätigt sie unter Besprechungen › Termin › **Bestätigen**; erst dann sind Einladung und Übernahme in Microsoft 365/Google/CalDAV möglich. Die Bestätigung steht im Log des AP, der Agent läuft daraufhin weiter. Termine aus der Projekt-KI („KI Bearbeiten“) sind ebenso vorläufig; nimmt eine Person den Terminvorschlag eines Agenten an, gilt er als bestätigt.
- **Versandstatus schreibt das System:** Ob eine Mail gesendet wurde, als Entwurf auf Freigabe wartet oder nicht gesendet werden konnte (z. B. kein Mailkonto), steht als eigener Log-Eintrag unter seinem Namen; der Agent selbst behauptet keinen Versand.
- Ändert bestehende Termine anderer nur, wenn er planen darf; erfindet keine Fakten, pflegt keine Risiken, Zeiten oder Einstellungen. Inhalte aus persönlichen Konten sieht er nur, wenn sie freigegeben sind (Kopie) oder nur der Eigentümer im Projekt ist.

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

**Beispiel:** Teilprojekt „Elektrik“ dem Agenten geben, darin ein AP „Teilprojekt durchplanen, Fragen an die PL“. Der Agent legt Aufgaben mit Terminen an, weist Handwerksarbeit Personen zu, trägt Besichtigungen vorläufig in den Kalender (die PL bestätigt) und klärt Fragen per Chat mit der PL.

## 13. Einstellungen und Verwaltung

- **Benutzereinstellungen:** Name, Theme, Sprache, Mail-Benachrichtigungen (aus, sofort, täglich), Passwort, zweiter Faktor (Authenticator-App), Kalender-Abo und Kalender schreiben.
- **Konfiguration:** Mail-Konten (persönlich, Projekt, Organisation; Microsoft 365 und Google per OAuth).
- **Verwaltung (Org-Admin):** Benutzer einladen und deaktivieren, Gruppen, PDF-Stil, Module (Zeiterfassung, persönliche Projekte für alle), KI-Profile, eigene Agenten der PL (Freigabe, Profile, Budgetdeckel), KI-Agenten, Projekt- und Doku-Vorlagen, Audit-Export.
- **Anmeldung:** Passwort mit optionalem zweiten Faktor oder Single Sign-on (OIDC), falls eingerichtet.

## 14. Persönliches Projekt (Assistent)

- Anlegen unter Projekte mit „Persönlich“: Projektersteller immer, alle anderen, wenn der Org-Admin es erlaubt (Verwaltung › Mandant). Startet leer (nur Spalten).
- Nur der Ersteller (PL) und KI-Agenten; weitere Personen und Einladungen sind gesperrt, sichtbar nur für Mitglieder.
- Der Org-Admin sieht im Audit-Export Aktion, Person und Zeit, aber keine Details, und verwaltet die Projektkonten dieses Projekts nicht.
- Typischer Aufbau: eigenes Postfach als persönliches Konto, Ansicht ins Projekt, **Ordner „KI Bearbeiten“** einrichten, eigenen Agenten anlegen (oder aufnehmen) und als stellv. PL einsetzen. Mails in den Ordner legen: Die Projekt-KI macht daraus Aufgaben und Termine und gibt dem Agenten, was er selbst erledigen kann; zum Abschluss beantwortet er die Ursprungsmail als Entwurf, den du freigibst.
