# PROject

Aufgaben, Projektplan, Mail und Dokumentation auf **einem Datenmodell** mit zentraler Rechteprüfung.
Umsetzung der Produktbeschreibung „Projekttool (Konzept B)“, Version 1.1. Alle Abläufe laufen regelbasiert über
API und Worker; KI ist das letzte Modul und greift nur als Vorschlag mit Freigabe ein (Regel vor KI).

## Schnellstart (ohne Postgres)

```bash
npm install
npm run dev          # API auf :3000 (PGlite-Datei unter .data), Web auf :5173 mit Proxy
```

Dann http://localhost:5173 öffnen. Demodaten werden beim ersten Start angelegt (Passwort `demo1234`):

| Login | Rolle |
| --- | --- |
| pl@demo.local | Petra Lenz, PL „Website-Relaunch“, Mitglied „ERP“ |
| anna@demo.local | Anna Berger, Stellvertretung (zweiter PL) WEB, PL ERP |
| max@demo.local | Max Keller, Mitglied mit Recht „Projektplan ändern“ |
| leser@demo.local | Lea Reuter, Leser |
| admin@demo.local | Alex Admin, Org-Admin ohne Projektmitgliedschaft |

Produktionsnaher Lauf mit PostgreSQL aus dem Quellcode:

```bash
docker compose up --build     # App auf :3000, Postgres 16
```

Oder manuell: `DATABASE_URL=postgres://… npm run build && npm start`.

## Deployment mit fertigem Image

Der Workflow `.github/workflows/docker.yml` baut bei jedem Push das Image (amd64 und arm64) und veröffentlicht es
unter `ghcr.io/phat-shot/project` mit den Tags Branch-Name, Commit-SHA, `latest` (Standard-Branch) und Versionen aus Git-Tags `v1.2.3`.
`.github/workflows/ci.yml` führt Typecheck, API-Tests und Build aus.

```bash
cp deploy/.env.example deploy/.env           # Passwort, PUBLIC_URL, DOMAIN eintragen
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d                   # App + Postgres
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile backup up -d  # zusätzlich tägliches pg_dump nach ./backups
```

Die App hängt am bestehenden Traefik: externes Docker-Netz `proxy`, Entrypoints `http`/`https`, Certresolver `http`, Router `projekttool` mit Redirect auf HTTPS. `DOMAIN` in `deploy/.env` setzen; `PUBLIC_URL` ergibt sich daraus. Es werden keine Ports veröffentlicht.

Erster Start mit `SEED=false`: Die App zeigt eine Ersteinrichtung, in der Mandant und erster Org-Admin angelegt werden; danach ist dieser Weg gesperrt. `SEED=true` legt stattdessen die Demodaten an.

Update: `IMAGE_TAG` in `deploy/.env` setzen, dann `docker compose … pull && docker compose … up -d`. Migrationen laufen beim Start automatisch.
Das Image läuft ohne Root, mit Healthcheck auf `/api/health`; Uploads und PGlite-Daten liegen im Volume `/data`.
Ist das Paket in ghcr.io privat, vorher `docker login ghcr.io` mit einem Token mit `read:packages`.

## Was die Alpha kann

