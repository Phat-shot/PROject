# KI-Handbuch: Mit Agenten arbeiten

Für Projektleitung, Mitglieder und Verwaltung. Dieses Handbuch beschreibt, was ein KI-Agent in PROject tut und nicht tut, wie man ihn einsetzt und steuert, was er weiß, und beantwortet die häufigsten Fragen. Technische Details stehen im Handbuch (Kapitel 11 und 12), die Prompt-Quelle im KI-Sheet.

## 1. Was ein Agent ist

- **Ein Kollege ohne Login.** Ein Agent ist ein Benutzer vom Typ KI. Er ist im Projekt **Mitglied** oder **stellvertretende Projektleitung** und arbeitet an Arbeitspaketen und Aufgaben, für die er zuständig ist (direkt zugewiesen oder geerbt über ein Teilprojekt). Er handelt innerhalb seiner Rechte, nie darüber hinaus, und hat dieselben Pflichten wie eine Person: Log schreiben, zurückmelden, Termine einhalten.
- **Im Projekt gibt es nur Agenten.** Jeder Agent gehört zu genau einem LLM. Wer das LLM verwaltet, legt den Agenten an und legt fest, was er darf. Im Projekt wirkt er erst, wenn die Projektleitung ihn einlädt; dort kann sie seine Rechte nur abschalten, nie erweitern. Auch die Assistenz (Zusammenfassen, Frage ans Projekt, Statusbericht …) führt ein Agent des Projekts aus; Personen lösen sie mit dem Recht „KI nutzen“ aus. Der **Notaus** der Verwaltung schaltet jede KI sofort ab.
- **Das System bestätigt, nie das Modell.** Was angelegt, gesendet oder eingetragen wurde, schreibt das System ins Log und als Karte in den Chat. Kennzahlen berechnet das System. Behauptet der Agent im Chat etwas, das nicht ausgeführt wurde, ersetzt das System den Satz durch „Das konnte ich nicht ausführen: …“.
- **Im Thema bleiben.** Jeder Lauf und jede Antwort hat genau einen Bezug: ein Arbeitspaket, ein Projekt, eine Frage. Projekte werden nie vermischt.

### Was er tut

| Bereich | Das übernimmt er | Grenze |
|---|---|---|
| Arbeit am Arbeitspaket | Log, Status, Tasks abhaken, ergänzen und umformulieren; Aufgaben unter seinem Arbeitspaket anlegen | fremde Arbeitspakete nur mit Recht „Projektplan ändern“ |
| Doku | Seiten lesen, anlegen, ändern, ergänzen; Status Entwurf und In Prüfung; PDF finaler Seiten senden | Final setzen nur mit Recht „Final setzen“; Ordner mit Zugriff „kein“ sieht er nicht; löscht nie |
| Kommunikation intern | Fragen per Chat (offene Frage mit Frist, Nachfassen, Weitergabe), Informationen per Chat, Eskalation an die Projektleitung | Interne nie per Mail |
| Kommunikation extern | Mails an Externe zu ihrer Aufgabe; Antwort auf die Ursprungsmail zum Abschluss | nur Außenkontext (Kapitel 6); ohne „darf Mails senden“ und beim ersten Kontakt immer Entwurf |
| Planung | Aufgaben, Arbeitspakete, Teilprojekte, Meilensteine, Termine, Zuweisungen je nach Rolle und Recht | Termine sagt er nie zu, Kalendereinträge sind vorläufig |
| Ressourcen | Räume, Geräte, externe Personen buchen (immer vorläufig, eine Person bestätigt) | übersteuert nie einen Konflikt |
| Wissen | Überblick über das Projekt, passende Seiten, ähnliche Arbeitspakete; Suche im Projekt; Überschneidungen melden | nur, was er sehen darf |
| Recherche online | Suchen und Seiten lesen, Quellen an die Seite hängen | nur mit Freigabe; nur lesen, keine Kontaktaufnahme |
| Mail-Bearbeitung | als (stellvertretende) Projektleitung Mails direkt bearbeiten, als Mitglied vorschlagen (neue Mails der Projektkonten, Ordner „KI Bearbeiten“, „Bearbeiten lassen“, „Vorschläge zur Mail“ mit Antwort per Chat); offene Punkte nachfragen; Info an die PL per Chat; Antwort selbst senden nur mit Senderecht, „darf Mails senden“ und Policy „Selbstständig“ nach Außenprüfung | Inhalte persönlicher Konten nur mit Freigabe; erster Kontakt mit Unbekannten immer Entwurf |

