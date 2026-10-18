# Integriertes Konzept PROject: Rechte, KI-Steuerung, Kommunikation, Agenten, Externe, Ressourcen

## Entscheidungen (18.10.2026)

| Nr. | Frage | Entscheidung |
|---|---|---|
| 1 | In welcher Reihenfolge sollen die Phasen umgesetzt werden? | Sicherheit und Steuerung zuerst: Sofort-Fixes, KI-Freigaben, Außengrenze, Rechte, Benachrichtigungen, Fragen, Agenten-Policy, Chat-Steuerung, Recherche, Projektwissen, Ressourcen, Portal |
| 2 | Sollen externe Personen eigene Konten (Portal) bekommen? | Jetzt nur Externe als Mailadressen mit Informationsgrenze; Portal mit Aufgabenzugriff später als optionale Phase P11 |
| 3 | Wie streng sollen Mails von Agenten an Nicht-Interne behandelt werden? | strict: das System formuliert die Mail mit nur dem Aufgabenkontext neu und prüft sie danach deterministisch (ein kleiner Zusatzaufruf je externer Mail) |
| 4 | Wer darf Agenten im Chat neue Arbeit geben? | PL und Stellvertretung; je Projekt erweiterbar auf TP-Verantwortung, Zuständige oder alle Mitglieder; alle anderen erzeugen einen Vorschlag an die PL |
| 5 | Wie gibt die PL im Chat frei? | Aufträge der PL (neue Arbeit) führt das System sofort aus; angehaltene Aktionen bestätigt sie mit einem Klick auf die Karte, die direkt unter ihrer Nachricht erscheint |
| 6 | Welche Selbstständigkeit gilt standardmäßig, und was passiert mit bestehenden Projekten? | Neue Projekte: „Rückfrage bei wichtigen Schritten“ (Final setzen, PDF an Verteiler, Mails nach außen, Erledigt, Umstrukturieren); bestehende Projekte bekommen bei der Migration „Selbstständig“, damit sich nichts unbemerkt ändert |
| 7 | Welche KI-Regel gewinnt, wenn sich Projekt- und Personenregeln widersprechen? | Sperre gewinnt: ist ein Projekt gesperrt, hilft eine Personenfreigabe nicht; eine Ausnahme gibt es nur über eine Regel „Person in Projekt“; die PL kann Freigaben im Projekt weiter einschränken, der Notaus gilt immer |
| 8 | Wie verhalten sich direkte Mitgliedschaft und Gruppenmitgliedschaft im Projekt zueinander? | Der Direkteintrag überschreibt alle Gruppen; zwischen mehreren Gruppen gilt die höchste Rolle, Einzelrechte werden ODER-verknüpft |
| 9 | Wie verhalten sich offene Fragen bei Klick, Frist und Weitergabe? | Klick markiert nur als gesehen, die Frage bleibt unter „Offen für mich“, bis jemand antwortet oder sie abgebrochen wird; das System fasst ohne KI nach und gibt nach Frist an die nächste Stufe weiter; die Kette endet im Projektkanal (nicht bei eingeschränkten Teilprojekten); die erste gültige Antwort schließt die Frage |
| 10 | Wie soll die Online-Recherche bereitgestellt werden? | Anthropic web_search für Anthropic-Profile, optional SearXNG oder Brave für lokale Profile; standardmäßig gesperrt, Freigabe durch den Org-Admin je Mandant, Projekt oder Agent; nur lesen, Quellen werden gespeichert |
| 11 | Welchen Umfang soll die erste Ressourcen-Phase haben? | Pool des Mandanten und Ressourcen je Projekt, externe Personen (z. B. Elektriker) als Ressource vom Typ Person, Abwesenheiten interner Personen, Konflikt übersteuern nur PL oder „Projektplan ändern“, Freigabegruppe je Ressource optional; keine Belegt-Zeiten aus Outlook, Google oder CalDAV |
| 12 | Welche Reichweite haben Agenten standardmäßig? | Reichweite „zugewiesene APs“ mit relevantem Projektwissen; Überschneidungen werden bei den Zuständigen bzw. der PL nachgefragt; der Projektagent (täglicher Durchlauf über das ganze Projekt) ist ein Modus, den die PL einschaltet, und läuft werktags |

Alle Entscheidungen folgen der Empfehlung; 1–6, 10, 11 wurden ausdrücklich gewählt, 7, 8, 9 und 12 sind als Standard übernommen. P11 (Externe Konten) entfällt vorerst.

## Umsetzungsplan

| Phase | Umfang | Migration | Abhängig von |
|---|---|---|---|
| P0 Sofort-Fixes (ohne Migration) | Behebt verifizierte Fehler ohne neues Datenmodell. doc_send_pdf an genannte Empfänger nur für finale Seiten; Nicht-Interne nur über Verteiler oder aktive doc_shares (agent.ts:349-358). orgAiSettings: `?? 50` statt `// 50`, damit ein Budget von 0 gilt (client.ts:37). Leser mit „KI nutzen“ dürfen /ai/ask (ai.ts:28). Eine Stellvertretung kann sich nicht selbst zur verantwortlichen PL machen (projects.ts:216). notify() überspringt Agenten und inaktive Benutzer. Im Projektkanal schreiben nur explizite Mitglieder (chat.ts:116). Agenten-Entwürfe ohne view_id: PATCH und DELETE über canManageAccount; Ablehnen schreibt ins Log und startet einen Lauf. Eigene Anthropic-LLMs eines Projekts nutzen nie ANTHROPIC_API_KEY; der LLM-Test prüft ownLlm. Ein manueller Agentenlauf beachtet agent_paused und Budget. Das Budget zählt nur ok und error. agentEvents: Dirty-Flag statt verworfener Ereignisse. triggerText bekommt Texte für changed und periodic und empfiehlt bei reminder_due den Chat. ChatPane: Intervall über useRef (Thread). Dashboard: Klick markiert als gelesen. Handbuch aktualisieren. | – | – |
| P1 KI-Freigaben und Notaus | Anforderung 5. Tabelle ai_policies (Ort × Wer × Funktion × allow/deny), Notaus orgs.settings.ai.enabled, Org-Rechte users.org_rights (ai_admin, groups_admin, resources_admin), Funktionskatalog AI_FEATURES. ai/policy.ts: aiAllowed() mit Prüfstufen Notaus → Org-Regeln (Regel K) → PL-Ebene → Profil → Budget, jeweils mit Begründung und Spur. client.ts: aiConfigFor(); aiConfigForProject und aiConfigForAgent werden intern. Alle 11 complete()-Wege werden umgestellt, dazu canUse, checkPolicy, setViewAi, die Mail-Aktionen (mail.ts:720), Mail-KI-Läufe, Agentenläufe (Worker, Ereignis, manuell) und Chat. Beim Chat werden Absender und Agent geprüft. Eine Projektsperre gilt auch für Org-Agenten; pl.agents wird auch bei laufenden PL-Agenten geprüft. Gesperrte Läufe werden als skipped mit Begründung protokolliert. Budget für assist.* je Projekt (assistDailyBudget). Routen /ai/policies, /ai/policies/effective, /ai/policy-targets, /projects/:id/ai/capabilities. Oberfläche: Karte „KI-Freigaben“ mit Notaus, Matrix und Vorschau, Verwaltung › KI auch für ai_admin, Knöpfe mit Begründung. | 043_ai_policy.sql | P0 Sofort-Fixes (ohne Migration) |
| P2 Informationsgrenze für Externe | Anforderung 8. outbound.ts: audienceOf() (Regel E: internal, outside, task_external, unknown_external), externalContext(), composeExternal() (Neuformulierung nur mit Außenkontext, Stufe strict) und checkOutbound() (deterministisch: fremde Kennungen, Titel anderer APs, TPs und nicht freigegebener Seiten, interne Adressen, App-Links, nicht freigegebene Anhänge). Gilt für Agent-mail, reply_origin und doc_send_pdf; Mail-KI reply_draft und aiFinalReply werden nur geprüft (Hinweise). Erster Kontakt an unknown_external immer als Entwurf. Tabelle outbound_checks, task_comments.visibility, tasks.external_brief, projects.external_profile. Aktion refer (vorläufig: Log, Meldung und DM an die erste Person der Kette; ab P5 als Frage). Prompt kennzeichnet eingehende Mails nach Absenderklasse. Sheet-Satz zu Externen. Oberfläche: Mail › Freigaben „Außenprüfung angehalten“ mit Fundstellen und „Bearbeiten und senden“; TaskDrawer mit Außenbeschreibung und Badge „für Externe sichtbar“; MembersView-Karte „Außenkommunikation“. | 044_outbound_guard.sql | P1 KI-Freigaben und Notaus |
| P3 Rechte, Rollen, Gruppen | Anforderung 3. Gruppen als Projektmitglied (project_groups, Rolle reader/member plus Einzelrechte), project_members.origin, syncProjectGroups(); Aufrufe bei Änderungen an project_groups und group_members, beim SSO-Abgleich, beim Deaktivieren und beim Löschen eines Direkteintrags. Regel M: Direkteintrag überschreibt, zwischen Gruppen gilt das Maximum. Gruppenverwalter (group_members.is_manager) und Org-Recht groups_admin. PATCH /users/:id für Rolle, Org-Rechte und Reaktivieren, mit Schutz des letzten Org-Admins und des eigenen Zugangs. requireTask() an den Stellen aus Lücke 6 (tasks.ts, time.ts:88, docs.ts:497, mail/access.ts:19). can_use_ai einheitlich vorbelegt (Mitglied an, Leser aus). can_approve heißt „Freigeben“. groupRecipients() für spätere Regeln. Org-Admin kann die verantwortliche PL neu bestimmen, ohne Inhaltszugriff. Oberfläche: AdminPage (Benutzer, Gruppen mit Verwaltern), MembersView (Spalte Herkunft, „Gruppe hinzufügen“, „überschreibt Gruppe“), InviteCard. | 045_groups_rights.sql | P1 KI-Freigaben und Notaus |
| P4 Benachrichtigungsregeln mit Vererbung | Anforderung 4. Ereigniskatalog NOTIFY_EVENTS mit NOTIFY_DEFAULTS. Tabelle notification_rules mit den Ebenen Org, Projekt, AP, Benutzer, Benutzer im Projekt und Benutzer am AP; Sperren nur auf Org und Projekt. rules.ts mit resolveRule() (Regel N). notify() löst Mail-Modus und Kanäle selbst auf, schreibt event, ref und mail in die Meldung und filtert Agenten, Inaktive und den Auslöser. dispatch() löst Empfängerrollen inklusive Gruppen auf. Kanäle In-App (Pflicht), Chat (off, thread, project; Systembeitrag mit chat_messages.kind='system'), Mail (off, now, digest), Log (task_comments source system) und Doku (Seite „Entscheidungen und Meldungen“, nicht bei eingeschränkten TPs). notifyMail: Modus je Meldung, Digest-Stunde der Org in Europe/Berlin (dueLocal), Fehler ins Audit. markRead koppelt chat.*-Meldungen; Thread laden markiert dessen Meldungen. Backfill aus users.settings.mailNotifications. Oberfläche: AdminPage-Karte „Kommunikation“ (Matrix mit Schlössern), MembersView-Abschnitt „Kommunikation“ mit Vorschau „Wer bekommt was?“, UserSettings-Matrix mit „Projekt stummschalten“, Glocke mit Filtern und gemeinsamem openNotification(). | 046_notification_rules.sql | P3 Rechte, Rollen, Gruppen |
| P5 Offene Fragen und Synchronität | Anforderung 2. Tabelle questions (alle Arten). questions.ts: askQuestion, answerQuestion (idempotent), cancelQuestions, escalateQuestion, runQuestions (Worker, ohne KI). contactChain() in tasks/service.ts (Regel C). Agentenaktionen ask, resolve, escalate (eine Meldung), refer als Frage external_referral. createPlannedEvent erzeugt eine Frage confirm; /meetings/:id/confirm beantwortet sie, DELETE bricht sie ab. Kommentare mit questionId; AP erledigt, archiviert, gelöscht oder Zuständigkeitswechsel bricht Fragen ab. Regel F ersetzt answeredTask; der Regex bleibt 14 Tage als Rückfall. agent_wait.questionId; runAgents überspringt Fristen-Läufe für Fragen; das Laufende löscht Warten nur ohne offene Frage. Chat: Threads auch in DMs, GET /chat/messages/:id, Deep-Link ?thread=&msg=, Scrollen, Hervorheben, Fokus, Thread-Kopf mit Status. TaskDrawer-Block „Offene Fragen“; Glocke „Offen für mich“; Dashboard-KPI. Sheet: Absätze Kommunikation und Warten auf ask umgestellt. | 047_questions.sql | P4 Benachrichtigungsregeln mit Vererbung |
| P6 Agenten-Policy: Selbstständigkeit und Bestätigungen | Anforderung 6 (Teil Autonomie). Stufen auto, confirm_critical und confirm_all mit Aktionsklassen. Vererbung Org → Projekt → Agent im Projekt → AP mit maxMode und lockedConfirm (Regel A). effectiveAgentPolicy() liefert die Herkunft je Feld. gateAction() → run, hold oder deny; deny über ai_policies agent.<klasse>. applyAgentAction() wird aus der Laufschleife herausgelöst. Angehaltene Aktionen werden ai_proposals (kind agent_action) an einer Frage approval mit Systemkarte im Chat. decideAgentActions() führt mit den aktuellen Rechten des Agenten aus und erkennt stale oder failed; Ablehnen wirkt auch auf abhängige Vorschläge und sperrt den Fingerprint für 14 Tage; Ablauf nach expireH. send_external über Entwürfe mit mail_draft_id; Senden oder Ablehnen in Mail › Freigaben entscheidet den Vorschlag. doc_folders.agent_access (write, read, none, vererbt) für read_page, doc_* und den Kontext. Policy-Text im variablen Prompt-Teil. Bestand je nach Entscheidung 6. Oberfläche: AdminPage-Karte „Agenten-Policy“, MembersView (Projektkarte, Agentenblock, Ordnerzugriff), TaskDrawer „Selbstständigkeit für dieses AP“ und „Wartet auf Bestätigung“, ChatPane-Karten, AiView-Vorschläge, DocsView-Ordnerzugriff. | 048_agent_policy.sql | P1 KI-Freigaben und Notaus, P5 Offene Fragen und Synchronität |
| P7 Steuerung der Agenten im Chat | Anforderung 7. Der Chat-Lauf liefert reply plus commands: order, note, pause, resume, stop, priority, approve, reject, policy, report und refer. gateChatCommand() prüft nach der Absenderrolle (7.1), agent_policy.chat.orders, aiAllowed (agent.chat, agent.order) und Budget. Aufträge legt createPlannedTask mit den Rechten des Auftraggebers an (requested_by, origin_message_id, Tasks aus deliverables, Log source chat); der Auftraggeber steht an erster Stelle der Kette; Lauf mit Anlass order. Systemkarte (chat_messages.meta) mit Ergebnissen und Knöpfen Öffnen, Rückgängig (10 min), Freigeben und Ablehnen; claimCheck ersetzt unbelegte Behauptungen. Der Chat-Prompt kennt Rolle und Rechte des Absenders, die effektive Policy mit Herkunft, offene Fragen und Vorschläge, Fähigkeiten und die AP-Liste der gemeinsamen Sicht. Berichtsregel als notification_rules auf AP-Ebene (Ereignis progress, Empfänger requester); deliver.mail mit PDF über notifyMail. order_request an die PL; refer als external_referral. Folgenachrichten werden über das Dirty-Flag nicht verloren. Sheet: CHAT_RULES mit Befehlsliste. | 049_chat_control.sql | P6 Agenten-Policy: Selbstständigkeit und Bestätigungen |
| P8 Online-Recherche | ai/web.ts: research(cfg, {question}). Anthropic-Profile nutzen das Server-Tool web_search_20260209 (ältere Modelle web_search_20250305) als eigenen Aufruf ohne JSON-Schema, weil Zitate mit output_config.format nicht kombinierbar sind; dazu max_uses, allowed_domains oder blocked_domains (nicht beides) und user_location DE. Lokale Profile optional über SearXNG oder Brave mit Abruf durch das System (nur GET, SSRF-Schutz, Größenlimit, Filter der Suchbegriffe). Fehler kommen als Ergebnisblock, nicht als Exception. Funktion agent.web standardmäßig gesperrt; ai_profiles.web_search; Limits je Lauf und je Agent und Tag. Aktion research als Leserunde; Quellen in agent_web_sources; das System hängt Seiten den Abschnitt „Quellen (abgerufen am …)“ an. Ohne Freigabe ehrlicher Hinweis in Fähigkeiten und Log. Oberfläche: AdminPage (Anbieter, Limits, Domains), TaskDrawer-Quellen, AiView-Zähler. | 050_web_research.sql | P1 KI-Freigaben und Notaus, P7 Steuerung der Agenten im Chat |
| P9 Projektwissen, Projekt-Scope, Synergien | Anforderung 6 (Teil Reichweite und Wissen). ai/knowledge.ts: agentVisibility() (visibleSubprojectSql, agent_access, lesbare Ansichten, bodyOk), search() für Kontext, Aktion search, den Chat-Agenten (Schnittmenge mit dem Absender) und askProject; findCandidates() (Signale contact, terms, date_place, page, dependency, question); fitBudget() mit ai_profiles.context_tokens. Prompt-Reihenfolge stabil vor variabel (cacheAfter für Anthropic). DMs im Prompt nur mit Bezug zum AP. Aktionen search, read_task, relate und withdraw. Synergien nach synergies (off, ask, use) mit Frage synergy und POST /relations/:id/decide. Projektagent: scope project, Lauf project_review ohne AP über runProjectReviews (werktags, dueLocal), nur mit geändertem Quell-Hash; project_digests je visibility_key. PROJECT_RULES. Oberfläche: TaskDrawer „Verwandte APs“, MembersView Reichweite und „Projektdurchlauf jetzt“, AiView Durchläufe und Kontextstatistik. | 051_agent_knowledge.sql | P6 Agenten-Policy: Selbstständigkeit und Bestätigungen |
| P10 Ressourcen und Personen im Kalender | Anforderung 1. Tabellen resources (Pool oder Projekt; Raum, Gerät, Gerüst, Fahrzeug, Person, Sonstiges) und resource_bookings (Ressource oder interne Person; an Besprechung, AP bzw. Aufgabe oder frei; Sperrzeiten und Abwesenheiten ohne Projekt). resources/service.ts mit findConflicts(), maskBooking(), syncMeetingBookings(), syncTaskBookings() und dayRange(). force nur PL oder can_edit_plan; Pool pflegen Org-Admin oder resources_admin; Freigabegruppe optional. Besprechungen mit resourceIds; Zeitänderungen ziehen Belegungen nach, Bestätigen bestätigt sie mit. AP-Termine verschieben Belegungen (follow_task). Agent: Aktion book_resource immer vorläufig, Frage confirm mit booking_id, Belegt-Zeiten mit Ressourcen, Abwesenheiten und eigenem Projekt; createPlannedEvent trägt den Ansprechpartner als Teilnehmer ein. Meldungsklasse booking über dispatch. ICS: eigene Belegungen, Projekt-Feed, Ressourcen-Feed, CUTYPE ROOM/RESOURCE. Person-Ressourcen mit Buchung am AP zählen als AP-Bezug in audienceOf. Oberfläche: Calendar-Modus „Belegung“ (Occupancy), BookingForm, Filter, MeetingsView-Ampel, TaskDrawer-Ressourcen, ResourcesCard, ContactsCard „als buchbare Person führen“, AdminPage-Pool, UserSettings-Abwesenheiten. | 052_resources.sql | P4 Benachrichtigungsregeln mit Vererbung, P5 Offene Fragen und Synchronität |
| P11 Externe Konten (optional) | Nur nach Entscheidung 2. global_role external, Einladung als Extern zu einer Aufgabe (invitations.task_id), groups.kind, Tabelle task_access. Externe werden nie Projektmitglied (Prüfung in PUT /members, bei Einladungen und im Gruppenabgleich); alle requireProject-Routen weisen sie automatisch ab. Portal-Routen /extern/tasks, /extern/tasks/:id, Kommentare (visibility external) und Tasks abhaken. DMs nur mit dem Agenten und den menschlichen Zuständigen ihrer Aufgaben; der Chat-Agent bekommt bei externem Absender nur externalContext. KI für Externe standardmäßig gesperrt. Oberfläche: Portal-Seite, Einladung „als Extern“ in InviteCard und TaskDrawer. | 053_external_portal.sql | P2 Informationsgrenze für Externe, P3 Rechte, Rollen, Gruppen, P5 Offene Fragen und Synchronität |

