# Konzept: Einstellungen (Ist, Befund, Zielbild)

Stand 2026-10-20. Grundlage: vollständiges Inventar der Web-UI (`apps/web`), der API (`apps/api`) und der Typen (`packages/shared`). Zeilenangaben beziehen sich auf den Stand dieses Datums.

## 1. Kurzbefund

Die Einstellungen liegen auf vier Ebenen (Mandant, Projekt, Person, Arbeitspaket) an drei Seiten plus Drawer, mit drei verschiedenen Seitenmustern und ohne gemeinsame Themenordnung. Dieselben Themen (Mail, KI, Benachrichtigungen) stehen je Ebene an anderer Stelle, unter anderem Namen und in anderer Darstellung.

| Ebene | Route | Seitenmuster | Themenordnung |
| --- | --- | --- | --- |
| Mandant | `/verwaltung` | Anker-Sprungleiste, Cards untereinander, 9 Abschnitte | Benutzer, Gruppen, Projekte, Kommunikation, Ressourcen, KI, Vorlagen, Mandant, Audit |
| Projekt | `/projekte/:id/einstellungen` (+ Reiter Audit) | Anker-Sprungleiste, 2-Spalten-Grid mit 14 Cards | Allgemein, Mitglieder, Kontakte, Planung, Board, Projekt, KI, Eskalation, Kommunikation, Reporting, Mail-Ansichten, Außenkommunikation, Papierkorb |
| Person | `/einstellungen/benutzer` | 2-Spalten-Grid, 7 Cards, keine Navigation | Profil, 2FA, Benachrichtigungen, Abwesenheiten, Kalender-Abo, Kalender schreiben, Passwort |
| Mail-Konten aller Ebenen | `/einstellungen/konfiguration` | Eine Tabelle für persönliche, Projekt-, zentrale und Org-Postfächer | Menü „Konfiguration“, Seitentitel „Mail-Konten“, API-Text „Meine Mail-Konten“ |
| Arbeitspaket | TaskDrawer | Inline im Feld „KI-Agent“ und „Berichtswunsch“ | – |

## 2. Ist-Inventar je Thema und Ebene

Spalten: wo heute (Seite › Abschnitt), Speicherort, Vererbung (V = Vorgabe überschreibbar, G = Grenze, S = Sperre, – = keine), „wirksam“ = zeigt die UI den geerbten Wert mit Herkunft.

### 2.1 Mail

| Einstellung | Mandant | Projekt | Person | Vererbung | wirksam sichtbar |
| --- | --- | --- | --- | --- | --- |
| Org-Postfach, zentrale Postfächer, „für alle wählbar“, Verwalter | Konfiguration (gleiche Tabelle wie persönliche Konten) | – | – | – | – |
| Projektpostfach: Bindung, Standardkonto, neu anlegen, OAuth | – | Einstellungen › Mail-Ansichten › „Postfächer des Projekts“; Link in Card „Projekt“ führt nach Konfiguration | – | – | – |
| Persönliche Konten, OAuth Microsoft/Google | – | – | Konfiguration (nicht in Benutzereinstellungen) | – | – |
| Ansichten, Filter, Rechte je Ansicht | – | Einstellungen › Mail-Ansichten (Modals aus MailView) | – | – | – |
| Agent je Ansicht, Ordner „KI Bearbeiten“ | – | Einstellungen › Mail-Ansichten (Tabellenspalte) | – | – | – |
| Mail-Rückfrage (Modus, Frist) | Verwaltung › Mandant › „PDF-Stil und Module“ | Einstellungen › KI | – | V | teilweise („wie Mandant (…)“, Code-Standard nicht unterschieden) |
| Agent-Mail-Modus des Projektagenten | – | Einstellungen › KI | – | – | – |
| Außenprüfung (strict/check) | Verwaltung › KI › Grenzen | nur Text in „Außenkommunikation“ | – | S | ja (Text) |
| Arbeitszeitfenster Mails nach außen | Verwaltung › KI › Grenzen | – | – | S | nein |
| Externes Profil (Name, Adresse, Ansprechpartner) | – | Einstellungen › Außenkommunikation | – | – | – |
| Erinnerungen an Externe | – | Einstellungen › Eskalation (zweiter Abschnitt) | – | – | – |
| Unterschrift | nur Agenten (Verwaltung › KI › Agenten) | nur eigene Agenten | keine | – | – |
| `agentCanMail` je Agent | – | drei Stellen, drei Standards (RoleForm true, „Aufnehmen“ fest true, eigener Agent false) | – | – | – |