**Projekttool**
- Projekte mit Kürzel, Rollen PL / Mitglied / Leser, zweiter PL als Stellvertretung (die verantwortliche PL übergibt ihre Rolle nur selbst, der Org-Admin kann sie ohne Inhaltszugriff neu bestimmen, nie sich selbst; die bisherige PL bekommt eine Meldung), Einzelrechte („opt.“; „KI nutzen“ vorbelegt: Mitglied an, Leser aus); Leser mit „KI nutzen“ dürfen nur Fragen ans Projekt stellen
- Teilprojekte, Arbeitspakete, Aufgaben, Tasks (Checkliste); Verantwortung wird vererbt (Aufgabe → Arbeitspaket → Teilprojekt → PL) und als „geerbt“ markiert
- Aufgabe als Zwischenebene zwischen Arbeitspaket und Task (entspricht dem Vorgang nach DIN 69901 bzw. der Activity nach PMBOK, in Tools Sub-task): eine Ebene tief, mit eigener Zuständigkeit, Status, Terminen, Log, Mail-Antwortadresse, Anhängen und KI-Agent; Teilprojekt folgt dem Arbeitspaket; Archiv, Papierkorb, Kopieren und Verschieben nehmen die Aufgaben mit; Board, Fortschritt und Portfolio zählen nur Arbeitspakete, die Karte zeigt „Aufgaben erledigt / gesamt“, der Plan rückt Aufgaben unter ihrem Arbeitspaket ein
- Zuweisung an Benutzer oder externe Mail-Adresse (Projektkontakte)
- Kanban: Spalten pro Projekt mit WIP-Limit, Swimlanes je Teilprojekt, Drag & Drop inkl. Sortierung, Labels, Filterleiste (Text, Person, Label, Priorität, nur meine, überfällig, Konflikte, Archiv), Tastaturkürzel f/q/n/x, Karten-Badges (Fälligkeit farbig, Beschreibung, Kommentare, Anhänge, Mails, Checklisten-Fortschritt), Schnellanlage, Spalten einklappen, Archivieren
- Wiederkehrende Aufgaben (W6): täglich, wöchentlich, monatlich, n-ter Wochentag; nächste Instanz nach Erledigung oder vor Fälligkeit
- Projekt-Dashboard = Dashboard mit Projektfilter (Kennzahlen, Fortschritt je Teilprojekt, Überfälliges, Konflikte, Meilensteine, Auslastung, offene Freigaben, Aktivität), Kalender (Deadlines, Meilensteine)
- In-App-Benachrichtigungen: Zuweisung, Kommentar, @-Erwähnung, bald fällig, überfällig, Termin verschoben, Freigabe wartet, Seite in Prüfung, externe Bearbeitung; nur an aktive Personen (nie an KI-Agenten); Klick in Glocke oder Dashboard öffnet das Ziel und markiert gelesen
- Kommunikationsregeln mit Vererbung Org → Projekt → Arbeitspaket → Benutzer (auch je Projekt und am AP): je Ereignisklasse (Frage, Entscheidung, Bestätigung, Überschneidung, vorläufiger Termin, Auftragsvorschlag, Rückfrage von extern, Zwischenstand, Zuweisung, Blockiert, Eskalation, Prüfung/Freigabe, Mail am AP, Log, Fälligkeit, Chat, Buchung, Information) Empfängerrollen mit „sonst“, Kanäle Chat (aus, Thread, Projektkanal), Mail (aus, sofort, Digest zur Stunde des Mandanten in Europe/Berlin), Log, Doku-Seite „Entscheidungen und Meldungen“, Fristen (Nachfassen, Weitergabe, Verfall) und Häufigkeit von Zwischenständen; Sperren nur durch Org und PL (oberste Sperre gewinnt), Benutzer nur Chat und Mail (je Projekt, stummschalten), Berichtswunsch am AP; Vorschau „Wer bekommt was?“; `notify()` löst die Regel je Person auf (Mail-Modus, Klasse und Bezug in der Meldung, In-App immer), `dispatch()` die Empfängerrollen (Gruppen nur mit Projektsicht); Systembeiträge im Chat (`chat_messages.kind = 'system'`, nur aus Services, lösen keine Läufe aus); Digest-Mails (nur Meldungen von vor der Digest-Stunde des Tages) mit PDF-Anhang bei Seitenbezug, ohne Org-Postfach über das Projektkonto; Klasse „Mail am AP“ bei jeder neuen Zuordnung einer Mail (`mail/link.ts`: Log, Empfänger nach Regel); Backfill der bisherigen Mail-Einstellung als Benutzerregel
- @-Erwähnungen in Kommentaren mit Vervollständigung über Projektmitglieder
- Eskalationsregelwerk je Projekt (Regel vor KI): Verzug, Stillstand („hängt“) und Blockaden eskalieren entlang Zuständig → Teilprojekt-Verantwortung → PL → Eskalationskontakt (intern oder extern per Mail, als Entwurf zur Freigabe oder direkt); Kritikalität aus Priorität, Nachfolgern, nahem Meilenstein und Blockade halbiert die Fristen; jede Stufe mit Benachrichtigung und Log-Eintrag, automatische Rücksetzung; „Blockiert“-Meldung an der Aufgabe; Warnungen in der Übersicht; manuelle Eskalation
- Reporting je Projekt (Regel vor KI): Vorlage (z. B. Statusbericht) im Rhythmus wöchentlich / zweiwöchentlich / monatlich; der Worker legt die Seite unter der gewählten Oberseite oder im Ordner „Berichte“ an, ergänzt Kennzahlen (Fortschritt, erledigt seit letztem Bericht, Verzug, Blockaden, Eskalationen, Meilensteine, gebuchte Zeit) und versendet sie als PDF über das Projektkonto an den Empfängerkreis; Modus „Prüfung“ (Entwurf, PL setzt final und versendet) oder „direkt“; manueller Lauf „Jetzt erzeugen“ in den Projekteinstellungen
- Navigation: „PROject“ oben öffnet das Dashboard; darunter bis zu fünf angeheftete Projekte (☆/★, Benutzereinstellung, ohne Auswahl die ersten fünf), „Alle Projekte“ klappt die übrigen in der Leiste aus; je Projekt Arbeitspakete (oberster Punkt), Postfach, Doku, Risiken, KI, Einstellungen (PL). Danach global Postfach (alle lesbaren Mail-Ansichten), Kalender, Workflows (mit Projektfilter) und Chat. Dashboard, Workflows und Chat gibt es nur global. Projekt-Sichtbarkeit „nur Mitglieder“ oder „alle Benutzer des Mandanten (lesend)“
- Hierarchie Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task; „Meine Arbeit“ zeigt geklammert nur eigene und vererbte Zuständigkeit; Arbeitspakete, Tasks und Teilprojekte direkt editierbar; Wechsel der Verantwortung fragt, ob direkt zugewiesene Arbeitspakete mit übertragen werden
- Benutzer einladen per Mail über das Org-Postfach (Kontotyp „org“), Annahme mit Passwort unter /einladung/:token, manuelles Anlegen als Fallback
- Berechtigungsgruppen des Mandanten mit Verwaltern (pflegen die Mitglieder ihrer Gruppe; alle Gruppen: Org-Admin und Org-Recht „Gruppen verwalten“); Gruppen als Projektmitglied (Leser oder Mitglied plus Einzelrechte, Herkunft je Mitglied): Direkteintrag überschreibt alle Gruppen, zwischen Gruppen gilt die höchste Rolle, Einzelrechte ODER-verknüpft; nie Agenten, nie in persönlichen Projekten; Abgleich bei Gruppenänderungen, SSO, Deaktivieren und Reaktivieren. Eingeschränkte Teilprojekte (nur PL, Verantwortliche, benannte Benutzer und Gruppen) an allen Wegen zum AP (Log, Tasks, Anhänge, Zeiten, Mail-Kopien, Verschieben, Kopieren, Eskalieren, Bezüge aus Zeiten, Besprechungen, Mail-Entwürfen und RAID) und in Listen (Agentenläufe, KI-Vorschläge samt Meldung, Aktionspunkte, Zeitauswertung, Meilensteine, Übersicht, Warnungen), auch beim Kopieren und Verschieben ganzer Teilprojekte; Mail-Kopien im AP nur für ausdrückliche Mitglieder; Gruppen auch in Mail-Ansicht-Rechten; „Deine Rechte“ in den Projekteinstellungen mit Begründung je KI-Funktion
- Benutzerverwaltung: globale Rolle, Org-Rechte, deaktivieren und reaktivieren; eigener Zugang und letzter aktiver Org-Admin geschützt
- Interaktives, überspringbares Tutorial beim ersten Login, jederzeit neu startbar
- Hilfe in der App (unten links): Kurzanleitung, Handbuch und KI-Sheet aus `docs/`, beim Build eingebunden und damit immer passend zur installierten Version
- Dashboard (nur global, nach Projekt filterbar): Reiter „Meine Arbeit“ (Soll/Ist der eigenen Arbeit: offen, überfällig, fällig, blockiert, im Plan; Termine, Meldungen, geklammerte Sicht Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task), „Projekte“ (früher Portfolio: Ampel manuell oder berechnet, Fortschritt, Verzug, Meilenstein, Budget, Auslastung und Zeiten über Projekte) und „Alle Arbeitspakete“; mit Projektfilter zeigt „Meine Arbeit“ das Projekt-Dashboard und die eigene Arbeit im Projekt
- Kanban-Spaltenarten Geplant / in Bearbeitung / Zurückgestellt / Erledigt; nur aktive Spalten zählen als Stillstand für die Eskalation
- Projekt-Postfach als Posteingang aller Ansichten mit Ordnern (Posteingang, Gesendet, Archiv, Papierkorb, Unterordner), Filter je Ansicht; Mails archivieren, löschen, verschieben, Unterordner anlegen (IMAP und Datenbank synchron); Ansichten und Filter in den Projekteinstellungen
- Einstellungen: Benutzereinstellungen (Name, Theme hell/dunkel/System, Sprache, Passwort), Konfiguration (Mail-Konten mit Verwalter und Verwendungen: persönlich, Projektkonto mit Standard je Projekt, Org-Postfach; Org-Admin bietet Konten der Organisation an und wechselt Verwalter, PL bindet Konten ihrer Projekte), Verwaltung
- Tasks mit externer Mail-Zuständigkeit; „Stand nachfragen“ aus Arbeitspaket und Task mit vorbelegter Mail, Antwort landet über die Antwortadresse im Arbeitspaket
- Zeiterfassung als optionales Modul je Projekt: Buchung je Aufgabe oder frei, Schätzung je Aufgabe, Budget je Projekt, Auswertung je Person und Teilprojekt, CSV-Export, „Meine Zeiten“; Mitglieder sehen eigene Buchungen, PL alle (auch im AP)
- Plan: Balken Start–Deadline, Punkt bei reiner Deadline, Teilprojekt-Sammelbalken, Meilensteine, Abhängigkeiten Ende → Anfang
- Konflikte werden markiert, nichts verschiebt sich automatisch; „Nachfolger verschieben“ mit Vorschau (W7)
- „Meine Aufgaben“ über alle Projekte, Suche, Audit-Log je Projekt (Mitglieder sehen eigene Aktionen)