Grundlage ist der Code bis Migration 042 (Commit aadffea), geprüft am 18.10.2026. Die neuen Migrationen tragen die Nummern 043 bis 053. Pfade ohne Präfix beziehen sich auf `apps/api/src`, Oberflächenpfade auf `apps/web/src`. Die Phasen P0 bis P11 stehen im Umsetzungsplan.

Die acht Anforderungen und wo sie behandelt werden:

| Nr. | Anforderung | Abschnitt |
|---|---|---|
| 1 | Ressourcen (Räume, Gerüste …) und Personen (Elektriker) im Kalender | 10 |
| 2 | Kommunikationsregeln, offene Fragen synchron zwischen Benachrichtigung, Chat und Aufgabe | 4.6, 5 |
| 3 | Berechtigungskonzept (Benutzer, Gruppen) für Org, Projekt und KI | 2, 3 |
| 4 | Benachrichtigungen (Chat, Mail, Doku, Log) auf Org-Ebene, vererbbar auf Projekt und Benutzer | 4 |
| 5 | Org-Admin kann KI für alles sperren oder freigeben: für alle, je Projekt, je Benutzer oder PL | 3 |
| 6 | Agenten-Policy (selbstständig, Rückfrage bei bestimmten Schritten, Rückfrage bei allem), Projekt-Scope, Synergien, Wissen nur soweit berechtigt | 6 |
| 7 | PL steuert Agenten im Chat | 7, 8 |
| 8 | Externe erfahren nur, was zu ihrer Aufgabe gehört; alles andere geht an PL oder den nächsten Menschen | 9 |

---

## 0. Leitlinien

1. **Es gibt eine einzige effektive Mitgliedschaft.** `project_members` bleibt die Tabelle, die alle Abfragen lesen; heute sind es 74 Abfragen in 24 Dateien. Rechte aus Gruppen werden als eigene Zeilen dort eingetragen (`origin='group'`).
2. **Der Org-Admin hat keinen impliziten Zugriff auf Projektinhalte** (rights.ts:27). Er legt fest, was erlaubt ist. Die PL legt fest, was im Projekt genutzt wird, und kann dabei nur einschränken.
3. **Jedes Querschnittsthema hat genau einen Weg.**
   - KI-Nutzung läuft über `aiConfigFor()` und `aiAllowed()`.
   - Meldungen laufen über `notify()` (wendet die Regeln an) und `dispatch()` (löst Empfängerrollen auf).
   - Offene Fragen laufen über `questions.ts`.
   - Alles, was an Nicht-Interne hinausgeht, läuft über `outbound.ts`.
   - Jede Agentenaktion läuft durch `gateAction()`.
4. **Bestätigt wird vom System, nie vom Modell.** Was ausgeführt, gesendet oder angelegt wurde, schreibt das System ins Log und als Systemkarte in den Chat. Behauptet das Modell etwas, ohne dass eine passende Aktion lief, ersetzt das System den Text.
5. **Wissen gibt es nur, soweit berechtigt.** Der Kontext eines Agenten entsteht aus seinen eigenen Rechten. Im Chat ist es die Schnittmenge mit den Rechten des Gegenübers. Nicht-Interne bekommen nur den Außenkontext ihrer Aufgabe.
6. **Ein Upgrade ändert nichts stillschweigend.** Die Backfills übernehmen den heutigen Zustand. Ausnahmen sind ausdrücklich genannt: pl.agents (siehe 3.6) und die Sofort-Fixes in Abschnitt 16.

## 1. Bausteine im Überblick

| Baustein | Datei | Tabellen / Felder | Phase |
|---|---|---|---|
| KI-Freigaben | `ai/policy.ts` (`aiAllowed`), `ai/client.ts` (`aiConfigFor`) | `ai_policies`, `users.org_rights`, `orgs.settings.ai.enabled` | P1 |
| Außengrenze | `outbound.ts` | `outbound_checks`, `task_comments.visibility`, `tasks.external_brief`, `projects.external_profile` | P2 |
| Rechte und Gruppen | `rights.ts` (`syncProjectGroups`, `requireTask`) | `project_groups`, `project_members.origin`, `group_members.is_manager` | P3 |
| Benachrichtigungsregeln | `rules.ts`, `notify.ts` (`dispatch`), `notifyMail.ts` | `notification_rules`, `notifications.event/ref_type/ref_id/resolved_at/mail`, `chat_messages.kind/meta` | P4 |
| Offene Fragen | `questions.ts`, `tasks/service.ts` (`contactChain`) | `questions` | P5 |
| Agenten-Policy | `ai/policy.ts` (`effectiveAgentPolicy`, `gateAction`), `ai/agentActions.ts` | `projects/project_members/tasks.agent_policy`, `ai_proposals` (erweitert), `doc_folders.agent_access` | P6 |
| Chat-Steuerung | `ai/agentChat.ts`, `ai/chatCommands.ts` | `tasks.requested_by/origin_message_id`, `chat_messages.agent_run_id` | P7 |
| Online-Recherche | `ai/web.ts` | `agent_web_sources`, `ai_profiles.web_search`, `agent_runs.web_searches` | P8 |
| Projektwissen | `ai/knowledge.ts` | `task_relations`, `project_digests`, `agent_runs.scope/context_stats`, `ai_profiles.context_tokens` | P9 |
| Ressourcen | `resources/service.ts`, `routes/resources.ts` | `resources`, `resource_bookings`, `questions.booking_id` | P10 |
| Externe Konten (optional) | `routes/extern.ts` | `task_access`, `global_role 'external'`, `groups.kind` | P11 |

---

## 2. Rechte, Rollen, Gruppen (Anforderung 3)

### 2.1 Org-Ebene

`users.global_role` bleibt bei den Werten `org_admin`, `project_creator` und `user`. Der Wert `external` kommt erst mit P11. Neu ist die Spalte `users.org_rights text[]` für einzelne Verwaltungsrechte.

| Rolle / Recht | Darf | Darf nicht |
|---|---|---|
| `org_admin` | Benutzer anlegen, ändern und reaktivieren; Gruppen; Mandanten-Einstellungen; KI-Regeln und Notaus; Kommunikationsregeln der Org; Pool-Ressourcen; Audit; die verantwortliche PL eines Projekts neu bestimmen (über die Verwaltung, ohne Inhalte zu sehen) | Projektinhalte ansehen |
| `ai_admin` (neu) | Verwaltung › KI: Profile, Freigaben, Notaus, Agenten der Org, Budgets, Agenten-Policy der Org, Recherche-Einstellungen | Benutzer, Gruppen |
| `groups_admin` (neu) | alle Gruppen pflegen | – |
| `resources_admin` (neu) | Pool-Ressourcen und Sperrzeiten im Pool | – |
| `project_creator` | Projekte anlegen (wie heute) | – |
| `user` | wie heute | – |

`PATCH /users/:id` ändert Rolle, Org-Rechte und den Aktiv-Status, kann also auch reaktivieren. Der letzte aktive Org-Admin ist geschützt, ebenso der eigene Zugang (Lücke 9). In `requireUser` werden die Org-Rechte mitgeladen. Den Menüpunkt Verwaltung (Layout.tsx:123) sieht auch, wer ein Org-Recht hat, allerdings nur mit den passenden Karten.

### 2.2 Projektebene

Rollen (`pl`, `member`, `reader`), `is_deputy` und die Einzelrechte bleiben. Folgendes wird präzisiert:

- **Verantwortliche PL:** Nur sie selbst übergibt die Rolle; zusätzlich darf es der Org-Admin über die Verwaltung. Eine Stellvertretung kann sich nicht selbst befördern (Lücke 2, projects.ts:216, behoben in P0).
- **`can_approve` heißt „Freigeben“.** Es umfasst KI-Vorschläge, Workflow-Schritte und Bestätigungen von Agentenaktionen. Bei Agentenaktionen braucht man zusätzlich das Recht, das die Aktion selbst verlangt (Abschnitt 6.5).
- **`can_use_ai` ist überall gleich vorbelegt:** an für Mitglieder, aus für Leser. Das gilt für Einladung, API, Formular und Seed (Lücke 4).
- **Leser** lesen. Mit `can_use_ai` dürfen sie nur `assist.ask` nutzen (Lücke 1, behoben in P0).
- **Implizite Leser** (Projektsichtbarkeit `org`) dürfen nur lesen, auch im Chat. Sie haben keine KI.
- **`requireTask(db, user, taskId, min)`** prüft `requireProject` und `canSeeSubproject` zusammen. Die Funktion ersetzt alle Stellen aus Lücke 6: tasks.ts (move, archive, delete, restore, shift, escalate, checklist, comments), time.ts:88, docs.ts:497 und mail/access.ts:19.

### 2.3 Gruppen

- **Pflege:** Org-Admin und `groups_admin` pflegen alle Gruppen. Wer in einer Gruppe `group_members.is_manager` hat, pflegt deren Mitglieder. Der SSO-Abgleich bleibt (oauth.ts:135-146).
- **Gruppe als Projektmitglied:** Die Tabelle `project_groups` vergibt die Rolle `reader` oder `member` plus Einzelrechte. PL und Stellvertretung sind immer einzelne Personen, weil `resolveProjectLead` und der Löschschutz eine Person brauchen. Agenten werden nie über Gruppen Mitglied. Persönliche Projekte nehmen keine Gruppen auf.

**Regel M: effektive Mitgliedschaft**

1. Gibt es einen Direkteintrag (`origin='direct'`), gilt nur dieser.
2. Sonst gelten die Gruppen: die höchste Rolle, die Einzelrechte ODER-verknüpft.
3. Sonst, bei Projektsichtbarkeit `org`: implizite Leserolle für aktive Personen.
4. Sonst besteht kein Zugriff.

`syncProjectGroups(db, {projectId?, userId?, groupId?})` pflegt nur die Zeilen mit `origin='group'`. Sie läuft bei Änderungen an `project_groups` oder `group_members`, beim SSO-Abgleich, beim Deaktivieren eines Benutzers und beim Löschen eines Direkteintrags. In der Oberfläche steht dann etwa „überschreibt Elektro-Team (Mitglied)“ mit dem Knopf „Gruppenrechte übernehmen“.

**Wo Gruppen wirken:** bei `subproject_access`, bei `mail_view_rights`, als „Wer“ in `ai_policies`, als Empfänger in `notification_rules` (gefiltert auf aktive Personen mit Projektsicht und `canSeeSubproject`) und als Freigabegruppe einer Ressource. **Wo Gruppen nicht wirken:** bei der Zuständigkeit für APs und in der Frage- und Entscheidungskette.

### 2.4 Externe

Heute sind Externe nur Adressen: `tasks.responsible_email`, `checklist_items.responsible_email`, `project_contacts`, Absender und Empfänger von Mails, `meetings.attendees` und Freigabelinks in `doc_shares`. Abschnitt 9 legt fest, wie sie behandelt werden.

Eigene Konten für Externe gibt es nur mit P11 und nur nach Entscheidung 2. Ein externes Konto (`global_role='external'`) wird nie Projektmitglied. Zugriff gibt es dann nur über `task_access` und die Portal-Routen `/extern/*`.

### 2.5 Rechtematrix

| Bereich | Org-Admin | PL / Stv. | Mitglied | Einzelrecht | Leser (explizit) | impliziter Leser | Agent | Extern (P11) |
|---|---|---|---|---|---|---|---|---|
| Projekt sehen | nur Kennung, Name, PL | ja | ja | – | ja | ja | als Mitglied | nur eigene Aufgaben |
| Plan: Teilprojekte, Meilensteine, fremde Termine, Kopieren | – | ja | – | `can_edit_plan` | – | – | Rechte + Policy (`plan`, `foreign`) | – |
| Board: APs/Aufgaben anlegen, Status, Log, Tasks | – | ja | in sichtbaren TPs | – | lesen | lesen | Grundmenge + Policy | Tasks abhaken, Kommentar (extern) |
| Eingeschränkte TPs | – | ja | mit Zugriff (Person/Gruppe) | – | mit Zugriff | nein | mit Zugriff | – |
| Doku lesen und bearbeiten | – | ja | ja | `can_finalize`: Final, Verteiler, Freigabelinks | lesen | lesen | nach `agent_access` je Ordner; Final nach Recht + Policy | nur freigegebene Seiten |
| Ordner/Seite löschen | – | ja | – | – | – | – | nie | – |
| Mail | Org-Postfach; Projektkonten verwalten | Konten, Ansichten | je Ansicht | – | je Ansicht | – | `agent_can_mail` + Policy + Außengrenze, sonst Entwurf | – |
| Projektkanal | – | schreiben, löschen | schreiben | – | schreiben (ohne Notizen/Befehle) | lesen | über Läufe | nein |
| Chat mit Agenten | wie Person | Befehle laut 7.1 | laut 7.1 | – | nur Auskunft | – | – | DM mit Agent und Zuständigen eigener Aufgaben |
| Besprechungen | – | alle | anlegen, eigene ändern, vorläufige bestätigen | `can_edit_plan`: fremde ändern | lesen | lesen | nur vorläufig | Teilnahme |
| Ressourcen | Pool (auch `resources_admin`) | Projektressourcen, alle Buchungen | anlegen, buchen, eigene Buchungen | `can_edit_plan`: Konflikt übersteuern, fremde Buchungen | lesen | lesen (maskiert) | nur vorläufig buchen | – |
| Zeiten | – | alle | eigene | – | – | – | – | – |
| Freigaben (KI-Vorschläge, Workflow, Agentenaktionen) | – | ja | – | `can_approve` + Recht der Aktion; Ansprechpartner bei close/assign/schedule | – | – | nie | – |
| Fragen beantworten | – | ja | wenn AP sichtbar | – | Antwort zählt nicht | nein | – | nur Außenrückfragen zur eigenen Aufgabe |
| KI nutzen (`assist`) | – | ja (Policy) | `can_use_ai` + Policy | – | `can_use_ai`: nur `ask` | nein | – | nein |
| Agenten im Chat beauftragen | – | ja | nach `chat.orders`, sonst Vorschlag an PL | – | nein | nein | – | nein |
| Mitglieder, Gruppen im Projekt, Projekt-KI, Agenten, Policy, Regeln | – | ja | – | – | – | – | nie | – |
| Org-Verwaltung | ja | – | – | `ai_admin`, `groups_admin`, `resources_admin` | – | – | – | – |

