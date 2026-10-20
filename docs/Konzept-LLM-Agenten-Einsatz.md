# Konzept: LLMs und Agenten – Verwalter und Einsatz

Stand 20.10.2026 (Migration 060). Ergänzt Konzept-KI-Agent.md (Kapitel 8) und Konzept-Rechte-KI-Kommunikation.md (Kapitel 3, 17.3). Vorbild sind die Mail-Konten (Migration 058): ein Konto hat einen **Verwalter** und **Verwendungen**. LLMs und Agenten bekommen dasselbe Muster: einen **Verwalter** (Organisation oder ein Projekt) und einen **Einsatz** (alle Projekte, ausgewählte Projekte, nur das eigene Projekt).

## 1. Leitsätze

1. **Zwei Dinge, ein Muster.** Ein LLM (KI-Profil) und ein KI-Agent haben je einen Verwalter und einen Einsatz. Wer verwaltet, legt an, ändert und löscht; der Einsatz sagt, in welchen Projekten das LLM bzw. der Agent zur Verfügung steht.
2. **Org-Admin immer, PL wenn erlaubt.** Der Org-Admin (und das Org-Recht „KI verwalten“) legt LLMs und Agenten der Organisation an, immer. Die Projektleitung legt LLMs und Agenten ihres Projekts an, wenn der Mandant es erlaubt (Einstellung „Eigene LLMs der Projekte“: aus / nur persönliche Projekte / alle; KI-Freigabe „Eigene Agenten der PL“ mit höchstem Tagesbudget). Projekte entstehen durch Projektersteller; die PL eines Projekts ist, wer es angelegt hat oder wem es übergeben wurde.
3. **Ein Agent läuft nur dort, wo sein LLM freigegeben ist.** Der Einsatz eines Agenten ist höchstens so weit wie der Einsatz seines LLM: Aufnehmen in ein Projekt, Projektagent setzen und jeder Lauf prüfen, ob das LLM des Agenten im Projekt verfügbar ist. Wird eine Freigabe später enger, läuft der Agent dort nicht mehr („läuft nicht: LLM im Projekt nicht freigegeben“), die Mitgliedschaft bleibt sichtbar, damit die PL es sieht und handeln kann.
4. **Nichts ist von selbst frei** (wie bisher): KI-Freigaben (Notaus, Regeln), Ebene der PL („KI nutzen“, Mitgliedschaft), Profil, Budget bleiben die vier Prüfstufen. Dieses Konzept ordnet nur die Profilstufe neu und macht sie für beide Dinge gleich.
5. **Alle Einstellungen an einem Ort, nach Thema.** Verwaltung und Projekteinstellungen bekommen eine Abschnittsnavigation; alles zur KI steht in einem Abschnitt „KI“ mit vier Karten: LLMs, Agenten, Freigaben, Grenzen und Vorgaben.

## 2. Modell

### 2.1 LLM (ai_profiles)

| Feld | Bedeutung |
|---|---|
| Verwalter | `project_id` leer = Organisation; gesetzt = dieses Projekt (von der PL eingebunden) |
| Einsatz (`project_scope`) | Org-LLM: `all` (alle Projekte; `personal_scope` = auch persönliche), `selected` (Projekte in `ai_profile_projects`), `none` (kein Projekt: nur noch für den Verbindungstest, Agenten darauf laufen nirgends). Projekt-LLM: immer nur das eigene Projekt |
| Status | `active`, `admin_blocked` (der Org-Admin sperrt ein Projekt-LLM), Verbrauch (Token, zuletzt genutzt) |
| Verfügbar in Projekt P | `PROJECT_PROFILE_SQL`: aktiv, nicht gesperrt, und (Org-LLM mit Einsatz P) oder (Projekt-LLM von P und der Mandant erlaubt eigene LLMs für diese Projektart) |

### 2.2 Agent (users, kind = agent)