### 2.2 Benachrichtigungen

| Einstellung | Mandant | Projekt | Person | Arbeitspaket | Vererbung | wirksam sichtbar |
| --- | --- | --- | --- | --- | --- | --- |
| Regelmatrix je Klasse (Empfänger, Chat, Mail, Log, Fristen) | Verwaltung › Kommunikation | Einstellungen › Kommunikation (+ Doku-Seite, Vorschau) | Benutzereinstellungen › Benachrichtigungen (nur Chat/Mail, je Projekt umschaltbar, Stummschalten) | nur Klasse `progress` (Berichtswunsch) | V + S (Schloss Org/Projekt) | ja, einheitlich („erbt: X (Ebene)“, 🔒) |
| Tages-Digest-Stunde | Verwaltung › Kommunikation (Kartenkopf) | – | – | – | S | – |
| `expireH` | API ja | API ja | – | API ja | – | keine UI |
| `mailNotifications` (veraltet) | – | – | API schreibt noch, keine UI | – | – | – |
| Ebene `user_task` (Zwischenstände für mich) | – | – | – | Drawer, ohne geerbten Wert | V | nein |

Die Matrix ist das einzige Thema, das heute auf allen Ebenen gleich aussieht und die Herkunft zeigt. Sie ist das Muster für alles andere.

### 2.3 KI

| Einstellung | Mandant | Projekt | Person / Agent | Arbeitspaket | Vererbung | wirksam sichtbar |
| --- | --- | --- | --- | --- | --- | --- |
| LLM-Profile, Einsatz, Standard, Sperren | Verwaltung › KI › LLMs | Einstellungen › KI › „Eigenes LLM“ | – | – | G (Einsatz) | ja (Badges „verfügbar“) |
| LLM der Assistenz | `defaultProfileId` gilt nur für Agenten | Einstellungen › KI (Select) | – | – | – (kein Erben) | „aus“ statt geerbt |
| Agenten: Persona, Unterschrift, LLM, Denkmodus, Einsatz, Budget | Verwaltung › KI › Agenten (Budget nicht editierbar) | Einstellungen › KI › „Eigene KI-Agenten“ | Agent = Benutzerobjekt | – | G (maxBudget) | teilweise |
| Projektagent + Mail-Modus | – | Einstellungen › KI | – | – | – | – |
| Agent aufnehmen | – | zwei Wege: Mitglieder › RoleForm und KI › „Agenten im Projekt“ | – | – | – | – |
| Agenten-Policy | Verwaltung › KI › Grenzen | Einstellungen › KI (Text + Editor) | je Agent im Projekt: nur `mode` | Drawer: `mode`, `depth` | V + G (maxMode, lockedConfirm, maxDepth) | Projekt ja; Org-Editor ohne `effective`; Agent/AP nein |
| KI-Freigaben (Matrix) + Notaus | Verwaltung › KI › Freigaben | nur Anzeige „Deine Rechte“ (Mitglieder-Card) | – | – | S | ja (Vorschau Org, Tabelle Projekt) |
| Budgets (Agent, Assistenz), was PL darf (ownLlm, maxBudget) | Verwaltung › KI › Grenzen | Wirkung: Cards ausgeblendet / Button gesperrt | – | – | G | ja (Begründungstext) |
| Online-Recherche | Verwaltung › KI › Grenzen; Häkchen am Profil nur bei lokalem Anbieter | – | – | Quellen am AP | S | – |
| „KI nutzen“ je Mitglied | – | Mitglieder › RoleForm | – | – | – | – |
| Bestätigungskarten im Chat | – | – | Benutzereinstellungen › Profil | – | – | – |

