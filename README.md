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
- Projekte mit Kürzel, Rollen PL / Mitglied / Leser, zweiter PL als Stellvertretung, Einzelrechte („opt.“)
- Teilprojekte, Aufgaben, Tasks (Checkliste); Verantwortung wird vererbt (Aufgabe → Teilprojekt → PL) und als „geerbt“ markiert
- Zuweisung an Benutzer oder externe Mail-Adresse (Projektkontakte)
- Kanban: Spalten pro Projekt mit WIP-Limit, Swimlanes je Teilprojekt, Drag & Drop inkl. Sortierung, Labels, Filterleiste (Text, Person, Label, Priorität, nur meine, überfällig, Konflikte, Archiv), Tastaturkürzel f/q/n/x, Karten-Badges (Fälligkeit farbig, Beschreibung, Kommentare, Anhänge, Mails, Checklisten-Fortschritt), Schnellanlage, Spalten einklappen, Archivieren
- Wiederkehrende Aufgaben (W6): täglich, wöchentlich, monatlich, n-ter Wochentag; nächste Instanz nach Erledigung oder vor Fälligkeit
- Übersicht je Projekt (Kennzahlen, Fortschritt je Teilprojekt, Überfälliges, Konflikte, Meilensteine, Auslastung, offene Freigaben, Aktivität), Kalender (Deadlines, Meilensteine)
- In-App-Benachrichtigungen: Zuweisung, Kommentar, @-Erwähnung, bald fällig, überfällig, Termin verschoben, Freigabe wartet, Seite in Prüfung, externe Bearbeitung
- @-Erwähnungen in Kommentaren mit Vervollständigung über Projektmitglieder
- Eskalationsregelwerk je Projekt (Regel vor KI): Verzug, Stillstand („hängt“) und Blockaden eskalieren entlang Zuständig → Teilprojekt-Verantwortung → PL → Eskalationskontakt (intern oder extern per Mail, als Entwurf zur Freigabe oder direkt); Kritikalität aus Priorität, Nachfolgern, nahem Meilenstein und Blockade halbiert die Fristen; jede Stufe mit Benachrichtigung und Log-Eintrag, automatische Rücksetzung; „Blockiert“-Meldung an der Aufgabe; Warnungen in der Übersicht; manuelle Eskalation
- Reporting je Projekt (Regel vor KI): Vorlage (z. B. Statusbericht) im Rhythmus wöchentlich / zweiwöchentlich / monatlich; der Worker legt die Seite unter der gewählten Oberseite oder im Ordner „Berichte“ an, ergänzt Kennzahlen (Fortschritt, erledigt seit letztem Bericht, Verzug, Blockaden, Eskalationen, Meilensteine, gebuchte Zeit) und versendet sie als PDF über das Projektkonto an den Empfängerkreis; Modus „Prüfung“ (Entwurf, PL setzt final und versendet) oder „direkt“; manueller Lauf „Jetzt erzeugen“ in den Projekteinstellungen
- Navigation: „Projekte“ mit Gesamtsicht aller Aufgaben und gemeinsamem Postfach über alle lesbaren Mail-Ansichten; je Projekt Übersicht, Aufgaben, Postfach, Doku, Einstellungen (PL); Projekt-Sichtbarkeit „nur Mitglieder“ oder „alle Benutzer des Mandanten (lesend)“
- Hierarchie Projekt › Teilprojekt › Arbeitspaket › Task; „Meine Arbeit“ zeigt geklammert nur eigene und vererbte Zuständigkeit; Arbeitspakete, Tasks und Teilprojekte direkt editierbar; Wechsel der Verantwortung fragt, ob direkt zugewiesene Arbeitspakete mit übertragen werden
- Benutzer einladen per Mail über das Org-Postfach (Kontotyp „org“), Annahme mit Passwort unter /einladung/:token, manuelles Anlegen als Fallback
- Berechtigungsgruppen des Mandanten; eingeschränkte Teilprojekte (nur PL, Verantwortliche, benannte Benutzer und Gruppen); Gruppen auch in Mail-Ansicht-Rechten
- Interaktives, überspringbares Tutorial beim ersten Login, jederzeit neu startbar
- Dashboard: Soll/Ist der eigenen Arbeit über alle Projekte (offen, überfällig, fällig, blockiert, im Plan), Termine, Meldungen, geklammerte Sicht Projekt › Teilprojekt › Arbeitspaket › Task
- Kanban-Spaltenarten Geplant / in Bearbeitung / Zurückgestellt / Erledigt; nur aktive Spalten zählen als Stillstand für die Eskalation
- Projekt-Postfach als Posteingang aller Ansichten mit Ordnern (Posteingang, Gesendet, Archiv, Papierkorb, Unterordner), Filter je Ansicht; Mails archivieren, löschen, verschieben, Unterordner anlegen (IMAP und Datenbank synchron); Ansichten und Filter in den Projekteinstellungen
- Einstellungen: Benutzereinstellungen (Name, Theme hell/dunkel/System, Sprache, Passwort), Konfiguration (Mail-Konten persönlich, Projekt, Organisation; Org-Admin verwaltet Projekt- und Org-Konten, PL die Konten seiner Projekte), Verwaltung
- Tasks mit externer Mail-Zuständigkeit; „Stand nachfragen“ aus Arbeitspaket und Task mit vorbelegter Mail, Antwort landet über die Antwortadresse im Arbeitspaket
- Zeiterfassung als optionales Modul je Projekt: Buchung je Aufgabe oder frei, Schätzung je Aufgabe, Budget je Projekt, Auswertung je Person und Teilprojekt, CSV-Export, „Meine Zeiten“; Mitglieder sehen eigene Buchungen, PL alle
- Plan: Balken Start–Deadline, Punkt bei reiner Deadline, Teilprojekt-Sammelbalken, Meilensteine, Abhängigkeiten Ende → Anfang
- Konflikte werden markiert, nichts verschiebt sich automatisch; „Nachfolger verschieben“ mit Vorschau (W7)
- „Meine Aufgaben“ über alle Projekte, Suche, Audit-Log je Projekt (Mitglieder sehen eigene Aktionen)

