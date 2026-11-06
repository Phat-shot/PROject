# Betriebshandbuch

Zielgruppe: Administratoren, die PROject installieren, aktualisieren, sichern und überwachen. Für die Bedienung siehe [Handbuch](Handbuch.md), für den Funktionsumfang [Funktionen](Funktionen.md).

## 1. Überblick

PROject ist ein Node-Prozess (Fastify-API, Worker und ausgelieferter Web-Client) mit PostgreSQL. Ohne `DATABASE_URL` läuft stattdessen PGlite (eingebettetes Postgres als Datei unter `DATA_DIR/pglite`); der gleiche SQL-Code läuft auf beiden. Migrationen laufen beim Start automatisch. Uploads, PGlite-Daten und der Schlüssel `secret.key` liegen im Datenverzeichnis `DATA_DIR` (im Container `/data`).

Drei Wege:

| Weg | Wofür | Datei |
| --- | --- | --- |
| Fertiges Image hinter Traefik | Produktion | `deploy/docker-compose.yml`, `deploy/.env` |
| Image lokal bauen | Eigenbetrieb aus dem Quellcode, Test | `docker-compose.yml` (Port nur auf localhost) |
| Ohne Docker | Entwicklung | `.env`, `npm run dev` bzw. `npm run build && npm start` |

## 2. Installation (Image, Compose, Traefik)

Das Image wird von `.github/workflows/docker.yml` bei jedem Push gebaut (amd64 und arm64) und unter `ghcr.io/phat-shot/project` veröffentlicht, mit den Tags Branch-Name, Commit-SHA, `latest` (Standard-Branch) und Versionen aus Git-Tags `v1.2.3`. Ist das Paket privat, vorher `docker login ghcr.io` mit einem Token mit `read:packages`.

Voraussetzung: Traefik läuft bereits mit dem externen Docker-Netz `proxy`, den Entrypoints `http`/`https` und dem Certresolver `http`. Die App veröffentlicht keine Ports selbst; der Router `projekttool` leitet HTTP auf HTTPS um.

```bash
git clone https://github.com/Phat-shot/PROject.git && cd PROject
cp deploy/.env.example deploy/.env           # POSTGRES_PASSWORD, DOMAIN eintragen
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile backup up -d      # zusätzlich tägliches Backup
docker compose -f deploy/docker-compose.yml --env-file deploy/.env --profile autoupdate up -d  # zusätzlich Watchtower
```

`PUBLIC_URL` ergibt sich aus `DOMAIN` als `https://DOMAIN`. Das Image läuft ohne Root, mit Healthcheck auf `/api/health`; Uploads und PGlite-Daten liegen im Volume `appdata` (`/data`), die Datenbank in `pgdata`.

Watchtower (Profil `autoupdate`, gepflegter Fork `ghcr.io/nicholas-fedor/watchtower`, per Digest gepinnt) prüft alle 5 Minuten und aktualisiert nur den App-Container. Für kontrollierte Updates `IMAGE_TAG` auf eine Version oder einen Commit-SHA setzen.

### Ohne Traefik oder aus dem Quellcode

```bash
docker compose up --build     # App auf 127.0.0.1:3000, Postgres 16
```

Für den Betrieb im Netz ist `deploy/docker-compose.yml` vorgesehen (TLS, `COOKIE_SECURE=true`). Manuell ohne Docker: `DATABASE_URL=postgres://… npm run build && npm start`.

## 3. Umgebungsvariablen

Quelle: `.env.example` (Entwicklung) und `deploy/.env.example` (Produktion). Werte in `deploy/.env` gehen über Compose in den Container; Variablen ohne Eintrag dort (z. B. `OAUTH_*`, `OIDC_*`) trägt man in `deploy/docker-compose.yml` unter `environment` nach oder übergibt sie per `env_file`.

### Compose (nur `deploy/.env`)