### 2.4 Übrige Themen

| Thema | Mandant | Projekt | Person |
| --- | --- | --- | --- |
| Allgemein | Verwaltung › Mandant (Firma, Akzentfarbe, Fußzeile, Zeiterfassung, persönliche Projekte, Mail-Rückfrage in einem Formular) | Allgemein (Name, Beschreibung, Sichtbarkeit) und Projekt (Kürzel, Status, Ampel, Zeiterfassung, Budget, Vorlage, Archivieren) in zwei Cards | Profil und Darstellung (Name, Theme, Sprache ohne Wirkung, Chat-Karten) |
| Personen und Rechte | Benutzer, Einladungen, Gruppen, PL je Projekt | Mitglieder, Gruppen, Einladungen, Kontakte | – |
| Fristen und Berichte | – | Eskalation, Erinnerungen, Reporting (drei Cards) | – |
| Planung und Board | Ressourcen-Pool, Projektvorlagen, Doku-Vorlagen | Teilprojekte, Meilensteine, Spalten (Modal), Labels, Ressourcen | – |
| Kalender | – | – | Kalender-Abo, CalDAV, Abwesenheiten |
| Sicherheit | 2FA zurücksetzen je Benutzer | – | Passwort, 2FA |
| Daten | Audit-Export | Papierkorb, Audit-Log (Reiter) | – |
| Angeheftete Projekte | – | – | nur Stern in der Seitenleiste |

## 3. Befund im Einzelnen

### 3.1 Ort und Benennung

1. Drei Namen für eine Seite: Menü „Konfiguration“, Titel „Mail-Konten“, API „Meine Mail-Konten“. Dort liegen Konten aller vier Arten nebeneinander, obwohl sie drei Ebenen gehören.
2. Mail-Rückfrage: Mandant unter „PDF-Stil und Module“, Projekt unter „KI“.
3. Arbeitszeitfenster und Außenprüfung (beides Mail nach außen) unter „KI › Grenzen“.
4. Erinnerungen an Externe (Mail) in der Card „Eskalationsregeln“.
5. Projektagent, dessen Mail-Modus und Agent je Mail-Ansicht in zwei Cards (KI, Mail-Ansichten).
6. Agent aufnehmen auf zwei Wegen (Mitglieder, KI) mit unterschiedlichem Standard für `agentCanMail`.
7. Zwei Kontaktlisten: `project_contacts` (Card Kontakte) und `external_profile.contacts` (Card Außenkommunikation).
8. Projekt-Allgemeines in zwei Cards („Allgemein“ und „Projekt“), Sprungleiste und Card-Reihenfolge weichen ab, `#ressourcen` fehlt in der Sprungleiste.
9. Verweistexte zeigen auf falsche Orte: `AiView.tsx:52` und `MailAi.tsx:79` („Einstellungen › Projekt“), `MailAi.tsx:109` und `MailView.tsx:665` („Einstellungen › Mail“), `ContactsCard.tsx:33` („Einstellungen › Ressourcen“).
10. `resources_admin` sieht den Abschnitt Ressourcen, aber nicht den Menüpunkt Verwaltung (`Layout.tsx:127`).

### 3.2 Darstellung