**Mail**
- Konten mit Verwalter (Person, Projekt, Org-Admin) und Bindungen (`mail_account_uses`: org | project mit Standard-Ausgangskonto | personal); Rechte und Inhaltsgrenzen hängen an der Bindung der Ansicht; Adapter: IMAP/SMTP (imapflow, nodemailer), Microsoft Graph und Dev-Postfach im Speicher; OAuth2 für Microsoft 365 (Graph oder IMAP-XOAUTH2) und Google (IMAP/SMTP-XOAUTH2) mit Token-Refresh, Knöpfe „Mit Microsoft 365/Google verbinden“ in Konfiguration und Projekteinstellungen (Variablen `OAUTH_*` in `.env.example`)
- Konto ≠ Ansicht: geteilt werden nur Ansichten (Filter: Ordner, Absender/Domain, Empfänger, Betreff, Stichwort, ab Datum)
- Gespeichert werden **nur Treffer** einer Ansicht; Kopfdaten werden vor dem Laden des Bodys geprüft
- Rechte je Ansicht pro Person oder Rolle: Lesen, Entwurf, Senden, KI, Aufgabe erzeugen; aus persönlichen Konten sendet nur der Eigentümer
- Mail → Aufgabe (W3, vorbefüllt), Aufgabe → Mail (W4), verknüpfen oder kopieren (Kopie mit Bestätigung und Audit)
- Inhalt ins Projekt (Log-Zitat, Arbeitspaket mit Mailtext): Rückfrage mit Namensliste, wenn Mitglieder die Mail dadurch erstmals sehen; aus persönlichen Konten übernimmt nur der Eigentümer Inhalte, andere nur Absender, Datum und Betreff. Zuständige müssen aktive Projektmitglieder sein, KI-Agenten weist auch hier nur die PL zu
- HTML-Mails werden bereinigt (DOMPurify) in einem Sandbox-iframe ohne Skripte angezeigt; externe Bilder (Tracking-Pixel) bleiben blockiert, bis man sie lädt
- Aktionen an einer Mail: verknüpfen/kopieren, ins Aufgaben-Log übernehmen, Aufgabe anpassen (Mail als Beleg), Aufgabe erstellen, in Doku ablegen (eigene Seite), an Seite anhängen (Abschnitt); KI: Zusammenfassen, Essenz → Arbeitspaket (Vorschlag), Essenz → Seite (Vorschlag), „KI bearbeiten“
- Ursprungsmail: aus einer Mail entstandene Arbeitspakete/Aufgaben merken sich die Mail (umschaltbar), Sprung in beide Richtungen (auch projektübergreifend, soweit sichtbar); erledigt und unbeantwortet → „Ursprungsmail beantworten“ mit aufbereitetem Ergebnis (optional Projekt-KI), Antwort aus dem Konto der Mail im selben Verlauf, hängt als Mail am Arbeitspaket, kein Log-Eintrag
- Mail-KI: Ordner „KI Bearbeiten“ je Konto (Eigentümer bzw. PL): die Projekt-KI legt aus jeder dort abgelegten Mail direkt Arbeitspaket/Aufgabe mit Ursprungsmail, Zuweisung (auch an Agenten), vorläufigen Termin, Antwortentwurf an und legt die Mail nach „Archiv“ oder „In Arbeit“ ab, im Auftrag und mit den Rechten der einrichtenden Person; Agent an einer Ansicht schlägt dieselben Aktionen vor, Annahme mit einem Klick mit den Rechten der annehmenden Person; einmal je Mail und Projekt, Tagesbudget, Audit
- Entwürfe ohne Senderecht gehen in die Freigabe-Liste; der Worker versendet
- Antworten Externer werden per Plus-Adresse (`projekt-x+t<code>@…`) der Aufgabe zugeordnet, Fallback In-Reply-To

