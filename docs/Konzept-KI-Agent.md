# Konzept KI-Agent: Verhalten, Rechte, Wissen, Steuerung

Stand 19.10.2026, aufbauend auf `docs/Konzept-Rechte-KI-Kommunikation.md` (Hauptkonzept; Abschnitte 3, 5, 6, 7, 8, 9) und dem Code bis P4 (Commit 4acc946). Dieses Konzept legt fest, **wie** ein Agent sich verhält und **was** sich daran je Agent steuern lässt. Es präzisiert die Abschnitte 6–8 des Hauptkonzepts und ändert sie an den ausdrücklich genannten Stellen (6.3 Felder von Regel A, 7.2 Kontext im Chat, 7.3 Befehl `policy`, 11 Sheet). Geprüft gegen den Code durch eine Kritikrunde; die Korrekturen sind eingearbeitet.

## 0. Leitsätze

1. **Ein Agent ist ein Kollege ohne Login.** Er handelt wie eine zuständige Person: innerhalb seiner Rechte, nie darüber hinaus, mit denselben Pflichten (Log, Rückmeldung, Termintreue).
2. **Nichts ist von selbst frei.** Eine KI der Org (Profil, Org-Agent) wirkt in einem Projekt nur, wenn der Org-Admin es nicht sperrt (KI-Freigaben) **und** die PL sie aufnimmt bzw. als Projekt-KI wählt. Für eine Person gilt sie nur mit „KI nutzen“ der PL. Im Chat gilt beides zugleich. Persönliche Projekte bekommen nur das eigene LLM und die eigenen Postfächer; Org-Profile nur, wenn der Org-Admin sie dafür freigibt.
3. **Im Thema bleiben.** Jeder Lauf und jede Chat-Antwort hat genau einen Bezug (AP, Projekt, Frage, Gespräch). Nennt jemand ein AP oder ein Projekt, zählt nur das. Projekte werden nie vermischt.
4. **Das System bestätigt, nie das Modell.** Was angelegt, gesendet oder eingetragen wurde, schreibt das System ins Log und als Systemkarte in den Chat; Kennzahlen berechnet das System. Behauptungen ohne ausgeführte Aktion ersetzt das System.
5. **Echte Hilfe.** Der Agent bringt Arbeit voran, meldet knapp, fragt nur, was er nicht wissen kann, und hält an, wenn er nicht weiterkommt (Blockade, Eskalation), statt zu raten.
6. **Wissen nur, soweit berechtigt.** Kontext entsteht aus den Rechten des Agenten; im Chat aus der Schnittmenge mit dem Gegenüber; nach außen nur der Außenkontext der Aufgabe.
7. **Ein Modell, ein Weg.** Rechte sind die Mitgliedschaftsflags, Freigaben sind `ai_policies`, Verhalten ist die Agenten-Policy (Regel A). Jede Oberfläche ist eine Sicht darauf, kein zweiter Speicher.

## 1. Rollen und Einsatzarten

| Einsatzart | Wie er dazu kommt | Was er tut | Was er nie tut |
|---|---|---|---|
| **Mitglied, zuständig** | PL weist AP, Aufgabe oder Teilprojekt zu (direkt oder geerbt) | treibt die Arbeit voran: Tasks, Log, Doku, Rückfragen, Termine vorschlagen, Mails nach außen im Rahmen von Recht und Policy | fremde APs ändern, zuweisen an Dritte (ohne Recht), finalisieren ohne Recht |
| **Stellvertretende PL** | PL nimmt ihn mit Rolle „stellv. PL“ auf | plant projektweit: APs, Aufgaben, Teilprojekte, Meilensteine, Termine, Zuweisungen (auch an Agenten) | Mitglieder, Rechte, Einstellungen, Konten; nie verantwortliche PL |
| **Projektagent** | PL setzt Reichweite `project` | täglicher Durchlauf (werktags, `reviewAt`): Doppelarbeit, Synergien, Widersprüche AP ↔ Doku, offene Fragen, Steckbrief des Projekts | fremde APs ändern ohne `auto` + „Projektplan ändern“ |
| **Postfach-Agent** | PL hängt ihn an eine Mail-Ansicht | schlägt je neuer Mail Aktionen vor (Triage); Menschen nehmen an | selbst anlegen oder senden |
| **Auftragnehmer im Chat** | PL (oder wer laut `chat.orders` darf) gibt ihm im Chat Arbeit | legt den Auftrag als AP/Aufgabe an (Auftraggeber = Absender), arbeitet dann wie „Mitglied, zuständig“ | Aufträge Unberechtigter ausführen (die werden Frage `order_request` an die PL) |
| **Eigener Agent der PL** | PL legt ihn im Projekt an (Freigabe „Eigene Agenten der PL“) | wie Mitglied/stellv. PL, nur in diesem Projekt, nur auf Projekt-LLMs | andere Projekte, Org-Profile ohne Projektfreigabe |