---

## 3. KI-Freigaben (Anforderung 5)

### 3.1 Funktionskatalog

Der Katalog steht als `AI_FEATURES` in shared. Eine Regel bezieht sich auf eine einzelne Funktion, eine Kategorie oder auf `*`.

| Funktion | Einstiegspunkt heute | geprüft wird |
|---|---|---|
| `assist.summarize`, `assist.essence`, `assist.report`, `assist.ask`, `assist.final_reply` | ai.ts:192/208/227/312/327, mail.ts:771 | die Person |
| `mail.process` (Ordner „KI Bearbeiten“) | mail.ts:271/283/303, mailAi.ts:100 | `ai_process_by`, beim Einschalten und bei jedem Lauf |
| `mail.triage` (Agent betreut eine Ansicht) | mailAi.ts:111 | der Agent |
| `agent.run` | agent.ts (Worker, Ereignis), agents.ts:154 | der Agent |
| `agent.chat` | chat.ts:130/222, agentChat.ts | Absender und Agent |
| `agent.order` | Chat-Aufträge (P7) | Absender und Agent |
| `agent.web` | Recherche (P8), **standardmäßig gesperrt** | der Agent |
| `agent.finalize`, `.distribute`, `.send_external`, `.close`, `.restructure`, `.plan`, `.assign`, `.schedule`, `.foreign` | Aktionsklassen (6.2) | der Agent |
| `pl.agents`, `pl.own_llm` | agents.ts:87, ai.ts:77-136 | die PL (bei PL-Agenten die PL, die den Agenten angelegt hat) |

### 3.2 Prüfstufen von `aiAllowed(db, {userId, projectId, feature})`

Die erste Sperre gewinnt. Das Ergebnis hat die Form `{allowed, reason, stage, rule?, trace}`.

0. **Notaus:** `orgs.settings.ai.enabled === false` sperrt alles: „KI im Mandanten abgeschaltet (Notaus)“. Der Notaus gilt auch gegen Ausnahmen.
1. **Regeln des Org-Admins** nach Regel K, zum Beispiel „Gesperrt durch Org-Admin (A. Admin) für Projekt BAU: Datenschutz Bauherr“.
2. **Ebene der PL:**
   - Personen müssen ausdrücklich Mitglied sein; implizite Leser werden abgewiesen.
   - Leser dürfen nur `assist.ask` nutzen und brauchen dafür `can_use_ai`.
   - Mitglieder brauchen `can_use_ai`; die PL hat es immer. `pl.*` verlangt die Rolle PL.
   - Für `assist.*` muss eine Projekt-KI gewählt sein.
   - Agenten müssen aktiv und Mitglied sein. Für einen Lauf gilt zusätzlich `agent_paused`.
   - Für Agenten einer PL wird zusätzlich `pl.agents` geprüft (Lücke 8).
   - Für `mail.process` braucht die einschaltende Person `can_use_ai` sowie `can_ai` und `can_create_task` an der Ansicht.
3. **Profil:** `aiConfigForProject` bzw. `aiConfigForAgent` liefert null, Begründung „Kein freigegebenes KI-Profil im Projekt“. Die Profilachse bleibt unverändert (3.6).
4. **Budget:**
   - `agent.*` je Agent, `mail.process` je Projekt (wie heute).
   - Neu: `assist.*` je Projekt über `orgs.settings.ai.assistDailyBudget` (Standard 200).
   - Der Wert 0 bedeutet gesperrt (`?? 50` statt `|| 50`).
   - Gezählt werden nur Läufe mit Status `ok` oder `error`.

### 3.3 Regel K: Auflösung der `ai_policies`

Eine Regel besteht aus Ort (alle Projekte oder ein Projekt), Wer (alle, eine Person bzw. ein Agent, oder eine Gruppe), Funktion und Wirkung (`allow` oder `deny`). Fehlt eine Regel, wird geerbt. Innerhalb einer Zelle gilt zuerst die genaue Funktion, dann die Kategorie, dann `*`.

Für Benutzer oder Agent u, Projekt p und Funktion f entscheidet die erste zutreffende Stufe:

1. **Ausnahme:** eine Regel für u in p; sonst für eine Gruppe von u in p. Treffen mehrere Gruppen zu, gewinnt die Sperre.
2. **Person und Projekt:** Die Personenregel gilt für u (ersatzweise seine Gruppen) in allen Projekten, die Projektregel für p und alle Personen. Gibt es beide, ist f nur erlaubt, wenn beide erlauben. Gibt es nur eine, entscheidet sie.
3. **Org:** eine Regel für alle Personen in allen Projekten.
4. **Standard:** erlaubt. Ausgenommen sind `agent.web` und, mit P11, alle Funktionen für Externe; sie sind gesperrt.

| Regeln | Ergebnis |
|---|---|
| Org `*` gesperrt, Projekt BAU `*` erlaubt | KI nur in BAU |
| Org gesperrt, Person Max `assist` erlaubt | Max überall, wo die PL es zulässt |
| Projekt BAU gesperrt, Max erlaubt | in BAU gesperrt; Ausnahme nur über „Max in BAU“ |
| BAU erlaubt, Max gesperrt | Max auch in BAU gesperrt |
| Gruppe Externe gesperrt, Gruppe Elektro erlaubt | gesperrt (Gleichstand) |
| Projekt BAU `agent` gesperrt | auch Agenten der Org laufen in BAU nicht |
| Agent Morton `agent.send_external` gesperrt | Morton schreibt nur noch Entwürfe; andere Agenten bleiben unberührt |

**Wirkung von „KI sperren für eine PL“:** Eine Personenregel für die PL sperrt deren eigene Nutzung. Das betrifft `assist`, `mail.process` als einschaltende Person, `agent.chat` und `agent.order` als Absenderin und `pl.agents`/`pl.own_llm`. Agenten, die in ihren Projekten laufen, regelt eine Projekt- oder Agentenregel, denn ihr „Wer“ ist der Agent.

### 3.4 Wer kann was sperren oder freigeben

| Wer / Ebene | Mittel | Wirkt auf |
|---|---|---|
| Org-Admin oder `ai_admin`: Mandant | Notaus; Regel (alle, alle, f) | alles, auch Agenten der Org; der Notaus gilt auch gegen Ausnahmen |
| Org-Admin: Projekt | Regel (p, alle, f) | alle Personen und Agenten in p, auch Agenten der Org |
| Org-Admin: Person oder PL | Regel (alle, u, f) | eigene Nutzung durch u in allen Projekten |
| Org-Admin: Gruppe | Regel (alle oder p, g, f) | Mitglieder der Gruppe |
| Org-Admin: einzelner Agent | Regel (alle oder p, Agent, f); `active` | Läufe, Chat, Triage, Aktionsklassen |
| Org-Admin: Ausnahme | Regel (p, u oder g, f) | übersteuert Person und Projekt, nicht den Notaus |
| Org-Admin: Profile | `active`, `project_scope`, `admin_blocked`, `ownLlm` | welches LLM genutzt werden darf |
| PL im Projekt (nur einschränken) | Projekt-KI wählen oder leer lassen; `can_use_ai`; Agenten als Mitglied, Zuständigkeit, `agent_paused`, `agent_can_mail`; Agenten-Policy bis `maxMode`; Mail-KI je Ansicht; `chat.orders` | im Projekt |
| Zuständige(r) bzw. Ansprechpartner | Pause und Weiter am eigenen AP (Drawer oder Chat) | AP |

### 3.5 Agentenläufe, die Mitglieder auslösen

Wenn ein Mitglied ohne „KI nutzen“ kommentiert oder zuweist, läuft der Agent trotzdem. Geprüft wird dabei der Agent, denn die PL hat ihn eingesetzt. Für den direkten Chat mit einem Agenten wird dagegen der Absender geprüft (`agent.chat`).

In einer DM mit einem Agenten der Org gilt für den Absender: Stufen 0 und 1 werden ohne Projekt geprüft. Danach antwortet der Agent nur aus Projekten, in denen der Absender `can_use_ai` hat oder PL ist.

### 3.6 Was bleibt

- `project_scope` behält seine Bedeutung aus 041: `none` heißt, das Profil nutzen nur Agenten der Org. Eine Projektsperre ist es nicht; eine solche gibt es nur über `ai_policies`, und sie gilt dann auch für Agenten der Org (KI-Lücke 3).
- `admin_blocked` und `ownLlm` bleiben unverändert. Eigene Anthropic-LLMs eines Projekts nutzen nie `ANTHROPIC_API_KEY` (P0). Der Verbindungstest prüft `ownLlm`.
- Gesperrte Läufe werden als `agent_runs` bzw. `mail_ai_runs` mit Status `skipped` und Begründung protokolliert, ohne LLM-Aufruf. Routen antworten mit 403 und Begründung.
- **Backfill:** Der Schalter „Eigene Agenten der PL“ wird zur Org-Regel `pl.agents`. War er aus, stoppen bestehende Agenten der PL; das ist gewollt (Lücke 8). Die Migration schreibt dazu das Audit `ai.policy.migrated`, und die Verwaltung zeigt die betroffenen Agenten mit dem Knopf „erlauben“.
- **Bestandsschutz:** Wer Mail-KI eingeschaltet hat, behält `can_use_ai`.

---

## 4. Benachrichtigungen und Kommunikationsregeln (Anforderung 4, Teil von 2)

### 4.1 Ereignisklassen

Die 20 heutigen `notifications.type` bleiben, damit Links und Tests weiter funktionieren. Jeder Typ gehört zu genau einer Klasse (`EVENT_OF_TYPE` in shared).

| Klasse | Typen | Standard-Empfänger | Chat | Mail | Log | Fristen (Erinnern/Weitergeben) |
|---|---|---|---|---|---|---|
| `question` | Frage (neu) | Kette ab Stufe 0 | thread (fest) | sofort | ja | 48 h / 120 h |
| `decision` | Entscheidung, Agent-`escalate` | Kette ab PL | thread (fest) | sofort | ja | 24 h / 48 h |
| `approval` | Bestätigung angehaltener Agentenaktionen | Kette, nur Freigabeberechtigte | thread (fest) | Digest | ja | 24 h / 72 h, Ablauf 336 h |
| `synergy` | Überschneidung | beide Zuständige, sonst PL | thread (fest) | Digest | ja | 72 h / – |
| `confirm` | vorläufiger Termin oder vorläufige Buchung | Stufe 0 | thread (fest) | sofort | ja | 24 h / 72 h |
| `order_request` | Auftragsvorschlag eines Mitglieds | PL | thread | sofort | – | 48 h / – |
| `external_referral` | Rückfrage eines Externen außerhalb seiner Aufgabe | Kette ab Auftraggeber | thread | sofort | ja | 24 h / 72 h |
| `progress` | Zwischenstand eines Auftrags | `requester` | thread | aus (am AP wählbar) | – | every = milestones |
| `assigned` | task.assigned, plan.shifted | Zuständige(r) | off | Digest | – | – |
| `blocked` | „blockiert“ (Mensch oder Agent) | TP-Verantwortung, sonst PL | off | sofort | ja | – |
| `escalation` | Worker- und manuelle Eskalation, Stufe-3-Mail | Stufen aus `projects.escalation` | off | sofort | (Aufrufer) | – |
| `review` | page.review, report.review, ai.proposal, workflow.approval, mail.approval, draft.review, Außenprüfung angehalten | Freigabeberechtigte | off | Digest | – | – |
| `mail_in` | Mail einem AP zugeordnet (neu) | keine (nur Log) | off | – | ja | – |
| `log` | task.comment, mention, Log-Eintrag eines Agenten | Beteiligte, Erwähnte | off | Digest | – | – |
| `due` | task.due_soon, task.overdue | Zuständige(r) | off | Digest | – | – |
| `chat` | chat.dm, chat.mention, chat.reply | Empfänger | – | Digest | – | – |
| `booking` | Konflikt, Anfrage, gebucht, bestätigt/abgelehnt, unbestätigt | siehe 10.6 | off | Digest (Konflikt sofort) | ja | – |
| `info` | report.sent/.failed, page.external_edit, mail.ai | wie heute | off | Digest | – | – |

### 4.2 Empfängerrollen

`responsible`, `parent_responsible`, `subproject_lead`, `pl`, `deputy_pl`, `requester` (Auftraggeber), `flag:can_approve`, `flag:can_finalize`, `flag:can_edit_plan`, `participants`, `mentioned`, `escalation_contact` (nur `contactUserId`), `project_channel`, `group:<uuid>` und `user:<uuid>`.

`dispatch()` entfernt immer Agenten, inaktive Benutzer, den Auslöser und Personen ohne Sicht auf das AP. Das behebt Lücke 10.

### 4.3 Kanäle

| Kanal | Werte | Wirkung | Einstellbar auf |
|---|---|---|---|
| `inapp` | immer an | Glocke; Anker für den Gelesen- und Erledigt-Status | – |
| `chat` | `off` / `thread` / `project` | `thread`: Systembeitrag im zugehörigen Thread (Frage, Auftrag, DM des Agenten). `project`: Systembeitrag im Projektkanal; nie bei eingeschränkten TPs oder persönlichen Projekten. Bei Fragearten ist der Chat die Frage selbst und lässt sich nicht abschalten | L1–L3; Benutzer nur `off`/`thread` für nicht feste Klassen |
| `mail` | `off` / `now` / `digest` | über das Org-Postfach | alle Ebenen |
| `log` | an / aus | `task_comments` mit source `system`, nur wenn die Aufrufstelle nicht schon selbst ins Log schreibt | L1–L3 |
| `doc` | `pageId` / aus | Eintrag auf der Projektseite „Entscheidungen und Meldungen“ (wird beim Einschalten angelegt, Standard nur `decision` und `escalation`); nie bei eingeschränkten TPs | L2 |

### 4.4 Regel N: Vererbung und Auflösung

Die Ebenen sind:

- L0: Code (`NOTIFY_DEFAULTS`)
- L1: Org
- L2: Projekt
- L3: AP
- L4: Benutzer
- L5: Benutzer im Projekt
- L6: Benutzer am AP

Für jedes Feld getrennt (`recipients`, `chat`, `mail`, `log`, `doc`, `remindH`, `escalateH`, `expireH`, `every`) gilt:

1. Innerhalb einer Ebene geht die Zeile des Ereignisses der Zeile `'*'` vor.
2. Von L0 nach L6 überschreibt jeder gesetzte Wert den vorigen. Ein leerer Wert erbt.
3. Sperrt L1 oder L2 ein Feld (`locked`), ignoriert das System für dieses Feld alle tieferen Ebenen. Die oberste Sperre gewinnt.
4. Auf L4 bis L6 sind nur `chat` und `mail` erlaubt; die API weist andere Felder dort ab. `recipients`, `log`, `doc` und `timing` sind nur auf L1 bis L3 erlaubt.
5. Den Berichtswunsch einer Person für sich selbst speichert das System als L6, damit der spezifischste Wunsch gewinnt.
6. Der aufgelöste Mail-Modus wird beim Erzeugen in `notifications.mail` festgeschrieben.

> Beispiel: Die Org setzt `decision.mail = now` und sperrt das Feld. Max setzt `'*'.mail = digest`. Entscheidungen erhält Max trotzdem sofort, alles andere als Digest. Am AP GZ-9 setzt Philipp für sich `progress.mail = now` (L6). Seine Zwischenstände zu GZ-9 kommen sofort, obwohl sein `'*'` auf Digest steht.

**Migration:** `users.settings.mailNotifications` wird zu einer L4-Zeile `'*'`. Bestehende ungelesene Meldungen behalten den bisherigen Modus. `PATCH /me` mit `mailNotifications` schreibt eine Version lang in diese Regel.

### 4.5 Zustellung

