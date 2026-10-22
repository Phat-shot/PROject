# Betrieb: offene Schritte nach dem Update vom 22.10.2026 (PR #2)

Die App selbst übernimmt Watchtower nach dem Merge automatisch; Migration 068 läuft beim Start. Ohne die folgenden Schritte läuft alles weiter wie bisher.

## 1. Compose-Datei auf dem Server aktualisieren (einmalig)

Watchtower aktualisiert Images, nicht `deploy/docker-compose.yml`. Damit greifen:
- neues Watchtower-Image (gepflegter Fork `ghcr.io/nicholas-fedor/watchtower`, das bisherige `containrrr/watchtower` ist archiviert)
- `TRUST_PROXY` (Drosselung und Protokoll je Client statt je Traefik)
- Weitergabe von `OUTBOUND_ALLOW_HOSTS`

```bash
git pull   # oder deploy/docker-compose.yml und deploy/.env.example neu kopieren
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile autoupdate up -d   # ggf. zusätzlich --profile backup
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps   # Watchtower-Image: ghcr.io/nicholas-fedor/watchtower:1.21.2
```

Die Datenbank wird dabei nicht neu erstellt.

## 2. Nur bei Bedarf: interne Ziele freigeben

CalDAV, IMAP/SMTP und eigene LLMs der PL dürfen nicht ins interne Netz (LAN-IP, interner Hostname). Öffentliche Server sind nicht betroffen, LLM-Profile des Org-Admins auch nicht. Interne Dienste in `deploy/.env` freigeben:

```
OUTBOUND_ALLOW_HOSTS=nextcloud.lan,10.0.5.0/24
```

Danach `up -d` wie oben.

## 3. Nur bei Einführung von SSO (OIDC)

Liefert der Identitätsanbieter kein `email_verified` (z. B. Entra ID mit eigenem Tenant), `OIDC_TRUST_EMAIL=true` setzen; sonst werden Benutzer nicht per E-Mail zugeordnet.

## Verhaltensänderungen für Benutzer

- Passwort-Reset mit aktivem zweiten Faktor meldet nicht mehr direkt an: danach mit neuem Passwort und Code anmelden.
- Ein TOTP-Code gilt nur einmal; nach 5 falschen Codes neu anmelden.
- Agenten antworten Erstabsendern nie selbstständig, nur als Entwurf.
- Root-`docker-compose.yml` (Betrieb aus dem Quellcode): Demodaten nur noch mit `SEED=true`, Port nur an localhost.
- Android: Am Release hängt nur noch die signierte APK; die Debug-APK bleibt Workflow-Artefakt.