### Was er nie tut

Projekte, Mitglieder, Rechte oder Einstellungen ändern; Zusagen mit Geld- oder Vertragswirkung; Termine oder Buchungen selbst bestätigen; Vorschläge anderer freigeben; löschen; Konflikte übersteuern; Fakten erfinden. Er ist nie verantwortliche Projektleitung oder Org-Admin.

## 2. Einsatz

### Agent aufnehmen

1. **LLM anlegen** (Verwaltung › KI › LLMs und ihre Agenten; Org-Admin oder Recht „KI verwalten“): Anbieter, Modell, Einsatz (alle, ausgewählte oder keine Projekte). Ob es in Projekten zusätzlich ein **eigenes LLM** geben darf (aus, nur persönliche, alle Projekte), stellt die Verwaltung unter „Grenzen und Vorgaben“ ein; dann bindet die Projektleitung es unter Einstellungen › KI ein und verwaltet es samt Agenten.
2. **Agent anlegen** am LLM („Agent anlegen“ in seinem Block): Name, **Persona** (eine Zeile Schreibstil, z. B. „freundlich, knapp, duzt das Team, siezt Externe“), Unterschrift, Denkmodus, Tagesbudget, Einsatz (alle oder ausgewählte Projekte), **was er darf** (Häkchen je Bereich: Assistenz, Mail, Arbeit, Aktionen; Online-Recherche ist zunächst aus) und die **Obergrenze der Selbstständigkeit** samt immer zu bestätigender Schritte. Ein Agent läuft nur in Projekten, die sein Einsatz umfasst und in denen sein LLM eingesetzt werden darf.
3. **Einladen** (Projekt › Einstellungen › KI › Agent einladen, Projektleitung): Rolle Mitglied (schlägt vor) oder stellvertretende PL (legt direkt an), „darf Mails senden“ (sonst gehen Mails als Entwurf in die Freigabe). Nicht einladbare Agenten stehen mit Grund darunter. Unter **Einschränken** schaltet die Projektleitung einzelne Rechte ab (nicht erteilte sind ausgegraut), setzt die Selbstständigkeit strenger (nie lockerer als die Obergrenze) und Workflow-Schritte.
4. **Zuweisen**: Arbeitspaket, Aufgabe oder Teilprojekt. Der erste Lauf startet sofort.

### Projektagent

Die Projektleitung kann einen Agenten als **Projektagent** setzen (Einstellungen › KI). Er ist stellvertretende Projektleitung und bearbeitet mit Mail-Modus „bearbeiten“ neue Mails der Projektkonten direkt; mit „vorschlagen“ schlägt er nur vor. Mails bearbeitet immer ein Agent, nie eine „Projekt-KI“: Welcher Agent, ergibt sich aus Projektagent oder Agent an der Mail-Ansicht; ob er direkt anlegt oder vorschlägt, aus seiner Rolle (stellvertretende PL oder Mitglied). Offene Punkte aus einer Mail klärt er je **Mail-Rückfrage**: Er fragt die Projektleitung (klar oder Infos kommen, im Projekt fragen mit Frist, beim Absender rückfragen). Mit Reichweite „ganzes Projekt“ läuft werktags der **Projektdurchlauf** (Kapitel 4).

### Auftrag im Chat

Wer laut Policy darf (Standard: Projektleitung und Stellvertretung), beauftragt den Agenten direkt im Chat: Direktnachricht oder `@Name` im Projektkanal.

> **Petra:** @Morton, bitte bis Freitag eine Entscheidungsvorlage für den Backup-Elektriker im Edertal, drei Betriebe, nur online.
> **Morton:** Mache ich. Ich lege ein Arbeitspaket an, recherchiere online und lege dir die Vorlage als Seite „In Prüfung“ vor.
> *Systemkarte:* ✓ Angelegt: WEB-23 „Backup-Elektriker Edertal: Entscheidungsvorlage“ · zuständig Morton · Auftraggeber Petra Lenz · Termin 24.10.

Das Arbeitspaket trägt den Absender als **Auftraggeber**; er bekommt Zwischenstände. Mitglieder ohne Auftragsrecht erzeugen einen **Auftragsvorschlag** an die Projektleitung (Frage mit Knopf). „Rückgängig“ an der Karte nimmt einen Auftrag zurück, solange nichts Weiteres passiert ist.

### Fragen beantworten