Nie: Org-Admin, verantwortliche PL, Gruppenmitglied, Freigeber fremder Vorschläge, Bestätiger vorläufiger Termine, Löscher.

## 2. Aufgabenkatalog: was er übernimmt und wie weit

| Bereich | Übernimmt | Ergebnis | Grenze |
|---|---|---|---|
| **Recherche intern** | Doku, Log, Mails, APs des Themas durchsuchen (`search`, `read_task`, nur Berechtigtes) | Antwort mit Quelle (Seite, AP, Mail) | nichts aus Teilprojekten ohne Sicht, Ordnern ohne `agent_access`, persönlichen Konten ohne Freigabe |
| **Recherche extern** | Websuche, Seiten lesen (`research`; nur mit Freigabe `agent.web`, Profil mit Websuche, Policy nicht `off`) | Seite mit Abschnitt „Quellen (abgerufen am …)“; Aussagen ohne Beleg gekennzeichnet | nur lesen: keine Formulare, keine Anfragen, keine Namen/Interna in Suchbegriffen |
| **Entscheidungsvorlage** | Optionen sammeln, bewerten, Empfehlung | Seite im Ordner „Entscheidungen“, Status „In Prüfung“, Frage `decision` an den Auftraggeber mit Optionen als Knöpfe | entscheidet nie selbst; Final setzt die entscheidende Person (Freigabe) |
| **Koordination** | Termine vorschlagen, Belegt-Zeiten prüfen, Rückfragen bündeln, nachfassen, eskalieren | vorläufige Termine, Fragen mit Frist, Eskalation nach Regel N | sagt Termine nie zu; eine Person bestätigt |
| **Dokumentation** | Log, Seiten anlegen/ändern/anhängen, Protokolle aus Vorlage, Status Entwurf ↔ In Prüfung | Seite, Log-Eintrag | Final nur mit `can_finalize` und je nach Policy nach Bestätigung; löscht nie |
| **Planung** | Aufgaben unter dem eigenen AP; mit Rolle/Recht APs, Teilprojekte, Meilensteine, Termine, Zuweisung | Anlagen stehen im Log | Rolle/Recht (Abschnitt 7) und Policy-Klassen `plan`, `assign`, `schedule`, `foreign` |
| **Korrespondenz** | intern per Chat (`ask`, `chat`); extern per Mail (`mail`, `reply_origin`) | Chat-Nachricht, Mail oder Entwurf; Versandstatus schreibt das System | Außengrenze (Hauptkonzept 9); erster Kontakt zu einer Adresse ohne Bezug zum AP (`unknown_external`) immer Entwurf; Interne nie per Mail |
| **Überwachung** | Fälligkeit, Stillstand, Blockaden, Zwischenstände | Meldungen nach Regel N; Zwischenstände schreibt das System aus den ausgeführten Aktionen | keine eigenen Berichte außerhalb der Regeln |
| **Mail-Ablage** | Mails dem AP zuordnen, Essenz ins Log, Antwortentwurf | Log, Entwurf | Inhalte persönlicher Konten nur mit Freigabe |

Nicht seine Sache, auch nicht mit `auto`: Zusagen mit Geld- oder Vertragswirkung, Personalfragen, Rechte und Mitglieder, Löschen, Termine bestätigen, Bestellungen auslösen, Externe anfragen ohne Senderecht.

## 3. Denktiefe

Die Denktiefe `depth` ist ein Feld der Agenten-Policy (Abschnitt 7): Standard je Agent, je Projekt, je AP/Auftrag (PL, auch per Chat-Befehl `policy`), begrenzt durch `maxDepth` von Org und Projekt. Sie bestimmt Kontext, Leserunden und Aufwand; sie erweitert nie Rechte.