11. Drei Speichermuster ohne Regel: Formular mit Button (Profil, Eskalation, Reporting, CalDAV), Autosave je Feld (Matrix, Zeiterfassung, LLM-Select, Policy je Agent), Aktions-Buttons. In der Card „Projekt“ stehen Autosave-Checkbox und Button-Feld nebeneinander. „Mandant“ lädt nach dem Speichern die Seite neu.
12. Vererbung wird nur bei der Benachrichtigungsmatrix vollständig gezeigt. Mail-Rückfrage unterscheidet Mandant und Code-Standard nicht; LLM der Assistenz zeigt „aus“; Policy je Agent zeigt „erbt vom Projekt“ ohne Wert; AP-Policy zeigt nichts; der Org-Policy-Editor bekommt kein `effective` und blendet dadurch die Bestätigungsliste aus.
13. Eskalation, Erinnerungen, Reporting haben Code-Standards, aber keine Anzeige „Standard“ und kein „Zurücksetzen“.
14. Nicht-PL sehen je Card eine andere Nur-Lese-Form (dl, Text, deaktiviertes Feld) oder gar nichts; der Menüpunkt fehlt, die URL funktioniert.
15. Erfolgs- und Fehlermeldungen von „Passwort ändern“ erscheinen in der Profil-Card (geteilter State, `UserSettingsPage.tsx:22-23`).

### 3.3 API ohne UI, UI ohne Wirkung, Fehler

16. Ohne UI: `expireH`, Tagesbudget für Org-Agenten (`PATCH /agents/:id` kennt es nicht), `confirm`/`workflows` je Agent im Projekt, alle Klassen der AP-Regeln (API erlaubt sie der PL), Schlüssel löschen (Profil, Web-Suche), `project_templates.description/spec`, Org-Name ändern, `web_search` an Anthropic-Profilen und eigenen LLMs.
17. Ohne Wirkung oder veraltet: `settings.language` (nirgends ausgewertet), `settings.mailNotifications`, `ai.plAgents.enabled`/`profileIds`, Spalte `orgs.ai_api_key`. `ai.ownLlm` fehlt im Typ `OrgSettings`. `PATCH /me` merged ohne Whitelist.
18. Fehler: Mode-Select im Drawer sendet nur `{mode}` und löscht eine gesetzte Denktiefe (`TaskDrawer.tsx:135`). Sichtbarkeit „org“ wird in persönlichen Projekten angeboten, die API lehnt ab. Spalte „Konto“ in Mail-Ansichten zeigt zentrale Postfächer als „Projektkonto“ (`MembersView.tsx:506`). Label-Farben im Board-Formular sind eine zweite Liste neben `LABEL_COLORS`. `/auth/me` liefert `orgs.settings` roh an jeden Benutzer (inkl. versiegeltem Web-Schlüssel). Org-Zeiterfassung wird in der API nie geprüft.

## 4. Zielbild

### 4.1 Drei Einstellungsseiten, ein Muster

| Ebene | Route | Menüpunkt | wer |
| --- | --- | --- | --- |
| Mandant | `/verwaltung/<tab>` | Verwaltung | Org-Admin; Org-Rechte sehen ihre Tabs |
| Projekt | `/projekte/:id/einstellungen/<tab>` | Einstellungen (Projekt) | PL bearbeitet; Mitglieder lesen (Menüpunkt für alle, Felder gesperrt) |
| Person | `/einstellungen/<tab>` | Meine Einstellungen | jede Person |

Die Seite `/einstellungen/konfiguration` entfällt. Ihre Konten wandern nach Art: Org-Postfach und zentrale Postfächer nach Verwaltung › Mail, Projektpostfächer nach Projekt › Mail, persönliche nach Meine Einstellungen › Mail. Verwaltung › Mail zeigt zusätzlich alle Konten des Mandanten als Übersicht (heutige Tabelle, Spalte Art).

Gemeinsames Muster: eine Shell-Komponente (`SettingsPage`) mit Unterreitern als echte Routen (TopBar-`tabs` wie heute bei Einstellungen/Audit), eine Spalte, Cards je Abschnitt. Keine Anker-Sprungleiste, kein 2-Spalten-Grid. Jeder Reiter ist verlinkbar; Hilfetexte verlinken auf Reiter, nicht auf Pfadbeschreibungen.