- **`notify()`** (der einzige Weg, der in `notifications` schreibt) löst `mail` und die Kanäle nach Regel N auf. Es setzt `event`, `ref_type`, `ref_id` und `mail` und filtert Agenten, Inaktive und den Auslöser.
- **`dispatch(event, ctx)`** löst Empfängerrollen auf und ruft danach `notify()` auf. Die 20 bestehenden Aufrufstellen laufen zunächst unverändert über `notify()` und werden schrittweise umgestellt: agent.ts, chat.ts, tasks.ts, escalation.ts, docs.ts, mail.ts, engine.ts, worker.ts.
- **`notifyMail`:**
  - Der Modus kommt aus der einzelnen Meldung.
  - Der Digest geht zur Stunde `orgs.settings.notify.digestHour` in Europe/Berlin raus; der Worker-Helfer `dueLocal` ersetzt `DIGEST_HOUR`.
  - Anhänge sind für Meldungen mit Bezug auf eine Seite möglich (Lieferung, 7.5), nur an interne Empfänger mit Leserecht.
  - Fehler gehen ins Audit `notify.mail_failed`.
  - Ohne Org-Postfach gehen Lieferungen über das Projektkonto.
- **Gelesen-Status:**
  - `markRead` im Chat setzt `read_at` für die eigenen `chat.*`-Meldungen dieses Kanals. Wer einen Thread lädt, markiert dessen Meldungen.
  - Glocke und Dashboard nutzen denselben Handler `openNotification()`.
- **Aufbewahrung:** Gelesene und erledigte Meldungen, die älter als 180 Tage sind, löscht der Worker. Dedupe-Schlüssel enthalten Zeitraum oder Stufe, zum Beispiel `q:<id>:<level>` oder `due_soon:<id>:<due_date>`.

### 4.6 Kommunikationsregeln für Agenten (wann, wer, wie)

| Situation | Weg | Wer | Wie |
|---|---|---|---|
| Frage an Interne (Information, Termin, Zusage) | `ask` | Kette ab Stufe 0 bzw. gewählte Stufe | Chat (DM-Thread) + Meldung; nie per Mail |
| Wissen fehlt (keine Entscheidung) | `ask {to:'projekt'}` | Projektkanal (nicht bei eingeschränkten TPs) | Thread im Projektkanal |
| Entscheidung außerhalb der eigenen Zuständigkeit oder unsicher | `ask {kind:'decision'}` bzw. `escalate` | nächste Stufe der Kette (TP, PL) | Chat + Meldung (Mail sofort) |
| Aktion braucht laut Policy Bestätigung | System (`approval`) | Freigabeberechtigte der Kette | Karte im Chat + Meldung |
| Information ohne erwartete Antwort | `chat` | Mitglieder oder Projektkanal | Chat |
| Externe | `mail` / `reply_origin` | nur zur jeweiligen Aufgabe | über die Außengrenze (Abschnitt 9) |
| Externer fragt außerhalb seiner Aufgabe | `refer` | Kette ab Auftraggeber | Frage `external_referral`; an den Externen nur der Verweis |
| Fortschritt eines Auftrags | System (`progress`) | Auftraggeber | Thread des Auftrags, Mail laut Berichtsregel |
| Nachfassen, Weitergabe | System (`runQuestions`) | gleiche bzw. nächste Stufe | gleicher Thread, ohne KI |

---

## 5. Offene Fragen und Synchronität (Anforderung 2)

### 5.1 Objekt

Eine Frage ist ein eigenes Objekt (`questions`). Chat-Nachricht, Benachrichtigungen (`ref_type='question'`), Log-Eintrag, Wartezustand und Vorschläge verweisen darauf. Den Status ändert nur `questions.ts`; von dort überträgt er sich an alle anderen Stellen. Die Frage hat bewusst kein Feld `notification_id`, weil es mehrere Empfänger gibt.

**Arten:** `question`, `decision`, `confirm` (Termin oder Buchung), `approval` (angehaltene Agentenaktionen), `synergy`, `order_request`, `external_referral`.

**Status:** `open`, `answered`, `escalated`, `cancelled`.

### 5.2 Regel C: Kette

`contactChain(db, task, {kind, actionClass?})` liefert interne, aktive Personen in dieser Reihenfolge:

1. Auftraggeber (`tasks.requested_by`)
2. Zuständige(r) des Über-AP
3. TP-Verantwortung
4. verantwortliche PL, zusammen mit der Stellvertretung
5. Eskalationskontakt (nur `contactUserId`)
6. Projektkanal

Dabei gilt:

- Übersprungen werden der Fragende selbst, Agenten, Externe (`responsible_email`, `contactEmail`), Inaktive und Personen ohne Sicht auf das AP.
- Bei eingeschränkten TPs und in persönlichen Projekten entfällt der Projektkanal.
- Bei `approval` bleiben nur Personen, die die Klasse freigeben dürfen (6.5).
- Stufe 0 ist der erste verbliebene Eintrag. Das ist dasselbe Prinzip wie heute in agent.ts:169-178, das in die Funktion umzieht.
- Die KI darf mit `to` eine Stufe direkt wählen (`tp`, `pl`, `projekt` oder die Mailadresse einer Person aus der Kette).

### 5.3 Lebenszyklus (`questions.ts`)

- **`askQuestion(db, {taskId, askedBy, kind, body, to?, meetingId?, bookingId?, proposalIds?})`:**
  - Dedupe: Gibt es am AP schon eine offene Frage an denselben Adressaten mit gleichem normalisiertem Text, wird sie abgewiesen. Der Agent erhält „Frage an Anna offen seit …“.
  - Die Fristen kommen aus Regel N. `dueHours` des Modells darf sie nur im Bereich [4 h, timing] verkürzen.
- **`answerQuestion(db, q, {source, userId, text, messageId?, commentId?})`:** idempotent über `update … where status='open' returning`.
- **`cancelQuestions(db, {taskId|meetingId|bookingId|questionId, reason})`:** wird aufgerufen, wenn das AP erledigt, archiviert oder gelöscht wird (Soft-Delete), wenn die Zuständigkeit vom fragenden Agenten wegwechselt, wenn eine Besprechung oder Buchung gelöscht wird, bei der Agentenaktion `withdraw` und über `POST /questions/:id/cancel` (fragende Person, PL oder Adressat).
- **`escalateQuestion` und `runQuestions(now)`:** laufen im Worker neben `runAgents`, ohne KI.

### 5.4 Abläufe: Frage, Benachrichtigung, Chat und Aufgabe synchron

**A. Ein Agent fragt (`ask`)**
1. `ask` gehört zur freien Grundmenge; `agent.run` wurde vor dem Lauf geprüft.
2. `askQuestion` bestimmt den Adressaten nach Regel C und prüft das Dedupe.
3. Die Chat-Nachricht des Agenten lautet `KEY-12 „Titel“: Frage …`. Sie geht als DM an die Person oder als Thread-Wurzel in den Projektkanal. Die Frage merkt sich `channel_id` und `message_id`. `agentChatMessage` gibt `{channelId, messageId}` zurück und erzeugt bei Fragen selbst keine `chat.dm`-Meldung.
4. `notify()` erzeugt je Empfänger eine Meldung: `event='question'`, `ref=('question', id)`, Link `/chat/<cid>?thread=<mid>&msg=<mid>`, Mail-Modus nach Regel N (Standard sofort), Dedupe `q:<id>:<level>`.
5. Ins Log kommt „Frage an Anna (Chat): …“ (source `ai`).
6. `tasks.agent_wait = {kind:'reply', questionId, reason, since}`; `agent_next_check_at = least(remind_at, escalate_at)`.
7. Audit `question.ask`.

**B. Klick auf die Benachrichtigung**
1. `openNotification()` setzt `read_at`; die Meldung gilt als gesehen.
2. Am Desktop öffnet sich das Messenger-Overlay, mobil `/chat/<cid>?thread=<mid>&msg=<mid>`.
3. ChatPane lädt `GET /chat/messages/:id` mit Nachricht, Fragestatus und Thread, scrollt per `scrollIntoView`, hebt die Nachricht hervor und setzt den Fokus ins Antwortfeld des Threads.
4. Ist die Frage schon erledigt, zeigt der Thread-Kopf „beantwortet von Anna in der Aufgabe“ bzw. „erledigt“. Antworten bleiben möglich, sind dann aber normaler Chat.
5. Die Meldung bleibt unter „Offen für mich“, bis `resolved_at` gesetzt ist.

**C. Antwort im Chat**
1. `POST /chat/channels/:cid/messages` mit `threadId` = Frage-Nachricht. Bei DMs gilt auch Regel F.
2. Regel F findet die offene Frage, und `answerQuestion(source 'chat', messageId)` läuft.
3. Status `answered`, dazu `answered_by`, `answered_at`, `answer_text` und `answer_message_id`.
4. `update notifications set read_at = coalesce(read_at, now()), resolved_at = now() where ref_type='question' and ref_id in (Frage und ihre Vorgänger über parent_id)` – für alle Empfänger.
5. Log „Rückmeldung per Chat von Anna an Morton: …“ mit source `chat` und Autor Anna; die Zeile wird `answer_comment_id`.
6. Passt `agent_wait.questionId`, wird das Warten gelöscht. Danach `queueAgentRun(task, 'answer')` mit dem Anlass „Antwort auf deine Frage „…“: …“.
7. Für diese Nachricht startet kein eigener Chat-Lauf; der Lauf am AP verarbeitet die Antwort.

**D. Antwort in der Aufgabe**
1. Im TaskDrawer gibt es den Block „Offene Fragen“ mit „Beantworten“ (`POST /questions/:id/answer`). Alternativ nimmt `POST /tasks/:id/comments` ein `questionId` an.
2. Berechtigt sind der Adressat, jedes Mitglied ab Rolle member mit Sicht auf das AP und die PL.
3. Der Kommentar (source `user`) wird gespeichert, dann läuft `answerQuestion(source 'task', commentId)`.
4. Die Schritte C.3 und C.4 folgen. Zusätzlich gehen die `chat.*`-Meldungen des Threads beim Adressaten auf gelesen.
5. In den Frage-Thread kommt eine Systemnachricht (`kind='system'`, Autor Anna): „Beantwortet in GZ-4 von Anna: <Kurzfassung>“. Das Thema ist damit auch im Chat abgeschlossen.
6. `queueAgentRun(task, 'answer')`.

**E. Antwort auf anderem Weg**
- Bei `confirm` beantwortet `/meetings/:id/confirm` bzw. `/bookings/:id/confirm` die Frage (source `meeting`).
- Bei `approval` beantwortet `decideAgentActions` die Frage, sobald kein Vorschlag mehr offen ist.
- Die Agentenaktion `resolve {questionId, reason}` (etwa wenn die Antwort per Mail kam) setzt `answered` mit source `mail`. Im Thread erscheint die Systemnachricht „Erledigt: Antwort kam per Mail (siehe Log GZ-4)“.

**F. Frist**
1. Ist `remind_at` erreicht und noch nicht erinnert, kommt eine Systemnachricht in denselben Thread (Autor der Agent): „Erinnerung: …“. Dazu eine neue Meldung (`q:<id>:remind`) und `reminded_at`.
2. Ist `escalate_at` erreicht, läuft `escalateQuestion`:
   - Die Frage bekommt den Status `escalated`.
   - Ihre Meldungen werden mit „weitergegeben an Peter (PL)“ erledigt; im alten Thread steht eine Systemnachricht.
   - Auf der nächsten Stufe entsteht eine neue Frage mit `level+1` und `parent_id`.
   - `agent_wait.questionId` zeigt auf die neue Frage; ins Log kommt ein Eintrag.
3. Auf der letzten Stufe gibt es keine weitere Weitergabe. Die Frage bleibt offen und erscheint auf dem Dashboard der PL.

**G. Abbruch**
- Auslöser stehen in 5.3.
- Status `cancelled`, alle Meldungen gelesen und erledigt, im Thread „Hat sich erledigt: GZ-4 ist erledigt“, `agent_wait` gelöscht.

**H. Lesen ohne Antwort**
- Wer einen Kanal oder Thread liest, markiert nur die `chat.*`-Meldungen, nicht die Meldungen zu Fragen.

### 5.5 Regel F: Zuordnung von Chat-Antworten

Sie ersetzt `answeredTask` (chat.ts:36-49). Geprüft wird bei jeder Nachricht, auch wenn kein Agent Empfänger ist.

1. **Thread:** Gibt es eine offene Frage mit `message_id = threadId`, ist die Nachricht die Antwort. Im Projektkanal zählen explizite Mitglieder ab Rolle member mit `canSeeSubproject`, in einer DM nur der Adressat. Bei `approval` zählt Freitext nicht als Bestätigung, sondern wird als Rückmeldung ins Log geschrieben (Abschnitt 6.5).
2. **DM-Hauptnachricht:** Gibt es genau eine offene Frage dieses Agenten an diese Person in diesem Kanal, ist die Nachricht die Antwort. Gibt es mehrere, entfällt die Zuordnung. Der Chat-Agent bekommt die offenen Fragen in den Kontext und liefert `answers: [{questionId, text}]`.
3. **Kein Treffer:** `queueAgentChat` wie heute.

Der Regex und die Fenster von 14 Tagen bzw. 2 Stunden bleiben nur 14 Tage als Rückfall für alte Agentennachrichten ohne Frage-Objekt.

### 5.6 Wartezustand

- Am Ende eines Laufs wird `agent_wait` nur gelöscht, wenn keine offene Frage des AP mehr besteht (heute agent.ts:494).
- `runAgents` überspringt `reminder_due` und `escalation_due`, wenn `questionId` gesetzt ist.
- Die Arten `date`, `task` und `info` bleiben. `triggerText` bekommt Texte für `answer`, `approved`, `rejected`, `order`, `changed` und `periodic`.

### 5.7 Oberfläche

- **Glocke:** Reiter „Offen für mich“ (Fragen mit `resolved_at is null`) und „Alle“; Filter nach Projekt und Klasse; Status-Badge.
- **Dashboard:** KPI „Offene Fragen an mich“ und „Bestätigungen für mich“.
- **Messenger:** Threads auch in DMs (Messenger.tsx:113).
- **ChatPane:** Deep-Link `?msg=`, Hervorhebung, Thread-Kopf „Frage zu GZ-4 · offen / beantwortet von Anna in der Aufgabe / erledigt“ mit „Im AP öffnen“ und „Erledigt“, Badge an der Nachricht.
- **TaskDrawer:** Block „Offene Fragen“ über dem Log; im Kommentarfeld die Option „beantwortet Frage …“.

---

## 6. Agenten-Policy (Anforderung 6)

### 6.1 Drei Achsen

- **Selbstständigkeit:** was der Agent ohne Bestätigung ausführt.
- **Reichweite:** zugewiesene APs (`task`) oder das ganze Projekt (`project`).
- **Wissen:** welches Projektwissen er bekommt; immer nur das, wofür er berechtigt ist.

Die KI-Freigaben (Abschnitt 3) entscheiden zuerst. Was dort gesperrt ist, wird weder ausgeführt noch vorgeschlagen.

### 6.2 Stufen und Aktionsklassen

| Stufe | Wirkung |
|---|---|
| `auto` „Selbstständig“ | führt alles aus, was Rechte und KI-Freigaben erlauben |
| `confirm_critical` „Rückfrage bei wichtigen Schritten“ | die Klassen in `confirm` werden bestätigt; Standard: `finalize`, `distribute`, `send_external`, `close`, `restructure` |
| `confirm_all` „Rückfrage bei allem“ | alles außer der Grundmenge wird bestätigt |

**Grundmenge, immer frei** (nach dem Wortlaut der Anforderung: „Doku/Aufgaben bearbeiten, abhaken, loggen, intern kommunizieren“):

- Log schreiben;
- Tasks anlegen, ändern und abhaken;
- Status setzen, außer AP → Erledigt;
- Aufgaben unter dem eigenen AP anlegen und bearbeiten, ohne Zuweisung an Dritte;
- Doku anlegen, ändern, anhängen und verschieben (nicht final);
- Seitenstatus zwischen Entwurf und In Prüfung wechseln;
- Ordner anlegen;
- intern kommunizieren (`chat`, `ask`);
- lesen (`read_page`, `search`, `read_task`, `research`, sofern freigegeben);
- `wait`, `blocked`, `escalate`, `relate`, `withdraw`, `resolve`, `refer`, `none`.

| Klasse | Aktionen | auto | confirm_critical | confirm_all |
|---|---|---|---|---|
| Grundmenge | siehe oben | frei | frei | frei |
| `finalize` | `doc_status` Final setzen oder aufheben (z. B. Protokoll finalisieren) | frei | Rückfrage | Rückfrage |
| `distribute` | `doc_send_pdf` | frei | Rückfrage | Rückfrage |
| `send_external` | `mail`, `reply_origin` an Nicht-Interne | frei* | Rückfrage (Entwurf) | Rückfrage |
| `close` | AP → Erledigt; Aufgabe → Erledigt, wenn sie einen Workflow-Schritt auslöst | frei | Rückfrage | Rückfrage |
| `restructure` | AP verschieben, zusammenführen, archivieren | frei | Rückfrage | Rückfrage |
| `plan` | `create_ap`, `create_subproject`, `create_milestone`, Abhängigkeit setzen | frei | wählbar | Rückfrage |
| `assign` | `assign`; Anlage mit Zuweisung an Dritte | frei | wählbar | Rückfrage |
| `schedule` | `set_dates` an bestehenden Terminen | frei | wählbar | Rückfrage |
| `foreign` | Änderungen an fremden APs (setzt `can_edit_plan` voraus) | frei | wählbar | Rückfrage |