| Name | Pflicht | Standard | Bedeutung |
| --- | --- | --- | --- |
| `IMAGE` | nein | `ghcr.io/phat-shot/project` | Image aus der Registry |
| `IMAGE_TAG` | nein | `latest` | Tag des Images; für kontrollierte Updates Version oder Commit-SHA |
| `POSTGRES_PASSWORD` | ja | – | Passwort der Datenbank; Compose bildet daraus `DATABASE_URL` |
| `DOMAIN` | ja | – | Hostname, unter dem Traefik die App ausliefert; `PUBLIC_URL` = `https://DOMAIN` |

### App

| Name | Pflicht | Standard | Bedeutung |
| --- | --- | --- | --- |
| `DATABASE_URL` | nein | leer | PostgreSQL-Verbindung; leer = PGlite als Datei unter `DATA_DIR/pglite` |
| `PORT` | nein | `3000` | HTTP-Port der App |
| `DATA_DIR` | nein | `.data` (Image: `/data`) | Datenverzeichnis: Uploads, PGlite, `secret.key` |
| `PUBLIC_URL` | ja (Produktion) | `http://localhost:5173` | Öffentliche Basis-URL für Links in Mails, Freigabe-Links, OAuth-/OIDC-Redirects |
| `SEED` | nein | nicht gesetzt | `true` legt beim ersten Start Demodaten an (nur zum Ausprobieren, in Produktion gesperrt; Abschnitt 4) |
| `SYNC_INTERVAL_MS` | nein | `60000` | Takt des Workers (Mail-Synchronisation, Agenten-Wiedervorlagen, Erinnerungen) |
| `FILE_SYNC_INTERVAL_MS` | nein | `900000` (15 min) | Abgleich der Dateiquellen (Nextcloud/WebDAV), mindestens 60000; läuft neben dem Worker-Takt, ein langsamer Server hält Mails und Agenten nicht auf |
| `FILE_SYNC_MAX_FILES` | nein | `5000` | Höchstzahl Dateien je Quelle im Index; darüber bleibt der Index unvollständig (Hinweis an der Quelle), gelöscht wird dann nichts |
| `COOKIE_SECURE` | ja (Produktion) | `false` | `true` hinter TLS: Session-Cookie nur über HTTPS, setzt HSTS |
| `TRUST_PROXY` | nein | Produktion: `loopback,linklocal,uniquelocal` | Adressen oder Netze der vertrauenswürdigen Reverse-Proxys für `X-Forwarded-For` (Drosselung und Protokoll je Client); `true` vertraut jedem Proxy (nicht verwenden) |
| `OUTBOUND_ALLOW_HOSTS` | nein | leer | Interne Ziele, die Benutzer eintragen dürfen (CalDAV, IMAP/SMTP, eigenes LLM, Recherche, Dateiquellen): Hostnamen (auch `*.domain`) oder Netze, kommagetrennt, z. B. `nextcloud.lan,10.0.5.0/24` |
| `SECRET_KEY` | nein | leer | Schlüssel für gespeicherte Geheimnisse (AES-256-GCM); leer = Datei `DATA_DIR/secret.key` beim ersten Start erzeugt. Selbst gesetzt: mindestens 32 Byte Zufall, z. B. `openssl rand -hex 32`; nach dem ersten Start nicht mehr ändern. Bestandswerte (`enc1:`) bleiben lesbar und werden beim nächsten Speichern neu verpackt (`enc2:`) |
| `PASSWORD_SCRYPT_N` | nein | `131072` | Arbeitsfaktor der Passwort-Hashes (scrypt N, Zweierpotenz ≥ 16384); nur für Tests oder sehr schwache Hardware senken |
| `ANTHROPIC_API_KEY` | nein | leer | Anthropic-Schlüssel aus der Umgebung, nur für KI-Profile des Mandanten (nie für eigene LLMs der Projekte); alternativ im Profil hinterlegen |
| `LOG` | nein | `true` | `false` schaltet das Zugriffsprotokoll aus |
| `LOG_ERRORS` | nein | leer | gesetzt: Serverfehler mit Stacktrace auf stderr |
| `STATIC_DIR` | nein | `apps/web/dist` (Image: `/app/apps/web/dist`) | Verzeichnis des gebauten Web-Clients |
| `NODE_ENV` | nein | Image: `production` | `production` registriert keine Dev-Routen und verweigert `SEED` |
| `APP_VERSION` | nein | `dev` | Build-Version (Image: Git-SHA), sichtbar in `/api/health` und unten in der Leiste |