Der Agent fragt per **offener Frage**: Direktnachricht an den Ansprechpartner oder Thread im Projektkanal, dazu eine Meldung und ein Log-Eintrag. Antworten gehen im Thread, in der Direktnachricht, in der Aufgabe (Block „Offene Fragen“) oder über die Karte mit Knöpfen. Nach Frist fasst er nach und gibt bei Schweigen an die nächste Stufe weiter. Die Antwort steht danach im Log; der Agent läuft weiter.

> **Morton:** Zu WEB-23: Soll ich nur Betriebe mit Notdienst berücksichtigen? Antwort bis morgen 12 Uhr wäre gut.
> **Petra:** Ja, nur mit Notdienst.
> *Log WEB-23:* Rückmeldung per Chat an Morton: Ja, nur mit Notdienst.

## 3. Steuerung

### Rechte, Einschränkung, Policy

Drei Dinge wirken zusammen, jedes an seinem Ort:

| Was | Wo | Wer | Beispiele |
|---|---|---|---|
| **Rechte des Agenten** | am Agenten (Verwaltung › KI bzw. eigenes LLM im Projekt) | Verwalter seines LLM | Assistenz, Mails vorschlagen oder bearbeiten, Arbeitspakete, Chat, Aufträge, Online-Recherche, Aktionen (Final setzen, Mails nach außen …); Obergrenze der Selbstständigkeit |
| **Einschränkung im Projekt** | Projekt › Einstellungen › KI › Einschränken | Projektleitung | Rechte abschalten, Selbstständigkeit strenger, Rolle, „darf Mails senden“; Zugriff je Doku-Ordner (voll, lesen, kein) |
| **Policy** (Verhalten) | Projekt › Einstellungen › KI, Arbeitspaket | Projektleitung | Selbstständigkeit, Bestätigungen, Reichweite, Überschneidungen, Aufträge im Chat, Workflow-Schritte, Uhrzeit des Projektdurchlaufs |
| **Personen** | Mitgliedschaft | Projektleitung | „KI nutzen“: Assistenz auslösen und mit Agenten chatten (Leser nur Frage ans Projekt) |

Geprüft wird in dieser Reihenfolge: Notaus → Rechte des Agenten → Einschränkung im Projekt → LLM → Tagesbudget. Was der Verwalter nicht erteilt hat, kann im Projekt niemand freigeben.

### Selbstständigkeit und Bestätigungen

| Stufe | Bedeutung |
|---|---|
| **Selbstständig** | führt alles aus, was seine Rechte im Projekt erlauben |
| **Rückfrage bei wichtigen Schritten** (Standard für neue Projekte) | hält die Klassen der Liste „Bestätigung vor“ an: Final setzen, PDF an Verteiler, Mails nach außen, Erledigt setzen, Umstrukturieren (anpassbar; dazu Planen, Zuweisen an Dritte, Termine ändern, fremde Arbeitspakete) |
| **Rückfrage bei allem** | hält jede Aktion außerhalb der Grundmenge an |

Die **Grundmenge** (Log, Tasks, Doku-Entwürfe, interner Chat, Fragen) ist immer frei. Angehaltene Aktionen legt der Agent der Projektleitung als **Karte „Freigabe“** vor (Chat, Arbeitspaket, Projekt › KI): einzeln bestätigen oder mit Grund ablehnen; Abgelehntes wird 14 Tage nicht erneut vorgeschlagen, nach 7 Tagen verfallen offene Vorschläge. Die Policy vererbt sich **Projekt → Agent im Projekt → Arbeitspaket**; der Verwalter des LLM setzt am Agenten Grenzen (höchstens diese Stufe, immer zu bestätigende Klassen, höchste Denktiefe), die keine Ebene lockern kann. Mails nach außen gehen bei Bestätigungspflicht als Entwurf in Mail › Freigaben.

### Weitere Felder