| Stufe | Leserunden | Kontext | Recherche (wenn frei) | Synergie-Kandidaten | Aufwand |
|---|---|---|---|---|---|
| `quick` „schnell“ | 1 Runde, nur Seiten, die geändert werden (Sheet: „vor jeder Änderung die Seite lesen“); keine Suche | AP, Log (letzte 20), Mails (letzte 5), Seitentitel | aus | 0 | Anthropic `effort: low`; lokal Denkmodus aus |
| `standard` (Standard) | 2 Runden, je bis zu 3 Zugriffe | wie Hauptkonzept 6.8 (Überblick, Suche: 10 Titel + 3 Ausschnitte, 5 ähnliche APs) | bis `maxPerRun` | 3 je AP-Lauf | wie Profil (`effort: low`, Denkmodus laut Profil/Agent) |
| `deep` „gründlich“ | 4 Runden, je bis zu 3 Zugriffe | zusätzlich bis zu 3 vollständige Seiten der Suche, Log vollständig, Mails 10 | bis 2 × `maxPerRun`, zusätzlich Seiten abrufen | 6 | Anthropic `effort: high`; lokal Denkmodus an; `maxTokens` erhöht |

Regeln:
- `deep` gibt es nur, wenn `maxDepth` es zulässt. Ein `deep`-Lauf hat `agent_runs.cost = 2`, sonst 1; `agentBudgetLeft` summiert `cost` statt Zeilen zu zählen (Migration zusammen mit der Policy).
- Reicht die Tiefe nicht (Kontext gekürzt, Suche ohne Treffer), sagt der Agent das im Log und in der Antwort („Ich habe nur die Seitentitel gesehen; soll ich gründlich prüfen?“) statt zu raten.
- `agent_runs.context_stats` zeigt, was gekürzt wurde; die PL sieht es unter Projekt › KI.

## 4. Zeiten

| Was | Regel | Einstellbar |
|---|---|---|
| **Ereignis** | sofort bei Zuweisung, Kommentar, Mail, Rückmeldung, Bestätigung, Auftrag; während eines Laufs genau ein Folgelauf | – |
| **Wiedervorlage** | nach `wait` zur Frist; Nachfassen und Weitergabe nach Regel N (Standard 48 h / 120 h; Entscheidung 24 h / 48 h) | Regel N (Org, Projekt, AP) |
| **Durchsicht** | spätestens alle 3 Tage je AP (`periodic`, agent.ts:858); Projektdurchlauf werktags zur Uhrzeit (Standard 06:45, Europe/Berlin) | `reviewAt` je Org/Projekt |
| **Arbeitszeit** | Mails nach außen (`mail`, `reply_origin`, `doc_send_pdf` an Nicht-Interne) werden außerhalb des Fensters (Standard Mo–Fr 07:00–19:00) als **geplanter Versand** gehalten (sichtbar unter Mail › Ausgang, abbrechbar) und am nächsten Werktag gesendet. Interne Fragen und Chat-Nachrichten gehen sofort in den Chat; wann jemand davon erfährt, regelt Regel N (Kanäle, Digest). Log, Doku, Entwürfe jederzeit | `hours.window` Org, Projekt überschreibt; `hours: always` je Agent/Projekt |
| **Fälligkeit** | eigene Arbeit: 2 Tage vor Termin Stand prüfen (`due_soon`, agent.ts:857; über Regel N „Fälligkeit“ einstellbar); am Termin ohne Ergebnis Blockade oder Eskalation | Regel N |
| **Budget** | Läufe je Tag (`users.agent_daily_budget`, `cost` summiert), Recherchen je Tag (`maxWebPerDay`) | Org-Admin bzw. PL im Deckel |

## 5. Ansprache und Ton

- **Menschlich, kollegial, direkt.** Keine Floskeln, keine Entschuldigungsschleifen, kein Beamtendeutsch. Die Persona bestimmt Du/Sie und Tonfall; ohne Persona: im Team Du, nach außen Sie (Standard in `styleText`, agent.ts:117).
- **Externe**: Sie, Anrede, Unterschrift; nichts über das Projekt hinaus (Außengrenze).
- **Status auf Nachfrage** („Status?“, „Wie steht es?“) hat ein festes Format:
  1. Eine Zeile Kennzahlen, **vom System berechnet** und im Prompt als „Kennzahlen zu <Thema>: offen 3 · in Arbeit 2 · fällig diese Woche 1 · überfällig 0 · blockiert 0 · wartet auf Bestätigung 1“; das Modell übernimmt sie wörtlich und zählt nie selbst (SQL je Thema: offen = nicht erledigt; in Arbeit = aktive Spalte; fällig diese Woche = Termin ≤ Sonntag; überfällig; blockiert; wartet = offene Bestätigung/Frage).
  2. **Nächste Schritte** (höchstens 3, je ein Satz, mit Kennung).
  3. **Termine** (die nächsten, mit Datum).
  4. **Blocker** oder „keine“.
  Keine Log-Wiedergabe, keine Aufzählung aller APs, nichts wiederholen, was der Fragende sieht.