**Doku (à la Confluence)**
- WYSIWYG-Editor (TipTap/ProseMirror): Überschriften, Schriftgrößen, Fett/Kursiv/Unterstrichen, Listen, Tabellen mit Zeilen/Spalten, Bilder (Upload, Drag & Drop, Einfügen), Links, Zitate; HTML als Speicherformat, Markdown abgeleitet für Suche und Mail-Aktionen; serverseitige Bereinigung
- Ordner mit Verteiler, Seitenbaum mit Unterseiten; jede Seite kann Oberseite sein (Besprechungsreihe, Teilprojekt, Berichte): Zusammenfassung und Teilnehmer auf der Oberseite, Vorlage für neue Unterseiten wird vererbt, Unterseiten-Index, PDF-Layout (Akzentfarbe, Kopf-/Fußzeile, Metadaten) je Oberseite
- Versionen bei jeder Änderung, Konfliktschutz bei veralteter Version
- Status Entwurf → In Prüfung → Final; Final sperrt; Versand finaler Seiten als **PDF-Anhang** an den Verteiler über das Projektkonto (W5); die versendete PDF wird an der Seite abgelegt; PDF-Ansicht jeder Seite, auch über Freigabe-Links
- Vorlagen: Besprechungsprotokoll, Statusbericht, Konzept, RAID-Log, Änderungsantrag, Kickoff, Lessons Learned; Vorlagen-Editor in der Verwaltung
- PDF aus dem Seiten-HTML (pdfkit): Titelblock, Metadaten, Schriftgrößen, Fett/Kursiv/Unterstrichen, verschachtelte Listen, Tabellen-Zebra, Bilder, Kopf- und Fußzeile; Stil je Mandant, überschreibbar je Oberseite
- Freigabe per Link: Seite (wahlweise mit Unterseiten) an eine Mail-Adresse, lesend oder schreibend, mit Ablauf, widerrufbar, Versand über das Projektkonto; externe Änderungen werden mit der Adresse versioniert und gemeldet (`/s/<token>`)
- Anhänge an Seiten und Aufgaben