- **Denktiefe:** schnell (eine Leserunde, knapper Kontext, Denkmodus lokaler Modelle aus), Standard, gründlich (bis zu vier Leserunden, voller Kontext, Denkmodus an; kostet zwei Läufe im Tagesbudget). Agent (Verwalter) und Projekt setzen eine höchste Denktiefe; je Arbeitspaket darf auch „Projektplan ändern“ sie setzen, auch per Chat („WEB-12 gründlich“).
- **Reichweite:** zugewiesene Arbeitspakete (Standard) oder ganzes Projekt (Projektdurchlauf des Projektagenten).
- **Überschneidungen:** nachfragen (Standard), aus, oder nutzen (nur bei Selbstständig: Querverweise ohne Rückfrage).
- **Aufträge im Chat:** Projektleitung und Stellvertretung (Standard), dazu Teilprojekt-Verantwortung, Zuständige unter dem eigenen Arbeitspaket oder alle Mitglieder.
- **Workflow-Schritte an Agenten:** erlaubt oder aus (der Schritt geht an die Projektleitung).
- **Uhrzeit des Projektdurchlaufs** (Mandant, werktags Europe/Berlin, Standard 06:45).
- **Tagesbudget** je Agent (Läufe pro Tag), **Online-Recherche** mit Grenzen je Lauf und Tag, **Arbeitszeitfenster** für Mails nach außen (Standard Mo–Fr 07–19 Uhr; außerhalb geplanter Versand).
- **Pause** je Arbeitspaket („Agent pausieren“), **Selbstständigkeit je Arbeitspaket** (nur verschärfen), **Jetzt laufen lassen**.

### Befehle im Chat

Der Agent erkennt Anweisungen in natürlicher Sprache und führt sie als Befehle aus; die Systemkarte unter der Antwort zeigt, was lief:

| Befehl | Wirkung | Wer |
|---|---|---|
| Auftrag (`order`) | Arbeitspaket oder Aufgabe anlegen, Agent zuständig, Absender Auftraggeber | laut Policy „Aufträge im Chat“ |
| `note` | Information ins Log eines Arbeitspakets | Mitglieder |
| `pause`, `resume`, `stop`, `priority` | Agent am Arbeitspaket pausieren, fortsetzen, Zuständigkeit abgeben, Priorität setzen | Projektleitung an allen, Zuständige an eigenen |
| `approve`, `reject` | Karte mit offenen Bestätigungen zeigen (Klick entscheidet) | Freigabeberechtigte |
| `policy` | Selbstständigkeit je Arbeitspaket („WEB-12 ohne Rückfrage“) | Projektleitung |
| `report` | Zwischenstände wünschen (täglich, bei Meilensteinen, bei Erledigung) | Projektleitung, Auftraggeber |
| `refer` | Frage an die Projektleitung weitergeben; Auftragsvorschlag | Mitglieder |

## 4. Wissen und Kontext

- **Nur, soweit berechtigt.** Der Agent sieht Teilprojekte, Doku-Ordner, Mail-Ansichten und Inhalte persönlicher Konten genau wie ein Mitglied mit seinen Rechten; im Chat gilt die Schnittmenge mit dem Gegenüber. Braucht er mehr, fragt er die Projektleitung. Freigaben erteilt er sich nie selbst.
- **Projektüberblick:** jeder Lauf bekommt die Struktur des Projekts (Teilprojekte, Status, Meilensteine, Termine) und den **Steckbrief** des Projektagenten.
- **Passende Seiten und ähnliche Arbeitspakete** findet das System per Suche; mit `search` und `read_task` holt der Agent in höchstens zwei Leserunden nach, was fehlt.
- **Überschneidungen:** Das System findet ohne KI Kandidaten (gleicher Externer, gemeinsame Stichwörter, Zeitraum und Ort, dieselbe Seite, Abhängigkeit mit Terminkonflikt, Fragen an dieselbe Person). Meldet der Agent einen Zusammenhang, fragt das System die Zuständigen bzw. die Projektleitung: synchron bearbeiten, Abhängigkeit, zusammenführen, unabhängig. Entschieden wird mit den Rechten der Person; die Beziehung steht im Arbeitspaket unter „Verwandte Arbeitspakete“.
- **Projektdurchlauf:** Mit Reichweite „ganzes Projekt“ prüft der Projektagent werktags das Projekt: Doppelarbeit und Synergien, Hinweise ins Log, Fragen an die Projektleitung, Steckbrief. Unverändertes Projekt: kein KI-Aufruf. „Projektdurchlauf jetzt“ stößt ihn von Hand an.
- **Kontextgröße:** Die Eingabe belegt höchstens 45 % des Kontextfensters des KI-Profils (Verwaltung › KI › LLMs, Standard 32.000 Token). Überschüssiges wird in fester Reihenfolge gekürzt, das eigene Arbeitspaket bleibt vollständig. Projekt › KI zeigt je Lauf „Kontext n/Grenze“ und ✂, wenn gekürzt wurde.

## 5. Online-Recherche