Festlegungen zur Tabelle:

- \* `send_external`: Der erste Kontakt zu einer Adresse der Klasse `unknown_external` ist unabhängig von der Stufe immer ein Entwurf. Direkt gesendet wird nur, wenn `agent_can_mail` an ist, `send_external` nicht in `confirm` liegt, `agent.send_external` erlaubt ist und `checkOutbound` pass liefert.
- `create_event` und `book_resource` legen immer vorläufig an. Das Vorläufige ist selbst die Rückfrage (Frage `confirm`); sie werden nie zusätzlich angehalten.
- Agenten löschen nie und bestätigen nie Termine (meetings.ts:180).
- Eine `mail` an interne Projektmitglieder wird verworfen: „Interne per ask/chat“. Org-Benutzer ohne Zugriff auf das Projekt gelten als Nicht-Interne (`outside`).
- Mail-KI „KI Bearbeiten“ handelt mit den Rechten der einschaltenden Person; für sie gilt diese Policy nicht. Triage schlägt weiterhin nur vor.

### 6.3 Regel A: Vererbung

| Ebene | Speicher | Wer setzt | Felder |
|---|---|---|---|
| Org | `orgs.settings.ai.agentPolicy` | Org-Admin, `ai_admin` | `mode`, `confirm`, `scope`, `synergies`, `reviewAt`; Grenzen `maxMode`, `lockedConfirm` |
| Projekt | `projects.agent_policy` | PL | dieselben Felder; Grenzen für tiefere Ebenen; `chat.orders` |
| Agent im Projekt | `project_members.agent_policy` | PL | `mode`, `confirm`, `scope`, `synergies` |
| AP (gilt auch für seine Aufgaben) | `tasks.agent_policy` | PL (auch per Chat-Befehl `policy`); mit `can_edit_plan` nur verschärfen | `mode`, `confirm` |

`effectiveAgentPolicy(db, {agentId, projectId, taskId})` löst so auf:

1. Je Feld gilt die tiefste gesetzte Angabe.
2. `mode` wird auf die strengste `maxMode` von Org und Projekt begrenzt. Die Reihenfolge der Strenge ist auto < confirm_critical < confirm_all.
3. `confirm` ist die gewählte Liste plus `lockedConfirm` von Org und Projekt.
4. Gesperrte Klassen kommen aus `ai_policies` (`agent.<klasse>`).
5. Zu jedem Feld wird die Herkunft mitgeliefert, zum Beispiel „Org erzwungen“ oder „Projekt BAU“.

Der Policy-Text steht im variablen Teil des Prompts, nicht im Sheet, damit der Prefix-Cache erhalten bleibt.

### 6.4 `gateAction(action, ctx) → run | hold | deny`

1. `aiAllowed(agent, p, 'agent.run')` fällt durch → der ganze Lauf ist `skipped`.
2. `classifyAction` bestimmt die Klasse aus Aktion und Ziel: eigenes oder fremdes AP, Empfänger intern oder extern, Zielstatus.
3. `aiAllowed(..., 'agent.<klasse>')` sperrt → `deny`. Ins Log und an das Modell geht „Gesperrt durch Org-Admin: …“. Deny schlägt alles.
4. Rechte wie heute: `can_finalize`, `inScope`, `agent_can_mail`, `canSeeSubproject`; neu `agent_access` des Ordners. Eine Bestätigung erweitert keine Rechte.
5. Liegt die Klasse in `confirm` (bzw. gilt `confirm_all`), ergibt sich `hold`, sonst `run`.

### 6.5 Bestätigung

**Anhalten**

1. Jede angehaltene Aktion wird ein Eintrag in `ai_proposals`:
   - `kind='agent_action'`, `payload {action, base}`, `action_class`, `seq`, `depends_on`, `agent_run_id`, `fingerprint`.
   - `base` hält den Stand fest, auf den sich die Aktion bezieht: Seitenversion, Status, Termine, Zuständigkeit.
   - Bei `send_external` wird zusätzlich der Entwurf (`pending_approval`) angelegt und über `mail_draft_id` verknüpft.
2. Je Lauf entsteht **eine** Frage `approval` an die erste freigabeberechtigte Person der Kette. Im Thread steht eine Systemkarte (`chat_messages.meta`): „GZ-12 „Elektroabnahme“: Bitte bestätigen: 1) Protokoll final setzen 2) PDF an Verteiler (5 Empfänger)“, mit „Alle bestätigen“, einzelnen Häkchen und „Ablehnen“ (Grund ist Pflicht).
3. Ins Log kommt „Wartet auf Bestätigung durch Anna: …“; `agent_wait` zeigt auf die Frage. Die freien Aktionen des Laufs werden normal ausgeführt.

**Wer bestätigt**

- PL bzw. Stellvertretung.
- Wer `can_approve` und das Recht der Aktion hat: `can_finalize` für finalize und distribute, `can_edit_plan` für plan, foreign und restructure, Senderecht der Ansicht bzw. Konto-Verwaltung für send_external.
- Bei `close`, `assign` und `schedule` zusätzlich der Ansprechpartner (Stufe 0).
- Agenten nie.

**Entscheiden:** `POST /questions/:id/decide {approve:[], reject:[], reason}` über die Karte, den TaskDrawer oder AiView › Vorschläge. Senden bzw. Ablehnen eines verknüpften Entwurfs in Mail › Freigaben entscheidet den Vorschlag mit.

**Ausführen:** `applyAgentAction()` wird aus agent.ts:257ff herausgelöst; Laufschleife und Bestätigung nutzen denselben Code.

- Die Rechte des Agenten werden **neu** gelesen, und die Schritte 1, 3 und 4 aus 6.4 laufen erneut.
- Hat sich `base` geändert, wird der Vorschlag `stale`; fehlt ein Recht, wird er `failed`.
- Sonst Ausführung in `seq`-Reihenfolge mit dem Log „Ausgeführt nach Bestätigung durch Anna: …“.

**Ablehnen:** Status `rejected`, abhängige Vorschläge gleich mit, Log „Abgelehnt von Anna: Grund“. Denselben `fingerprint` weist das Gate 14 Tage lang ab.

**Abschluss:**

- Ist kein Vorschlag mehr offen, läuft `answerQuestion`, und die Meldungen sind erledigt. Danach `queueAgentRun(task, 'approved' | 'rejected')`.
- Freitext im Thread gilt nie als Bestätigung. Er kommt als Rückmeldung ins Log und startet einen Lauf; der Agent kann mit `withdraw` neu vorschlagen.
- Nach `expireH` (336 h) werden offene Vorschläge `expired`.
- Audit: `agent.action.proposed`, `.approved`, `.rejected`, `.expired`.

### 6.6 Reichweite und Projektagent

- **`scope='task'` (Standard):** Der Agent arbeitet an zugewiesenen APs wie heute. Er bekommt relevantes Projektwissen (6.8) und Kandidaten für Überschneidungen zu seinem AP.
- **`scope='project'` (Projektagent):** Zusätzlich gibt es den Lauf `project_review`.
  - Er hat kein AP (`agent_runs.task_id` ist null, `scope='project'`).
  - Der Worker startet ihn über `runProjectReviews`, werktags zur Uhrzeit aus `reviewAt` (Standard 06:45, Europe/Berlin, über `dueLocal`). Die PL kann ihn auch von Hand anstoßen.
  - Ist der Quell-Hash unverändert, gibt es keinen LLM-Aufruf.
  - Budget, Pause und `aiAllowed` gelten. Das schließt auch die Umgehung beim manuellen Lauf (agents.ts:154).
  - Er findet Doppelarbeit, Synergien, Widersprüche zwischen AP und Doku sowie offene Fragen. Er sieht alle sichtbaren APs, ist dadurch aber für keines zuständig.
  - Er schreibt den Steckbrief (`project_digests.brief`). Fremde APs ändert er nur mit `auto` und `can_edit_plan`.

### 6.7 Synergien

`findCandidates()` braucht keine Token. Die Signale sind:

- `contact`: gleicher Externer (über Zuständigkeit, Mailabsender oder Kontakt);
- `terms`: mindestens drei gemeinsame Stichwörter oder Jaccard ≥ 0,35;
- `date_place`: überlappender Zeitraum am gleichen Ort oder mit gleicher Ressource;
- `page`: dieselbe Seite in beiden Logs;
- `dependency`: Abhängigkeit mit Terminkonflikt;
- `question`: offene Fragen an dieselbe Person, die sich bündeln lassen.

Je Projektdurchlauf werden höchstens 10 Paare geprüft, je AP-Lauf 3. Das Modell bewertet sie und antwortet mit `relate`.

| `synergies` | Wirkung |
|---|---|
| `off` | keine Kandidaten |
| `ask` (Standard; in den `confirm_*`-Stufen immer) | Frage `synergy` an beide Zuständige. Sind Agenten zuständig oder liegen die APs in verschiedenen Teilprojekten, geht sie an die PL. Knöpfe: „synchron bearbeiten (Lead GZ-4)“, „Abhängigkeit“, „zusammenführen“, „unabhängig“ |
| `use` (nur bei `auto`) | Querverweis in beiden Logs und Abstimmung per Chat. Eine Abhängigkeit folgt der Klasse `plan`, Zusammenführen ist immer `restructure` |

`POST /relations/:id/decide` führt die gewählte Option mit den Rechten der entscheidenden Person aus. Bereits entschiedene Paare kommen nur mit einem neuen Signaltyp wieder.

### 6.8 Wissen und Kontext, nur soweit berechtigt

**`agentVisibility()`** liefert die Filter:

- `visibleSubprojectSql` (künftig auch für die Teilprojektliste im Prompt, heute agent.ts:159);
- `agent_access` der Ordner, über die Ordnerhierarchie vererbt, die strengste Angabe gilt;
- lesbare Mail-Ansichten und `bodyOk`;
- Direktnachrichten nur, wenn sie die Kennung des AP nennen, sowie die Frage-Threads des AP (heute alle DMs, agent.ts:182).

**Reihenfolge im Prompt:** feste Blöcke vorne für den Prefix-Cache, dann je Agent und Projekt, dann je Projekt und Sichtbarkeit, dann je AP, dann Suchergebnisse, zuletzt Rechte und Anlass.

1. **Fest:** `AGENT_SHEET` plus `TASK_RULES` bzw. `PROJECT_RULES`.
2. **Je Agent und Projekt:** Name, Rolle, Persona und der Policy-Text.
3. **Je Projekt und Sichtbarkeit:** Projektüberblick (`project_digests`).
   - Die Struktur entsteht per Code, höchstens 4000 Zeichen.
   - Den Steckbrief schreibt nur der Projektagent, höchstens 2500 Zeichen.
   - Gespeichert wird je `visibility_key`, damit ein Überblick nie mehr enthält, als der Agent sehen darf.
4. **Je AP:** AP, Aufgaben, Tasks, Log, offene Fragen und Bestätigungen, Mails.
5. **Gesucht (`knowledge.search`):** die 10 besten Seitentitel plus 3 Ausschnitte à 800 Zeichen (statt der 40 neuesten Titel), 5 ähnliche APs, Beziehungen.
6. **Rechte und Anlass:** Rechte, Planungsrahmen, Ansprechpartner, Kalender, Warten, Anlass.

**Lesen:** `search` und `read_task` sind Leserunden wie `read_page`: höchstens 2 Runden mit zusammen 6 Zugriffen.

**Kontextgröße:** `ai_profiles.context_tokens` (Standard 32k); die Eingabe belegt höchstens 45 %. `fitBudget()` kürzt in dieser Reihenfolge: AP-Liste, Seitentitel, ähnliche APs, Mailtexte, Log, Steckbrief. Das eigene AP und offene Bestätigungen bleiben immer vollständig. `agent_runs.context_stats` hält fest, was gekürzt wurde.

**Cache:** `complete()` bekommt `cacheAfter`, für Anthropic als `cache_control` nach Block 2 und Block 3. Ob der Cache greift, zeigt `cache_read_input_tokens`; die Mindestlänge eines Präfixes hängt vom Modell ab.

**Fehlender Zugriff:** Braucht der Agent etwas, das er nicht sieht, fragt er die PL per `ask`. Freigaben erteilt er sich nie selbst.

---

## 7. Steuerung durch die PL im Chat (Anforderung 7)

### 7.1 Wer darf was

| Absender | Aufträge (neue Arbeit) | Steuerbefehle | Bestätigen | Policy-Ausnahme |
|---|---|---|---|---|
| PL / Stellvertretung | überall im Projekt, sofort ausgeführt | alle Agenten, alle APs | ja (Karte) | ja, innerhalb von `maxMode`/`lockedConfirm` |
| TP-Verantwortung | im eigenen TP, wenn `chat.orders ≥ tp` | APs im eigenen TP | mit `can_approve` + Recht der Aktion | nein |
| Zuständige(r) bzw. Ansprechpartner | Aufgaben unter dem eigenen AP, wenn `chat.orders ≥ responsible` | Pause/Weiter am eigenen AP, eigene Berichtsregel | bei close/assign/schedule | nein |
| Mitglied | wenn `chat.orders = members`, sonst Frage `order_request` an die PL | `note` (Information ins Log) | nein | nein |
| Leser, implizite Leser | nein | nur Auskunft; implizite Leser schreiben nicht | nein | nein |
| Org-Benutzer ohne Projektzugriff | nein | nur Auskunft zu Projekten, die er selbst sieht | nein | nein |
| Extern (P11) | nein | `note` mit visibility external zur eigenen Aufgabe; `refer` | nein | nein |

Davor läuft immer `aiAllowed`: `agent.chat` für Absender und Agent, bei Aufträgen zusätzlich `agent.order`.

### 7.2 Kontext im Chat-Prompt

Der Kontext steht nach dem festen Block:

- Absender mit Rolle, Rechten und den daraus erlaubten Befehlen. Heute kennt der Agent nur den Namen (agentChat.ts:77) und verweist deshalb die PL an die PL.
- Effektive Agenten-Policy des Projekts und der genannten bzw. eigenen APs, jeweils mit Herkunft.
- Offene Bestätigungen, offene Fragen und `agent_wait`.
- Eine kompakte AP-Liste der Projekte, die Absender und Agent beide sehen (Kennung, Titel, TP; höchstens 40), statt nur der 25 eigenen.
- Fähigkeiten: Online-Recherche ja oder nein (mit Grund), Mail direkt oder als Entwurf, Selbstständigkeit.

So kann der Agent die Frage „Gab es eine Policy?“ wahrheitsgemäß beantworten, zum Beispiel: „GZ-4 wartet auf deine Bestätigung (Klasse plan; Projektvorgabe ‚Rückfrage bei wichtigen Schritten‘, gesetzt von der Org).“

### 7.3 Befehle

Das Antwortschema enthält neben `reply` die Liste `commands[]`: höchstens 5 Befehle, davon höchstens 1 `order`. `notes` gehen darin als `note` auf.

| Befehl | Wirkung (gemeinsamer Code mit dem AP-Lauf) |
|---|---|
| `order {parent?, subproject?, title, text, dueDate?, deliverables[], report?, deliver?}` | AP oder Aufgabe anlegen (7.4) |
| `note {ref, text}` | Log-Eintrag mit source `chat`; Autor ist der Absender, nicht der Agent; danach ein Lauf |
| `pause` / `resume {ref}` | `tasks.agent_paused`; erlaubt laut 7.1, heute nur PL (agents.ts:147) |
| `stop {ref, reason}` | Pause, offene Fragen abbrechen, offene Vorschläge `withdrawn` |
| `priority {ref, level}` | `tasks.priority` (gibt es schon); wird im AP-Prompt angezeigt und bestimmt die Reihenfolge in `runAgents` |
| `approve` / `reject {ref, reason?}` | Der Agent führt nichts aus. Das System zeigt die Karte mit den offenen Vorschlägen direkt unter der Nachricht; freigegeben wird per Klick (Entscheidung 5) |
| `policy {ref, mode?, release[]}` | `tasks.agent_policy` nur für dieses AP bzw. diesen Auftrag, nur durch die PL, begrenzt durch `maxMode`/`lockedConfirm`; Audit `agent.policy` |
| `report {ref, every, channels}` | Berichtsregel (7.5) |
| `refer {text}` | Frage an die Kette, wenn der Absender nicht berechtigt ist |

### 7.4 Auftrag aus dem Chat