### Mail-Konten per OAuth2 (Knöpfe erscheinen nur mit gesetzten Werten)

| Name | Pflicht | Standard | Bedeutung |
| --- | --- | --- | --- |
| `OAUTH_MS_CLIENT_ID` | nein | leer | App-Registrierung in Entra ID; Redirect-URI `PUBLIC_URL/api/oauth/callback/microsoft` |
| `OAUTH_MS_CLIENT_SECRET` | nein | leer | Client-Secret der App-Registrierung |
| `OAUTH_MS_TENANT` | nein | `common` | Tenant-ID oder `common` |
| `OAUTH_MS_MODE` | nein | `graph` | `graph` (Mail und Kalender über Microsoft Graph) oder `imap` (IMAP/SMTP mit XOAUTH2, ohne Kalender) |
| `OAUTH_GOOGLE_CLIENT_ID` | nein | leer | OAuth-Client (Web) in Google Workspace; Redirect-URI `PUBLIC_URL/api/oauth/callback/google` |
| `OAUTH_GOOGLE_CLIENT_SECRET` | nein | leer | Client-Secret |

Berechtigungen (delegiert) bei Microsoft: `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite` (Graph) bzw. `IMAP.AccessAsUser.All`, `SMTP.Send` (Modus imap). Google-Scopes: `https://mail.google.com/` und `calendar.events`.

### Single Sign-on per OIDC

| Name | Pflicht | Standard | Bedeutung |
| --- | --- | --- | --- |
| `OIDC_ISSUER` | für SSO | leer | Issuer-URL, z. B. `https://login.microsoftonline.com/<tenant>/v2.0`; Redirect-URI `PUBLIC_URL/api/auth/oidc/callback` |
| `OIDC_CLIENT_ID` | für SSO | leer | Client-ID |
| `OIDC_CLIENT_SECRET` | für SSO | leer | Client-Secret |
| `OIDC_LABEL` | nein | `Single Sign-on` | Beschriftung des Knopfs auf der Anmeldeseite |
| `OIDC_AUTO_CREATE` | nein | `false` | `true` legt unbekannte Benutzer bei der ersten Anmeldung als Mitglied an |
| `OIDC_ORG_ID` | bei Auto-Create mit mehreren Mandanten | leer | Mandant, dem automatisch angelegte Benutzer zugeordnet werden; ohne Angabe nur bei genau einem Mandanten |
| `OIDC_TRUST_EMAIL` | nein | `false` | `true`, wenn der IdP nur geprüfte Adressen kennt, aber kein `email_verified` liefert (Entra ID mit eigenem Tenant); sonst werden Benutzer nicht per E-Mail zugeordnet |
| `OIDC_SCOPES` | nein | `openid email profile` | Scopes |
| `OIDC_GROUPS_CLAIM` | nein | `groups` | Claim im Userinfo; Gruppen mit „Gruppe beim Identitätsanbieter“ werden bei jeder Anmeldung abgeglichen |

## 4. Ersteinrichtung und Demodaten

**Persönliche Projekte und Assistenten (Admin-Schalter):** Verwaltung › Allgemein „Persönliche Projekte“ erlaubt allen, sich selbst ein persönliches Projekt anzulegen (Vorgabe). Davon unabhängig gibt es je Person unter Verwaltung › Personen die Freigabe „persönliches Projekt“ (freigegeben / gesperrt / nach Mandant): Einladungen ohne Projekt setzen sie standardmäßig auf „freigegeben“ und legen das Projekt beim Annehmen an (Opt-out-Haken in der Einladung); „gesperrt“ lässt ein bestehendes Projekt stehen und schaltet jede KI darin ab. LLMs des Mandanten sind für persönliche Projekte standardmäßig gesperrt; die Freigabe je LLM steht unter Verwaltung › KI („Persönliche Projekte“: nicht / alle / nur ausgewählte Personen). Den Assistenten legt die Person danach selbst an. Migration 075 überführt das frühere Kästchen „auch in persönlichen Projekten“ (true → alle).