**Persönliches Projekt (Assistent)**
- Ein Projekt wie jedes andere mit neun gebündelten Abweichungen (`apps/api/src/projectPolicy.ts`, Web `useProjectPolicy`): Anlegen für Projektersteller oder alle Benutzer (Mandanteneinstellung), startet leer ohne Vorlage, nur Ersteller (PL) und KI-Agenten, keine Gruppen und Einladungen, nur für Mitglieder sichtbar, Org-Admin ohne Inhalte/Konten/Liste/PL-Wechsel und Audit ohne Details, nur eigene Postfächer ohne Org-Rückfall, Org-KI nur mit Freigabe, keine Systembeiträge im Projektkanal, Beschriftung „persönlich (Name)“

**KI (letztes Modul, Regel vor KI)**
- KI-Profile je Mandant (Verwaltung › KI-Profile, Org-Admin): beliebig viele KIs, je Profil lokales LLM mit OpenAI-kompatibler API (vLLM, Ollama, LM Studio; Adresse, Modell, optional Schlüssel, JSON per json_schema) oder Anthropic über das offizielle SDK (Structured Outputs, Refusal-Fallback); Schlüssel nur schreibend und verschlüsselt, alternativ `ANTHROPIC_API_KEY` (nur für Profile des Mandanten, nie für eigene LLMs der Projekte). Je lokalem Profil lässt sich der Denkmodus abschalten (Modelle mit Thinking wie Qwen: schneller, weniger Token, keine abgeschnittenen JSON-Antworten; sendet `chat_template_kwargs.enable_thinking = false`, ausgewertet von vLLM und llama.cpp); je Agent überschreibbar (wie Profil, aus, an; „an“ gibt mehr Ausgabe-Spielraum für Denk-Token). Jeder Agent bekommt ein Profil (Standardprofil als Vorbelegung). Freigabe je Profil für alle, ausgewählte oder keine Projekte (persönliche Projekte bei „alle“ nur mit „auch in persönlichen Projekten“, sonst per Auswahl; Agenten der Org laufen in persönlichen Projekten nur mit freigegebenem Profil; Bestand per Migration als Auswahl erhalten); die PL wählt die Projekt-KI aus den im Projekt verfügbaren LLMs (ohne Auswahl ist sie aus). Eigenes LLM der PL je Projekt, wenn der Mandant es erlaubt (aus / nur persönliche Projekte / alle): nur dort nutzbar, Schlüssel verschlüsselt, der Org-Admin sieht Metadaten und Verbrauch und kann sperren; Agenten der PL laufen nur auf Projekt-LLMs. Schemas für Structured Outputs ohne Union-Typen (nicht genutzte Felder leer statt null). Jede Anfrage im Audit mit Profil, Modell und Token
- KI-Agenten als Benutzer: vom Org-Admin angelegt und benannt (oder von der PL für ihr Projekt, wenn freigegeben: nur freigegebene Profile, Budgetdeckel, nur dort einsetzbar), mit Persona (eine Zeile Freitext, die den Schreibstil für Log, Mails, Doku und Chat beschreibt; Fakten- und Rechteregeln gehen vor) und freier Unterschrift, kein Login, nie verantwortliche PL oder Org-Admin; die PL nimmt sie als Mitglied oder stellvertretende PL auf („darf Mails senden“ abschaltbar, sonst Entwürfe zur Freigabe) und macht sie zuständig: Arbeitspakete, Aufgaben oder Teilprojekte (geerbte Zuständigkeit zählt). Agenten planen: Aufgaben/Arbeitspakete mit Terminen anlegen, zuweisen, Termine setzen, Kalendertermine (nur vorläufig: ein Mitglied bestätigt, vorher keine Einladung oder Kalenderübernahme; Terminvorschläge Externer sagt der Agent erst nach Rückfrage beim Ansprechpartner zu: Zuständige des übergeordneten AP, Teilprojekt-Verantwortung oder PL, deren Termine aus anderen Projekten er nur als belegt sieht); als stellv. PL im ganzen Projekt mit Teilprojekten und Meilensteinen; nie Projekte, Mitglieder oder Einstellungen. Zum Abschluss beantworten sie die Ursprungsmail aus deren Konto (persönliches Konto: Entwurf für den Eigentümer). Der Agent läuft sofort bei Zuweisung, neuem Kommentar oder neuer Mail; wartet er (Rückmeldung, Termin, Erledigung durch andere, Information), setzt er sich eine Wiedervorlage, bei Rückmeldungen zusätzlich Nachfassen und Eskalation an die PL nach Frist (Worker prüft jede Minute, `SYNC_INTERVAL_MS`); er schreibt Log-Einträge unter seinem Namen, setzt Status, hakt Tasks ab, fragt Interne als offene Frage per Chat (Thread, Meldung mit Bezug, Log, Nachfassen und Weitergabe entlang der Kette ohne KI; Antworten im Thread, in der Direktnachricht oder im AP erledigen alles zugleich und lösen einen Lauf aus), Externe per Mail (Versandstatus gesendet/Entwurf/nicht gesendet schreibt das System ins Log), meldet Blockaden und eskaliert an die PL. PDF per Mail nur von finalen Seiten, an Projektmitglieder oder Adressen mit aktiver Freigabe der Seite, an den Verteiler (auch einzelne Adressen daraus) nur mit „Final setzen“; lehnt die PL einen Mail-Entwurf ab, steht das im Log und der Agent läuft erneut. Ereignisse während eines Laufs lösen genau einen Folgelauf aus (Dirty-Flag, im Projektkanal je Thread), nichts geht verloren. Tagesbudget je Agent (0 = keine Läufe; gezählt werden ausgeführte Läufe), Pause je Arbeitspaket, beides gilt auch für den Lauf von Hand; jeder Lauf unter Projekt › KI mit Begründung, Aktionen und Token
- KI-Freigaben (Verwaltung › KI-Freigaben, Org-Admin oder Org-Recht „KI verwalten“): Notaus für den ganzen Mandanten; Regeln Ort × Wer × Funktion (Mandant, Gruppe, Projekt, Person, Agent, Ausnahme „Person, Agent oder Gruppe in Projekt“; Kategorien oder einzelne Funktionen; erlauben, sperren, erben, mit Notiz); Sperre gewinnt, Ausnahme nur über „Person in Projekt“, die PL schränkt im Projekt weiter ein, der Notaus gilt immer; Projektsperren gelten auch für Agenten der Org, „Eigene Agenten der PL“ ist ohne Regel gesperrt und wird auch bei laufenden Agenten geprüft. Jede KI-Nutzung läuft über eine Prüfung (Notaus, Regeln, Ebene der PL, Profil, Budget) mit Begründung und Spur: Vorschau „Wirkung für Person X in Projekt Y“, Fähigkeiten je Projekt für Knöpfe mit Begründung, Routen antworten mit 403 und Grund; gesperrte Agenten- und Mail-KI-Läufe stehen als übersprungen im Protokoll (ohne LLM-Aufruf, nicht budgetwirksam, höchstens einmal je AP und Tag); im Chat werden Absender und Agent geprüft (Absender mit „KI nutzen“ oder PL; gesperrt antwortet der Agent nur auf Direktnachrichten und Erwähnungen). Begründungen aus Regeln für Personen und Gruppen an geteilten Orten (Projektkanal, Lauflisten, Fähigkeiten der Agenten) ohne Namen und Notiz, voll nur für die betroffene Person und die Verwaltung. Eigene LLMs: Einbinden, Ändern, Testen und Wahl als Projekt-KI nur mit Freigabe „Eigenes LLM im Projekt“, Einschränken immer. Tagesbudget für die KI-Assistenz je Projekt. Regeländerungen und Notaus im Audit
- Informationsgrenze für Externe: Empfängerklassen je Mail (intern, Org-Benutzer ohne Zugriff, Extern mit Bezug zum AP, Extern ohne Bezug; die strengste gilt). Agenten-Mails und Antworten auf Ursprungsmails an Nicht-Interne formuliert ein eigener kleiner KI-Aufruf mit nur dem Außenkontext der Aufgabe neu (Außenbeschreibung, Log-Einträge „für Externe sichtbar“, freigegebene Seiten, externes Profil des Projekts); danach prüft das System deterministisch (fremde Kennungen, Titel anderer APs, Teilprojekte und nicht freigegebener Seiten, interne Adressen, andere Projekte, App-Links, Anhänge nicht final oder nicht freigegeben). Funde halten die Mail als Entwurf an (Mail › Freigaben „Außenprüfung angehalten“ mit „Bearbeiten und senden“), der erste Kontakt zu einer Adresse ohne Bezug ist immer ein Entwurf, Projektmitgliedern schreibt der Agent per Chat. Fragen Externer außerhalb ihrer Aufgabe gibt der Agent an den Ansprechpartner weiter (refer), der Externe erfährt nur, an wen. Entwürfe der Mail-KI, die Abschluss-Antwort mit KI und Mails, die Personen selbst an Externe senden, zeigen Fundstellen als Hinweis (vor dem Senden, ohne Block). Was ein Externer selbst schreibt, nimmt die Prüfung nicht aus; entscheiden darf nur, wer senden darf. Stufe streng oder nur prüfen (Verwaltung › KI); jede Prüfung in `outbound_checks` und im Audit (`ai.outbound`)
- KI-Sheet: fester Block ganz vorne im Systemprompt jedes Agentenlaufs (1280 Token, für alle Agenten und Projekte gleich, damit vLLM/llama.cpp ihn per Prefix-Caching wiederverwenden), danach Regeln je Laufart und zuletzt Name, Projekt und Persona; Text in `apps/api/src/ai/sheet.ts` und `docs/KI-Sheet.md` (Test hält beide gleich). Anleitungen werden bewusst nicht in die Projekt-Doku kopiert: Sie würden in „Frage ans Projekt“ (Stichwortsuche, höchstens 6 Seiten) echte Projektseiten verdrängen
- Rechte: „KI nutzen“ und „Freigeben“ in der Projektmitgliedschaft, „KI“ je Mail-Ansicht; alle KI-Aktionen an Mails (auch Zusammenfassen) brauchen beides; Leser mit „KI nutzen“ nur Frage ans Projekt und Chat mit Agenten (Auskunft); Chat mit Agenten nur mit „KI nutzen“ (vorher ohne); PL darf alles, soweit die KI-Freigaben es zulassen
- Zusammenfassen direkt (an der Mail gespeichert); Essenz → Arbeitspaket (Log-Eintrag, erkannter Status/Termin, offene Fragen) und Essenz → Seite (Abschnitt im Stil der Seite) nur als Vorschlag; Freigabe unter Projekt › KI mit Bearbeitung vor dem Anwenden, Log-Einträge tragen die Quelle „KI“
- Frage ans Projekt (RAG-lite): Stichwortsuche über Arbeitspakete, Seiten und lesbare Mails, Antwort mit Quellenangabe
- Statusbericht-Entwurf aus Kennzahlen des Regelwerks, RAID, Ampel und Log als Entwurfsseite in „Berichte“