1. **Projekt bestimmen:** Im Projektkanal ist es das Projekt des Kanals. In einer DM ist es das einzige gemeinsame Projekt, in dem der Absender Aufträge geben darf. Gibt es mehrere, fragt der Agent nach und gibt keinen Befehl ab. Bei Agenten einer PL ist es `agent_project_id`.
2. **Rechte:** Angelegt wird mit den Rechten des Auftraggebers. Der Agent wird zuständig, wenn der Auftraggeber laut `chat.orders` beauftragen darf; das ist eine Ausnahme zu plan.ts:34 nur auf diesem Weg. Danach arbeitet der Agent mit seinen eigenen Rechten und seiner Policy.
3. **Dubletten:** gleicher Titel unter demselben Über-AP (agent.ts:553), zusätzlich `findCandidates()` ab P9. Gibt es ein ähnliches offenes AP, fragt der Agent nach, statt anzulegen: „GZ-7 ‚Backup-Elektriker‘ gibt es schon – dort weiter?“.
4. **Anlage über `createPlannedTask`:** `requested_by` ist der Absender, `origin_message_id` die Chat-Nachricht, die Beschreibung der Auftrag im Wortlaut, die Tasks kommen aus `deliverables`. Ins Log kommt „Auftrag von Philipp Schwarz per Chat: …“ mit source `chat`.
5. Der Auftraggeber steht an erster Stelle der Kette. Rückfragen, Bestätigungen und Entscheidungen gehen an ihn.
6. `queueAgentRun(task, 'order')` mit eigenem Anlass-Text.
7. Die Bestätigung im Chat schreibt das System als Systemkarte: „Angelegt: GZ-9 ‚Backup-Elektriker Edertal: Entscheidungsvorlage‘ unter GZ-5 · zuständig Morton · Auftraggeber Philipp“. Knöpfe: „Öffnen“ und „Rückgängig“ (10 Minuten lang; archiviert mit Log-Eintrag).

### 7.5 Wahrheit, Zwischenstände, Lieferung

**Wahrheit**

- Ablauf: Modell → `commands` → `gateChatCommand()` (Rechte, Policy, Budget) → Ausführung → Ergebnisse `{ok|held|denied, text, link}`.
- Erst danach wird gepostet, und zwar zweierlei: die `reply` des Agenten und darunter die Systemkarte, zum Beispiel „Nicht ausgeführt: GZ-7 – kein Zugriff“.
- **`claimCheck`:** Steht in der Antwort in der ersten Person, etwas sei angelegt, vermerkt, eingetragen, gesendet, freigegeben oder erledigt, ohne dass ein erfolgreicher Befehl dieser Art dahintersteht, ersetzt das System den Satz durch „Das konnte ich nicht ausführen:“ und verweist auf die Karte.
- Heute wird eine `note` zu einem AP außerhalb der 25 eigenen ohne Meldung verworfen (agentChat.ts:88), die Antwort „in GZ-7 vermerkt“ bleibt aber stehen. Genau das verhindert `claimCheck`.

**Zwischenstände**

- „Ich möchte jeden Zwischenstand“ wird zum Befehl `report` und damit zu einer Regel auf L6 (für den Auftraggeber) mit dem Ereignis `progress`.

| `every` | Bedeutung |
|---|---|
| `each` | jeder Lauf mit mindestens einer ausgeführten inhaltlichen Aktion |
| `milestones` | Statuswechsel, Seite „In Prüfung“, Entscheidung (Standard bei Aufträgen) |
| `daily` | einmal am Tag |
| `done` | nur bei Abschluss |

- Den Inhalt schreibt das System aus den ausgeführten Aktionen und der Notiz des Laufs, mit Links. Er geht in den Thread der Auftragsnachricht.

**Lieferung**

- `deliver.mail` verschickt die Meldung mit dem PDF der Seite über den Benachrichtigungsversand (4.5). Das ist nicht die Mail-Aktion des Agenten; die Regel „Interne nie per Mail fragen“ bleibt unberührt.

**Entscheidungsvorlage**

1. Seite im Ordner „Entscheidungen“, danach Status „In Prüfung“.
2. Frage `decision` an den Auftraggeber mit den Optionen als Knöpfe.
3. „Freigeben“ setzt die Seite mit dem Recht der entscheidenden Person auf Final.
4. Lauf mit Anlass `approved`.

### 7.6 Der Fall aus dem Screenshot

1. **„gab es eine Policy, die das direkte Starten verbot?“** Morton liest Policy und offene Bestätigungen aus dem Kontext und antwortet wahrheitsgemäß.
2. **„Gesamtkonzept ist abgenommen. Baue das board“** wird zu zwei Befehlen:
   - `note {GZ-4, „Gesamtkonzept abgenommen“}`: Log mit Autor Philipp, source `chat`.
   - `approve {GZ-4}`: Die Karte mit den angehaltenen plan-Aktionen erscheint sofort unter der Nachricht, Philipp bestätigt mit einem Klick. Ist nichts angehalten, startet ein Lauf an GZ-4 mit Anlass `order`.
   - Optional `policy {GZ-4, mode:auto}`, wenn Philipp „ohne Rückfrage“ sagt.
3. **„3 Elektriker aus dem Edertal recherchieren … Entscheidungsvorlage … per Mail an mich … jeden Zwischenstand“** wird zu `order {parent: GZ-5, title: „Backup-Elektriker Edertal: Entscheidungsvorlage“, deliverables: [3 Betriebe recherchieren (nur online), Vergleich, Entscheidungsvorlage], report: {every: each}, deliver: {mail: true}}`. GZ-9 wird angelegt, die Karte bestätigt es.
4. Im Lauf an GZ-9 folgen:
   - `research`, wenn `agent.web` freigegeben ist; sonst Log und Chat: „Online-Recherche ist für mich nicht freigegeben (Verwaltung › KI)“.
   - die Seite mit Quellen;
   - die Frage `decision` an Philipp;
   - nach jedem Schritt ein Zwischenstand im Thread.
5. Philipp gibt frei. Die Seite wird Final, das PDF geht per Mail an ihn.
6. Eine spätere Anfrage beim gewählten Betrieb ist `send_external`: Rückfrage nach Policy, erster Kontakt immer als Entwurf, Außenprüfung (Abschnitt 9).

### 7.7 Keine verlorenen Nachrichten

Solange ein Lauf ansteht oder läuft, verwirft `queueAgentChat` heute neue Nachrichten (agentEvents.ts:44). Neu bekommt die Warteschlange ein Dirty-Flag: Ereignisse, die während eines Laufs eintreffen, lösen genau einen Folgelauf aus. Der Folgelauf liest den Verlauf neu.

---

## 8. Online-Recherche

- **Anthropic-Profile:**
  - Ein eigener Aufruf `research(cfg, {question})` in `ai/web.ts` mit dem Server-Tool `web_search_20260209` (auf Modellen ab Opus 4.6 bzw. Sonnet 4.6; ältere Modelle nutzen `web_search_20250305`) und optional `web_fetch_20260209`. web_fetch ruft nur URLs ab, die schon im Gespräch stehen.
  - Parameter: `max_uses` (Standard 5), `allowed_domains` **oder** `blocked_domains` (nicht beides), `user_location` Deutschland.
  - Der Aufruf läuft ohne JSON-Schema, weil Zitate und `output_config.format` sich ausschließen. complete() setzt das Schema heute über `output_config.format` (client.ts:108).
  - Das Ergebnis geht als Leserunde (wie `read_page`) in den Lauf zurück.
  - Fehler kommen als Ergebnisblock, nicht als Exception.
  - Gegebenenfalls muss die Websuche für die Organisation in der Anthropic-Console freigeschaltet werden.
- **Lokale Profile:**
  - Optional SearXNG (selbst betrieben) oder die Brave Search API. Das System sucht und ruft Seiten ab: nur GET, SSRF-Schutz, Größenlimit, Filter der Suchbegriffe. Weitergegeben werden Ausschnitte mit URL.
  - Ohne Anbieter steht in den Fähigkeiten „nicht verfügbar (Profil X)“.
- **Freigabe:**
  - KI-Funktion `agent.web`, **standardmäßig gesperrt**. Der Org-Admin schaltet sie für alle, einzelne Projekte oder einzelne Agenten frei.
  - Zusätzlich muss `ai_profiles.web_search` gesetzt sein.
  - Einstellungen: `orgs.settings.ai.web = {provider, url, maxPerRun, dailyPerAgent (20), allowedDomains | blockedDomains}`.
- **Nur lesen:** keine Formulare, kein Kontakt. „Nicht anfragen“ ist zusätzlich durch `send_external` abgesichert.
- **Quellen:**
  - Das System übernimmt Zitate bzw. URLs nach `agent_web_sources` und hängt der Seite automatisch den Abschnitt „Quellen (abgerufen am …)“ an.
  - Aussagen ohne Zitat kennzeichnet das System als „ohne Beleg“.
- **Kosten:** je Suche laut Preisliste von Anthropic (vor der Freigabe prüfen) plus Token. Zählung in `agent_runs.web_searches`, Anzeige in AiView.
- **Datenschutz:**
  - Regel im Sheet: Suchbegriffe ohne Namen, Adressen oder Interna.
  - Beim Anthropic-Tool lassen sich die Begriffe vorab nicht filtern, sie werden aber protokolliert. Bei der Suche auf dem Client filtert das System vor dem Senden.

---

## 9. Informationsgrenze für Externe (Anforderung 8)

### 9.1 Regel E: Empfängerklassen (`audienceOf(db, {projectId, taskId, recipients})`)

| Klasse | Wer | Darf erfahren |
|---|---|---|
| `internal` | aktive Person, effektives Projektmitglied (direkt oder über Gruppe), sieht das TP | was sie selbst sehen darf |
| `outside` | Org-Benutzer ohne Projektzugriff oder ohne Sicht auf das TP | nur den Außenkontext (nicht berechtigt) |
| `task_external` | Adresse oder Benutzer mit Bezug zu diesem AP (siehe unten) | nur den Außenkontext |
| `unknown_external` | alle übrigen | nur den Außenkontext; der erste Kontakt ist immer ein Entwurf |

**Bezug zum AP haben:**

- Zuständigkeit am AP, am Über-AP, an einer Aufgabe darunter oder an einem Task (`responsible_email`);
- Mails am AP (Absender, An, Cc);
- Teilnahme an einer verknüpften Besprechung;
- eine Person-Ressource, die am AP gebucht ist (ab P10);
- `task_access` (ab P11).

Für eine Nachricht gilt die strengste Klasse unter ihren Empfängern. Ein externer Cc macht die ganze Mail extern.

### 9.2 Außenkontext (`externalContext(db, taskId, recipient)`)

**Enthalten:**

- Titel, Termine und Status in Worten;
- die Tasks des Empfängers, bei eigener Zuständigkeit alle;
- `tasks.external_brief`; die Beschreibung selbst nur, wenn das AP diesem Externen zugewiesen ist;
- Mails mit genau diesem Empfänger am AP;
- Log-Einträge mit `visibility='external'`;
- freigegebene Seiten: der Empfänger steht im Verteiler des Ordners, oder es gibt eine aktive `doc_shares`-Zeile mit seiner Adresse (auch über `include_children`), oder eine Person gibt die Seite in der Außenprüfung frei (dabei entsteht eine `doc_shares`-Zeile mit mode read);
- Termine verknüpfter Besprechungen, an denen er teilnimmt;
- `projects.external_profile`: Name nach außen, Adresse, Zufahrt, Ansprechpartner für Externe (pflegt die PL).

**Nicht enthalten:** andere APs, Teilprojekte, Mitglieder und ihre Adressen, Doku-Index, Meilensteine, Belegt-Zeiten, andere Mails, Preise. Entwürfe von Seiten gehen nie nach außen.

### 9.3 Durchsetzung in vier Schichten

1. **Kontext schneiden:** Der Chat-Agent bekommt bei einem Absender, der nicht `internal` ist, nur die Projekte, die dieser sieht. Externe Absender (P11) bekommen nur den Außenkontext ihrer Aufgaben. `aiFinalReply` bleibt, wie es ist, wird aber geprüft (Schicht 3).
2. **Außen-Redaktion (Stufe `strict`)** für `mail` und `reply_origin` aus dem AP-Lauf an Empfänger, die nicht `internal` sind:
   - Der Lauf liefert Empfänger, Betreff und Text als Absicht.
   - `composeExternal()` formuliert neu und kennt dabei **nur** den Außenkontext und die Absicht. Ausgabe: `{subject, text, withheld[]}`.
   - Neues zu diesem AP (Terminvorschlag, Menge, Frage) ist erlaubt. Was nach Projektinternem aussieht, landet in `withheld`.
   - Kosten: ein kleiner Aufruf je externer Mail, höchstens drei je Lauf.
   - Bei Stufe `check` entfällt diese Schicht.
3. **Prüfung vor dem Versand (`checkOutbound()`, deterministisch).** Gesucht wird nach:
   - fremden Kennungen (alles außer AP, Über-AP und Aufgaben darunter);
   - Titeln anderer APs und Teilprojekte;
   - Titeln nicht freigegebener Seiten;
   - Adressen interner Personen außer den Kontakten aus `external_profile`;
   - anderen Projektkennungen und Projektnamen;
   - App-Links (`/projekte/`, `/doku/`, `/chat/`);
   - Anhängen, die nicht final sind oder keine Freigabe haben.

   | Ergebnis | Folge |
   |---|---|
   | `pass` | wird gesendet |
   | `held` | Entwurf `pending_approval`, Meldung `review`, Fundstellen in Mail › Freigaben mit „Bearbeiten und senden“ |
   | `blocked` | nicht freigegebener Anhang oder Entwurfsseite: wird nicht gesendet, der Fehler geht an das Modell |

   Bei KI-Entwürfen (reply_draft, aiFinalReply) und bei Mails, die eine Person selbst sendet, sieht die Person die Fundstellen nur als Hinweis und wird nicht blockiert.
4. **Protokoll:** `outbound_checks` speichert jede Prüfung samt Fundstellen und `withheld`. Ins interne Log kommt etwa „Nach außen an x@y (Aufgabenbezug GZ-9): gesendet, 1 Inhalt zurückgehalten“. Audit `ai.outbound`.

### 9.4 Rückfragen von Externen außerhalb ihrer Aufgabe

- Eingehende Nachrichten erscheinen im Prompt als „von Extern (task_external), Scope GZ-9“, also Mails an die Antwortadresse und, ab P11, Portal und DM.
- Für alles außerhalb dieses Scopes gibt es die Aktion `refer {text}`:
  1. Frage `external_referral` an die Kette: Auftraggeber → Zuständige(r) des Über-AP → TP-Verantwortung → PL, also an den nächsten Menschen. In P2 übergangsweise als Log-Eintrag, Meldung und DM an die erste Person der Kette.
  2. An den Externen geht nach der Prüfung nur: „Ihre Frage zu … gebe ich an [Kontakt aus `external_profile`, sonst ‚die Projektleitung‘ über die Projektadresse] weiter.“ Namen oder Adressen interner Personen nennt das System nur, wenn sie im externen Profil stehen.
  3. Ins interne Log kommt ein Eintrag.
- Antwortet die Person mit „darf weitergegeben werden“, wird ihre Antwort ein Log-Eintrag mit `visibility='external'` und damit Teil des Außenkontexts. Danach startet ein Lauf.

### 9.5 Was nicht über die Außengrenze läuft

Systemvorlagen ohne KI bleiben unverändert: Fälligkeitserinnerungen (tasks/reminders.ts), die externe Eskalationsmail der Stufe 3 (escalation.ts:170) und Einladungen per ICS. Sie enthalten nur Titel und Termin des AP. Freigabelinks in `doc_shares` sind ausdrückliche Entscheidungen von Menschen.

---

## 10. Ressourcen und Personen im Kalender (Anforderung 1)

### 10.1 Modell

- **`resources`** ist alles Buchbare, das kein Benutzer ist: Raum, Gerät, Gerüst, Fahrzeug, externe Person oder Firma (z. B. der Elektriker, mit `trade` = Gewerk), Sonstiges.
  - `project_id` null bedeutet Pool des Mandanten.
  - Kontakte werden über die Mailadresse verbunden. Ein eigenes Org-Adressbuch gibt es nicht.
  - Jede Einheit ist ein eigener Eintrag; ein Mengenmodell gibt es nicht.
- **`resource_bookings`** gilt genau einer Ressource **oder** einer internen Person. Die Belegung hängt an einer Besprechung, an einem AP bzw. einer Aufgabe oder steht frei im Projekt. Ohne Projekt ist sie eine Sperrzeit oder eine Abwesenheit.
  - **Ganztägig:** von Mitternacht bis Mitternacht Europe/Berlin, das Ende zählt nicht mit (`dayRange()`).
  - **`follow_task`:** Die Belegung folgt Start und Termin des AP.
  - **Vorläufig und bestätigt:** wie bei `meetings`.
- **Belegt-Zeit einer Person** = Belegungen + Besprechungen, die sie angelegt hat oder an denen sie teilnimmt (aus allen Projekten, auch dem eigenen) + Abwesenheiten.

### 10.2 Rechte