**Mail**
- Konten persönlich oder Projektkonto; Adapter: IMAP/SMTP (imapflow, nodemailer), Microsoft Graph und Dev-Postfach im Speicher; OAuth2 für Microsoft 365 (Graph oder IMAP-XOAUTH2) und Google (IMAP/SMTP-XOAUTH2) mit Token-Refresh, Knöpfe „Mit Microsoft 365/Google verbinden“ in Konfiguration und Projekteinstellungen (Variablen `OAUTH_*` in `.env.example`)
- Konto ≠ Ansicht: geteilt werden nur Ansichten (Filter: Ordner, Absender/Domain, Empfänger, Betreff, Stichwort, ab Datum)
- Gespeichert werden **nur Treffer** einer Ansicht; Kopfdaten werden vor dem Laden des Bodys geprüft
- Rechte je Ansicht pro Person oder Rolle: Lesen, Entwurf, Senden, KI, Aufgabe erzeugen; aus persönlichen Konten sendet nur der Eigentümer
- Mail → Aufgabe (W3, vorbefüllt), Aufgabe → Mail (W4), verknüpfen oder kopieren (Kopie mit Bestätigung und Audit)
- Aktionen an einer Mail: verknüpfen/kopieren, ins Aufgaben-Log übernehmen, Aufgabe anpassen (Mail als Beleg), Aufgabe erstellen, in Doku ablegen (eigene Seite), an Seite anhängen (Abschnitt); KI: Zusammenfassen, Essenz → Arbeitspaket (Vorschlag), Essenz → Seite (Vorschlag)
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

