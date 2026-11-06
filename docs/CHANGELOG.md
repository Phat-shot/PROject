# Änderungen

Zielgruppe: alle, die wissen wollen, was sich wann geändert hat (Administratoren vor einem Update, Projektleitung für die Kommunikation ans Team). Den vollständigen Funktionsumfang beschreibt [Funktionen.md](Funktionen.md); ältere Entwicklungsschritte stehen im Git-Log.

## 2026-11-06

- Dateiquellen (API; Web folgt): Nextcloud-Freigabelink oder WebDAV-Konto (App-Passwort) als lesende Quelle unter Doku › Dateien. Org-Admin: `GET/POST/PATCH/DELETE /file-sources` mit Freigabe für Projekte (all/selected/none) und persönliche Projekte (`personalUse` none/all/users); PL: `GET/POST /projects/:id/file-sources` (Org-Quelle mit Unterordner und Anzeigename einbinden oder eigene Quelle anlegen), `DELETE /projects/:id/file-sources/:sourceId`; Ordnerwahl `POST /file-sources/browse`, Abgleich von Hand `POST /file-sources/:id/sync`, sonst im Worker alle 15 min (`FILE_SYNC_INTERVAL_MS`). Liste `GET /projects/:id/files`, Textauszug `GET /files/:id/text`, Download live `GET /files/:id/download`. Index je Quelle einmal (Migration 077), Textauszug aus txt/md/csv/html/pdf/docx (neue Abhängigkeiten `unpdf`, `fflate` direkt), SSRF-Schutz über `pinnedFetch`.
- Agenten-Suche über Mails und Dateien: `search` mit `source`/`from`/`since`/`until`, neue Leseaktionen `read_mail` und `read_file`; Mails nur aus Ansichten mit KI-Recht, Dateien nur unter eingebundenen Unterordnern. Keine Doppelsuche: eine Abfrage über alle Projekte, jede Mail/Datei einmal, Laufcache („bereits gesucht, siehe oben“). Chat zeigt Mail- und Dateiausschnitte als „Treffer zur Nachricht“, der Projektdurchlauf „Neue Dateien seit letztem Lauf“. Neuer fester Block `SOURCES_RULES` (KI-Sheet), `DATA_RULE` nennt die Marker `<<<FILE … FILE>>>`.
- Persönlicher Assistent je Benutzer (API; Web folgt): Einladung ohne Projekt mit Haken „persönliches Projekt freigeben“ (Standard an) legt das persönliche Projekt beim Annehmen an; Freigabe je Person `personalProjectAllowed` (Verwaltung › Personen; false sperrt die KI im persönlichen Projekt mit Grund). LLM-Freigabe für persönliche Projekte je Mandanten-LLM (`personalUse` none/all/users, Migration 075 aus „auch in persönlichen Projekten“). Neuer Agententyp Assistent (`agent_role = 'assistant'`): die Person legt ihn im persönlichen Projekt selbst an (`GET/POST /projects/:id/assistant`), er ist dort gebunden, nicht in andere Projekte einladbar, antwortet nur auf Direktnachrichten, „persönlich“ ist sein sicheres Thema ohne Rückfrage. Persönliche Projekte starten schlank (zwei Spalten, Ordner „Notizen“, Checkliste, ohne Eskalation/Reporting) mit `policy.slim` und `showAllTabs`.
- Dokumentation neu geordnet: README als Einstieg, Funktionsübersicht in `docs/Funktionen.md`, Betriebshandbuch `docs/Betrieb.md` (Installation, Variablen, Update, Backup/Restore, Monitoring, SSO, Sicherheit), Glossar in der Kurzanleitung erweitert, Handbuch und Kurzanleitung auf die aktuellen Reiter gebracht.
- Demodaten nur noch mit `SEED=true`, in Produktion (`NODE_ENV=production`) verweigert.
- SSO: `OIDC_ORG_ID` legt bei automatischer Anlage den Mandanten fest.
- Backup-Profil sichert neben `pg_dump` auch das Datenverzeichnis `/data` mit `secret.key`.
- Systemprüfung: `docs/REVIEW-2026-11-06.md`.

## 2026-11-05

- Chat: Gespräche je Person archivieren (kommen mit der nächsten Nachricht zurück), Threads klappen direkt unter der Nachricht auf, Blasen-Optik, mobil feste Kopf- und Eingabezeile.
- Leiste: unter dem geöffneten Projekt die Doku als Untermenü (Besprechungen, Ordner, zuletzt geändert); ein Klick aufs Projekt öffnet weiter das Board.
- Projektreiter verschlankt: Besprechungen unter Doku, Kalender unter Plan, KI-Läufe unter Einstellungen; alte Adressen leiten weiter.

## 2026-10-22

- Watchtower-Image gewechselt (gepflegter Fork), `TRUST_PROXY` und `OUTBOUND_ALLOW_HOSTS` in der Compose-Datei; interne Ziele (CalDAV, IMAP/SMTP, eigene LLMs) nur noch mit Freigabe.
- `OIDC_TRUST_EMAIL` für Identitätsanbieter ohne `email_verified`.
- Passwort-Reset mit zweitem Faktor meldet nicht mehr direkt an; TOTP-Codes gelten nur einmal, nach 5 falschen Codes neu anmelden.
- Agenten antworten Erstabsendern nie selbstständig, nur als Entwurf.
- Root-Compose: Demodaten nur mit `SEED=true`, Port nur auf localhost. Android: am Release hängt nur die signierte APK.

## 2026-10-17 bis 2026-10-21

- Telefonie mit sipgate (Verwaltung › Telefonie), Einstellungen in drei Seiten mit gleichen Reitern (Konzept-Einstellungen), KI neu geordnet (LLM → Agent → Projekt, Migration 063), KI-Feedback, Postfach-Arten, Ungelesen je Person, Mail-KI nur durch Agenten, Projektwissen und Projektdurchlauf, Ressourcen im Kalender, Online-Recherche, Agenten-Policy und Steuerung im Chat. Details: [Funktionen.md](Funktionen.md), Systemprüfung `docs/REVIEW-2026-10-17.md`.