**Ersteinrichtung (Normalfall):** Ohne `SEED` zeigt die App beim ersten Aufruf eine Ersteinrichtung, in der Mandant und erster Org-Admin angelegt werden; danach ist dieser Weg gesperrt. Anschließend unter Verwaltung › Mail das Org-Postfach anbinden (Einladungen, Passwort-Reset, Digest), unter Verwaltung › Personen Benutzer einladen, unter Verwaltung › KI bei Bedarf LLM und Agenten anlegen.

**Demodaten (nur zum Ausprobieren):** `SEED=true` legt beim ersten Start einen Demomandanten mit Projekten und Benutzern an (Passwort `demo1234`, Logins siehe README). Seeding ist opt-in: Ohne `SEED=true` passiert nichts, und mit `NODE_ENV=production` (so läuft das Image, auch über `deploy/docker-compose.yml`) wird `SEED=true` ignoriert. Demodaten gibt es also nur in der Entwicklung (`npm run dev`, `npm run seed`) oder mit der Root-`docker-compose.yml` und `NODE_ENV=development`. Demodaten gehören nicht auf eine Instanz, die im Netz erreichbar ist: Das Admin-Passwort ist öffentlich bekannt.

## 5. Update

```bash
# deploy/.env: IMAGE_TAG prüfen (latest oder feste Version)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

Migrationen laufen beim Start der App; die Datenbank wird nicht neu erstellt. Mit Profil `autoupdate` übernimmt Watchtower neue Images mit dem gewählten Tag selbst. Watchtower aktualisiert Images, nicht die Compose-Datei: Nach Änderungen an `deploy/docker-compose.yml` oder `deploy/.env.example` (neue Variablen) `git pull` und `up -d` wie oben.

Vor einem Update ein Backup ziehen (Abschnitt 6). Zurück auf eine ältere Version geht nur mit Restore, weil Migrationen nicht rückwärts laufen.

### Änderungen seit 22.10.2026 (ehemals Betrieb-Update-2026-10)

- Watchtower-Image gewechselt auf den gepflegten Fork, `TRUST_PROXY` und `OUTBOUND_ALLOW_HOSTS` in der Compose-Datei: einmal `git pull` und `up -d` mit den gewünschten Profilen.
- Interne Ziele (CalDAV, IMAP/SMTP, eigene LLMs der PL) sind gesperrt, bis sie in `OUTBOUND_ALLOW_HOSTS` stehen; öffentliche Server und LLM-Profile des Org-Admins sind nicht betroffen.
- SSO: liefert der IdP kein `email_verified`, `OIDC_TRUST_EMAIL=true` setzen.
- Verhalten für Benutzer: Passwort-Reset mit aktivem zweiten Faktor meldet nicht mehr direkt an; ein TOTP-Code gilt nur einmal, nach 5 falschen Codes neu anmelden; Agenten antworten Erstabsendern nie selbstständig; Root-Compose startet Demodaten nur noch mit `SEED=true` und veröffentlicht den Port nur auf localhost; Android: am Release hängt nur die signierte APK.

### Dateiquellen (Nextcloud, WebDAV)

- **Nur lesend:** Das Tool sendet `PROPFIND` (Tiefe 1, Ordner für Ordner, höchstens 12 Ebenen und 1000 Ordner) und `GET`; es schreibt nie in die Cloud. Gespeichert werden Metadaten und Textauszüge (bis 200 kB je Datei, Dateien bis 20 MB); Downloads gehen live durch.
- **Freigabelink:** `https://host/s/<token>` (auch mit Unterpfad, z. B. `https://host/nextcloud/index.php/s/<token>`) wird zu `https://host/public.php/webdav/` mit Basic-Anmeldung `<token>:<Passwort>`. Für einen Projektordner reicht ein Link „Nur lesen“, bei Bedarf mit Passwort und Ablaufdatum.
- **Konto:** `https://host/remote.php/dav/files/<benutzer>/` mit Benutzername und **App-Passwort** (Nextcloud: Einstellungen › Sicherheit › Geräte & Sitzungen). Am besten ein eigenes technisches Konto, dem die Ordner nur lesend freigegeben sind. Passwörter liegen verschlüsselt (`enc2`, Schlüssel `SECRET_KEY` bzw. `secret.key`).
- **Netz:** Alle Aufrufe laufen durch den SSRF-Schutz (keine internen Adressen, DNS-Pinning, keine Weiterleitungen, Zeitlimit 30 s je PROPFIND, 60 s je Textauszug). Eine Nextcloud im eigenen Netz muss in `OUTBOUND_ALLOW_HOSTS` stehen; leitet der Server um (z. B. http → https), die endgültige Adresse eintragen.
- **Last:** Nur geänderte Dateien (ETag) werden geladen, je Abgleich höchstens 300 Textauszüge, der Rest folgt im nächsten Lauf. Fehler stehen an der Quelle (`last_error`) und im Server-Log (`[worker] Dateiquelle …`).