### 4.2 Gleiche Reiter auf allen Ebenen

Reihenfolge und Namen sind auf allen drei Seiten gleich. Ein Reiter fehlt, wenn die Ebene nichts dazu hat.

| Reiter | Mandant | Projekt | Person |
| --- | --- | --- | --- |
| Allgemein | Firma, Name des Mandanten, Akzentfarbe, Fußzeile; Module: Zeiterfassung, persönliche Projekte | Name, Kürzel, Beschreibung, Sichtbarkeit, Status, Ampel, Zeiterfassung, Budget; Aktionen: als Vorlage speichern, archivieren | Name, E-Mail (lesen), Theme, Chat-Karten |
| Personen | Benutzer, Einladungen, Gruppen, verantwortliche PL je Projekt | Mitglieder (Personen, Gruppen, Agenten in einer Liste mit Rolle und Einzelrechten), Einladungen, Kontakte und Stakeholder (eine Liste, Flag „nach außen nennbar“) | – |
| Mail | Org-Postfach, zentrale Postfächer, Übersicht aller Konten; Vorgaben: Mail-Rückfrage, Außenprüfung, Arbeitszeitfenster | Postfächer des Projekts (Bindung, Standard, neu, OAuth), Ansichten/Filter/Rechte, Mail-Rückfrage, Außenkommunikation (externes Profil), Erinnerungen an Externe | Meine Konten (IMAP, OAuth), Kalenderziele aus OAuth |
| Benachrichtigungen | Regelmatrix, Digest-Stunde | Regelmatrix, Doku-Seite, Vorschau „Wer bekommt was“ | Regelmatrix, je Projekt abweichen, stummschalten |
| KI | LLMs, Agenten, Freigaben, Grenzen (Budgets, was PL darf, Agenten-Policy), Online-Recherche | LLM der Assistenz, eigenes LLM, Agenten im Projekt (aufnehmen, eigene anlegen, Projektagent + Mail-Modus, Agent je Ansicht, Policy je Agent), Agenten-Policy, Deine Rechte | – (Chat-Karten unter Allgemein) |
| Fristen und Berichte | – | Eskalation, Reporting | – |
| Planung und Board | Ressourcen-Pool, Projektvorlagen, Doku-Vorlagen | Teilprojekte, Meilensteine, Spalten, Labels, Ressourcen | Kalender-Abo, CalDAV, Abwesenheiten (Reiter heißt hier „Kalender“) |
| Sicherheit | SSO/OIDC-Status (lesen, aus Umgebung) | – | Passwort, 2FA |
| Daten | Audit-Export | Papierkorb, Audit-Log | – |

Entscheidungen darin:

- Mail-Rückfrage, Außenprüfung, Arbeitszeitfenster, Agent-Mail-Modus und Agent je Ansicht gehören zu Mail (Thema ist der Mailverkehr, der Agent ist nur das Werkzeug). Ausnahme: Agent je Ansicht bleibt in der Ansichten-Tabelle unter Mail, Projektagent als Rolle unter KI.
- Erinnerungen an Externe gehen über das Projektkonto nach außen, daher Mail. Eskalation und Reporting bleiben zusammen als „Fristen und Berichte“.
- „Deine Rechte“ (KI-Fähigkeiten der angemeldeten Person) wandert in Projekt › KI und ist für alle Mitglieder sichtbar.
- Angeheftete Projekte bekommen einen Abschnitt unter Person › Allgemein (Liste, Reihenfolge), der Stern in der Seitenleiste bleibt.

### 4.3 Granularität: wer legt was fest

Jede Einstellung hat genau eine führende Ebene und höchstens eine Verfeinerung darunter. Die Org setzt pro Feld eine von drei Wirkungen, und die UI benennt sie so:

| Wirkung | Bedeutung | Anzeige unten |
| --- | --- | --- |
| Vorgabe | gilt, bis die tiefere Ebene überschreibt | Option „erben (Wert · Ebene)“ als erste Wahl |
| Grenze | tiefere Ebene darf nur enger | Feld begrenzt, Hinweis „höchstens X (Mandant)“ |
| Sperre | tiefere Ebene sieht, ändert nicht | Feld gesperrt, „🔒 Mandant“ |

| Thema | Mandant | Projekt | Person | Arbeitspaket | Agent (Objekt) |
| --- | --- | --- | --- | --- | --- |
| Mail-Konten | Org-Postfach, zentral, anbieten | binden, Standard, Projektpostfach | eigene Konten | – | – |
| Mail-Rückfrage | Vorgabe | Override | – | – | – |
| Außenprüfung, Arbeitszeitfenster | Sperre | lesen | – | – | – |
| Externes Profil, Erinnerungen an Externe | – | führend | – | – | – |
| Benachrichtigungen: Empfänger, Log, Doku, Fristen | Vorgabe + Sperre | Override + Sperre | – | Override (alle Klassen, PL) | – |
| Benachrichtigungen: Chat, Mail | Vorgabe + Sperre | Override + Sperre | Override, je Projekt | Override nur `progress` | – |
| Digest-Stunde | Sperre | – | – | – | – |
| LLM-Profile | führend (Einsatz = Grenze) | eigenes LLM, wenn erlaubt | – | – | LLM-Wahl innerhalb Einsatz |
| LLM der Assistenz | Vorgabe (neu: `defaultProfileId` erbt auch hier) | Override | – | – | – |
| Agenten-Policy | Vorgabe + Grenze | Override + Grenze | – | Override `mode`, `depth` | Override `mode` je Projekt |
| KI-Freigaben | Sperre (Matrix) | lesen (Deine Rechte); PL verengt über „KI nutzen“ | – | – | – |
| Budgets | Grenze | Agentenbudget bis Grenze | – | – | eigenes Budget (auch Org-Agenten) |
| Online-Recherche | Sperre (Dienst, Domains) + Freigabe | – | – | lesen (Quellen) | Häkchen je Profil (alle Anbieter) |
| Persona, Unterschrift, Denkmodus | – | – | – | – | führend |
| Eskalation, Reporting | – (Standard aus Code, sichtbar als „Standard“) | führend, mit „Zurücksetzen“ | – | – | – |
| Theme, Chat-Karten, Pins, Kalender | – | – | führend | – | – |
| Zeiterfassung | Modul an/aus (Sperre) | an/aus, Budget | – | – | – |

Arbeitspaket und Agent bekommen keine eigene Einstellungsseite. Ihre Overrides bleiben inline (Drawer, Agentenzeile), zeigen aber den wirksamen Wert und die Herkunft wie die Matrix.

### 4.4 Darstellungsregeln

1. **Speichern:** Zusammenhängende Felder (Formular) speichern per Button; Einzelwerte (Select, Checkbox, Matrixzelle) speichern sofort mit kurzer Bestätigung. Innerhalb einer Card nur ein Muster. Kein `location.reload()`.
2. **Vererbung:** Jedes vererbbare Feld nutzt dieselbe Komponente (`InheritSelect`/`InheritNumber`): erste Option „erben (Wert · Ebene)“, Herkunft aus `effective.origin`, Sperre als 🔒 mit Ebene. Code-Standard heißt „Standard“, nicht „Mandant“.
3. **Standard vs. gesetzt:** Nicht vererbte Policies (Eskalation, Reporting, Erinnerungen) zeigen ein Badge „Standard“ und einen Link „Zurücksetzen“.
4. **Nur lesen:** Gleiche Card, Felder `disabled`, eine Zeile „Ändert: PL“ bzw. „Ändert: Org-Admin“. Keine zweite dl-Variante je Card.
5. **Rückmeldung:** ein `useAsync` je Card, Meldung in derselben Card.
6. **Verweise:** Links auf Reiter-Routen (`/verwaltung/ki`, `/projekte/:id/einstellungen/mail`), nie Pfadtexte in Prosa.
7. **Rechtegrenzen:** Was eine Rolle nicht ändern darf, erscheint gesperrt mit Grund, nicht ausgeblendet (Ausnahme: ganze Reiter, zu denen die Rolle nichts hat).