**Chat**
- Regulärer Weg der Kommunikation zwischen Projektbeteiligten (Mail bleibt primär für Externe): Projektkanal je Projekt mit Threads und @Erwähnungen (schreiben nur eingetragene Mitglieder, implizite Leser lesen mit), Direktnachrichten mit Personen und KI-Agenten, Ungelesen-Zähler
- Desktop: Knopf unten rechts öffnet den Messenger als Overlay (Suche oben über Gespräche und Nachrichten, links alle Gespräche nach letzter Aktivität, rechts der Verlauf); der Leisteneintrag „Chat“ öffnet ihn ebenso; mobil Vollbild unter /chat; Chat-Benachrichtigungen öffnen das Gespräch
- KI-Agenten chatten: Antwort auf Direktnachrichten, auf @Name im Projektkanal (im Thread) und in Threads, in denen sie schon geantwortet haben, wenn die fragende Person „KI nutzen“ hat oder PL ist und die KI-Freigaben es erlauben (sonst der Grund, im Projektkanal nur auf Erwähnung); Auskunft nur über eigene Arbeitspakete aus Projekten und Teilprojekten, die die fragende Person sehen darf (im Projektkanal ohne eingeschränkte Teilprojekte); Informationen zu einem Arbeitspaket landen als Log-Eintrag dort und lösen einen Agentenlauf aus; jeder Chat-Lauf zählt gegen das Tagesbudget und steht im Audit, Läufe aus Projektkanälen zusätzlich unter Projekt › KI. **Thema je Nachricht** bestimmt das System (`resolveChatScope`): Projektkanal = Kanalprojekt (Thread: Arbeitspaket der Thread-Wurzel), Direktnachricht = genannte Kennungen/Projekte, sonst das zuletzt im Verlauf genannte (Antwort beginnt mit „Zu WEB-12:“), „über alle Projekte“ = alle gemeinsamen Projekte je Zeile mit Kürzel, ohne Anhaltspunkt bei mehreren gemeinsamen Projekten Rückfrage mit Projektnamen ohne LLM-Aufruf; Kennungen aus Projekten ohne gemeinsame Freigabe: „Dazu kann ich dir hier nichts sagen“, ohne Titel. Der Prompt enthält nur Arbeitspakete des Themas und eine vom System per SQL berechnete **Kennzahlen-Zeile** (offen, in Arbeit, fällig diese Woche, überfällig, blockiert, wartet); Status auf Nachfrage hat ein festes Format (Kennzahlen, nächste Schritte, Termine, Blocker). **claimCheck**: Behauptungen in der ersten Person („Ich habe … gesendet/angelegt/erledigt“, „vermerkt“ ohne Notiz) ersetzt das System durch „Das konnte ich nicht ausführen: …“ und vermerkt es im Lauf. Ohne Persona schreibt der Agent im Team Du, nach außen Sie