## 6. Backup und Restore

Zu sichern sind drei Dinge:

1. **Datenbank** (`pg_dump`, Volume `pgdata`).
2. **Datenverzeichnis `/data`** (Volume `appdata`): Uploads und Anhänge, bei PGlite auch die Datenbank selbst.
3. **Schlüssel `secret.key`** in `/data` (oder `SECRET_KEY` aus `deploy/.env`). Ohne diesen Schlüssel sind alle gespeicherten Geheimnisse (Mail-Passwörter, OAuth-Tokens, KI-Schlüssel) im Backup wertlos.

Das Profil `backup` legt täglich ein `pg_dump` nach `./backups` ab (14 Tage Aufbewahrung) und sichert dort auch das Volume `appdata` (`/data` mit Uploads und `secret.key`) als `projekttool-appdata-<Datum>.tar.gz`. Das Verzeichnis `./backups` gehört auf einen anderen Rechner (rsync, Objektspeicher). Wer `SECRET_KEY` in `deploy/.env` setzt, sichert diese Datei getrennt.

Von Hand:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec db pg_dump -U projekttool -d projekttool -Fc > projekttool-$(date +%F).dump
docker run --rm -v projekttool_appdata:/data -v "$PWD":/out alpine tar czf /out/appdata-$(date +%F).tgz -C /data .
```

(Volume-Name laut `docker volume ls`; Präfix ist der Projektname von Compose.)

Restore:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env stop app
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T db pg_restore -U projekttool -d projekttool --clean --if-exists < projekttool-DATUM.dump
docker run --rm -v projekttool_appdata:/data -v "$PWD":/in alpine sh -c 'cd /data && tar xzf /in/appdata-DATUM.tgz'
docker compose -f deploy/docker-compose.yml --env-file deploy/.env start app
```

Nach dem Restore prüfen: `/api/health`, Anmeldung, ein Mail-Konto mit „Verbindung testen“ (beweist, dass der Schlüssel passt).

## 7. Monitoring

- `GET /api/health` antwortet `{ ok: true, db: "postgres" | "pglite", version: "<sha>" }`; der Container-Healthcheck ruft ihn alle 30 s. Ein externer Monitor prüft denselben Pfad über die Domain.
- Logs: `docker compose … logs -f app` (Zugriffsprotokoll, `LOG=false` schaltet es ab; `LOG_ERRORS=1` zeigt Stacktraces).
- Verwaltung › KI › KI-Log zeigt alle LLM-Aufrufe (Dauer, Status, Token, 90 Tage); Verwaltung › Daten den Audit-Export.
- Die Build-Version steht unten in der Leiste und in `/api/health`.

## 8. SSO (OIDC)