- **Bezug nennen**: Stammt das Thema aus dem Verlauf, beginnt die Antwort mit „Zu WEB-12:“.
- **Rückfragen**: eine Frage je Nachricht, mit gewünschtem Termin und Optionen, wenn es welche gibt.
- **Nie**: „Ich habe … vermerkt/gesendet/angelegt“, wenn keine Aktion ausgeführt wurde (`claimCheck` ersetzt den Satz; die Systemkarte nennt das Ausgeführte).
- **Log**: sachlich, kurz, was/wer/bis wann/Beleg. Die Persona gilt für Chat, Mail und Seiten, nicht für das Log.

Ton und Status-Format stehen vollständig in `CHAT_RULES` (fester Block ohne Längengrenze); das `AGENT_SHEET` (4519/4600 Zeichen) ändert sich dafür nicht. Du/Sie ohne Persona steht im variablen Teil (`styleText`). Zusatz für `CHAT_RULES` (Wortlaut):

> Ton: wie eine Kollegin, direkt, ohne Floskeln; im Team Du, wenn die Persona nichts anderes sagt. Status auf Nachfrage („Status?“, „Wie steht es?“): erste Zeile die Kennzahlen-Zeile aus dem Kontext, unverändert; dann „Nächste Schritte:“ (höchstens 3, je ein Satz mit Kennung), „Termine:“ (die nächsten, mit Datum), „Blocker:“ (oder „keine“). Keine Log-Wiedergabe, keine Liste aller Arbeitspakete, nichts wiederholen, was der Fragende sieht. Antworte nur zum Thema der Nachricht (Abschnitt „Thema“ im Kontext); nenne den Bezug in der ersten Zeile, wenn er aus dem Verlauf stammt („Zu WEB-12:“). Andere Projekte erwähnst du nur, wenn ausdrücklich „über alle Projekte“ gefragt ist, dann je Zeile mit Projektkürzel.

## 6. Chat: Thema, Bezug, keine Vermischung

Das **Thema** je Nachricht bestimmt das System (`resolveChatScope`), nicht das Modell. Es läuft nach Regel F (Hauptkonzept 5.5) Schritt 1–2 und bekommt deren Treffer als Eingabe.

1. **Projektkanal**: das Projekt des Kanals (`how='channel'`). Thread: zusätzlich das AP der offenen Frage, deren Nachricht die Thread-Wurzel ist (Regel F); ohne Frage-Objekt die Kennung der Wurzel (Regex, 14-Tage-Rückfall).
2. **Direktnachricht**, in dieser Reihenfolge:
   - Nennt die Nachricht Kennungen oder einen Projektnamen/-kürzel: dieses Projekt mit diesen APs (`how='mentioned'`). Kennungen aus einem Projekt, das der Absender nicht sieht oder in dem einer von beiden gesperrt ist: „Dazu kann ich dir hier nichts sagen“, ohne Titel.
   - Sonst, wenn der Agent genau eine offene Frage an diese Person in diesem Kanal hat: deren AP (`how='question'`); bei mehreren bekommt er sie in den Kontext und ordnet mit `answers[]` zu (Regel F Schritt 2).
   - Gruß oder Kurzmeldung ohne Inhalt (`isSmallTalk`): kein Projektbezug, auch nicht aus dem Verlauf; mit persönlichem Projekt des Absenders (er PL, der Agent Mitglied) dieses (`how='personal'`), sonst allgemein ohne Projektinhalte (`how='general'`).
   - Sonst mit persönlichem Projekt immer dieses (`how='personal'`): Doku-Seiten (Suche nach der Nachricht) und Arbeitspakete nur von dort; andere Projekte nur bei Nennung.
   - Sonst das zuletzt genannte AP/Projekt des Verlaufs (`how='history'`), ohne Zeitfenster, bis ein neues genannt wird.
   - Ausdrücklich „über alle Projekte“: alle gemeinsamen, beidseitig freien Projekte (`how='all'`), jede Zeile mit Projektkürzel.
   - Ohne Anhaltspunkt bei mehreren gemeinsamen Projekten: Rückfrage mit Auswahl der Projektnamen, keine Inhalte (`how='ask'`); bei genau einem gemeinsamen Projekt: dieses.
   - **Externer Absender** (P11, falls gebaut): Thema sind nur seine Aufgaben aus `task_access` (`how='external'`); Kennungen, Projektnamen und „über alle Projekte“ werden nicht aufgelöst; der Prompt enthält ausschließlich `externalContext`; Befehle außer `note` (visibility external) und `refer` gibt es nicht.
