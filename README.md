# Projekttool – Alpha (Konzept B)

Aufgaben, Projektplan, Mail und Dokumentation auf **einem Datenmodell** mit zentraler Rechteprüfung.
Umsetzung der Produktbeschreibung „Projekttool (Konzept B)“, Version 1.1. KI ist bewusst noch nicht enthalten
(letztes Modul); alle Abläufe laufen regelbasiert über API und Worker.

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
- Zeiterfassung als optionales Modul je Projekt: Buchung je Aufgabe oder frei, Schätzung je Aufgabe, Budget je Projekt, Auswertung je Person und Teilprojekt, CSV-Export, „Meine Zeiten“; Mitglieder sehen eigene Buchungen, PL alle
- Plan: Balken Start–Deadline, Punkt bei reiner Deadline, Teilprojekt-Sammelbalken, Meilensteine, Abhängigkeiten Ende → Anfang
- Konflikte werden markiert, nichts verschiebt sich automatisch; „Nachfolger verschieben“ mit Vorschau (W7)
- „Meine Aufgaben“ über alle Projekte, Suche, Audit-Log je Projekt (Mitglieder sehen eigene Aktionen)

**Mail**
- Konten persönlich oder Projektkonto; Adapter: IMAP/SMTP (imapflow, nodemailer) und Dev-Postfach im Speicher
- Konto ≠ Ansicht: geteilt werden nur Ansichten (Filter: Ordner, Absender/Domain, Empfänger, Betreff, Stichwort, ab Datum)
- Gespeichert werden **nur Treffer** einer Ansicht; Kopfdaten werden vor dem Laden des Bodys geprüft
- Rechte je Ansicht pro Person oder Rolle: Lesen, Entwurf, Senden, KI, Aufgabe erzeugen; aus persönlichen Konten sendet nur der Eigentümer
- Mail → Aufgabe (W3, vorbefüllt), Aufgabe → Mail (W4), verknüpfen oder kopieren (Kopie mit Bestätigung und Audit)
- Aktionen an einer Mail: verknüpfen/kopieren, ins Aufgaben-Log übernehmen, Aufgabe anpassen (Mail als Beleg), Aufgabe erstellen, in Doku ablegen (eigene Seite), an Seite anhängen (Abschnitt); KI-Varianten (Essenz einpflegen) als Platzhalter
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

**Querschnitt**
- Zentrale Rechteprüfung in der API; Org-Admins sehen Projektinhalte nur als Mitglied; keine externen Gäste
- Audit-Log schreibt ausschließlich API/Worker; Org-Admin exportiert Metadaten über alle Projekte
- W10 Benutzer deaktivieren, W11 Projekt archivieren
- Mandanten-ID (`org_id`) von Anfang an im Datenmodell

## Noch nicht enthalten (laut Modulreihenfolge)

Kalender-Anbindung (M365/Google/CalDAV), Erinnerungen an Externe, Reports (W9), OAuth2 für M365/Google,
Microsoft-Graph-Adapter, Keycloak/SSO, Row-Level Security, Office-Bearbeitung, KI (Chat, Vorschläge, RAG).

## Struktur

```
apps/api        Fastify + TypeScript, SQL-Migrationen, Worker, Tests (node:test auf PGlite)
apps/web        React + Vite + TypeScript, ohne UI-Framework
packages/shared gemeinsame Typen
```

Befehle: `npm run dev`, `npm run build`, `npm start`, `npm test`, `npm run typecheck`, `npm run seed`.

Dev-Hilfen (nicht in Produktion): `POST /api/dev/mail/inject` spielt eine Mail in ein Dev-Postfach, `POST /api/dev/mail/sync-all`
synchronisiert alle Konten, `GET /api/dev/mail/sent` zeigt versendete Mails.

## Konfiguration

Siehe `.env.example`. Ohne `DATABASE_URL` läuft PGlite (eingebettetes Postgres) als Datei; mit `DATABASE_URL` echtes PostgreSQL.
Der gleiche SQL-Code läuft auf beiden.