| Aktion | Pool | Projektressource |
|---|---|---|
| Sehen | alle aktiven Personen des Mandanten | Leser des Projekts |
| Anlegen, ändern | Org-Admin, `resources_admin` | ab Mitglied |
| Deaktivieren, löschen (nur ohne künftige Belegungen, sonst `active=false`) | Org-Admin, `resources_admin` | PL |
| Buchen | ab Mitglied im buchenden Projekt; mit Freigabegruppe und ohne Mitgliedschaft darin bleibt die Buchung vorläufig (`booking.request`) | ab Mitglied |
| Belegung ändern, löschen | Ersteller oder PL des buchenden Projekts; die Freigabegruppe darf ablehnen | Ersteller, PL, `can_edit_plan` |
| Bestätigen | eine Person, kein Agent; bei Freigabegruppe nur deren Mitglieder | ab Mitglied |
| Konflikt übersteuern (`force`) | PL oder `can_edit_plan` des buchenden Projekts | dito |
| Sperrzeit | Org-Admin, `resources_admin`, Freigabegruppe | PL |
| Abwesenheit | jede Person für sich, Org-Admin für alle | – |

**Maskierung (`maskBooking`):** Titel, Projekt und AP sieht nur, wer das Projekt sieht (`effectiveMembership`) und, bei eingeschränktem TP, auch dieses. Alle anderen sehen nur „belegt“ bzw. „vorläufig“. Abwesenheiten zeigen anderen nur „abwesend“. Belegungen aus persönlichen Projekten sind für andere immer maskiert.

### 10.3 Konflikte

`findConflicts(db, {resourceId|userId, startsAt, endsAt, excludeBookingId?, excludeMeetingId?})` liefert `{hard: bestätigt, soft: vorläufig}`, bereits maskiert.

- Bestätigte Überschneidung bei direkter Buchung: Antwort 409 mit `conflicts`. Nur PL oder `can_edit_plan` können mit `force` buchen; das wird als Audit `booking.force` festgehalten und gemeldet. Mitglieder können stattdessen vorläufig anfragen.
- Vorläufige Überschneidung: Antwort 200 mit `warnings`.
- Agenten setzen nie `force`.
- Indirekte Verschiebungen (Besprechung oder AP verschoben) werden nicht blockiert. Die Belegung wird gespeichert und `booking.conflict` gemeldet.
- Das Feld `conflict` wird beim Lesen berechnet.
- Die Prüfung läuft im Code, nicht als Exclusion-Constraint, weil vorläufige Überschneidungen erlaubt bleiben sollen.

### 10.4 Besprechungen und APs

- **Besprechungen:** `POST/PATCH /meetings` nehmen `resourceIds` an. Daraus entstehen Belegungen mit der Zeit der Besprechung; sie sind vorläufig, wenn die Besprechung vorläufig ist oder eine Freigabe aussteht.
  - `syncMeetingBookings()` zieht die Belegungen bei Zeitänderungen nach.
  - Bestätigen bestätigt auch die Belegungen; Löschen entfernt sie über die Cascade.
  - Ist ein Raum gewählt und `location` leer, wird der Raumname zur `location`.
  - Eine Person-Ressource mit Mailadresse wird auch Teilnehmer.
- **APs:** Eine Belegung mit `task_id` übernimmt als Vorschlag den Zeitraum des AP, ganztägig mit `follow_task`. `syncTaskBookings()` läuft nach PATCH (tasks.ts:302), nach „Nachfolger verschieben“ (tasks.ts:430), nach `set_dates` (agent.ts:579) und nach übernommenen Vorschlägen (ai.ts:274). Ins Log kommt zum Beispiel „Gerüst Nord gebucht 03.–21.11. (vorläufig)“.

### 10.5 Agenten

- **Kontext:** Belegt-Zeiten des Ansprechpartners inklusive Belegungen, Abwesenheiten und eigenem Projekt; eine Liste der Ressourcen (Projekt und Pool, höchstens 15) mit ihren Belegungen der nächsten 45 Tage ohne Details (höchstens 5 je Ressource); die Belegungen dieses AP.
- **Aktion `book_resource {resource, startsAt/endsAt | startDate/dueDate, text}`:** Die Buchung ist immer vorläufig und erzeugt eine Frage `confirm` (mit `booking_id`) an Stufe 0. Bei hartem Konflikt geht der Fehler „belegt am …, anderen Zeitraum wählen“ an das Modell.
- **`create_event`** bekommt die Felder `resources` und `attendees`. `createPlannedEvent` trägt den Ansprechpartner als Teilnehmer ein; heute legt plan.ts:75 `'[]'` an, sodass KI-Termine für niemanden als belegt zählen. Der Code prüft Konflikte, statt nur Duplikate.
- **Zusage an Externe** erst nach der Bestätigung (Sheet).

### 10.6 Meldungen (Klasse `booking`)

| Typ | Auslöser | Empfänger |
|---|---|---|
| `booking.conflict` | `force` oder Verschiebung | Ersteller der anderen Belegung, gebuchte Person, Freigabegruppe |
| `booking.request` | Pool-Buchung mit Freigabegruppe | Mitglieder der Gruppe |
| `booking.assigned` | interne Person gebucht | diese Person |
| `booking.confirmed` / `.declined` | Bestätigung / Ablehnung | Ersteller; ist ein Agent der Ersteller, nur Log |
| `booking.unconfirmed` | täglich (dueLocal): vorläufige Belegung beginnt in höchstens 3 Tagen | Ersteller, sonst PL |

Der Link führt in den Modus „Belegung“ am richtigen Tag (`?ansicht=belegung&datum=&ressource=`).

### 10.7 Oberfläche und ICS

- **`Calendar.tsx`:** `CalItem.kind` bekommt `'booking'`. Dazu eine Filterleiste und der neue Modus „Belegung“ (`Occupancy.tsx`: Zeilen je Ressource oder Person, Spalten je Tag; vorläufig gestrichelt, Konflikt rot, maskiert grau).
- **`BookingForm.tsx`**, die Ampel „frei / vorläufig / belegt“ in MeetingsView (`GET /availability`), der Abschnitt „Ressourcen“ im TaskDrawer und `ResourcesCard.tsx`.
- **ContactsCard** bekommt „als buchbare Person führen“, **AdminPage** den Pool, **UserSettings** die Abwesenheiten.
- **ICS:** `alle.ics` mit eigenen Belegungen und Abwesenheiten, der Projekt-Feed mit den Belegungen des Projekts, neu `/ics/:token/ressource/:rid.ics` (maskiert). In `meetingIcs` erscheinen Räume als `ATTENDEE;CUTYPE=ROOM` und als `LOCATION`.
- **Nicht enthalten:** Belegt-Zeiten aus Outlook, Google oder CalDAV, Rückmeldungen auf Einladungen, Kosten.

---

## 11. KI-Sheet

`sheet.test.ts` begrenzt `AGENT_SHEET` heute auf 4600 Zeichen; gemessen sind 4225. Die Grenze wird bewusst auf **5000** angehoben. Details stehen in den festen Regelblöcken `TASK_RULES`, `CHAT_RULES`, `MAIL_RULES` und dem neuen `PROJECT_RULES`; `docs/KI-Sheet.md` bleibt gleich, der Test prüft auch `PROJECT_RULES`.

Neufassungen in `AGENT_SHEET`:

- **Kommunikation** (ersetzt den Absatz): „Interne (Projektmitglieder) fragst du nur mit ask, nie per Mail; das System stellt die Frage im Chat, benachrichtigt, fasst nach und gibt bei Schweigen an die nächste Stufe weiter; die Antwort steht danach im Log. Fehlt Wissen statt einer Entscheidung, frag den Projektkanal. Reine Information ohne Antwort per chat. Externe per Mail und nur zur jeweiligen Aufgabe. Frag nur, was weder in Log, Mails, Chat noch Doku steht; ein Thema je Frage.“
- **Warten:** „ask wartet selbst; für Termine, Erledigung durch andere oder Informationen setze wait mit Frist.“
- **Selbstständigkeit** (neu): „Wie selbstständig du handelst, steht unter ‚Arbeitsweise‘. Gib Aktionen, die Bestätigung brauchen, normal an; das System hält sie an und fragt. Behaupte nie, etwas sei angelegt, vermerkt, gesendet oder freigegeben, was das System nicht bestätigt hat.“
- **Wissen** (neu): „Du siehst nur, was du sehen darfst; brauchst du mehr, frag die PL. Prüfe vor Anlage oder Entscheidung Überblick, Seiten und ähnliche APs; Überschneidungen hältst du mit relate fest.“
- **Externe** (neu): „Nicht-Interne erfahren nur, was zu ihrer Aufgabe gehört: keine anderen APs, Personen, Preise, Doku oder Interna. Fragen außerhalb davon gibst du mit refer weiter.“
- **Effizienz:** „… im Rahmen deiner Selbstständigkeit …“

Weitere Änderungen:

- **`TASK_RULES`:** `ask`, `resolve`, `refer`, `research`, `search`, `read_task`, `relate`, `withdraw`, `book_resource`. `escalate` heißt künftig „Entscheidung an die nächste Stufe“.
- **`CHAT_RULES`:** Die Befehlsliste aus 7.3 ersetzt den Satz „Neue Arbeit … verweist auf die PL“ (sheet.ts:46). Dazu kommen `answers`.
- **`MAIL_RULES`:** „recherchieren (nur, wenn freigegeben)“.
- **`PROJECT_RULES`** (neu): Kandidaten prüfen, Doppelarbeit, Abhängigkeiten und Widersprüche finden; Ausgabe `digest`, `findings` und Aktionen aus der Grundmenge.

Beispiel für den variablen Teil: „Arbeitsweise: Rückfrage bei wichtigen Schritten (Projekt BAU). Mit Bestätigung: Final setzen, PDF an Verteiler, Mails nach außen, Erledigt, Umstrukturieren. Gesperrt (Org): Online-Recherche. Reichweite: dieses AP. Überschneidungen: nachfragen.“

---

## 12. Datenmodell (SQL)

### 043_ai_policy.sql

```sql
-- KI-Freigaben des Org-Admins und Org-Rechte; Notaus liegt in orgs.settings.ai.enabled
alter table users add column org_rights text[] not null default '{}'
  check (org_rights <@ array['ai_admin','groups_admin','resources_admin']::text[]);
create table ai_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,      -- null = alle Projekte
  user_id uuid references users(id) on delete cascade,            -- Person oder Agent; null = alle
  group_id uuid references groups(id) on delete cascade,
  feature text not null check (feature ~ '^(\*|assist|mail|agent|pl)(\.[a-z_]+)?$'),
  effect text not null check (effect in ('allow','deny')),
  note text,
  set_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (user_id is null or group_id is null)
);
create unique index ai_policies_uq on ai_policies (org_id, project_id, user_id, group_id, feature) nulls not distinct;
create index ai_policies_org_idx on ai_policies (org_id);
-- Bestand: Schalter „Eigene Agenten der PL“ als Org-Regel
insert into ai_policies (org_id, feature, effect, note)
  select id, 'pl.agents',
         case when coalesce((settings->'ai'->'plAgents'->>'enabled')::boolean, false) then 'allow' else 'deny' end,
         'übernommen aus „Eigene Agenten der PL“' from orgs;
-- Bestandsschutz: wer Mail-KI eingeschaltet hat, behält „KI nutzen“
update project_members pm set can_use_ai = true from mail_views v
  where v.ai_process and v.ai_process_by = pm.user_id and v.project_id = pm.project_id;
```

`nulls not distinct` verlangt PostgreSQL 15 oder neuer; im Einsatz ist 16 (docker-compose.yml), die Tests laufen mit PGlite 0.5.

### 044_outbound_guard.sql

```sql
-- Informationsgrenze: Sichtbarkeit von Log-Einträgen, Außenbeschreibung, externes Profil, Prüfprotokoll
alter table task_comments add column visibility text not null default 'internal' check (visibility in ('internal','external'));
alter table tasks add column external_brief text;
alter table projects add column external_profile jsonb not null default '{}'::jsonb;  -- {name, address, access, contacts:[{name,email,role}]}
create table outbound_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  run_id uuid references agent_runs(id) on delete set null,
  channel text not null check (channel in ('mail','reply_origin','pdf','draft','chat')),
  recipients jsonb not null,
  audience text not null check (audience in ('internal','outside','task_external','unknown_external')),
  result text not null check (result in ('pass','held','blocked')),
  findings jsonb not null default '[]'::jsonb,
  withheld jsonb not null default '[]'::jsonb,
  mail_draft_id uuid references mail_drafts(id) on delete set null,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index outbound_checks_held_idx on outbound_checks(project_id) where result = 'held';
create index outbound_checks_draft_idx on outbound_checks(mail_draft_id) where mail_draft_id is not null;
```

### 045_groups_rights.sql

```sql
-- Gruppen als Projektmitglied, Herkunft der Mitgliedschaft, Gruppenverwalter
alter table group_members add column is_manager boolean not null default false;
create table project_groups (
  project_id uuid not null references projects(id) on delete cascade,
  group_id uuid not null references groups(id) on delete cascade,
  role text not null check (role in ('member','reader')),
  can_edit_plan boolean not null default false,
  can_approve boolean not null default false,
  can_finalize boolean not null default false,
  can_use_ai boolean not null default false,
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, group_id)
);
create index project_groups_group_idx on project_groups(group_id);
alter table project_members add column origin text not null default 'direct' check (origin in ('direct','group'));
```

### 046_notification_rules.sql

```sql
-- Benachrichtigungsregeln mit Vererbung Org › Projekt › AP › Benutzer; Bezug und Erledigt-Status von Meldungen; Systemnachrichten im Chat
create table notification_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  event text not null,                          -- Ereignisklasse oder '*'
  recipients jsonb,                             -- null = erben; geordnete Rollenliste (nur Org/Projekt/AP)
  channels jsonb not null default '{}'::jsonb,  -- nur gesetzte Schlüssel zählen: chat, mail, log, doc
  timing jsonb not null default '{}'::jsonb,    -- remindH, escalateH, expireH, every
  locked text[] not null default '{}',          -- nur Org/Projekt
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (task_id is null or project_id is not null)
);
create unique index notification_rules_uq on notification_rules (org_id, project_id, task_id, user_id, event) nulls not distinct;
alter table notifications add column event text;
alter table notifications add column ref_type text check (ref_type in ('question','chat_channel','chat_thread','task','page','booking'));
alter table notifications add column ref_id uuid;
alter table notifications add column resolved_at timestamptz;
alter table notifications add column mail text not null default 'digest' check (mail in ('off','now','digest'));
create index notifications_ref_idx on notifications (ref_type, ref_id) where ref_id is not null;
create index notifications_open_idx on notifications (user_id, resolved_at) where resolved_at is null;
alter table chat_messages add column kind text not null default 'user' check (kind in ('user','system'));
alter table chat_messages add column meta jsonb;  -- Systemkarte: Ergebnisse, Links, Knöpfe
-- Backfill: bisheriger Mail-Modus als Benutzerregel und in offenen Meldungen
insert into notification_rules (org_id, user_id, event, channels)
  select org_id, id, '*', jsonb_build_object('mail', case settings->>'mailNotifications' when 'immediate' then 'now' when 'off' then 'off' else 'digest' end)
  from users where kind = 'person' and settings ? 'mailNotifications';
update notifications n set mail = case u.settings->>'mailNotifications' when 'immediate' then 'now' when 'off' then 'off' else 'digest' end
  from users u where u.id = n.user_id;
update notifications set event = case
  when type in ('task.assigned','plan.shifted') then 'assigned'
  when type = 'escalation' then 'escalation'
  when type in ('mail.approval','draft.review','page.review','report.review','ai.proposal','workflow.approval') then 'review'
  when type in ('mention','task.comment') then 'log'
  when type in ('task.due_soon','task.overdue') then 'due'
  when type in ('chat.dm','chat.mention','chat.reply') then 'chat'
  else 'info' end;
```

### 047_questions.sql

```sql
-- Offene Fragen: ein Objekt für Chat-Stelle, Meldungen, Log, Warten und Antwort
create table questions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  meeting_id uuid references meetings(id) on delete set null,
  kind text not null default 'question'
    check (kind in ('question','decision','confirm','approval','synergy','order_request','external_referral')),
  asked_by uuid not null references users(id),                    -- Agent oder Person
  addressee_id uuid references users(id) on delete set null,      -- null = Projektkanal
  addressee_role text,                                            -- Rolle aus der Kette
  level smallint not null default 0,
  parent_id uuid references questions(id) on delete set null,     -- Vorgänger bei Weitergabe
  body text not null,
  channel_id uuid references chat_channels(id) on delete set null,
  message_id uuid references chat_messages(id) on delete set null, -- Frage = Thread-Wurzel
  status text not null default 'open' check (status in ('open','answered','escalated','cancelled')),
  remind_at timestamptz,
  escalate_at timestamptz,
  reminded_at timestamptz,
  answered_by uuid references users(id) on delete set null,
  answered_at timestamptz,
  answer_source text check (answer_source in ('chat','task','meeting','mail','system')),
  answer_text text,
  answer_message_id uuid references chat_messages(id) on delete set null,
  answer_comment_id uuid references task_comments(id) on delete set null,
  cancel_reason text,
  created_at timestamptz not null default now()
);
create index questions_task_open_idx on questions (task_id) where status = 'open';
create index questions_msg_idx on questions (message_id);
create index questions_addressee_idx on questions (addressee_id, status);
create index questions_due_idx on questions (least(remind_at, escalate_at)) where status = 'open';
```