3. **Kontext nur aus dem Thema.** Das ändert Hauptkonzept 7.2: Die AP-Liste im Chat-Prompt umfasst bei `channel`, `mentioned`, `history`, `question` nur dieses Projekt bzw. diese APs (höchstens 40); bei `all` alle gemeinsamen Projekte mit Kürzel; bei `ask` keine AP-Liste. Offene Fragen, Bestätigungen, Policy-Texte und die Kennzahlen-Zeile ebenfalls nur zum Thema. Die heutigen Filter bleiben: in DMs nur Projekte, in denen der Absender PL ist oder „KI nutzen“ hat, beidseitig per `aiAllowed(agent.chat)` frei und mit internem Absender (agentChat.ts:88–108); im Projektkanal nur das Kanalprojekt ohne eingeschränkte Teilprojekte.
4. **Befehle** (Hauptkonzept 7.3) gelten nur bei `how ∈ {channel, mentioned, question}`; bei `history`, `all` oder `ask` wird ein `order` zur Rückfrage mit Auswahl.
5. Schema des Chat-Laufs: `reply`, `commands[]` (P7), `answers[]` (P5), `notes[]` (bis P7, dann im Befehl `note`).

## 7. Die Agenten-Policy: ein Modell für Verhalten, Rechte als Flags, Freigaben als Regeln

Es gibt genau **ein** Modell für das Verhalten: **Regel A** (Hauptkonzept 6.3), hier um die Felder erweitert, die dieses Konzept braucht. Rechte bleiben die Mitgliedschaftsflags, Freigaben bleiben `ai_policies`. Die Matrix der Oberfläche ist eine abgeleitete Sicht (Recht ∧ Freigabe ∧ Policy) und schreibt nur die Policy.

### 7.1 Ebenen und wer setzt

| Ebene | Speicher | Wer setzt | Felder |
|---|---|---|---|
| Org | `orgs.settings.ai.agentPolicy` | Org-Admin, „KI verwalten“ | Werte und Grenzen (`maxMode`, `lockedConfirm`, `lockedOff`, `maxDepth`, `maxWebPerDay`), `hours.window`, `reviewAt` |
| Agent-Vorgabe (Org-Agent) | `users.agent_policy` (neu) | Org-Admin je Org-Agent, optional | Werte (ohne Grenzen) |
| Projekt | `projects.agent_policy` | PL | Werte, Grenzen für tiefere Ebenen, `chat.orders`, `reviewAt`, `hours.window` |
| Agent im Projekt | `project_members.agent_policy` (nur Agenten) | PL | Werte; für eigene Agenten der PL ist die Org-Vorgabe für eigene Agenten die Obergrenze |
| AP / Auftrag | `tasks.agent_policy` | PL (auch per Chat-Befehl `policy`); mit „Projektplan ändern“ nur enger, außer `depth` und `report` | `mode`, `confirm`, `off`, `depth`, `report` |

Alle Speicher haben dieselbe Form, `null` = erben. **Felder:** `mode` (auto | confirm_critical | confirm_all), `confirm[]` (Klassen mit Rückfrage), `off[]` (Klassen, die auf dieser Ebene abgeschaltet sind: `web`, `send_external`, `assign`, `plan`, `schedule`, `foreign`, `finalize`, `distribute`, `restructure`, `close`), `scope` (task | project), `synergies` (off | ask | use), `depth` (quick | standard | deep), `hours` (inherit | always; Org/Projekt zusätzlich `window {days, from, to}`), `reviewAt` (Org/Projekt), `chat.orders` (Projekt: pl | tp | responsible | members), `report` (AP: Berichtsregel). **Grenzen** (Org/Projekt): `maxMode`, `lockedConfirm[]`, `lockedOff[]`, `maxDepth`, `maxWebPerDay`.

`effectiveAgentPolicy(db, {agentId, projectId, taskId})` löst auf: je Feld die tiefste Angabe; `mode` begrenzt durch `maxMode`; `confirm` und `off` sind Vereinigungen mit `lockedConfirm`/`lockedOff`; `depth` begrenzt durch `maxDepth`; zu jedem Feld die Herkunft („Org erzwungen“, „Projekt WEB“, „AP WEB-12“). Es gibt kein zweites `effectiveAgentCaps`, keine `agent_caps`-Spalten.

### 7.2 Rechte, Freigaben, Policy: Zuordnung je Fähigkeit

