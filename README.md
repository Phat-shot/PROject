# PROject

## Was ist PROject

PROject ist ein Projektwerkzeug für Teams, die Aufgaben, Projektplan, Mail, Dokumentation und Chat nicht in fünf Programmen, sondern auf **einem Datenmodell** führen wollen. Ein Arbeitspaket hat Termin, Zuständigkeit, Log, Anhänge, verknüpfte Mails und eine eigene Antwortadresse; Protokolle und Konzepte liegen als Seiten im selben Projekt; das Board, der Plan (Gantt), der Kalender und die Auswertungen lesen dieselben Daten. Rechte werden zentral in der API geprüft, jede Änderung steht im Audit-Log.

Alle Abläufe (Eskalation, Erinnerungen, Berichte, Benachrichtigungen) laufen regelbasiert über API und Worker. KI ist das letzte Modul: KI-Agenten sind Benutzer ohne Login, die Arbeitspakete übernehmen, nachfragen, planen und Mails bearbeiten, immer innerhalb ihrer Rechte und mit Freigabe für wichtige Schritte („Regel vor KI“). Das Modell ist frei wählbar: Anthropic oder ein lokales LLM mit OpenAI-kompatibler API (vLLM, Ollama, LM Studio).

Gedacht ist PROject für kleine und mittlere Organisationen mit mehreren parallelen Projekten, die ihre Daten selbst betreiben wollen: ein Docker-Image, PostgreSQL, hinter dem eigenen Reverse-Proxy. Die Oberfläche ist deutsch und duzt. Stand: Alpha (`0.1.0-alpha`), produktiv im Eigenbetrieb, mit laufenden Änderungen; vor dem Einsatz den Abschnitt Status unten lesen.

## Schnellstart

Node 20 oder neuer. Ohne Postgres läuft eine eingebettete Datenbank (PGlite) als Datei unter `.data`.

```bash
npm install
npm run build -w packages/shared      # gemeinsame Typen bauen; ohne diesen Schritt startet die API nicht
npm run dev                            # API auf :3000, Web auf :5173 mit Proxy
```

Dann http://localhost:5173 öffnen. Beim ersten Aufruf erscheint die Ersteinrichtung (Mandant und erster Org-Admin). Wer stattdessen mit Demodaten starten will, setzt vor dem ersten Start `SEED=true` in `.env` (Vorlage `.env.example`; `npm run seed` legt sie nachträglich an).

### Demo-Zugänge

Passwort jeweils `demo1234`:

| Login | Rolle |
| --- | --- |
| pl@demo.local | Petra Lenz, PL „Website-Relaunch“, Mitglied „ERP“ |
| anna@demo.local | Anna Berger, Stellvertretung (zweiter PL) WEB, PL ERP |
| max@demo.local | Max Keller, Mitglied mit Recht „Projektplan ändern“ |
| leser@demo.local | Lea Reuter, Leser |
| admin@demo.local | Alex Admin, Org-Admin ohne Projektmitgliedschaft |

Demodaten sind nur zum Ausprobieren: Das Seeding ist opt-in (`SEED=true`) und wird in Produktion (`NODE_ENV=production`, so läuft das Image) ignoriert.

## Deployment (Kurzfassung)

Fertiges Image `ghcr.io/phat-shot/project` (amd64, arm64) hinter Traefik mit PostgreSQL:

```bash
cp deploy/.env.example deploy/.env           # POSTGRES_PASSWORD, DOMAIN eintragen
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

Update: `IMAGE_TAG` setzen, `pull` und `up -d`; Migrationen laufen beim Start. Backup-Profil `--profile backup` sichert täglich Datenbank und Datenverzeichnis `/data` (inkl. `secret.key`). Alles Weitere, insbesondere alle Umgebungsvariablen, Backup/Restore, Monitoring, SSO und Sicherheitshinweise: **[docs/Betrieb.md](docs/Betrieb.md)**.

Eigenbetrieb aus dem Quellcode ohne Traefik: `docker compose up --build` (App auf 127.0.0.1:3000).

## Dokumentation

| Dokument | Für wen |
| --- | --- |
| [docs/Kurzanleitung.md](docs/Kurzanleitung.md) | Neue Benutzer: Begriffe, Glossar, Navigation, tägliche Arbeit auf einer Seite (in der App unter Hilfe) |
| [docs/Handbuch.md](docs/Handbuch.md) | Alle Benutzer und Projektleitung: vollständige Bedienung je Bereich (in der App unter Hilfe) |
| [docs/KI-Handbuch.md](docs/KI-Handbuch.md) | Projektleitung, Mitglieder und KI-Verwaltung: Agenten einsetzen, steuern, kontrollieren; häufige Fragen (in der App unter Hilfe › KI-Agenten) |
| [docs/KI-Sheet.md](docs/KI-Sheet.md) | KI-Verwaltung und Entwickler: der feste Regelblock im Systemprompt jedes Agentenlaufs (in der App unter Hilfe) |
| [docs/Funktionen.md](docs/Funktionen.md) | Entscheider und Administratoren: was PROject heute kann, nach Themen |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Administratoren und Projektleitung: was sich wann geändert hat |
| [docs/Betrieb.md](docs/Betrieb.md) | Administratoren: Installation, Umgebungsvariablen, Update, Backup/Restore, Monitoring, SSO, Sicherheit |
| [docs/Telefonie.md](docs/Telefonie.md) | Administratoren: KI-Agent am Telefon mit sipgate einrichten |
| [docs/Betrieb-Update-2026-10.md](docs/Betrieb-Update-2026-10.md) | Administratoren: Verweis auf Betrieb.md (Inhalt dort integriert) |
| [docs/Konzept-Rechte-KI-Kommunikation.md](docs/Konzept-Rechte-KI-Kommunikation.md) | Entwickler: Hauptkonzept für Rechte, Benachrichtigungen, offene Fragen, Agenten-Policy, Außengrenze, Ressourcen, Datenmodell |
| [docs/Konzept-KI-Agent.md](docs/Konzept-KI-Agent.md) | Entwickler: Verhalten, Denktiefe, Ansprache und Steuerung der Agenten |
| [docs/Konzept-LLM-Agenten-Einsatz.md](docs/Konzept-LLM-Agenten-Einsatz.md) | Entwickler: Verwalter und Einsatz von LLMs und Agenten |
| [docs/Konzept-Einstellungen.md](docs/Konzept-Einstellungen.md) | Entwickler: die drei Einstellungsseiten mit gleichen Reitern |
| [docs/REVIEW-2026-11-06.md](docs/REVIEW-2026-11-06.md), [docs/REVIEW-2026-10-17.md](docs/REVIEW-2026-10-17.md) | Entwickler und Produktverantwortliche: Systemprüfungen mit Befunden und Empfehlungen |

## Für Entwickler

```
apps/api        Fastify + TypeScript, SQL-Migrationen (apps/api/migrations), Worker, Tests (node:test auf PGlite)
apps/web        React + Vite + TypeScript, ohne UI-Framework; bindet docs/*.md beim Build als Hilfe ein
apps/mobile     Android-Hülle (Capacitor) um die Server-Instanz, APK über .github/workflows/android.yml
packages/shared gemeinsame Typen (vor API und Web bauen)
deploy/         Produktions-Compose hinter Traefik
e2e/            Playwright-Smoketests
```

Befehle (Root): `npm run dev`, `npm run build`, `npm start`, `npm test` (API und Web), `npm run typecheck`, `npm run e2e`, `npm run seed`. `npm test` und `npm run typecheck` bauen `packages/shared` selbst; `npm run dev` nicht.

Konfiguration: `.env.example` (Entwicklung) und `deploy/.env.example` (Produktion). Ohne `DATABASE_URL` läuft PGlite, mit `DATABASE_URL` echtes PostgreSQL; der gleiche SQL-Code läuft auf beiden.

Dev-Hilfen (nur außerhalb `NODE_ENV=production`): `POST /api/dev/mail/inject` spielt eine Mail in ein Dev-Postfach, `POST /api/dev/mail/sync-all` synchronisiert alle Konten, `GET /api/dev/mail/sent` zeigt versendete Mails.

CI: `.github/workflows/ci.yml` führt `npm audit` (Produktionsabhängigkeiten), Typecheck, Tests, Build und die e2e-Tests aus; `docker.yml` baut und veröffentlicht das Image bei jedem Push (Tags Branch, Commit-SHA, `latest`, `v1.2.3`); `android.yml` baut die APK.

Hilfe in der App: `apps/web/src/pages/HelpPage.tsx` importiert Kurzanleitung, Handbuch, KI-Handbuch und KI-Sheet aus `docs/` per `?raw`; ein Test hält `docs/KI-Sheet.md` und `apps/api/src/ai/sheet.ts` gleich.

## Lizenz und Status

Alpha, Version `0.1.0-alpha`. Kein Lizenztext im Repository; Nutzung nach Absprache mit dem Eigentümer (Phat-shot). Offene Punkte und bekannte Lücken stehen in [docs/REVIEW-2026-11-06.md](docs/REVIEW-2026-11-06.md) und unter „Noch nicht enthalten“ in [docs/Funktionen.md](docs/Funktionen.md).
