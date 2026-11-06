# Änderungen

Zielgruppe: alle, die wissen wollen, was sich wann geändert hat (Administratoren vor einem Update, Projektleitung für die Kommunikation ans Team). Den vollständigen Funktionsumfang beschreibt [Funktionen.md](Funktionen.md); ältere Entwicklungsschritte stehen im Git-Log.

## 2026-11-06

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