| Fähigkeit (Sicht in der Oberfläche) | Recht (Mitgliedschaft) | Freigabe (`ai_policies`, Org-Admin) | Policy (Regel A) |
|---|---|---|---|
| Chat mit Mitgliedern, Rückfragen (`ask`, `chat`) | – (Grundmenge, nicht abschaltbar) | `agent.chat` für Absender und Agent | – |
| Mail nach außen (`mail`, `reply_origin`) | `agent_can_mail` (Senderecht am Projektkonto; aus = immer Entwurf) | `agent.send_external` | `confirm ∋ send_external` (Entwurf), `off ∋ send_external` (keine Mail) |
| Final setzen, PDF an Verteiler | `can_finalize` (beides zusammen, wie bei Personen) | `agent.finalize`, `agent.distribute` | `confirm`/`off ∋ finalize`, `distribute` |
| Seiten anlegen, ändern, anhängen; Ordner | Rolle member; `doc_folders.agent_access` (P6) | – | – (Grundmenge) |
| Aufgaben unter dem eigenen AP | – (Grundmenge) | – | `confirm ∋ assign` nur bei Zuweisung an Dritte |
| APs, Teilprojekte, Meilensteine, Abhängigkeiten | Rolle `pl` oder `can_edit_plan` | `agent.plan` | `confirm`/`off ∋ plan` |
| Zuweisen | Rolle `pl` (Agenten zuweisen nur PL, plan.ts:34) | `agent.assign` | `confirm`/`off ∋ assign` |
| Termine bestehender Arbeit ändern | eigene: Grundmenge; alle: `can_edit_plan` | `agent.schedule` | `confirm`/`off ∋ schedule` |
| Fremde APs ändern | `can_edit_plan` | `agent.foreign` | `confirm`/`off ∋ foreign` |
| Erledigt setzen, Umstrukturieren | – | `agent.close`, `agent.restructure` | `confirm`/`off ∋ close`, `restructure` |
| Vorläufige Termine, Buchungen | – (immer vorläufig, selbst die Rückfrage) | – | – |
| Online-Recherche | – | `agent.web` (standardmäßig gesperrt) + `ai_profiles.web_search` | `off ∋ web`, `maxWebPerDay` |
| Wissen (Doku, Mail-Ansichten, Teilprojekte) | wie Mitglied: Ansichtsrechte, `agent_access`, Teilprojekt-Sicht | – | – (Reichweite `scope` betrifft nur den Projektdurchlauf) |
| Selbstständigkeit, Überschneidungen, Reichweite, Tiefe, Arbeitszeit | – | – | `mode`, `confirm`, `synergies`, `scope`, `depth`, `hours` |
| Beauftragen im Chat | – | `agent.order` (Absender) | `chat.orders` (Projekt) |
| Budget | – | – | `users.agent_daily_budget` (Läufe, `cost` summiert), `maxWebPerDay` |

Festlegungen:
- Feinere Unterscheidungen (nur Entwurf, nicht zuweisen, keine Termine ändern) sind Policy (`confirm`, `off`), keine neuen Rechte.
- Bestand: Mitgliedschaften behalten ihre Flags; `mode` bleibt bei Entscheidung 6 des Hauptkonzepts (Bestand `auto`, neue Projekte `confirm_critical`, damit `send_external` dort Entwurf ist, auch wenn `agent_can_mail` an ist).
- `gateAction` (Hauptkonzept 6.4): `aiAllowed(agent.run)` → Klasse → `aiAllowed(agent.<klasse>)` deny → `off` deny → Recht → `confirm` hold → sonst run. Deny gewinnt immer.
- Die Oberfläche zeigt je Fähigkeit den abgeleiteten Zustand **frei / Rückfrage / Entwurf / aus / gesperrt (Org)** mit Herkunft und bietet als Eingabe die drei Flags, die `confirm`-Liste, die `off`-Liste und die übrigen Policy-Felder; gesperrte Fähigkeiten sind grau mit Grund und Link auf die KI-Freigaben.

### 7.3 Oberfläche

- **Verwaltung › KI-Agenten › Agent**: Karte „Verhalten“ (Agent-Vorgabe: `mode`, `confirm`, `off`, `depth`, `synergies`, `hours`) und Budget. **Verwaltung › KI**: Org-Policy mit Grenzen, Arbeitszeitfenster, Vorgaben für eigene Agenten der PL.
- **Projekteinstellungen › Mitglieder › Agent**: Karte „Agent im Projekt“: Matrix nach 7.2 (Zustand, Herkunft, Eingabe), Reichweite, Beauftragen durch (Projektfeld), Vorschau „Was darf Morton hier?“ (dieselbe Textliste wie im Prompt-Abschnitt „Deine Rechte“).
- **Arbeitspaket › KI**: Verschärfen für dieses AP (`mode`, `confirm`, `off`), `depth`, Berichtswunsch, Pause, Lauf von Hand, „Läuft nicht, weil …“.
- **Chat**: Befehl `policy {ref, mode?, release?[], off?[], depth?}` (PL; ändert Hauptkonzept 7.3) setzt `tasks.agent_policy` innerhalb der Grenzen; Beispiel: „Morton, WEB-12 gründlich und ohne Rückfrage“ → `policy {ref: WEB-12, mode: auto, depth: deep}`. `report` bleibt eigener Befehl.