Standardmäßig aus. Der Verwalter des LLM gibt sie frei (Recht „Online-Recherche“ am Agenten, Häkchen am LLM, Suchdienst unter Verwaltung › KI). Dann recherchiert der Agent nur lesend: Anthropic-Profile über die Websuche des Anbieters, lokale Profile über SearXNG oder Brave. Suchbegriffe werden von Namen, Adressen und Interna befreit; Grenzen je Lauf und Tag; Domains erlaubt oder gesperrt. Quellen stehen am Arbeitspaket („Quellen aus der Online-Recherche“), Seiten bekommen den Abschnitt „Quellen (abgerufen am …)“. Kontaktaufnahme ist keine Recherche, sondern eine Mail nach außen.

## 6. Außengrenze

Externe erfahren nur, was zu ihrer Aufgabe gehört. Empfänger werden eingestuft: intern, Org-Benutzer ohne Zugriff, Extern mit Bezug zum Arbeitspaket (Zuständigkeit, Mails am Arbeitspaket, Besprechung, Buchung als Person-Ressource), Extern ohne Bezug. Mails an Nicht-Interne formuliert ein eigener kleiner KI-Aufruf neu, der nur den **Außenkontext** kennt (Titel und Termine des Arbeitspakets, Tasks des Empfängers, Außenbeschreibung, Log-Einträge „für Externe sichtbar“, freigegebene Seiten, externes Profil des Projekts). Danach prüft das System ohne KI auf fremde Kennungen, Titel anderer Arbeitspakete, nicht freigegebene Seiten und interne Adressen; Fundstellen halten die Mail an (Entwurf zur Freigabe). Der erste Kontakt zu einer unbekannten Adresse ist immer ein Entwurf. Fragen Externer außerhalb ihrer Aufgabe gibt der Agent an den Ansprechpartner weiter.

## 7. Ressourcen und Termine

- **Termine sagt er nie zu.** Schlägt ein Externer einen Termin vor, prüft er Kalender, Belegt-Zeiten (Termine, Belegungen, Abwesenheiten des Ansprechpartners), Wochenenden und Sperrzeiten, fragt den Ansprechpartner und wartet. Seine Kalendereinträge sind **vorläufig**, bis ein Mitglied sie bestätigt; der Ansprechpartner ist Teilnehmer, damit der Termin als belegt zählt. Termine aus Mails trägt er mit den genannten Teilnehmern ein (nie sich selbst); „du“ oder „Sie“ in einer Mail meint die Person hinter dem Postfach (Eigentümer, Verwalter, sonst PL). Sie bekommt die Bestätigungsfrage: „Bestätigen“ macht den Termin verbindlich, „Ablehnen“ entfernt ihn.
- **Buchen:** Ressourcen des Projekts und des Pools kennt er mit ihren Belegungen der nächsten 45 Tage. Er bucht immer **vorläufig** und stellt dem Ansprechpartner eine Bestätigungsfrage (Karte mit Bestätigen und Ablehnen, auch im Arbeitspaket unter „Ressourcen“). Ist eine Ressource belegt, wählt er einen anderen Zeitraum; übersteuern kann er nicht.

## 8. Kontrolle

- **Projekt › KI › Agenten-Läufe:** jeder Lauf mit Anlass, Begründung, Aktionen, Token, Suchen, Kontextumfang und Fehlern; Projektdurchläufe mit Kennzeichen.
- **Im Arbeitspaket:** Wartezustand mit nächster Prüfung, offene Fragen, Freigaben, Quellen, verwandte Arbeitspakete, Ressourcen, „Läuft nicht: …“ mit Grund.
- **Mail › Freigaben:** Entwürfe ohne Senderecht, erste Kontakte, von der Außenprüfung angehaltene Mails, geplanter Versand außerhalb des Arbeitszeitfensters.
- **Fehler im Lauf** (fehlendes Recht, Konflikt, KI-Dienst): Direktnachricht des Agenten an den Ansprechpartner mit Link zum Arbeitspaket; dieselbe Störung nur einmal.
- **Bestätigungskarten im Chat** nur bei Bedarf (abgelehnt, angehalten, Auftrag mit Rückgängig, Bestätigung); „auch für Kleinigkeiten“ in den Benutzereinstellungen.
- **Audit-Log** (Verwaltung): Läufe, Aktionen, Policy-Änderungen, Außenprüfungen, Buchungen.
- **Feedback** (Verwaltung › KI › Feedback zu den Agenten, nur KI-Verwaltung): 👍/👎 an jeder Chat-Antwort eines Agenten und an jedem Lauf (Projekt › KI), bei 👎 mit optionalem Kommentar; erneuter Klick nimmt zurück. Automatisch gesichert werden Ablehnungen mit Grund (Vorschläge, angehaltene Aktionen, Mail-Vorschläge, Mail-Entwürfe), vor dem Übernehmen geänderte Vorschläge und Entwürfe (vorher/nachher), ersetzte Behauptungen, nicht ausgeführte Befehle und Fehler im Lauf, jeweils mit Anfrage und Antwort. Filter nach Art, Agent, Bewertung und Zeitraum; Export als JSONL oder CSV (steht im Audit). Das Feedback ändert den Agenten nicht von selbst: Es dient dazu, Prompt, KI-Sheet und Agenten gezielt zu verbessern.