| Feld | Bedeutung |
|---|---|
| Verwalter | `agent_project_id` leer = Organisation; gesetzt = dieses Projekt (von der PL angelegt, Budget höchstens der Mandantenwert) |
| LLM | `ai_profile_id`, leer = Standardprofil des Mandanten (nur Org-Agenten) |
| Einsatz (`agent_scope`, neu) | Org-Agent: `all` (jedes Projekt darf ihn aufnehmen) oder `selected` (Projekte in `agent_projects`). Projekt-Agent: immer nur das eigene Projekt |
| Einsetzbar in Projekt P (`agentUsableIn`) | aktiv **und** Einsatz umfasst P **und** sein LLM ist in P verfügbar **und** (Org-Agent in persönlichem Projekt) sein LLM ist dort ausdrücklich freigegeben |

Die Prüfung läuft an drei Stellen mit derselben Funktion: beim Aufnehmen als Mitglied (`PUT /projects/:id/members/:userId`), beim Setzen als Projektagent (`PUT /projects/:id/agent`) und bei jedem Lauf (`aiConfigForAgent` liefert kein Profil, die Stufe „Profil“ der KI-Freigaben nennt den Grund). Beim Anlegen eines Projekt-Agenten wählt die PL nur aus den im Projekt verfügbaren LLMs.

### 2.3 Folgen von Änderungen

| Änderung | Wirkung |
|---|---|
| Einsatz eines Org-LLM wird enger, LLM deaktiviert oder gelöscht | Projekte verlieren es als Projekt-LLM (KI-Assistenz aus, bis die PL ein anderes wählt); Agenten mit diesem LLM laufen in den betroffenen Projekten nicht mehr, ihre Mitgliedschaft bleibt. Die Verwaltung zeigt beim Speichern eine Warnung mit den betroffenen Agenten und Projekten |
| Einsatz eines Org-Agenten wird enger | Er läuft in Projekten außerhalb des Einsatzes nicht mehr (Grund „nicht für dieses Projekt vorgesehen“); Mitgliedschaft und Zuständigkeiten bleiben sichtbar, die PL ersetzt ihn oder bittet den Org-Admin um Freigabe |
| Projekt-LLM gesperrt (Org-Admin) oder Mandant verbietet eigene LLMs | Projekt-Agenten auf diesem LLM laufen nicht, Projekt-LLM der Assistenz ist aus |
| Standardprofil des Mandanten geändert | gilt für Org-Agenten ohne eigenes LLM sofort, mit derselben Prüfung je Projekt |

### 2.4 Wer darf was

| Aktion | Org-Admin / KI-Verwaltung | PL im Projekt |
|---|---|---|
| Org-LLM anlegen, Einsatz setzen, Standard, löschen | ja | – |
| Projekt-LLM einbinden, testen, ändern | sperren/entsperren, Metadaten und Verbrauch sehen | ja, wenn „Eigene LLMs der Projekte“ es für die Projektart erlaubt und die KI-Freigabe `pl.own_llm` nicht sperrt |
| Org-Agent anlegen, LLM, Einsatz, Persona, deaktivieren | ja | – |
| Org-Agent ins Projekt aufnehmen | – | ja, wenn er dort einsetzbar ist (2.2); sonst nennt der Dialog den Grund |
| Projekt-Agent anlegen (nur eigenes Projekt) | sehen, deaktivieren | ja, wenn die KI-Freigabe „Eigene Agenten der PL“ erlaubt; LLM nur aus den im Projekt verfügbaren |
| Projekt-LLM der Assistenz wählen | – | ja, aus den verfügbaren |
| Projektagent (stellv. PL) setzen, Mail-Modus | – | ja, nur ein einsetzbarer Agent |

## 3. Oberfläche

### 3.1 Verwaltung (Org-Admin; KI-Verwaltung sieht nur „KI“)

Abschnittsnavigation oben: **Benutzer · Gruppen · Projekte · Kommunikation · Ressourcen · KI · Vorlagen · Mandant · Audit**. Jede Karte hat eine Anker-ID, die Reihenfolge folgt der Navigation.

Abschnitt **KI** mit vier Karten:

1. **LLMs** – eine Tabelle für Org- und Projekt-LLMs: Name · Verwalter (Organisation / Projekt X, von wem) · Einsatz (alle Projekte [+ persönliche] / n ausgewählte / nur Projekt X / keins) · Anbieter und Modell · Status (aktiv, inaktiv, gesperrt, Standard) · Verbrauch · Aktionen (Testen, Bearbeiten, Als Standard, Sperren bei Projekt-LLMs, Löschen). „LLM anlegen“ öffnet den Dialog mit Verwalter Organisation, Einsatz, Anbieter, Modell, Schlüssel, Denkmodus, Kontextgröße, Online-Recherche.
2. **KI-Agenten** – Name · Verwalter (Organisation / Projekt X) · LLM · Einsatz (alle / n Projekte / nur Projekt X) · Projekte (mit Markierung, wo er nicht läuft, und Grund) · Läufe · Aktionen. „Agent anlegen“: Name, Persona, LLM, Einsatz. Projekt-Agenten stehen in derselben Tabelle (nur deaktivierbar).
3. **KI-Freigaben** – Notaus und Matrix wie bisher.
4. **Grenzen und Vorgaben** – Tagesbudgets (Agent, Assistenz), Außenprüfung, Rechte der PL (eigene LLMs: aus / persönliche / alle; eigene Agenten: höchstes Budget, Regel in den Freigaben), Agenten-Policy des Mandanten, Online-Recherche, Arbeitszeitfenster.

### 3.2 Projekteinstellungen (PL)

Abschnitt **KI** (neu in der Navigation) mit einer Karte, die alles zur KI im Projekt bündelt:

- **LLM für die Assistenz:** Auswahl aus den verfügbaren LLMs; Liste der verfügbaren mit Verwalter und Einsatz („Organisation, alle Projekte“, „eigenes LLM“).
- **Eigene LLMs** (wenn erlaubt): wie bisher einbinden, testen, deaktivieren.
- **Agenten im Projekt:** alle Agenten, die Mitglied sind, mit Rolle, LLM und Einsetzbarkeit („läuft“ oder Grund); „Agent aufnehmen“ listet Org-Agenten mit Einsetzbarkeit und Grund; „Eigenen Agenten anlegen“ (wenn erlaubt).
- **Projektagent** und Mail-Modus, **Mail-Rückfrage**, **Agenten-Policy** (bisher in der Karte „Projekt“).

Die Karte „Projekt“ behält Kürzel, Mailadresse, Status, Ampel, Zeiterfassung, Vorlage, Archivieren.

## 4. API

| Route | Änderung |
|---|---|
| `GET /agents` | zusätzlich `scope`, `projectIds`, `profileName`, je Projekt `usable` und `reason` |
| `POST/PATCH /agents` | `scope: 'all' \| 'selected'`, `projectIds` (nur Projekte des Mandanten) |
| `GET /projects/:id/agents` | zusätzlich `orgAgents: { id, name, usable, reason, member }[]` für den Aufnahme-Dialog |
| `PUT /projects/:id/members/:userId`, `PUT /projects/:id/agent` | Agent nur, wenn `agentUsableIn` ja sagt (400 mit Grund) |
| `PATCH /ai/profiles/:id`, `PUT /ai/settings` (Standardprofil) | Antwort mit `warnings`: Agenten, die in Projekten nicht mehr laufen |
| `aiConfigForAgent(agent, projekt)` | Org-Agent: Profil muss im Projekt verfügbar sein (bisher nur in persönlichen Projekten geprüft) und der Einsatz muss das Projekt umfassen |

## 5. Migration 060

- `users.agent_scope text not null default 'all'` (all, selected), Tabelle `agent_projects (agent_user_id, project_id)`.
- Bestand: alle Org-Agenten behalten Einsatz „alle“; Mitgliedschaften bleiben. Agenten, deren LLM in einem Projekt nicht freigegeben ist, laufen dort ab jetzt nicht mehr (bisher nur in persönlichen Projekten geprüft) und erscheinen in der Verwaltung mit Grund.

## 6. Nicht Teil dieses Konzepts

- Die KI-Freigaben (Regeln je Mandant, Gruppe, Projekt, Person, Agent) bleiben unverändert; sie sperren, dieses Konzept stellt bereit.
- Die Agenten-Policy (Selbstständigkeit, Bestätigungen) bleibt unverändert.