**Besprechungen**
- Besprechung als Objekt unter Arbeitspakete › Besprechungen: Termin, Ort, Agenda, Teilnehmer aus Mitgliedern, Kontakten und freien Adressen, Zuordnung zu einer Besprechungsreihe; von KI eingetragene Termine sind vorläufig, bis ein Mitglied sie bestätigt
- Protokollseite aus der Vorlage der Reihe (sonst „Protokoll“ im Ordner „Protokolle“) mit Termin und Teilnehmern vorbelegt; Aktionspunkte direkt als Arbeitspakete mit Zuständigem und Termin, bestehende Arbeitspakete verknüpfen; Arbeitspaket zeigt die Besprechung
- Einladung mit Kalendereintrag (ICS, METHOD:REQUEST) über das Projektkonto an alle Teilnehmer, Aktualisierung mit Sequenz; ICS-Download für den eigenen Kalender; Besprechungen im Projekt- und Gesamtkalender und im ICS-Abo
- Kalender schreiben: Termin mit einem Klick in Microsoft 365 (Graph, persönliches OAuth-Konto mit Calendars.ReadWrite), Google Kalender (calendar.events) oder per CalDAV (Nextcloud, iCloud, Fastmail; Zugang in den Benutzereinstellungen, Passwort verschlüsselt); erneutes Eintragen aktualisiert den Eintrag