## 8. Vererbung der Verfügbarkeit: Org-KI → Projekt → Person → Chat

| Frage | Antwort |
|---|---|
| Steht ein **KI-Profil der Org** als Projekt-KI oder für eigene Agenten der PL bereit? | nur mit Freigabe des Org-Admins: `project_scope` „alle“ oder „ausgewählte“; in **persönlichen Projekten** bei „alle“ nur mit `ai_profiles.personal_scope` („auch in persönlichen Projekten“) oder ausdrücklicher Auswahl des persönlichen Projekts (Ergänzung 19 des Hauptkonzepts) |
| Läuft ein **Org-Agent** im Projekt? | nur, wenn die PL ihn aufnimmt **und** `aiAllowed(agent, projekt, 'agent.run')` erlaubt (Regel K: eine Projektregel „agent“ sperrt auch Org-Agenten). Sein Profil ist seine Sache (Hauptkonzept 3.6: `project_scope` sperrt kein Projekt). **In persönlichen Projekten** zusätzlich: sein Profil muss dort verfügbar sein (`personal_scope` oder Auswahl), sonst „läuft nicht: Profil im persönlichen Projekt nicht freigegeben“ |
| Darf eine **Person** KI nutzen? | nur mit ausdrücklicher Mitgliedschaft und „KI nutzen“ (PL) **und** `aiAllowed(person, projekt, funktion)`; Leser nur Frage ans Projekt und Chat-Auskunft |
| Darf eine Person mit einem Agenten **chatten**? | beide Seiten frei: Person (`agent.chat`, „KI nutzen“ oder PL) und Agent (`agent.chat`, aktiv, Profil, Budget); Thema nur aus gemeinsamen, beidseitig freien Projekten (Abschnitt 6) |
| Darf ein Agent **nach außen** schreiben? | `agent_can_mail` **und** `aiAllowed(agent, projekt, 'agent.send_external')` **und** Policy nicht `off`/`confirm` **und** Außenprüfung bestanden; erster Kontakt zu `unknown_external` immer Entwurf |
| Darf ein Agent **online recherchieren**? | `aiAllowed(agent, projekt, 'agent.web')` **und** Profil mit Websuche **und** Policy nicht `off ∋ web` **und** Tagesbudget Recherchen |
| **Persönliches Projekt** | eigenes LLM (wenn der Mandant es erlaubt) und eigene Postfächer; Org-Profile und Org-Agenten nur mit `personal_scope`/Auswahl; eigene Agenten der PL nur mit Freigabe „Eigene Agenten der PL“ |

Der Weg im Code bleibt einer: `aiConfigFor()`/`aiAllowed()` für die Freigabe (mit `projectId` auch für Org-Agenten, Zusatzbedingung nur bei `p.personal`), `effectiveAgentPolicy()` für das Verhalten, `gateAction()` für die Aktion.

## 9. Recherche

- **Intern**: `search` über Seiten, APs, Log und lesbare Mails des Themas (Rechte wie Abschnitt 8), `read_task` nur lesend und nur im Thema; Quellen in Antwort und Log.
- **Extern** (Hauptkonzept 8): `research {question, maxUses}` nur mit Freigabe, Profil und Policy; Ergebnis als Leserunde mit URL und Ausschnitt; das System übernimmt Quellen in `agent_web_sources` und hängt sie der Seite an. „Nur online, keine Anfragen“ gilt immer: Recherche ist lesen; Kontaktaufnahme ist `send_external`.
- **Auftrag „recherchieren“ im Chat**: wird zum Auftrag mit `deliverables` („3 Betriebe im Edertal, nur online“) und Tiefe `deep`, soweit `maxDepth` es erlaubt (sonst `standard` mit Hinweis in der Systemkarte „gründlich nicht freigegeben“). Ohne Freigabe `agent.web` sagt der Agent sofort „Online-Recherche ist für mich nicht freigegeben (Verwaltung › KI-Freigaben)“; der Auftrag entsteht trotzdem, wenn der Absender es will, mit Blockade „Recherche nicht freigegeben“.

## 10. Wahrheit und Nachvollziehbarkeit

