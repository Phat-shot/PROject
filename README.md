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

Produktionsnaher Lauf mit PostgreSQL:

```bash
docker compose up --build     # App auf :3000, Postgres 16
```

Oder manuell: `DATABASE_URL=postgres://… npm run build && npm start`.

## Was die Alpha kann

**Projekttool**
- Projekte mit Kürzel, Rollen PL / Mitglied / Leser, zweiter PL als Stellvertretung, Einzelrechte („opt.“)
- Teilprojekte, Aufgaben, Tasks (Checkliste); Verantwortung wird vererbt (Aufgabe → Teilprojekt → PL) und als „geerbt“ markiert
- Zuweisung an Benutzer oder externe Mail-Adresse (Projektkontakte)
- Kanban: Spalten pro Projekt mit WIP-Limit, Swimlanes je Teilprojekt, Drag & Drop inkl. Sortierung, Labels, Filterleiste (Text, Person, Label, Priorität, nur meine, überfällig, Konflikte, Archiv), Tastaturkürzel f/q/n/x, Karten-Badges (Fälligkeit farbig, Beschreibung, Kommentare, Anhänge, Mails, Checklisten-Fortschritt), Schnellanlage, Spalten einklappen, Archivieren
- Wiederkehrende Aufgaben (W6): täglich, wöchentlich, monatlich, n-ter Wochentag; nächste Instanz nach Erledigung oder vor Fälligkeit
- Übersicht je Projekt (Kennzahlen, Fortschritt je Teilprojekt, Überfälliges, Konflikte, Meilensteine, Auslastung, offene Freigaben, Aktivität), Kalender (Deadlines, Meilensteine)
- In-App-Benachrichtigungen: Zuweisung, Kommentar, bald fällig, überfällig, Termin verschoben, Freigabe wartet, Seite in Prüfung, externe Bearbeitung
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
- Ordner mit Verteiler, Seitenbaum mit Unterseiten, Markdown-Editor mit Vorschau
- Versionen bei jeder Änderung, Konfliktschutz bei veralteter Version
- Status Entwurf → In Prüfung → Final; Final sperrt; Versand finaler Seiten an den Verteiler über das Projektkonto (W5, als Mailtext; PDF folgt)
- Vorlagen: Besprechungsprotokoll, Statusbericht, Konzept, RAID-Log, Änderungsantrag, Kickoff, Lessons Learned
- Freigabe per Link: Seite (wahlweise mit Unterseiten) an eine Mail-Adresse, lesend oder schreibend, mit Ablauf, widerrufbar, Versand über das Projektkonto; externe Änderungen werden mit der Adresse versioniert und gemeldet (`/s/<token>`)
- Anhänge an Seiten und Aufgaben

**Querschnitt**
- Zentrale Rechteprüfung in der API; Org-Admins sehen Projektinhalte nur als Mitglied; keine externen Gäste
- Audit-Log schreibt ausschließlich API/Worker; Org-Admin exportiert Metadaten über alle Projekte
- W10 Benutzer deaktivieren, W11 Projekt archivieren
- Mandanten-ID (`org_id`) von Anfang an im Datenmodell

## Noch nicht enthalten (laut Modulreihenfolge)

Kalender-Anbindung (M365/Google/CalDAV), Erinnerungen an Externe, Reports (W9), PDF-Erzeugung, OAuth2 für M365/Google,
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