**Auswertungen (W9)**
- Je Projekt unter Arbeitspakete › Auswertung: Durchsatz je Woche (angelegt/erledigt), Durchlaufzeit (Median, Durchschnitt, längste), Verzug nach Alter, Eskalationen je Zeitraum und aktuell, je Teilprojekt; Zeitraum wählbar, alles als CSV
- Board und Plan als CSV (Excel), Zeiten über alle Projekte unter Dashboard › Projekte je Projekt und Person

**Identität und Sicherheit**
- Single Sign-on per OIDC (Entra ID, Keycloak, Authentik …) mit Zuordnung per E-Mail, optionaler Auto-Anlage, Name aus den Claims und Abgleich der Berechtigungsgruppen über den Gruppen-Claim (Gruppe trägt den Namen beim Identitätsanbieter; `OIDC_*` in `.env.example`); Passwort-Login, Passwort-Reset und 2FA (TOTP) bleiben
- Rate-Limit für Login und Reset, Sicherheits-Header inklusive Content-Security-Policy (nur eigene Skripte), Sitzungen per httpOnly-Cookie, CSRF-Prüfung über Origin/Referer
- Gespeicherte Geheimnisse (Mail-Passwörter, OAuth-Tokens, KI-Schlüssel) verschlüsselt (AES-256-GCM, Schlüssel `SECRET_KEY` oder `DATA_DIR/secret.key`); Uploads ohne ausführbare Dateien, aktive Inhalte nur als Download; `npm audit` für Produktionsabhängigkeiten in der CI

**Querschnitt**
- Zentrale Rechteprüfung in der API; Org-Admins sehen Projektinhalte nur als Mitglied; keine externen Gäste
- Audit-Log schreibt ausschließlich API/Worker; Org-Admin exportiert Metadaten über alle Projekte
- W10 Benutzer deaktivieren, W11 Projekt archivieren
- Mandanten-ID (`org_id`) von Anfang an im Datenmodell

## Noch nicht enthalten

Lesender Kalender-Abgleich (fremde Termine ins Tool), Row-Level Security in der Datenbank
(Rechte liegen zentral in der API), Office-Bearbeitung im Browser (braucht einen externen Dienst wie Collabora/OnlyOffice).

## Struktur

```
apps/api        Fastify + TypeScript, SQL-Migrationen, Worker, Tests (node:test auf PGlite)
apps/web        React + Vite + TypeScript, ohne UI-Framework
apps/mobile     Android-Hülle (Capacitor) um die Server-Instanz, APK über .github/workflows/android.yml
packages/shared gemeinsame Typen
```

Befehle: `npm run dev`, `npm run build`, `npm start`, `npm test`, `npm run typecheck`, `npm run seed`.

Dev-Hilfen (nicht in Produktion): `POST /api/dev/mail/inject` spielt eine Mail in ein Dev-Postfach, `POST /api/dev/mail/sync-all`
synchronisiert alle Konten, `GET /api/dev/mail/sent` zeigt versendete Mails.

## Konfiguration

Siehe `.env.example`. Ohne `DATABASE_URL` läuft PGlite (eingebettetes Postgres) als Datei; mit `DATABASE_URL` echtes PostgreSQL.
Der gleiche SQL-Code läuft auf beiden.