**KI (letztes Modul, Regel vor KI)**
- Anthropic-Anbindung je Mandant (Verwaltung › KI: an/aus, Schlüssel nur schreibend, Modell wählbar; alternativ `ANTHROPIC_API_KEY`); jede Anfrage im Audit mit Modell und Token
- Rechte: „KI nutzen“ und „KI-Vorschläge freigeben“ in der Projektmitgliedschaft, „KI“ je Mail-Ansicht; PL darf alles
- Zusammenfassen direkt (an der Mail gespeichert); Essenz → Arbeitspaket (Log-Eintrag, erkannter Status/Termin, offene Fragen) und Essenz → Seite (Abschnitt im Stil der Seite) nur als Vorschlag; Freigabe unter Projekt › KI mit Bearbeitung vor dem Anwenden, Log-Einträge tragen die Quelle „KI“
- Frage ans Projekt (RAG-lite): Stichwortsuche über Arbeitspakete, Seiten und lesbare Mails, Antwort mit Quellenangabe
- Statusbericht-Entwurf aus Kennzahlen des Regelwerks, RAID, Ampel und Log als Entwurfsseite in „Berichte“

**Besprechungen**
- Besprechung als Objekt unter Arbeitspakete › Besprechungen: Termin, Ort, Agenda, Teilnehmer aus Mitgliedern, Kontakten und freien Adressen, Zuordnung zu einer Besprechungsreihe
- Protokollseite aus der Vorlage der Reihe (sonst „Protokoll“ im Ordner „Protokolle“) mit Termin und Teilnehmern vorbelegt; Aktionspunkte direkt als Arbeitspakete mit Zuständigem und Termin, bestehende Arbeitspakete verknüpfen; Arbeitspaket zeigt die Besprechung
- Einladung mit Kalendereintrag (ICS, METHOD:REQUEST) über das Projektkonto an alle Teilnehmer, Aktualisierung mit Sequenz; ICS-Download für den eigenen Kalender; Besprechungen im Projekt- und Gesamtkalender und im ICS-Abo

**Auswertungen (W9)**
- Je Projekt unter Arbeitspakete › Auswertung: Durchsatz je Woche (angelegt/erledigt), Durchlaufzeit (Median, Durchschnitt, längste), Verzug nach Alter, Eskalationen je Zeitraum und aktuell, je Teilprojekt; Zeitraum wählbar, alles als CSV
- Board und Plan als CSV (Excel), Zeiten über alle Projekte im Portfolio je Projekt und Person

**Identität und Sicherheit**
- Single Sign-on per OIDC (Entra ID, Keycloak, Authentik …) mit Zuordnung per E-Mail, optionaler Auto-Anlage (`OIDC_*` in `.env.example`); Passwort-Login, Passwort-Reset und 2FA (TOTP) bleiben
- Rate-Limit für Login und Reset, Sicherheits-Header, Sitzungen per httpOnly-Cookie, CSRF-Prüfung über Origin/Referer
- Gespeicherte Geheimnisse (Mail-Passwörter, OAuth-Tokens, KI-Schlüssel) verschlüsselt (AES-256-GCM, Schlüssel `SECRET_KEY` oder `DATA_DIR/secret.key`); Uploads ohne ausführbare Dateien, aktive Inhalte nur als Download; `npm audit` für Produktionsabhängigkeiten in der CI

**Querschnitt**
- Zentrale Rechteprüfung in der API; Org-Admins sehen Projektinhalte nur als Mitglied; keine externen Gäste
- Audit-Log schreibt ausschließlich API/Worker; Org-Admin exportiert Metadaten über alle Projekte
- W10 Benutzer deaktivieren, W11 Projekt archivieren
- Mandanten-ID (`org_id`) von Anfang an im Datenmodell

## Noch nicht enthalten

Kalender-Schreibzugriff per API (M365/Google/CalDAV; heute ICS-Abo, ICS-Einladungen und ICS-Download), Row-Level Security in der Datenbank
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