Unterstützt werden Entra ID, Keycloak, Authentik und andere OIDC-Anbieter mit Discovery. Ablauf: `OIDC_*` setzen (Abschnitt 3), Redirect-URI `PUBLIC_URL/api/auth/oidc/callback` beim Anbieter eintragen, App neu starten. Die Anmeldeseite zeigt dann den Knopf `OIDC_LABEL`; Verwaltung › Sicherheit zeigt den Stand.

- **Zuordnung:** per E-Mail-Adresse, nur mit `email_verified` (oder `OIDC_TRUST_EMAIL=true`). Der Name kommt aus den Claims.
- **Auto-Create:** `OIDC_AUTO_CREATE=true` legt unbekannte Benutzer als Mitglied an. Bei mehreren Mandanten in einer Instanz gibt `OIDC_ORG_ID` an, welchem Mandanten sie zugeordnet werden; ohne Angabe nur bei genau einem Mandanten.
- **Gruppen:** Berechtigungsgruppen mit „Gruppe beim Identitätsanbieter“ (Verwaltung › Personen › Gruppen) werden bei jeder Anmeldung aus dem Claim `OIDC_GROUPS_CLAIM` abgeglichen; Projektmitgliedschaften über Gruppen folgen sofort.
- Passwort-Login, Passwort-Reset und 2FA bleiben parallel möglich. PKCE und State sind aktiv.

## 9. OAuth-Mailkonten (Microsoft 365, Google)

Mit gesetzten `OAUTH_*`-Variablen erscheinen in Meine Einstellungen › Mail, Projekt › Einstellungen › Mail und Verwaltung › Mail die Knöpfe „Mit Microsoft 365 verbinden“ und „Mit Google verbinden“. Tokens werden verschlüsselt gespeichert und automatisch erneuert. Microsoft im Modus `graph` erlaubt zusätzlich das Eintragen von Terminen in den Kalender der Person; Google über `calendar.events`. IMAP/SMTP mit Passwort geht ohne diese Variablen.

## 10. Telefonie

Ein KI-Agent nimmt Anrufe über sipgate Flow entgegen; optional protokolliert sipgate.io Anrufe ohne KI. Die Instanz muss aus dem Internet erreichbar sein (über Traefik ist sie das). Einrichtung (Schlüssel, Rufnummern, Webhook-URLs, Signaturprüfung): [Telefonie.md](Telefonie.md).

## 11. Sicherheitshinweise

- `COOKIE_SECURE=true` hinter TLS setzen (deploy-Compose tut das); sonst gehen Session-Cookies über HTTP und HSTS fehlt.
- `TRUST_PROXY=true` nicht verwenden: Dann kann jeder Client seine Adresse per `X-Forwarded-For` wählen und die Drosselung je Adresse für Login und Passwort-Reset umgehen (die Drosselung je Konto greift weiterhin). Nur die Adressen oder Netze des eigenen Proxys eintragen (Standard: private Netze).
- `SECRET_KEY` mit 32+ Byte Zufall erzeugen (`openssl rand -base64 48`) oder die automatisch erzeugte `secret.key` mitsichern; Schlüssel nie in Git.
- `SEED` in Produktion nicht setzen (wird verweigert); eine Instanz mit Demodaten nie ins Netz stellen.
- `OUTBOUND_ALLOW_HOSTS` nur für Dienste öffnen, die Benutzer wirklich brauchen; jeder Eintrag erlaubt Verbindungen aus der App in dieses Netz.
- Dev-Routen (`/api/dev/*`) gibt es nur außerhalb `NODE_ENV=production`; Staging-Instanzen deshalb ebenfalls mit `production` betreiben.
- Datenbank-Port nicht veröffentlichen (die Compose-Dateien tun das nicht); `POSTGRES_PASSWORD` lang und zufällig.
- Image regelmäßig aktualisieren (Watchtower oder manuell); die CI führt `npm audit` für Produktionsabhängigkeiten aus.
- Backups verschlüsselt ablegen: Sie enthalten Mails, Dokumente und (mit `secret.key`) Zugangsdaten.