## 5. Umzüge (von → nach)

| Einstellung | heute | Ziel |
| --- | --- | --- |
| Org-Postfach, zentrale Postfächer, Verwalter, „für alle“ | Konfiguration | Verwaltung › Mail |
| Projektpostfächer binden/anlegen | Projekt › Mail-Ansichten › Postfächer; Link nach Konfiguration | Projekt › Mail (oberer Abschnitt) |
| Persönliche Konten, OAuth | Konfiguration | Meine Einstellungen › Mail |
| Mail-Rückfrage (Org) | Verwaltung › Mandant › PDF-Stil und Module | Verwaltung › Mail › Vorgaben |
| Mail-Rückfrage (Projekt) | Projekt › KI | Projekt › Mail |
| Außenprüfung, Arbeitszeitfenster | Verwaltung › KI › Grenzen | Verwaltung › Mail › Vorgaben |
| Erinnerungen an Externe | Projekt › Eskalation | Projekt › Mail |
| Externes Profil | Projekt › Außenkommunikation | Projekt › Mail › Außenkommunikation |
| Ansprechpartner für Externe | `external_profile.contacts` | Flag an Projektkontakten |
| Agent-Mail-Modus | Projekt › KI | Projekt › KI › Projektagent (bleibt), Anzeige zusätzlich in Mail › Ansichten |
| Agent aufnehmen (zweiter Weg) | Projekt › KI › Agenten im Projekt | entfällt; Mitglieder-Liste führt Agenten mit Rolle, Mailrecht, Policy |
| Card „Projekt“ (Kürzel, Status, Ampel, Zeiterfassung, Budget, Vorlage, Archiv) | eigene Card | Projekt › Allgemein |
| Deine Rechte | Projekt › Mitglieder | Projekt › KI (alle Mitglieder) |
| Audit-Log | Reiter neben Einstellungen | Projekt › Daten (plus Link aus Übersicht) |
| Digest-Stunde | Kartenkopf der Matrix | Verwaltung › Benachrichtigungen, eigener Abschnitt über der Matrix |
| Ressourcen-Pool, Projekt- und Doku-Vorlagen | Verwaltung › Ressourcen / Vorlagen | Verwaltung › Planung und Board |
| Angeheftete Projekte | nur Stern | Meine Einstellungen › Allgemein (Liste) + Stern |
| Chat-Karten | Profil | Meine Einstellungen › Allgemein (bleibt), Abschnitt „Chat“ |
| Sprache | Profil | entfällt, bis es eine zweite Sprache gibt |

## 6. Bereinigung ohne Umbau (sofort)

1. `TaskDrawer.tsx:135`: Mode-Select muss die Denktiefe erhalten (`{ ...t.agentPolicy, mode }`).
2. `Layout.tsx:127`: `resources_admin` zum Menüpunkt Verwaltung.
3. `UserSettingsPage.tsx`: eigener `useAsync`/`msg` für die Passwort-Card.
4. `MembersView.tsx:343-346`: Option „org“ bei persönlichen Projekten ausblenden (`policy`).
5. `MembersView.tsx:506`: Kontoart über `kindLabel` statt `accountType`.
6. Verweistexte in `AiView.tsx:52`, `MailAi.tsx:79/109`, `MailView.tsx:665`, `ContactsCard.tsx:33` korrigieren (nach dem Umbau als Links).
7. `AdminPage.tsx:467`: `effective` an den Org-Policy-Editor geben (GET der wirksamen Org-Policy).
8. `BoardView.tsx:346`: `LABEL_COLORS` verwenden.
9. Typen: `ai.ownLlm` in `OrgSettings`, `plAgents.enabled`/`profileIds` und `mailNotifications` entfernen (API-Übertragung und Backfill sind durch), `language` entfernen.
10. `PATCH /me`: Whitelist der `settings`-Schlüssel.
11. `/auth/me`, `/org/settings`: `orgs.settings` auf die Felder reduzieren, die der Client braucht (keine `ai.web`-Schlüsseldaten).
12. `PATCH /agents/:id`: `dailyBudget` annehmen; `web_search` an Anthropic-Profilen und eigenen LLMs setzbar.
13. `expireH` in die Matrix (Spalte Fristen) oder aus `NOTIFY_LEVEL_FIELDS` streichen.