- Jede Aktion läuft durch `gateAction`; Ergebnis `run | hold | deny` steht im Lauf und im Log.
- Systemkarte unter jeder Chat-Antwort, wenn Befehle liefen („Angelegt …“, „Nicht ausgeführt: … – kein Zugriff“).
- `claimCheck` ersetzt Behauptungen in der ersten Person ohne ausgeführte Aktion.
- Projekt › KI zeigt je Lauf: Anlass, Thema, Kontextumfang (gekürzt?), Aktionen mit Gate-Ergebnis, Token, `cost`, Recherchen, Quellen.
- Audit: `agent.action.*`, `agent.policy`, `agent.web`.

## 11. KI-Dokumentation (ausbauen)

| Dokument | Für wen | Inhalt |
|---|---|---|
| `docs/KI-Handbuch.md` (umgesetzt; Hilfe › KI-Agenten, verlinkt aus Projekt › KI und Mitglieder › Projektagent) | PL, Mitglieder, Org-Admin | Was ein Agent tut und nicht tut (1, 2, 5), Einsatz (Aufnahme, Zuweisung, Auftrag im Chat, Beispiele mit Chat-Verläufen), Steuerung (Rechte, Freigaben, Policy: Selbstständigkeit, Reichweite, Tiefe, Zeiten, Budget, Pause, Befehle), Wissen und Vererbung (8), Recherche, Außengrenze, FAQ („Warum fragt er?“, „Warum hat er nicht gesendet?“, „Woher weiß ich, was er getan hat?“) |
| `docs/KI-Sheet.md` | Betreiber, Entwickler | Prompt-Quelle; neue Sätze in `CHAT_RULES` (Ton, Status, Thema), Sheet unverändert |
| `docs/Handbuch.md` §11–12 | alle | Verweis auf das KI-Handbuch, Kurzfassung |
| Hilfe in der App | alle | Seite „KI-Agenten“ (Kurzfassung), verlinkt aus Projekt › KI und Mitglieder › Agent |
| `docs/Konzept-KI-Agent.md` | Entwicklung | dieses Konzept |

## 12. Umsetzung und Zuordnung zu den Phasen

| Schritt | Inhalt | Phase |
|---|---|---|
| A | Chat: Thema (6; vorerst ohne Fragen als Quelle), Kennzahlen-Zeile, Ton und Status-Format in `CHAT_RULES`, Du/Sie-Standard, `claimCheck` light (ohne Befehle: Sätze „habe … angelegt/gesendet/vermerkt“ ohne Notiz ersetzen) | sofort (vor P5) |
| B | `personal_scope` an Profilen, Zusatzbedingung für Org-Agenten in persönlichen Projekten, Bestand per `ai_profile_projects`-Backfill (Hauptkonzept 19) | sofort |
| C | Offene Fragen (Hauptkonzept 5); Thema `question`, `answers[]` | P5 |
| D | Regel A mit den Feldern aus 7.1, `effectiveAgentPolicy`, `gateAction`, Bestätigungen, Matrix nach 7.2/7.3, `agent_runs.cost` | P6 |
| E | Chat-Befehle inkl. `policy` mit `depth`/`off`, Aufträge, Systemkarten, Hauptkonzept 7.2 angepasst | P7 |
| F | Online-Recherche, `maxWebPerDay`, Arbeitszeitfenster mit geplantem Versand | P8 |
| G | Wissen, Projektagent, Synergien, Denktiefe (3) | P9 (umgesetzt; Denktiefe als Policy-Feld `depth` mit `maxDepth`, `agent_runs.cost`, Chat-Befehl `policy` mit `depth`; ohne `effort`-Parameter für Anthropic) |
| H | KI-Handbuch, Hilfe in der App | ab P7, je Phase nachgezogen |

Migrationsnummern werden bei der Umsetzung nach `ls apps/api/migrations` vergeben; die Nummern im Hauptkonzept 12 sind seit 045 um eins verschoben.

## 13. Entscheidungen

1. **Arbeitszeitfenster** nur für Mails nach außen (geplanter Versand), Standard Mo–Fr 07:00–19:00, Org stellt ein, Projekt überschreibt, Agent „auch außerhalb“: **entschieden ja** (19.10.2026).
2. **Du/Sie ohne Persona**: im Team Du, nach außen Sie; die Persona kann es ändern.
3. **Denktiefe Standard** `standard`; `deep` nur bis `maxDepth`, `cost` 2.
4. **Org-Profile und Org-Agenten in persönlichen Projekten** nur mit `personal_scope` oder Auswahl; Bestand wird per Backfill freigegeben, damit nichts still ausfällt.
5. **Selbstständigkeit Bestand**: Entscheidung 6 des Hauptkonzepts bleibt.