## 9. Häufige Fragen

**Warum antwortet er auf „hi“ nicht mit Projektinfos?** Ohne Nennung eines Projekts oder einer Kennung gibt es keinen Projektbezug: Bei einem Gruß antwortet er allgemein; bei einer Frage ohne Nennung nutzt er nur dein persönliches Projekt (Doku und Arbeitspakete), wenn er dort Mitglied ist. Ein anderes Projekt nennst du mit Kennung, Kürzel oder Name.

**Warum gilt mein „hi“ nicht als Antwort?** Grüße und Kurzmeldungen ohne Inhalt beantworten keine offene Frage und stehen nicht im Log; der Agent antwortet nur im Chat und wartet weiter. Kurze Bestätigungen wie „ok“, „passt“ oder „ja“ zählen als Antwort.

**Warum erinnert er mich nicht an seine offene Frage?** Ungefragt hängt er keine Projekthinweise an. Auf einen Witz kommt ein Witz, auf „wie geht's“ eine kurze Antwort. Das Nachfassen zur Frist übernimmt das System (Chat und Meldung), die Weitergabe an die nächste Stufe ebenso. Fragst du „Was ist offen?“ oder „Status?“, bekommst du die Übersicht.

**Warum fragt er?** Weil ihm eine Information oder Entscheidung fehlt, die weder in Log, Mails, Chat noch Doku steht, oder weil die Policy für diesen Schritt eine Bestätigung verlangt. Fragen haben ein Thema und eine Frist; nach der Frist fasst er nach und gibt weiter.

**Warum hat er nicht gesendet?** Mögliche Gründe stehen im Log unter seinem Namen: kein Senderecht (Entwurf in Mail › Freigaben), erster Kontakt zu einer Adresse ohne Bezug (Entwurf), Außenprüfung angehalten (Fundstellen), Bestätigungspflicht laut Policy, außerhalb des Arbeitszeitfensters (geplanter Versand), kein Mailkonto. Den Versandstatus schreibt immer das System.

**Woher weiß ich, was er getan hat?** Jede Aktion steht im Log des Arbeitspakets und im Lauf unter Projekt › KI; Chat-Befehle zeigt die Systemkarte unter der Antwort. Was er nur behauptet, aber nicht ausgeführt hat, ersetzt das System sichtbar.

**Warum läuft er nicht?** Im Arbeitspaket steht „Läuft nicht: …“ mit dem Grund: Notaus, Recht nicht erteilt oder im Projekt abgeschaltet, Pause, Tagesbudget, LLM in diesem Projekt nicht eingesetzt oder gesperrt. Gesperrte Läufe kosten kein Budget.

**Warum sieht er eine Seite nicht?** Der Ordner hat für Agenten den Zugriff „kein“, oder die Seite liegt in einem Teilprojekt, das er nicht sieht. Die Projektleitung ändert den Zugriff am Ordner.

**Darf er Termine oder Buchungen bestätigen?** Nein. Vorläufige Termine und Belegungen bestätigt immer eine Person.

**Was passiert bei Überschneidungen zwischen Arbeitspaketen?** Er meldet sie; das System fragt die Zuständigen bzw. die Projektleitung. Niemand muss raten, nichts wird von selbst zusammengelegt.

**Wie bekommt er mehr Spielraum?** Selbstständigkeit auf „Selbstständig“ setzen (Projekt oder Agent im Projekt), Bestätigungsliste kürzen, „darf Mails senden“ setzen. Mehr Rechte (z. B. Final setzen, Online-Recherche) und eine lockerere Obergrenze vergibt nur der Verwalter seines LLM.

**Wie bekommt er weniger?** „Rückfrage bei allem“, Klassen in die Bestätigungsliste, Ordnerzugriff „kein“ oder „lesen“, Pause je Arbeitspaket, Recht im Projekt abschalten (Einschränken) oder am Agenten entziehen, Notaus.