## 7. Umsetzung in Schritten

| Schritt | Inhalt | Dateien (Kern) |
| --- | --- | --- |
| 0 | Bereinigung aus Abschnitt 6 | TaskDrawer, Layout, UserSettingsPage, MembersView, AdminPage, shared, users.ts |
| 1 | Shell `SettingsPage` mit Reiter-Routen; gemeinsame Bausteine `InheritSelect`, `InheritNumber`, `StandardBadge`, `ReadOnlyNote`, `SaveBar` | `components/settings/*` |
| 2 | Meine Einstellungen auf die Shell (Allgemein, Mail, Benachrichtigungen, Kalender, Sicherheit); persönliche Konten aus `MailAccountsPage` als `AccountsTable kind="personal"` | UserSettingsPage, MailAccountsPage → `components/mail/AccountsTable` |
| 3 | Verwaltung auf die Shell; Reiter Mail neu (Konten + Vorgaben); Mandant-Formular ohne Reload | AdminPage (aufteilen in `pages/admin/*`) |
| 4 | Projekt-Einstellungen auf die Shell; `MembersView` (858 Zeilen) in `pages/project/settings/*` aufteilen; Mitglieder-Liste mit Agenten; Kontakte zusammenführen (Migration: `external_profile.contacts` → `project_contacts.external = true`) | MembersView, ContactsCard, InviteCard, NotifyRules, AgentPolicy, projects.ts, Migration 061 |
| 5 | Vererbung sichtbar machen: LLM der Assistenz erbt `defaultProfileId`; Policy je Agent und am AP mit `effective`; Standard-Badge für Eskalation/Reporting/Erinnerungen | projects.ts, agents.ts, agentPolicy.ts, policy.ts |
| 6 | Redirects alter Routen (`/einstellungen/benutzer`, `/einstellungen/konfiguration`, `/projekte/:id/mitglieder`, `/projekte/:id/audit`), Handbuch Kapitel 13, Tour-Anker | App.tsx, Handbuch.md, Tour.tsx |

Schritte 2 bis 4 sind unabhängig voneinander und können einzeln ausgeliefert werden. Schritt 0 ist ohne Risiko und kann sofort erfolgen.

## 8. Offene Entscheidungen

1. **Konfiguration auflösen** (Empfehlung: ja). Alternative: Seite als reine Org-Admin-Übersicht behalten, dann unter Verwaltung › Mail.
2. **Reiter als Routen statt Anker** (Empfehlung: ja). Kostet den Umbau der drei Seiten, bringt Deep-Links und gleiche Struktur.
3. **Mail-Rückfrage unter Mail statt KI** (Empfehlung: Mail). Betrifft auch das Handbuch und die KI-Konzepte, die sie als Konzept 5 unter KI führen.
4. **Kontaktlisten zusammenführen** (Empfehlung: ja, Flag an `project_contacts`). Braucht eine Migration und Anpassung in `outbound.ts`/`agent.ts`, wo `externalProfile.contacts` gelesen wird.
5. **Sprache entfernen** (Empfehlung: ja). Alternative: Feld behalten und als „folgt“ sperren.
6. **Einstellungen für Mitglieder sichtbar** (Empfehlung: ja, nur lesen). Heute fehlt der Menüpunkt für Nicht-PL; die URL funktioniert trotzdem.