### 048_agent_policy.sql

```sql
-- Agenten-Policy: Selbstständigkeit, Bestätigungen angehaltener Aktionen, Agentenzugriff auf Doku-Ordner
alter table projects add column agent_policy jsonb not null default '{}'::jsonb;
alter table project_members add column agent_policy jsonb;   -- nur Agenten; null = erben
alter table tasks add column agent_policy jsonb;             -- gilt für das AP und seine Aufgaben
alter table ai_proposals drop constraint ai_proposals_kind_check;
alter table ai_proposals add constraint ai_proposals_kind_check check (kind in ('task_update','page_append','agent_action'));
alter table ai_proposals drop constraint ai_proposals_status_check;
alter table ai_proposals add constraint ai_proposals_status_check
  check (status in ('pending','approved','rejected','stale','failed','expired','withdrawn'));
alter table ai_proposals add column agent_run_id uuid references agent_runs(id) on delete set null;
alter table ai_proposals add column question_id uuid references questions(id) on delete set null;
alter table ai_proposals add column action_class text;
alter table ai_proposals add column seq smallint not null default 0;
alter table ai_proposals add column depends_on uuid references ai_proposals(id) on delete set null;
alter table ai_proposals add column mail_draft_id uuid references mail_drafts(id) on delete set null;
alter table ai_proposals add column fingerprint text;
alter table ai_proposals add column result text;
create index ai_proposals_question_idx on ai_proposals(question_id);
create index ai_proposals_task_pending_idx on ai_proposals(task_id) where status = 'pending';
create index ai_proposals_rejected_fp_idx on ai_proposals(project_id, fingerprint) where status = 'rejected';
alter table doc_folders add column agent_access text not null default 'write' check (agent_access in ('write','read','none'));
-- Bestand nach Entscheidung 6: bestehende Projekte behalten das heutige Verhalten
update projects set agent_policy = '{"mode":"auto"}'::jsonb;
```

### 049_chat_control.sql

```sql
-- Aufträge per Chat: Auftraggeber und Ursprungsnachricht; Systemkarten mit Bezug zum Lauf
alter table tasks add column requested_by uuid references users(id) on delete set null;
alter table tasks add column origin_message_id uuid references chat_messages(id) on delete set null;
alter table chat_messages add column agent_run_id uuid references agent_runs(id) on delete set null;
create index tasks_requested_by_idx on tasks(requested_by) where requested_by is not null;
```

### 050_web_research.sql

```sql
-- Online-Recherche: Profilfreigabe, Zähler, Quellen
alter table ai_profiles add column web_search boolean not null default false;
alter table agent_runs add column web_searches int not null default 0;
create table agent_web_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  run_id uuid references agent_runs(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  page_id uuid references doc_pages(id) on delete set null,
  query text,
  url text not null,
  title text,
  cited_text text,
  retrieved_at timestamptz not null default now()
);
create index agent_web_sources_task_idx on agent_web_sources(task_id);
```

### 051_agent_knowledge.sql

```sql
-- Reichweite, Kontextstatistik, Beziehungen zwischen APs, Projektüberblick je Sichtbarkeit
alter table agent_runs add column scope text not null default 'task' check (scope in ('task','project','chat','mail'));
alter table agent_runs add column context_stats jsonb;
alter table ai_profiles add column context_tokens int check (context_tokens is null or context_tokens >= 4000);
create table task_relations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  task_a uuid not null references tasks(id) on delete cascade,
  task_b uuid not null references tasks(id) on delete cascade,
  kind text not null check (kind in ('related','sync','duplicate','dependency')),
  status text not null default 'suggested' check (status in ('suggested','asked','accepted','rejected')),
  signals jsonb not null default '[]'::jsonb,
  note text,
  lead_task_id uuid references tasks(id) on delete set null,
  question_id uuid references questions(id) on delete set null,
  found_by uuid references users(id) on delete set null,
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (task_a < task_b)
);
create unique index task_relations_uq on task_relations(task_a, task_b, kind);
create index task_relations_project_idx on task_relations(project_id, status);
create table project_digests (
  project_id uuid not null references projects(id) on delete cascade,
  visibility_key text not null,
  structure text not null,
  brief text,
  source_hash text not null,
  brief_run_id uuid references agent_runs(id) on delete set null,
  built_at timestamptz not null default now(),
  primary key (project_id, visibility_key)
);
```

### 052_resources.sql

```sql
-- Buchbare Ressourcen (Pool des Mandanten oder je Projekt) und Belegungen; Bestätigungsfrage je Buchung
create table resources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,      -- null = Pool
  kind text not null check (kind in ('room','equipment','scaffold','vehicle','person','other')),
  name text not null,
  description text,
  location text,
  email text,                                                     -- Raumpostfach bzw. externe Person (ICS, Kontakt)
  phone text,
  organization text,
  trade text,                                                     -- Gewerk bei kind = person
  approval_group_id uuid references groups(id) on delete set null,
  active boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index resources_org_idx on resources(org_id, project_id);
create unique index resources_name_uniq on resources(org_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create table resource_bookings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,      -- null = Sperrzeit/Abwesenheit
  resource_id uuid references resources(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,             -- interne Person statt Ressource
  meeting_id uuid references meetings(id) on delete cascade,
  task_id uuid references tasks(id) on delete cascade,
  follow_task boolean not null default false,
  title text,
  note text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  tentative boolean not null default false,
  confirmed_by uuid references users(id) on delete set null,
  confirmed_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((resource_id is null) <> (user_id is null)),
  check (ends_at > starts_at),
  check (project_id is not null or (meeting_id is null and task_id is null))
);
create index resource_bookings_res_idx on resource_bookings(resource_id, starts_at) where resource_id is not null;
create index resource_bookings_user_idx on resource_bookings(user_id, starts_at) where user_id is not null;
create index resource_bookings_project_idx on resource_bookings(project_id, starts_at);
create index resource_bookings_task_idx on resource_bookings(task_id) where task_id is not null;
create unique index resource_bookings_meeting_uniq on resource_bookings(meeting_id, resource_id) where meeting_id is not null and resource_id is not null;
alter table questions add column booking_id uuid references resource_bookings(id) on delete set null;
create index questions_booking_idx on questions(booking_id) where booking_id is not null;
```

### 053_external_portal.sql (optional, Entscheidung 2)

```sql
-- Externe Konten: Rolle, Einladung zu einer Aufgabe, Gruppenart, Aufgabenzugriff (nie Projektmitglied)
alter table users drop constraint users_global_role_check;
alter table users add constraint users_global_role_check check (global_role in ('org_admin','project_creator','user','external'));
alter table invitations drop constraint invitations_global_role_check;
alter table invitations add constraint invitations_global_role_check check (global_role in ('org_admin','project_creator','user','external'));
alter table invitations add column task_id uuid references tasks(id) on delete cascade;
alter table groups add column kind text not null default 'internal' check (kind in ('internal','external'));
create table task_access (
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  mode text not null default 'read' check (mode in ('read','write')),
  include_children boolean not null default true,
  granted_by uuid references users(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
create index task_access_user_idx on task_access(user_id);
```

**Einstellungen ohne eigene Spalte** (JSON in `orgs.settings` bzw. `projects.agent_policy`):

- `ai.enabled`, `ai.assistDailyBudget`, `ai.agentPolicy {mode, confirm[], scope, synergies, reviewAt, maxMode, lockedConfirm[]}`
- `ai.web {provider, url, maxPerRun, dailyPerAgent, allowedDomains|blockedDomains}`
- `ai.externalGuard ('strict'|'check')`
- `notify.digestHour`
- `worker.lastRuns`
- im Projekt: `agent_policy.chat.orders ('pl'|'tp'|'responsible'|'members')`

**Typen in shared:** `AiFeature`, `AiDecision`, `AiPolicy`, `ProjectGroup`, `NotifyEvent`, `NotificationRule`, `Question`, `AgentMode`, `AgentActionClass`, `AgentPolicy`, `EffectiveAgentPolicy` (mit Herkunft), `ChatCommand`, `ChatCommandResult`, `AudienceClass`, `OutboundCheck`, `ExternalProfile`, `WebSource`, `TaskRelation`, `Resource`, `ResourceBooking`. Bestehende Typen werden erweitert: `Membership.origin`, `Notification.event/ref/resolvedAt`, `AiProposal.kind` um `agent_action`, `Meeting.resources`.

---

## 13. Routen

| Route | Wer | Phase |
|---|---|---|
| `GET/PUT /ai/policies`, `GET /ai/policies/effective?userId&projectId`, `GET /ai/policy-targets?q` | Org-Admin, `ai_admin` | P1 |
| `PUT /ai/settings` (+ `enabled`, `assistDailyBudget`, `agentPolicy`, `web`, `externalGuard`) | Org-Admin, `ai_admin` | P1/P6/P8 |
| `GET /projects/:id/ai/capabilities` | Mitglied | P1 |
| `PUT /projects/:id/external-profile`; `PATCH /tasks/:id` (+ `externalBrief`) | PL bzw. `can_edit_plan` | P2 |
| `GET /projects/:id/outbound-checks?result=held`, `POST /outbound-checks/:id/decide {release, edit, block}` | PL bzw. Senderecht | P2 |
| `PATCH /users/:id`; `PATCH /groups/:id` (Mitglieder, Verwalter) | Org-Admin; Gruppenverwalter, `groups_admin` | P3 |
| `PUT/DELETE /projects/:id/groups/:groupId` | PL | P3 |
| `PUT /admin/projects/:id/lead` | Org-Admin | P3 |
| `GET/PUT /org/notification-rules`, `GET/PUT /projects/:id/notification-rules`, `GET …/effective`, `GET/PUT /tasks/:id/notification-rules`, `GET/PUT /me/notification-rules[?projectId&taskId]` | Org-Admin / PL / PL, Auftraggeber, Zuständige(r) / Benutzer | P4/P7 |
| `GET /notifications` (+ `event`, `ref`, `resolvedAt`, Filter) | Benutzer | P4 |
| `GET /questions?mine=1&status=open`, `GET /tasks/:id/questions`, `POST /questions/:id/answer`, `POST /questions/:id/cancel` | Benutzer laut 5.4 | P5 |
| `GET /chat/messages/:id` | Kanalzugriff | P5 |
| `GET/PUT /projects/:id/agent-policy`; `agentPolicy` in `PUT /projects/:id/members/:userId` und `PATCH /tasks/:id` | PL (Mitglieder lesen) | P6 |
| `GET /projects/:id/agents/:agentId/policy?taskId` | Mitglied | P6 |
| `GET /tasks/:id/proposals`, `POST /questions/:id/decide` | laut 6.5 | P6 |
| `POST /chat/messages/:id/actions {approve, reject, undo, items}` | laut 7.1 | P7 |
| `GET /tasks/:id/sources` | Mitglied | P8 |
| `POST /projects/:id/agents/:agentId/review`, `GET /projects/:id/digest` | PL | P9 |
| `GET /projects/:id/relations`, `GET /tasks/:id/relations`, `POST /relations/:id/decide` | Mitglied, wenn beide APs sichtbar | P9 |
| `GET/POST/PATCH/DELETE /resources`, `GET /bookings`, `GET /availability`, `POST /projects/:id/bookings`, `PATCH/DELETE /bookings/:id`, `POST /bookings/:id/confirm`, `POST /blocked` | laut 10.2 | P10 |
| `GET /extern/tasks`, `GET /extern/tasks/:id`, `POST /extern/tasks/:id/comments`, `POST /extern/items/:id/check`; `PUT/DELETE /tasks/:id/access/:userId` | Extern mit `task_access`; PL, Zuständige(r) | P11 |

## 14. Oberfläche (Übersicht)

- **AdminPage:**
  - Karte „KI-Freigaben“ (ersetzt den Schalter für PL-Agenten): roter Notaus; Matrix mit den Zeilen Mandant, Gruppen, Projekte, Benutzer, Agenten und Ausnahmen und den Spalten Kategorien bzw. Funktionen, jede Zelle mit drei Zuständen (erben, erlauben, sperren) und Notiz; Vorschau „Wirkung für Person X in Projekt Y“ mit Spur.
  - Karten „Agenten-Policy“, „Kommunikation“ (Matrix mit Schlössern, Digest-Stunde), „Online-Recherche“, „Außenprüfung“, „Ressourcen (Pool)“.
  - Benutzer: Rolle, Org-Rechte, reaktivieren. Gruppen: Verwalter.
- **MembersView:**
  - Spalte Herkunft, „Gruppe hinzufügen“, Rechte mit Begründung aus `capabilities`.
  - Abschnitte „Kommunikation“ (geerbte Werte grau mit Herkunft, gesperrte deaktiviert, Vorschau „Wer bekommt was?“), „KI-Agenten: Selbstständigkeit“ (Stufe, Klassen, Reichweite, Synergien, Aufträge im Chat, „Projektdurchlauf jetzt“), „Außenkommunikation“ (externes Profil, Prüfstufe), Ressourcen.
- **TaskDrawer:** „Offene Fragen“, „Wartet auf Bestätigung“, „Selbstständigkeit für dieses AP“, „Verwandte APs“, Auftraggeber mit Link zur Chat-Nachricht, Berichtsregel, Außenbeschreibung, Badge „für Externe sichtbar“, Quellen, Ressourcen, KI-Knöpfe mit Begründung.
- **ChatPane / Messenger:** Threads in DMs, Deep-Link `?msg=`, Thread-Kopf mit Fragestatus, Systemkarten (Ergebnisse, Bestätigen, Ablehnen, Rückgängig, Synergie-Optionen), Badge „Auftrag GZ-9“, Fähigkeiten des Agenten im Kopf.
- **Glocke und Dashboard:** „Offen für mich“, Filter, KPIs „Offene Fragen“ und „Bestätigungen“.
- **Mail › Freigaben:** Abschnitt „Außenprüfung angehalten“ mit Fundstellen, zurückgehaltenen Inhalten und „Bearbeiten und senden“.
- **Kalender:** Modus „Belegung“, Filter, BookingForm. **UserSettings:** Benachrichtigungsmatrix, „Projekt stummschalten“, Abwesenheiten. **DocsView:** Agentenzugriff je Ordner.

## 15. Audit

- **Neue Aktionen:**
  - KI: `ai.policy.set` / `.delete` / `.migrated`, `ai.killswitch`, `ai.outbound`.
  - Gruppen und Benutzer: `group.project.set` / `.remove`, `user.role`, `user.reactivate`.
  - Regeln und Fragen: `notify.rule.set`, `notify.mail_failed`, `question.ask` / `.answer` / `.escalate` / `.cancel`.
  - Agenten: `agent.policy`, `agent.action.proposed` / `.approved` / `.rejected` / `.expired`, `agent.order`, `agent.chat` (mit Ergebnisliste der Befehle), `agent.web`.
  - Ressourcen: `resource.*`, `booking.create` / `.update` / `.delete` / `.confirm` / `.force`.
- Sperren selbst erzeugen keinen Audit-Eintrag. Sie stehen als `skipped` in den Lauflisten bzw. kommen als 403 zurück.
- Persönliche Projekte bleiben im Audit des Org-Admins geschwärzt (users.ts:343-352).

## 16. Sofort-Fixes (Phase 0, im Code verifiziert)

1. **`doc_send_pdf`** an genannte Empfänger nur bei finaler Seite. Nicht-Interne nur, wenn sie im Verteiler stehen oder eine aktive `doc_shares`-Freigabe haben (agent.ts:349-358: heute geht jeder Entwurf an jede Adresse).
2. **Budget 0 gilt:** `Number(ai.agentDailyBudget ?? 50)` (client.ts:37).
3. **Leser mit „KI nutzen“** dürfen `/ai/ask` nutzen (ai.ts:28).
4. **Stellvertretung** kann sich nicht selbst zur verantwortlichen PL machen (projects.ts:216).
5. **`notify()`** überspringt Agenten und Inaktive (tasks.ts:236 und 538).
6. **Im Projektkanal** schreiben nur explizite Mitglieder (chat.ts:64 und 116).
7. **Agenten-Entwürfe ohne Ansicht:** PATCH und DELETE über `canManageAccount` (mail.ts:860 und 898). Ablehnen schreibt ins Log und startet einen Lauf.
8. **Eigene Anthropic-LLMs eines Projekts** nutzen nie `ANTHROPIC_API_KEY` (client.ts:27). Der Test eines Projekt-LLMs prüft `ownLlm` (ai.ts:129).
9. **Der manuelle Agentenlauf** beachtet `agent_paused` und das Budget (agents.ts:154-165). Das Budget zählt nur `ok` und `error`.
10. **`agentEvents`:** Dirty-Flag statt verworfener Ereignisse (agentEvents.ts:32 und 44).
11. **`triggerText`** bekommt Texte für `changed` und `periodic`. `reminder_due` empfiehlt den Chat statt Mail (agent.ts:641).
12. **ChatPane:** Das Intervall nutzt den aktuellen Thread über `useRef` (ChatPane.tsx:44).
13. **Dashboard:** Ein Klick auf eine Meldung markiert sie als gelesen.
