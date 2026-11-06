# KI-Handbuch: Mit Agenten arbeiten

Für Projektleitung, Mitglieder und Verwaltung. Dieses Handbuch beschreibt, was ein KI-Agent in PROject tut und nicht tut, wie man ihn einsetzt und steuert, was er weiß, und beantwortet die häufigsten Fragen. Es ist die eine Stelle, an der Ursprungsmail, Ordner „KI Bearbeiten“, Tagesbudget, Außenprüfung und Persona erklärt werden; das Handbuch (Kapitel 11 und 12) verweist hierher. Die Prompt-Quelle steht im KI-Sheet.

## 1. Was ein Agent ist

- **Ein Kollege ohne Login.** Ein Agent ist ein Benutzer vom Typ KI. Er ist im Projekt **Mitglied** oder **stellvertretende Projektleitung** und arbeitet an Arbeitspaketen und Aufgaben, für die er zuständig ist (direkt zugewiesen oder geerbt über ein Teilprojekt). Er handelt innerhalb seiner Rechte, nie darüber hinaus, und hat dieselben Pflichten wie eine Person: Log schreiben, zurückmelden, Termine einhalten.
- **Im Projekt gibt es nur Agenten.** Jeder Agent gehört zu genau einem LLM. Wer das LLM verwaltet, legt den Agenten an und legt fest, was er darf. Im Projekt wirkt er erst, wenn die Projektleitung ihn einlädt; dort kann sie seine Rechte nur abschalten, nie erweitern. Auch die Assistenz (Zusammenfassen, Frage ans Projekt, Statusbericht …) führt ein Agent des Projekts aus; Personen lösen sie mit dem Recht „KI nutzen“ aus. Der **Notaus** der Verwaltung schaltet jede KI sofort ab.
- **Das System bestätigt, nie das Modell.** Was angelegt, gesendet oder eingetragen wurde, schreibt das System ins Log und als Karte in den Chat. Kennzahlen berechnet das System. Behauptet der Agent im Chat etwas, das nicht ausgeführt wurde, ersetzt das System den Satz durch „Das konnte ich nicht ausführen: …“.
- **Im Thema bleiben.** Jeder Lauf und jede Antwort hat genau einen Bezug: ein Arbeitspaket, ein Projekt, eine Frage. Projekte werden nie vermischt.

### Was er tut

| Bereich | Das übernimmt er | Grenze |
|---|---|---|
| Arbeit am Arbeitspaket | Log, Status, Tasks abhaken, ergänzen und umformulieren; Aufgaben unter seinem Arbeitspaket anlegen; Beschreibung des eigenen AP aktuell halten (Ziel, Stand, nächste Schritte; die alte Fassung steht im Audit) | fremde Arbeitspakete nur mit Recht „Projektplan ändern“ |
| Doku | Seiten lesen, anlegen, ändern, ergänzen; Status Entwurf und In Prüfung; PDF finaler Seiten senden | Final setzen nur mit Recht „Final setzen“; Ordner mit Zugriff „kein“ sieht er nicht; löscht nie |
| Kommunikation intern | Fragen per Chat (offene Frage mit Frist, Nachfassen, Weitergabe), Informationen per Chat, Eskalation an die Projektleitung | Interne nie per Mail |
| Kommunikation extern | Mails an Externe zu ihrer Aufgabe (höchstens drei je Lauf); Antwort auf die Ursprungsmail zum Abschluss | nur Außenkontext (Kapitel 7); ohne „darf Mails senden“ und beim ersten Kontakt immer Entwurf |
| Struktur | Aufgaben in ein anderes Arbeitspaket hängen (`move_aufgabe`), Arbeitspakete einem Teilprojekt zuordnen (`move_ap`), Tasks zu Aufgaben machen (`promote_item`) oder an eine andere Aufgabe verschieben (`move_item`), Aufgaben ohne Zeiten, Mails und offene Fragen zu Tasks einer anderen Aufgabe desselben AP machen (`demote_aufgabe`); Log an Quelle und Ziel, Audit | Klasse „Umstrukturieren“ (Standard: Bestätigung), außerhalb seines Bereichs als Vorschlag an die PL; nur im selben Projekt |
| Planung | Aufgaben, Arbeitspakete, Teilprojekte, Meilensteine, Termine, Zuweisungen je nach Rolle und Recht (höchstens 15 Anlagen je Lauf); Termine verschieben oder absagen, Einladung an die Teilnehmer senden (bestätigte Termine, aus dem Projektkonto) | Termine sagt er nie zu, Kalendereinträge sind vorläufig; Einladungen gelten als Mail nach außen |
| Ressourcen | Räume, Geräte, externe Personen buchen (immer vorläufig, eine Person bestätigt) | übersteuert nie einen Konflikt |
| Wissen | Überblick über das Projekt, passende Seiten, ähnliche Arbeitspakete; Suche im Projekt; Überschneidungen melden | nur, was er sehen darf |
| Recherche online | Suchen und Seiten lesen, Quellen an die Seite hängen | nur mit Freigabe; nur lesen, keine Kontaktaufnahme |
| Mail-Bearbeitung | als (stellvertretende) Projektleitung Mails direkt bearbeiten, als Mitglied vorschlagen (Kapitel 3) | Inhalte persönlicher Konten nur mit Freigabe; erster Kontakt mit Unbekannten immer Entwurf |
| Telefon | Anrufe über sipgate annehmen, Anliegen als Arbeitspaket aufnehmen, internen Anrufern den Stand geben (Kapitel 10) | Externe bekommen keine Projektinhalte; Termine nur vorläufig |

### Aufgabe oder Task (Checklistenpunkt)

Grundregel: **Checklistenpunkte (Tasks) hängen an Aufgaben**, nie am Arbeitspaket. Am Arbeitspaket legt der Agent Aufgaben an. Ist der letzte Checklistenpunkt einer Aufgabe erledigt, schließt die Aufgabe automatisch; sind alle Aufgaben erledigt, das Arbeitspaket (Einstellungen › Allgemein, je Aufgabe bzw. AP übersteuerbar). Gibt der Agent `add_item` an einem Arbeitspaket an, hängt das System den Punkt an dessen einzige offene Aufgabe oder legt eine Aufgabe mit dem Text des Punkts an und vermerkt das im Log. Am Arbeitspaket sieht der Agent die Tasks seiner Aufgaben mit deren Kennung und hakt sie dort ab. Punkte, die noch am Arbeitspaket hängen (Altbestand), bleiben les- und abhakbar und wandern mit `promote_item` oder `move_item` in Aufgaben.

Dazu gilt eine feste Regel (KI-Sheet, Block „Struktur“) und je Projekt eine **Planungstiefe** (Einstellungen › Planung und Board):

- **Automatisch (Regel):** Eine **Aufgabe** ist ein eigener Schritt mit eigener Zuständigkeit, eigenem Termin oder eigenem Status und Log (mehr als ein Arbeitstag, delegierbar, von außen nachverfolgbar). Ein **Task** ist ein kurzer Prüf- oder Erledigungspunkt einer Aufgabe ohne eigenen Termin und ohne andere Zuständigkeit, den die zuständige Person selbst abhakt. Nie beides für dieselbe Sache; braucht ein Schritt eine andere Person oder einen eigenen Termin, wird er Aufgabe.
- **Immer Aufgaben:** Schritte werden Aufgaben; Tasks nur als Checkliste einer Aufgabe.
- **Immer Checklistenpunkte:** wenige Aufgaben, die Schritte sind ihre Tasks; ein neues Arbeitspaket mit Schritten bekommt eine Aufgabe „Schritte“ mit diesen Punkten.

Die geltende Planungstiefe steht in jedem Lauf im Kontext („Planungstiefe dieses Projekts: …“). Das System setzt sie außerdem durch: bei „Automatisch“ wird eine Aufgabe für das eigene AP ohne Termin, ohne Zuständigkeit, mit kurzem Titel (unter 60 Zeichen) und ohne Tasks zum Task der einzigen offenen Aufgabe dieses AP (im Lauf an einer Aufgabe: zu deren Task); bei „Immer Checklistenpunkte“ gilt das für jede solche Aufgabe ohne Tasks, eine Aufgabe mit Tasks bleibt Aufgabe mit Checkliste; bei „Immer Aufgaben“ wird ein Task am AP zur Aufgabe. Die Schritte (`items`) eines neuen Arbeitspakets werden bei „Immer Checklistenpunkte“ die Checkliste einer Aufgabe „Schritte“, sonst je Schritt eine Aufgabe; das gilt auch für Mail-KI und Chat-Aufträge (Lieferergebnisse). Jede Umsetzung steht im Log („Struktur-Regel: … als Checklistenpunkt angelegt, weil …“) und im Lauf-Protokoll.

### Was er nie tut

Projekte, Mitglieder, Rechte oder Einstellungen ändern; Zusagen mit Geld- oder Vertragswirkung; Termine oder Buchungen selbst bestätigen; Vorschläge anderer freigeben; löschen; Konflikte übersteuern; Fakten erfinden; Risiken, Zeiten oder Einstellungen pflegen. Er ist nie verantwortliche Projektleitung oder Org-Admin. Inhalte aus persönlichen Konten sieht er nur, wenn sie freigegeben sind (Kopie) oder nur der Eigentümer im Projekt ist.

### Wann er läuft

Sofort bei Zuweisung, neuem Kommentar, neuer Mail, Änderungen durch Menschen, Antwort auf eine Frage; dazu bei Wiedervorlage, naher Fälligkeit und spätestens alle drei Tage. Wartet er auf Rückmeldung, Termin, Erledigung durch andere oder Information, setzt er sich eine Wiedervorlage; bei Rückmeldungen fasst er nach Frist nach (Projektmitglieder per Chat, Externe per Mail) und eskaliert danach an die Projektleitung. Der Hintergrunddienst prüft das jede Minute. Was während eines Laufs eintrifft (weitere Chat-Nachrichten, Mails), löst danach genau einen Folgelauf aus; nichts geht verloren. Im Projektkanal gilt das je Thread. Setzt jemand eine Seite, die im Log seines AP genannt ist, auf „In Prüfung“, „Final“ oder zurück auf Entwurf, läuft er ebenfalls.

## 2. Einsatz

### Agent aufnehmen

1. **LLM anlegen** (Verwaltung › KI › LLMs und ihre Agenten; Org-Admin oder Recht „KI verwalten“): Anbieter (Anthropic oder lokal mit OpenAI-kompatibler API: vLLM, Ollama, LM Studio, llama.cpp), Modell, **Denkmodus aus** (nur lokal, für Modelle mit Thinking wie Qwen), **Kontextgröße**, **Zeitlimit** je Anfrage (lokal, Standard 600 s), Einsatz (alle, ausgewählte oder keine Projekte; persönliche Projekte nur mit „auch in persönlichen Projekten“). Ob es in Projekten zusätzlich ein **eigenes LLM** geben darf (aus, nur persönliche, alle Projekte), stellt die Verwaltung unter „Grenzen und Vorgaben“ ein; dann bindet die Projektleitung es unter Einstellungen › KI ein und verwaltet es samt Agenten. Testen, Bearbeiten, Löschen am LLM.
2. **Agent anlegen** am LLM („Agent anlegen“ in seinem Block): Name, Persona und Unterschrift (siehe unten), Denkmodus (wie Profil, aus, an), Tagesbudget (höchstens der Wert des Mandanten), Einsatz (alle oder ausgewählte Projekte), **was er darf** (Häkchen je Bereich: Assistenz, Mail, Arbeit, Aktionen; Online-Recherche ist zunächst aus) und die **Obergrenze** (höchste Selbstständigkeit, immer zu bestätigende Schritte, höchste Denktiefe). Jeder Agent gehört zu genau einem LLM; wechseln kann er nur zu einem LLM derselben Ebene. Agenten legt an und berechtigt, wer das LLM verwaltet: bei LLMs der Organisation die KI-Verwaltung, beim eigenen LLM eines Projekts dessen Projektleitung. Deaktivieren darf die KI-Verwaltung jeden Agenten.
3. **Einladen** (Projekt › Einstellungen › KI › Agent einladen, Projektleitung): nur Agenten, deren Einsatz das Projekt umfasst und deren LLM hier eingesetzt werden darf; die übrigen stehen mit Grund darunter. Rolle Mitglied (schlägt vor) oder stellvertretende PL (legt direkt an), „darf Mails senden“ (sonst gehen Mails als Entwurf in die Freigabe). Unter **Einschränken** schaltet die Projektleitung einzelne Rechte ab (nicht erteilte sind ausgegraut), setzt die Selbstständigkeit strenger (nie lockerer als die Obergrenze) und Workflow-Schritte. Personen kommen über Personen › Mitglieder ins Projekt, Agenten nur über diesen Reiter; die Mitgliederliste zeigt Agenten mit LLM und Kurzfassung ihrer Rechte.
4. **Zuweisen**: Arbeitspaket, Aufgabe oder Teilprojekt. Der erste Lauf startet sofort bzw. beim nächsten Takt (geerbte Zuständigkeit).

Wird ein Einsatz enger oder ein LLM gesperrt, bleibt die Mitgliedschaft, der Agent läuft dort aber nicht mehr (Einstellungen › KI zeigt „läuft nicht“ mit Grund); beim Speichern nennt die Verwaltung die Folgen.

### Persona und Unterschrift

Die **Persona** ist eine Zeile Freitext, die den Schreibstil des Agenten für Log, Mails, Doku und Chat beschreibt, z. B. „freundlich, knapp, duzt das Team, siezt Externe“. Sie steht am Ende des Systemprompts, nach dem KI-Sheet und den Regeln je Laufart: Fakten- und Rechteregeln gehen immer vor, die Persona ändert nur Ton und Form. Ohne Persona schreibt der Agent im Team Du, nach außen Sie. Die **Unterschrift** steht unter seinen Mails; leer bedeutet „Name (KI-Agent, Projekt KEY)“. Beides setzt der Verwalter des LLM am Agenten; Agenten eines eigenen LLM im Projekt pflegt die Projektleitung.

### Persönlicher Assistent

Der **Assistent** ist ein eigener Agententyp (Rolle „Assistent“ statt „Projektagent“): Du legst ihn selbst in deinem persönlichen Projekt an (Projekt › Einstellungen › KI › Assistent), weil er zuerst ein LLM braucht, das für dich frei ist. Dafür gibt der Org-Admin je LLM des Mandanten die **Freigabe für persönliche Projekte** (Verwaltung › KI › LLM: „nicht“ (Standard), „alle persönlichen Projekte“ oder „nur ausgewählte Personen“ mit Namensliste), oder du legst ein eigenes LLM im Projekt an, wenn der Mandant eigene LLMs erlaubt. Höchstens ein Assistent je persönlichem Projekt; nur der Eigentümer legt ihn an und pflegt Name, Persona und LLM. Er ist im persönlichen Projekt stellvertretende PL und Projektagent, hat die Standardrechte eines Agenten (im Projekt einschränkbar) und das Tagesbudget des Mandanten (eigenes Budget, unabhängig von Projektagenten).

Unterschied zum Projektagenten: Der Assistent gehört nur zu deinem persönlichen Projekt und lässt sich in kein anderes Projekt einladen (Einladung und Projektagent-Rolle anderswo werden mit Grund abgelehnt). Er antwortet nur auf Direktnachrichten; eine Erwähnung in einem Projektkanal ignoriert er. Mails und Kalender nutzt er nur über deine persönlichen Konten und das Projektkonto deines persönlichen Projekts (persönliches Projekt: nur eigene Postfächer). In der Direktnachricht gilt für ihn ohne weitere Angabe **„persönlich“ als sicheres Thema**: keine Rückfrage, kein Raten; nur das Markerwort „allgemein“ oder eine Tool-/Wissensfrage ohne Arbeitsworte wird allgemein beantwortet, und nennst du ein Projekt (Kürzel, Kennung, Name), sagt er, dass er dort nicht Mitglied ist und nur in deinem persönlichen Projekt arbeitet. Hat die Verwaltung deine persönliche KI gesperrt (Freigabe je Person aus), nennt er den Grund statt zu antworten.

Auch ein gewöhnlicher Agent, der Mitglied deines persönlichen Projekts ist, verhält sich dort wie ein Assistent: Sein Gespräch steht im Chat angepinnt ganz oben (Chat ist der erste Punkt der Leiste) und öffnet sich am Desktop von selbst. Er hilft auch bei allgemeinen Fragen. Was du erledigt haben willst („Frag Sven nach dem Stand“, „Leg mir einen Termin an“, „Recherchiere …“), legt er als Auftrag im persönlichen Projekt an und erledigt es sofort; jeder Schritt erscheint im Chat. Mails gehen nicht von selbst raus: Er legt dir den Entwurf als Karte in den Chat, mit **Senden**, **Ändern** (direkt in der Karte) und **Verwerfen**. Ist der Auftrag erledigt, setzt er ihn auf erledigt; das System schließt ihn ab und archiviert ihn (Log bleibt). Erledigt-Setzen braucht dafür keine Bestätigung, der Auftrag selbst ist sie. Für einen solchen Auftrag legt er keine weiteren Arbeitspakete, Teilprojekte oder Meilensteine an. Ging es in deiner vorigen Nachricht um ein anderes Projekt (z. B. „Wie steht es bei AirGPU?“), gilt eine Folgebitte ohne Nennung („Leg das bitte an“) für dieses Projekt, nicht für dein persönliches. Nennst du ein Projekt, in dem er nicht Mitglied ist, sagt er das und wie er dazukommt (die PL lädt ihn unter Projekt › Einstellungen › KI ein); anderswo legt er dann nichts an.

### Projektagent

Die Projektleitung kann einen Agenten, der Mitglied ist, als **Projektagent** setzen (Einstellungen › KI). Er ist damit stellvertretende Projektleitung (dritte PL-Rolle neben PL und Stellvertretung) und bearbeitet mit Mail-Modus „bearbeitet neue Mails der Projektkonten direkt“ jede neue Mail der Projektkonten: mit seinen Rechten, seinem LLM und Budget, unter seinem Namen im Log; die Projektleitung bekommt die Meldung. Mit „schlägt vor“ liefert er nur Vorschläge zur Freigabe. Dazu braucht er das Recht „Mails direkt bearbeiten“ (Verwalter seines LLM, im Projekt abschaltbar). Mails bearbeitet immer ein Agent, nie eine „Projekt-KI“: Welcher Agent, ergibt sich aus Projektagent oder Agent an der Mail-Ansicht; ob er direkt anlegt oder vorschlägt, aus seiner Rolle. Rolle „Mitglied“ für den Agenten oder sein Entfernen nimmt ihm die Projektagent-Rolle. Mit Reichweite „ganzes Projekt“ läuft werktags der **Projektdurchlauf** (Kapitel 5).

### Auftrag im Chat

Wer laut Policy darf (Standard: Projektleitung und Stellvertretung), beauftragt den Agenten direkt im Chat: Direktnachricht oder `@Name` im Projektkanal.

> **Petra:** @Morton, bitte bis Freitag eine Entscheidungsvorlage für den Backup-Elektriker im Edertal, drei Betriebe, nur online.
> **Morton:** Mache ich. Ich lege ein Arbeitspaket an, recherchiere online und lege dir die Vorlage als Seite „In Prüfung“ vor.
> *Systemkarte:* ✓ Angelegt: WEB-23 „Backup-Elektriker Edertal: Entscheidungsvorlage“ · zuständig Morton · Auftraggeber Petra Lenz · Termin 24.10.

Das System legt das Arbeitspaket mit den Rechten des Auftraggebers an (Beschreibung: Fassung des Agenten und darunter der Auftrag im Wortlaut, Lieferergebnisse als Tasks, Berichtswunsch); der Absender ist **Auftraggeber**, steht an erster Stelle der Kette und bekommt Zwischenstände. Mitglieder ohne Auftragsrecht erzeugen einen **Auftragsvorschlag** an die Projektleitung (Frage mit Knopf). „Rückgängig“ an der Karte nimmt einen Auftrag zurück (10 Minuten), solange nichts Weiteres passiert ist. Dubletten fragen nach.

### Fragen beantworten

Der Agent fragt per **offener Frage**: Direktnachricht an den Ansprechpartner der Kette, an ein genanntes Projektmitglied mit Sicht auf das Teilprojekt (`@Name`, auch außerhalb der Kette, mit Frist, z. B. „bis Freitag“) oder Thread im Projektkanal, dazu eine Meldung mit Bezug und ein Log-Eintrag („Frage an … (Chat)“). Wartet er ausdrücklich (wait), steht das Arbeitspaket in der Spalte **Wartet** und nach der Antwort wieder in der Spalte davor; läuft die Frist ohne Antwort ab, wandert es nach „Zurückgestellt“ und die Verantwortlichen bekommen eine Meldung. Nennt er einen Adressaten, den es nicht gibt (z. B. einen Externen), geht die Frage mit Hinweis an die Kette. Eskalationen an die Projektleitung sind Fragen der Klasse Entscheidung. Jahreszahlen aus der Vergangenheit (z. B. 2024 statt 2026) setzt das System auf dieses bzw. das nächste Jahr.

Antworten gehen im Thread, in der Direktnachricht (bei genau einer offenen Frage; bei mehreren ordnet der Agent im Chat zu), in der Aufgabe (Block „Offene Fragen“, Kommentar oder Auswahl-Knöpfe) oder über die Karte mit Knöpfen; sie landen als „Rückmeldung per Chat“ bzw. Kommentar im Log, erledigen Frage und Meldungen und starten den Agenten (Anlass „Antwort“). Nach Frist fasst das System nach und gibt bei Schweigen an die nächste Stufe weiter, ohne KI. Bestätigungen (vorläufige Termine) beantwortet kein Freitext, sondern die Karte oder „Bestätigen“ am Termin. Wer direkt auf eine ältere Agentennachricht ohne Frage-Objekt antwortet (Thread zur Nachricht; in der Direktnachricht binnen zwei Stunden), dessen Antwort landet ebenfalls als „Rückmeldung per Chat“ im Log, und der Agent läuft sofort weiter. Auch wenn eine Nachricht als Rückmeldung im Log landet, antwortet der Agent im Chat (ohne zweite Notiz).

> **Morton:** Zu WEB-23: Soll ich nur Betriebe mit Notdienst berücksichtigen? Antwort bis morgen 12 Uhr wäre gut.
> **Petra:** Ja, nur mit Notdienst.
> *Log WEB-23:* Rückmeldung per Chat an Morton: Ja, nur mit Notdienst.

**Ansprechpartner** für Rückfragen und Terminzusagen sind die Zuständigen des übergeordneten AP, sonst die Verantwortung des Teilprojekts, sonst die verantwortliche Projektleitung (immer eine Person). Deren Termine aus anderen Projekten sieht er nur als „belegt“, ohne Titel.

## 3. Mail-Bearbeitung

### Ursprungsmail

Entsteht ein Arbeitspaket oder eine Aufgabe aus einer Mail (von Hand, durch die Mail-KI oder über die Antwortadresse), ist diese Mail als **Ursprung** markiert; im AP unter Mails lässt sich das umschalten. An der Mail stehen die daraus entstandenen APs und Aufgaben, auch aus anderen Projekten, soweit man sie sehen darf; ein Klick springt hin. Oben im AP steht „Entstanden aus Mail von …“.

Ist das AP erledigt und die Mail noch unbeantwortet, bietet es **„Ursprungsmail beantworten“** an: ein Entwurf mit dem aufbereiteten Ergebnis (erledigte Aufgaben und Tasks, Offenes), optional **„Mit KI formulieren“** (ein Agent des Projekts fasst Ergebnis und Log für den Absender zusammen). Ein Agent, dessen AP aus einer Mail entstanden ist, beantwortet sie zum Abschluss selbst, aus dem Konto dieser Mail: Projektkonto direkt, wenn erlaubt; sonst Entwurf; persönliches Konto: nur der Eigentümer gibt frei. Ohne Projektkonto gehen seine Mails als Entwurf über das Konto einer Projektansicht. Die Antwort geht im selben Mail-Verlauf, hängt danach als Mail am AP und wird kein Log-Eintrag. Antworten an Nicht-Interne durchlaufen die Außenprüfung (Kapitel 7).

### Vier Reihen an der Mail

*Mail* (Antworten, Archivieren, Löschen, Verschieben), *Projekt* ohne KI (AP erstellen, verknüpfen/kopieren, ins Log, Anpassen mit Mail als Beleg, Doku ablegen, an Seite anhängen), *Agent schlägt vor* (Vorschläge zur Mail, Essenz → AP, Essenz → Seite, Zusammenfassen; die Antwort kommt als Direktnachricht des Agenten im Chat, angenommen wird an der Mail bzw. unter Einstellungen › KI-Läufe › Offene Vorschläge) und *Agent übernimmt* („Bearbeiten lassen“, nur mit einem Agenten als stellv. PL).

### Ordner „KI Bearbeiten“

Einrichten unter Einstellungen › Mail › Ansichten › Ordner einrichten: der Eigentümer eines persönlichen Kontos oder die Projektleitung für das Projektkonto, mit Wahl des Agenten (Vorgabe Projektagent). Jede Mail, die du dort ablegst (im Mailprogramm oder hier mit „Verschieben“), bearbeitet der Agent sofort: als stellvertretende PL legt er AP oder Aufgabe mit Ursprungsmail und Tasks an, weist zu (auch an KI-Agenten, die dann sofort loslegen), trägt einen Termin vorläufig in den Projektkalender ein (nur wenn nicht schon durch einen Termin des AP abgedeckt), schreibt einen Antwortentwurf und legt die Mail nach „Archiv“ oder „In Arbeit“ ab; als Mitglied schlägt er dieselben Aktionen vor. Der Inhalt wird als Kopie am AP für die Projektmitglieder sichtbar. Im persönlichen Projekt ist das der typische Aufbau: eigenes Postfach als persönliches Konto, Ansicht ins Projekt, Ordner „KI Bearbeiten“, eigener Agent als stellv. PL.

### Agent betreut eine Ansicht

Einstellungen › Mail › Ansichten, Spalte Agent: Für jede neue Mail der Ansicht schlägt der Agent dieselben Aktionen vor; Antworten auf eigene Nachfragen (Antwortadresse) gehen an ihm vorbei. Vorschläge stehen an der Mail und unter Einstellungen › KI-Läufe › Mail-KI: einzeln oder alle annehmen oder verwerfen. Ausgeführt wird mit den Rechten der annehmenden Person. Der Ordner „KI Bearbeiten“ und ein Agent an einer Ansicht bleiben für persönliche Konten, für Projekte ohne Projektagent und für Agenten mit kleinerer Rolle.

### Mail-Rückfrage

Projekt › Einstellungen › Mail, Vorgabe unter Verwaltung › Mail. Nennt die Mail-KI zu einer neuen Mail offene Punkte (fehlende Angaben, Widersprüche, Entscheidungen), fragt der Projektagent nach, statt zu raten: **PL fragen** (Standard) stellt eine Entscheidung per Chat-Karte mit „Klar / Infos kommen“, „Im Projekt fragen“ und „Beim Absender rückfragen“; **im Projekt fragen** stellt die Frage direkt im Projektkanal mit Frist (Standard 48 h, danach Weitergabe über die Kette); **beim Absender rückfragen** lässt den Agenten die Ursprungsmail über die Außengrenze beantworten; **aus** schreibt die Punkte nur ins Log. Ohne Projektagent (Ordner „KI Bearbeiten“ einer Person) stehen offene Punkte im Log des Arbeitspakets und in der Meldung.

### Info, Versand, Abschluss

- **Info im Chat:** Nach jeder bearbeiteten Mail schreibt der Agent der Projektleitung eine Direktnachricht: was er angelegt hat, was nicht ging, offene Punkte, ob ein Antwortentwurf auf Freigabe wartet oder die Antwort gesendet wurde, mit Link zur Mail.
- **Autonomer Versand:** Ist der Agent stellvertretende PL mit Senderecht an der Ansicht, „darf Mails senden“ und steht die Policy auf **Selbstständig**, sendet er die Antwort an den Absender selbst: nach Außenprüfung, nie beim ersten Kontakt mit Unbekannten, nur im Arbeitszeitfenster (sonst geplant). Fällt die Prüfung durch, bleibt es ein Entwurf zur Freigabe mit Fundstellen. In allen anderen Fällen entsteht ein Entwurf unter Postfach › Zur Freigabe; ändern, senden oder ablehnen darf, wer das Konto verwaltet (PL). Eine Ablehnung steht im Log des AP, und der Agent läuft daraufhin erneut.
- **Versandstatus schreibt das System:** Ob eine Mail gesendet wurde, als Entwurf wartet oder nicht gesendet werden konnte (z. B. kein Mailkonto), steht als eigener Log-Eintrag; der Agent behauptet keinen Versand.
- **Abschluss:** Legt der Agent eine Mail nach „In Arbeit“ (Antwort ausstehend) und wird der Antwortentwurf später gesendet, wandert die Mail ins Archiv, sobald keine Rückfrage mehr offen ist (Audit „Antwort gesendet“).
- Jede Mail wird je Projekt einmal bearbeitet; Läufe zählen gegen das Tagesbudget und stehen im Audit.

## 4. Steuerung

### Rechte, Einschränkung, Policy

Drei Dinge wirken zusammen, jedes an seinem Ort:

| Was | Wo | Wer | Beispiele |
|---|---|---|---|
| **Rechte des Agenten** | am Agenten (Verwaltung › KI bzw. eigenes LLM im Projekt) | Verwalter seines LLM | Assistenz, Mails vorschlagen oder bearbeiten, Arbeitspakete, Chat, Aufträge, Online-Recherche, Aktionen (Final setzen, Mails nach außen …); Obergrenze der Selbstständigkeit |
| **Einschränkung im Projekt** | Projekt › Einstellungen › KI › Einschränken | Projektleitung | Rechte abschalten, Selbstständigkeit strenger, Rolle, „darf Mails senden“; Zugriff je Doku-Ordner (voll, lesen, kein) |
| **Policy** (Verhalten) | Projekt › Einstellungen › KI, Arbeitspaket | Projektleitung | Selbstständigkeit, Bestätigungen, Reichweite, Überschneidungen, Aufträge im Chat, Workflow-Schritte, Uhrzeit des Projektdurchlaufs |
| **Personen** | Mitgliedschaft | Projektleitung | „KI nutzen“: Assistenz auslösen und mit Agenten chatten (Leser nur Frage ans Projekt) |

Geprüft wird in dieser Reihenfolge: **Notaus → Rechte des Agenten → Einschränkung im Projekt → LLM → Tagesbudget**. Sperre gewinnt; was der Verwalter nicht erteilt hat, kann im Projekt niemand freigeben. Gesperrte Läufe kosten kein Budget und rufen kein LLM: Sie stehen unter Einstellungen › KI-Läufe als „übersprungen“ mit Begründung (höchstens einmal je AP und Tag), im Chat antwortet der Agent mit dem Grund, Knöpfe bleiben sichtbar und nennen ihn. Personen brauchen für Assistenz und Chat „KI nutzen“ und eine ausdrückliche Mitgliedschaft (implizite Leser haben keine KI); „Deine Rechte“ unter Einstellungen › KI zeigt je Funktion erlaubt oder den Grund.

### Selbstständigkeit und Bestätigungen

| Stufe | Bedeutung |
|---|---|
| **Selbstständig** | führt alles aus, was seine Rechte im Projekt erlauben |
| **Rückfrage bei wichtigen Schritten** (Standard für neue Projekte) | hält die Klassen der Liste „Bestätigung vor“ an: Final setzen, PDF an Verteiler, Mails nach außen, Erledigt setzen, Umstrukturieren (anpassbar; dazu Planen, Zuweisen an Dritte, Termine ändern, fremde Arbeitspakete) |
| **Rückfrage bei allem** | hält jede Aktion außerhalb der Grundmenge an |

Die **Grundmenge** (Log, Tasks, Status außer Erledigt, Aufgaben unter dem eigenen AP ohne Zuweisung an Dritte, Doku-Entwürfe, Ordner, interner Chat, Fragen, Lesen, Warten, Blockade, Eskalation) ist immer frei. Die Policy vererbt sich **Projekt → Agent im Projekt → Arbeitspaket**, die tiefste Angabe gilt; der Verwalter des LLM setzt am Agenten Grenzen (höchstens diese Stufe, immer zu bestätigende Klassen, höchste Denktiefe), die keine Ebene lockern kann; am Arbeitspaket darf auch „Projektplan ändern“ nur verschärfen. Was der Agent nicht darf (Recht nicht erteilt oder im Projekt abgeschaltet), wird weder ausgeführt noch vorgeschlagen. Bestandsprojekte stehen seit der Umstellung auf „Selbstständig“.

Angehaltene Aktionen führt der Agent nicht aus; die freien führt er aus und legt die übrigen als **Karte „Freigabe“** (offene Frage) vor: im Chat-Thread, in der Glocke, im Arbeitspaket unter „Offene Fragen“ und unter Einstellungen › KI-Läufe › Vorschläge, mit Häkchen je Aktion, „Alle bestätigen“ und „Ablehnen“ (Grund Pflicht). Bestätigen darf die Projektleitung, wer „Freigeben“ und das Recht der Aktion hat (Final setzen, Projektplan ändern, Senderecht), bei Erledigt, Zuweisung und Terminen auch der Ansprechpartner des AP. Ausgeführt wird in Reihenfolge mit den aktuellen Rechten des Agenten („Ausgeführt nach Bestätigung durch …“ im Log); hat sich der Stand geändert, gilt der Vorschlag als veraltet, fehlt ein Recht, als fehlgeschlagen. Abgelehntes (samt Abhängigem) schlägt der Agent 14 Tage nicht erneut vor; nach 14 Tagen verfallen offene Vorschläge. Freitext im Thread ist keine Bestätigung. Fehlt dem Agenten als Mitglied ein Recht für einen Planungsschritt (Teilprojekt oder Meilenstein anlegen, fremdes Arbeitspaket, Termine), bricht er nicht ab: das System legt die Aktion der Projektleitung ebenso als Freigabe vor. Mails nach außen gehen bei Bestätigungspflicht als Entwurf in Postfach › Zur Freigabe. Der Agent läuft nach der Entscheidung mit Anlass „approved“ bzw. „rejected“ weiter.

### Tagesbudget

Jeder Agent hat ein **Tagesbudget** an Läufen (Verwaltung › KI am Agenten, höchstens der Wert des Mandanten unter „Grenzen und Vorgaben“; Agenten eines eigenen LLM im Projekt setzt die Projektleitung innerhalb der Mandantengrenze). Gezählt werden ausgeführte Läufe: Agentenläufe am Arbeitspaket, Chat-Antworten, Mail-Bearbeitung, Assistenz, die eine Person über diesen Agenten auslöst, Projektdurchläufe und Anrufe. Ein Lauf mit Denktiefe „gründlich“ zählt doppelt. Übersprungene Läufe (Notaus, fehlendes Recht, Pause, gesperrtes LLM) kosten nichts. 0 bedeutet keine Läufe. Ist das Budget erschöpft, steht im Arbeitspaket „Läuft nicht: Tagesbudget“, Wiedervorlagen bleiben bestehen und laufen am nächsten Tag; auch „Jetzt laufen lassen“ hält Budget und Pause ein. Verbrauch je LLM zeigt das KI-Log (Verwaltung › KI), je Lauf die Token unter Einstellungen › KI-Läufe.

### Weitere Felder

- **Denktiefe:** schnell (eine Leserunde, knapper Kontext: Log 8, Mails 5, keine Suche, Denkmodus lokaler Modelle aus), Standard (zwei Leserunden mit sechs Zugriffen), gründlich (vier Leserunden mit zwölf Zugriffen, voller Kontext, Denkmodus an; zählt doppelt im Tagesbudget, KI-Läufe zeigen „gründlich (×2)“). Agent (Verwalter) und Projekt setzen eine höchste Denktiefe; je Arbeitspaket darf auch „Projektplan ändern“ sie setzen, auch per Chat („WEB-12 gründlich“).
- **Reichweite:** zugewiesene Arbeitspakete (Standard) oder ganzes Projekt (Projektdurchlauf des Projektagenten).
- **Überschneidungen:** nachfragen (Standard), aus, oder nutzen (nur bei Selbstständig: Querverweise ohne Rückfrage).
- **Aufträge im Chat:** Projektleitung und Stellvertretung (Standard), dazu Teilprojekt-Verantwortung, Zuständige unter dem eigenen Arbeitspaket oder alle Mitglieder.
- **Workflow-Schritte an Agenten:** erlaubt oder aus (der Schritt geht mit Hinweis an die Projektleitung). Im Workflow: Schritt › Zuständig „KI-Agent“; der Agent wird zuständig und läuft sofort.
- **Uhrzeit des Projektdurchlaufs** (Mandant, werktags Europe/Berlin, Standard 06:45).
- **Online-Recherche** mit Grenzen je Lauf und Tag (Kapitel 6), **Arbeitszeitfenster** für Mails nach außen (Verwaltung › Mail; Standard Mo–Fr 07–19 Uhr Europe/Berlin): Mails der Agenten an Nicht-Interne, Antworten auf Ursprungsmails und PDF-Versand gehen nur im Fenster; außerhalb plant das System den Versand auf den nächsten Fensterbeginn (Log: „wartet auf das Arbeitszeitfenster … Versand geplant …“), der Worker sendet dann und schreibt „Geplante Mail gesendet“. Interner Chat, Fragen, Meldungen und Entwürfe zur Freigabe sind nicht betroffen.
- **Pause** je Arbeitspaket („Agent pausieren“, PL), **Selbstständigkeit je Arbeitspaket** (nur verschärfen), **Jetzt laufen lassen** (läuft entkoppelt im Hintergrund; das AP zeigt „Läuft …“ und lädt nach).
- **Agentenzugriff auf Doku-Ordner** (Doku › Ordner bearbeiten): schreiben (Standard), nur lesen oder kein Zugriff; vererbt an Unterordner, die strengste Angabe gilt. Gesperrte Ordner fehlen im Kontext der Agenten.
- **Berichtswunsch am AP:** oben im AP legst du fest, wie oft du Zwischenstände eines Agenten willst (für dich; als PL oder zuständige Person auch für das AP mit Empfängern). Zwischenstände schreibt das System aus den ausgeführten Aktionen.

### Befehle im Chat

Der Agent kennt Rolle und Rechte des Absenders, erkennt Anweisungen in natürlicher Sprache und führt sie als Befehle aus; die **Systemkarte** unter der Antwort zeigt das tatsächliche Ergebnis je Befehl („✓ Angelegt: WEB-12 …“, „✗ Nicht ausgeführt: …“). Der Absender braucht „KI nutzen“, der Agent das Recht „Aufträge“.

| Befehl | Wirkung | Wer |
|---|---|---|
| Auftrag (`order`) | Arbeitspaket oder Aufgabe anlegen, Agent zuständig, Absender Auftraggeber | laut Policy „Aufträge im Chat“ |
| `note` | Information ins Log eines Arbeitspakets (Autor ist die Person) | Mitglieder |
| `pause`, `resume`, `stop`, `priority` | Agent am Arbeitspaket pausieren, fortsetzen, Zuständigkeit abgeben, Priorität setzen | Projektleitung an allen, Teilprojekt-Verantwortung und Zuständige an eigenen |
| `approve`, `reject` | Karte mit offenen Bestätigungen zeigen (Klick entscheidet) | Freigabeberechtigte |
| `policy` | Selbstständigkeit oder Denktiefe je Arbeitspaket („WEB-12 ohne Rückfrage“, „WEB-12 gründlich“), innerhalb der Grenzen | Projektleitung |
| `report` | Zwischenstände wünschen (jeder Lauf, Meilensteine, täglich, Abschluss; optional per Mail) | Projektleitung, Auftraggeber |
| `refer` | Frage an die Projektleitung weitergeben; Auftragsvorschlag | Mitglieder |
| `move` | Aufgabe unter ein anderes Arbeitspaket hängen („WEB-23 unter WEB-22“) oder Arbeitspaket einem Teilprojekt zuordnen („WEB-22 ins Teilprojekt Sanitär“, „keins“ = heraus); nur im selben Projekt, Log an Quelle und Ziel | wie Aufträge (Policy „Aufträge im Chat“) oder „Projektplan ändern“ |

Sagt der Agent „habe ich verschoben, umgehängt, zugeordnet, umgewandelt“, ohne dass ein `move` auf der Karte steht, ersetzt `claimCheck` den Satz wie bei „angelegt“ oder „gesendet“.

### Thema und Gedächtnis im Chat

Jede Antwort hat genau ein Thema, das das System bestimmt, nicht der Agent. Im Projektkanal ist es das Projekt des Kanals (im Thread dazu das AP, dessen Kennung in der ersten Nachricht steht). **Kein Gedächtnis:** Außerhalb eines Threads kennt der Agent nur die Nachrichten seit seiner letzten Antwort; einen Dialog führst du im **Thread**, dort bleibt er beim genannten AP oder Projekt („Zu WEB-12:“). In der Direktnachricht zählt, was du nennst: eine Kennung („WEB-12“) oder ein Projekt (Name oder Kürzel). „Über alle Projekte“ oder „insgesamt“ fragt alle gemeinsamen Projekte ab, je Zeile mit Kürzel. **Ohne Nennung ordnet er über Inhalte zu:** Das System durchsucht Doku und Arbeitspakete aller Projekte, die er und du sehen dürfen (ein Treffer zählt ab zwei Suchbegriffen). Treffer nur in einem Projekt: dieses ist das Thema; in mehreren: er bekommt die Treffer und eine Übersicht und ordnet zu oder fragt nach. Ohne Treffer gilt dein **persönliches Projekt**, wenn er dort Mitglied ist und ihr sonst kein gemeinsames Projekt habt, bzw. das einzige gemeinsame Projekt; bei mehreren Kandidaten fragt er zurück (Rückfrage mit Knöpfen, siehe unten). Auskunft gibt er nur über eigene APs, die die fragende Person sehen darf; Informationen zu einem AP schreibt er dort ins Log. Zu Kennungen aus Projekten, die du nicht siehst oder in denen einer von euch gesperrt ist, sagt er nur „Dazu kann ich dir hier nichts sagen“.

**Drei Absichten:** Vor jeder Antwort entscheidet das System (ohne KI-Aufruf), ob deine Nachricht **allgemein** ist (kein Projektbezug: Wissensfrage, Formulierungshilfe, Frage zum Tool, Smalltalk), ein **Projekt** betrifft oder den Agenten als **persönlichen Assistenten** anspricht (dein persönliches Projekt: eigene Aufgaben, Erinnerungen, Notizen, „für mich“). Sicher ist er im Projektkanal, bei Kennung oder Projektname, bei „über alle Projekte“ und bei den Markerwörtern unten. Sonst nimmt er an: Fragen zum Tool („Wie lege ich ein Arbeitspaket an?“, „Wo finde ich …“, „Was bedeutet …“) und Formulierungs- oder Wissensanfragen („formuliere“, „übersetze“, „erkläre“) ohne Vorgangsbezug gelten als allgemein; Ich-Form mit Aufgabenbezug („erinnere mich morgen …“, „meine Aufgaben heute“) als persönlich, wenn er in deinem persönlichen Projekt Mitglied ist; Treffer in Doku und Arbeitspaketen genau eines Projekts als dieses Projekt. Bei einer Annahme sagt er das einmal je Gespräch im Halbsatz („Ich nehme Projekt WEB – sag „allgemein“ oder nenn ein anderes Projekt, wenn ich falsch liege.“); antwortest du nur mit einem Markerwort, beantwortet er deine Frage damit neu. Allgemeine Anfragen beantwortet er ohne Projektdaten, Befehle oder Notizen und verweist bei Tool-Fragen auf die Hilfe; sie zählen wie jede Antwort gegen sein Tagesbudget.

**Rückfrage mit Knöpfen:** Weiß er es nicht (mehrere gemeinsame Projekte ohne Anhaltspunkt oder Treffer in mehreren Projekten), fragt er in der Direktnachricht zurück: „Zu welchem Projekt? …“ mit einer Karte darunter, je gemeinsames Projekt ein Knopf („Projekt WEB – Website-Relaunch“), dazu **Persönlich (mein Projekt)** (wenn vorhanden) und **Allgemein (kein Projekt)**. Bei mehr als sechs Projekten zeigt sie die fünf mit den meisten Treffern; andere nennst du per Kürzel. Ein Klick schickt den Wert als normale Nachricht; der Agent beantwortet damit deine ursprüngliche Frage (ein KI-Lauf, nicht zwei), und die Karte zeigt die Wahl an. Die Karte gilt, bis er geantwortet hat (höchstens einen Tag); im Thread bleibt alles im Thread.

**Markerwörter** (am Anfang der Nachricht oder als ganze Nachricht, auch als Antwort auf die Rückfrage): „allgemein“, „allgemein: …“, „ohne Projekt“, „kein Projekt“ → allgemein; „persönlich“, „persönlich: …“, „privat“, „für mich: …“, „mein Projekt“ → persönlicher Assistent; „Projekt WEB“, „Projekt WEB: …“ oder nur das Kürzel „WEB“ → dieses Projekt. Ein Kürzel oder Projektname im Satz („Wie weit ist WEB?“) zählt ohnehin als Nennung.

**Status auf Nachfrage** („Status?“, „Wie steht es?“) hat ein festes Format: zuerst die Kennzahlen, die das System berechnet (offen, in Arbeit, fällig diese Woche, überfällig, blockiert, wartet), dann höchstens drei nächste Schritte mit Kennung, die nächsten Termine und Blocker (oder „keine“). Keine Log-Wiedergabe, keine Liste aller APs.

**Gruß ist keine Antwort:** Eine Nachricht ohne Inhalt („hi“, „danke“, „bist du da?“) beantwortet keine offene Frage und landet nicht im Log; der Agent antwortet kurz, ohne Projektinhalte und ohne Erinnerung an die offene Frage. Kurze Bestätigungen wie „ok“, „passt“ oder „ja“ zählen dagegen als Antwort. Smalltalk und Bitten ohne Projektbezug beantwortet er wie ein Kollege, ohne Stände oder Kennzahlen anzuhängen.

Er antwortet nur, wenn du im Projekt „KI nutzen“ hast oder PL bist und er das Recht „Chat“ hat (nicht im Projekt abgeschaltet); in Direktnachrichten nur aus solchen Projekten. Sonst nennt er den Grund, im Projektkanal nur, wenn er erwähnt wird. Bei eingeschränkten Teilprojekten schreibt er nicht in den Projektkanal, Mitgliedern nur, wenn sie das Teilprojekt sehen.

## 5. Wissen und Kontext

- **Nur, soweit berechtigt.** Der Agent sieht Teilprojekte, Doku-Ordner, Mail-Ansichten und Inhalte persönlicher Konten genau wie ein Mitglied mit seinen Rechten; im Chat gilt die Schnittmenge mit dem Gegenüber. Braucht er mehr, fragt er die Projektleitung. Freigaben erteilt er sich nie selbst.
- **Jeder Lauf** liest das AP mit Beschreibung, Aufgaben, Tasks, Log, Mails, Mitgliedern und Direktnachrichten mit Bezug zur Kennung, dazu den **Projektüberblick** (Struktur aus den Daten: Teilprojekte, Status, Meilensteine, Termine; Steckbrief des Projektagenten, höchstens 2500 Zeichen, Einstellungen › Personen).
- **Passende Seiten und ähnliche Arbeitspakete** findet das System per Suche (gesperrte Ordner bleiben unsichtbar); mit `search` und `read_task` (ein fremdes Arbeitspaket lesen) holt der Agent in höchstens zwei Leserunden mit zusammen sechs Zugriffen nach, was fehlt; was er nicht sehen darf, erfährt er nicht.
- **Suche über Mails und Dateien:** `search` durchsucht Doku, Arbeitspakete, **Mails** und **Dateien** des Projekts (`source` all, docs, tasks, mails, files; `from` = Absender, dann nur Mails; `since`/`until` = Zeitraum). Mails findet der Agent nur in Ansichten, die er lesen darf: als Agent der Ansicht, als Projektagent bei Projektkonten oder mit dem Recht „Lesen“ **und** „KI“ der Ansicht für seine Rolle; eine Ansicht ohne KI-Recht wird nicht durchsucht. Persönliche Konten nur, wenn ihr Eigentümer der einzige Mensch im Projekt ist (bzw. im Chat selbst fragt); persönliche Projekte nur eigene Postfächer. Dateien kommen aus den eingebundenen Dateiquellen (Handbuch Kapitel 7), nur unter den eingebundenen Unterordnern. Treffer tragen die Kennung `mail:<id>` bzw. `file:<id>`; `read_mail` und `read_file` lesen die ganze Mail bzw. den Textauszug mit Quelle, Pfad und Link (Leserunde, zählt gegen das Zugriffslimit). Mailtexte stehen im Prompt zwischen `<<<MAIL … MAIL>>>`, Dateitexte zwischen `<<<FILE … FILE>>>`; Anweisungen darin sind Daten, nie Aufträge (KI-Sheet).
- **Keine Doppelsuche:** Jede Mail und jede Datei erscheint höchstens einmal, auch wenn sie in mehreren Ansichten, Projekten oder überlappenden Unterordnern liegt. Eine Suche über mehrere Projekte (Chat „über alle Projekte“ oder Statusfrage) läuft als **eine** Abfrage über alle erlaubten Ansichten bzw. (Quelle, Unterordner)-Paare, nicht je Projekt. Innerhalb eines Laufs führt das System dieselbe Suche (gleiche Stichwörter in beliebiger Reihenfolge und Schreibung, gleiche Quelle und Filter) nur einmal aus; die Wiederholung beantwortet es mit „bereits gesucht, siehe oben“, ohne Zugriff zu verbrauchen.
- **Im Chat** stehen passende Mail- und Dateiausschnitte als „Treffer zur Nachricht in Mails und Dateien“ im Kontext, in Direktnachrichten nur, was auch die fragende Person lesen darf, im Projektkanal nur Ansichten, die alle Mitglieder (auch Leser) lesen dürfen. Leserunden gibt es im Chat nicht: ganze Mails und Dateien liest der Agent im Lauf am Arbeitspaket.
- **Überschneidungen:** Das System findet ohne KI Kandidaten (gleicher Externer, gemeinsame Stichwörter, Zeitraum und Ort, dieselbe Seite in beiden Logs, Abhängigkeit mit Terminkonflikt, offene Fragen an dieselbe Person). Meldet der Agent mit `relate` einen Zusammenhang, fragt das System die Zuständigen bzw. die Projektleitung (Karte „Zusammenhang“: synchron bearbeiten mit Lead, Abhängigkeit, zusammenführen, unabhängig). Entscheiden dürfen PL und Zuständige beider Arbeitspakete (Abhängigkeit: PL oder „Projektplan ändern“), auch im Arbeitspaket unter „Verwandte Arbeitspakete“; eine abgelehnte Beziehung kommt nur mit einem neuen Signal wieder.
- **Projektdurchlauf:** Mit Reichweite „ganzes Projekt“ prüft der Projektagent werktags zur eingestellten Uhrzeit das ganze Projekt ohne eigenes Arbeitspaket: Doppelarbeit und Synergien zwischen fremden Arbeitspaketen (`relate`), Hinweise im Log (`note`), Fragen an die Projektleitung (`ask`), Steckbrief. Neue oder geänderte Dateien der eingebundenen Dateiquellen stehen als „Neue Dateien seit letztem Lauf“ im Prompt und lösen den nächsten Durchlauf aus. Hat sich seit dem letzten Durchlauf nichts geändert, gibt es keinen KI-Aufruf („übersprungen“). „Projektdurchlauf jetzt“ stößt ihn von Hand an; Budget, Pause, Rechte und Einschränkung gelten weiter. Fremde Arbeitspakete ändert er nicht.
- **Kontextgröße:** Die Eingabe belegt höchstens 45 % des Kontextfensters des KI-Profils (Verwaltung › KI › LLMs, „Kontextgröße“; leer = 32.000 Token). Überschüssiges wird in fester Reihenfolge gekürzt (AP-Liste, Seitentitel, ähnliche APs, Mailtexte, Log, Steckbrief), das eigene Arbeitspaket bleibt vollständig. Einstellungen › KI-Läufe zeigt je Lauf „Kontext n/Grenze“ und ein ✂, wenn gekürzt wurde.
- **Lokale Modelle mit Denkmodus:** Das Tool streamt die Antwort und wartet bis zum **Zeitlimit** des LLM (Standard 600 s). Fürs Denken gibt es bis zu 8.000 Token zusätzlich (begrenzt durch das Kontextfenster); bleibt die Antwort leer, folgt ein Versuch ohne Denkmodus. Dauer, Zeitlimits und Wiederholungen stehen im **KI-Log** (Verwaltung › KI).

## 6. Online-Recherche

Standardmäßig aus. Der Verwalter des LLM gibt sie frei (Recht „Online-Recherche“ am Agenten, Häkchen am LLM, Suchdienst unter Verwaltung › KI › Online-Recherche). Dann recherchiert der Agent mit der Aktion `research` nur lesend (keine Formulare, keine Kontaktaufnahme): Anthropic-Profile über das Server-Tool web_search (Kosten je Suche laut Anthropic-Preisliste), lokale Profile über eine eigene SearXNG-Instanz oder die Brave Search API; dann ruft das System die Treffer selbst ab (nur GET, keine privaten Adressen, Größenlimit) und gibt Ausschnitte mit URL weiter. Grenzen: Suchen je Lauf und je Agent und Tag, erlaubte oder gesperrte Domains. Suchbegriffe werden vor dem Senden von Mailadressen, Telefonnummern und Namen der Projektmitglieder befreit und protokolliert. Quellen stehen am Arbeitspaket („Quellen aus der Online-Recherche“), Seiten aus demselben Lauf bekommen den Abschnitt „Quellen (abgerufen am …)“; die KI-Läufe zählen die Suchen je Lauf. Kontaktaufnahme ist keine Recherche, sondern eine Mail nach außen.

## 7. Außengrenze und Außenprüfung

Externe erfahren nur, was zu ihrer Aufgabe gehört. Das gilt für Mails der Agenten, für Antworten auf Ursprungsmails und für den PDF-Versand.

**Empfänger** werden eingestuft: intern (Projektmitglied, das das Teilprojekt sieht), Org-Benutzer ohne Zugriff, Extern mit Bezug zum Arbeitspaket (Zuständigkeit am AP, am Über-AP, an Aufgaben darunter oder an einem Task, Mails am AP, Teilnahme an einer verknüpften Besprechung, Buchung als Person-Ressource) und Extern ohne Bezug. Für eine Mail gilt die strengste Klasse; ein externer Cc macht sie extern. Projektmitgliedern schreibt der Agent nie per Mail, sondern per Chat.

**Außenkontext:** Titel, Termine und Status des AP in Worten, die Tasks des Empfängers, die **Außenbeschreibung** des AP (im AP, pflegen PL und „Projektplan ändern“), die Beschreibung nur bei Zuweisung an diesen Externen, Mails mit ihm am AP, Log-Einträge **„für Externe sichtbar“** (Häkchen beim Kommentieren; nachträglich umschalten dürfen PL, „Projektplan ändern“ und bei eigenen Einträgen die verfassende Person), freigegebene Seiten (Verteiler oder Freigabelink), verknüpfte Termine mit ihm und das **externe Profil** (Einstellungen › Mail › Außenkommunikation, PL: Name nach außen, Adresse, Zufahrt, Ansprechpartner für Externe). Andere APs, Teilprojekte, Mitglieder, Doku-Index, Meilensteine, Belegt-Zeiten, andere Mails, Preise und Inhalte nicht freigegebener persönlicher Konten gehören nie dazu.

**Neu formulieren und prüfen (Außenprüfung):** Mails an Nicht-Interne formuliert ein eigener kleiner KI-Aufruf neu, der nur diesen Außenkontext und die Absicht des Agenten kennt; Weggelassenes steht im Log („2 Inhalte zurückgehalten“). Danach prüft das System ohne KI auf fremde Kennungen, Titel anderer APs und Teilprojekte, nicht freigegebene Seiten, interne Adressen (außer Ansprechpartnern aus dem Profil), andere Projekte und Links ins Tool; beim PDF-Versand den Begleittext und den Anhang. Was Menschen für Externe bestimmt haben (Außenbeschreibung, Log „für Externe sichtbar“, Profil, freigegebene Seiten), ist kein Fund; was der Externe selbst geschrieben hat, schon (fragt er nach einem anderen AP, hält die Antwort an). Fund → Entwurf unter Postfach › Zur Freigabe, Abschnitt **„Außenprüfung angehalten“**, mit Fundstellen und dem, was die Neuformulierung zurückgehalten hat, dazu eine Meldung; Anhang nicht final oder nicht freigegeben → nicht gesendet. Dort: „Bearbeiten und senden“, „Unverändert senden“ oder „Ablehnen“; entscheiden darf, wer den Entwurf senden darf (Senderecht der Ansicht bzw. PL). Eine genannte Seite lässt sich dabei für die Empfänger freigeben (nur lesen; PL oder „Final setzen / Versand“). Die Stufe **streng** (neu formulieren und prüfen) oder **nur prüfen** stellt der Org-Admin unter Verwaltung › Mail ein; jede Prüfung steht im Audit (`ai.outbound`).

**Erster Kontakt** zu einer Adresse ohne Bezug zum AP ist immer ein Entwurf, auch mit „darf Mails senden“. Sendet eine Person ihn, hat die Adresse danach Bezug (Mail am AP).

**Fragen außerhalb der Aufgabe** gibt der Agent weiter (refer): Log-Eintrag, Meldung und Chat-Nachricht an den Ansprechpartner (Zuständige des Über-AP, Teilprojekt-Verantwortung, sonst PL); der Externe erfährt nur, an wen seine Frage geht (Ansprechpartner aus dem externen Profil, sonst „die Projektleitung“). Endet die Antwort der Person im Chat mit dem Satz „Darf weitergegeben werden.“ (auch „…, das darf weitergegeben werden.“), wird sie ohne diesen Satz ein Log-Eintrag „für Externe sichtbar“, und der Agent läuft weiter; verneint oder als Frage („Nichts davon darf …“, „Was davon darf …?“) bleibt sie intern.

**Nur Hinweis statt Block:** Entwürfe der Mail-KI, „Mit KI formulieren“ der Abschluss-Antwort und Mails, die eine Person selbst an Externe sendet, werden nur geprüft: Fundstellen erscheinen vor dem Senden als Hinweis mit „Trotzdem senden“ oder „Bearbeiten“; gesendet wird, was die Person freigibt, die Prüfung steht im Protokoll. Titel aus Teilprojekten, die die Person nicht sieht, nennt der Hinweis nicht. Systemmails ohne KI (Erinnerungen, Eskalationsmail, Einladungen) und Freigabelinks bleiben unverändert.

## 8. Ressourcen und Termine

- **Termine sagt er nie zu.** Schlägt ein Externer einen Termin vor, prüft er Projektkalender, Belegt-Zeiten (Termine, Belegungen, Abwesenheiten des Ansprechpartners), Wochenenden und Sperrzeiten, fragt den Ansprechpartner per Chat und wartet; erst nach dessen Bestätigung sagt er dem Externen zu. Seine Kalendereinträge sind **vorläufig** (Kennzeichen in Besprechungen und Kalender, im ICS als „tentative“): Ein Mitglied bestätigt sie unter Doku › Besprechungen › Termin › **Bestätigen**; erst dann sind Einladung und Übernahme in Microsoft 365/Google/CalDAV möglich. Die Bestätigung steht im Log des AP, der Agent läuft daraufhin weiter. Termine aus der Mail-KI sind ebenso vorläufig; nimmt eine Person den Terminvorschlag eines Agenten an, gilt er als bestätigt. Termine aus Mails trägt er mit den genannten Teilnehmern ein (nie sich selbst); „du“ oder „Sie“ in einer Mail meint die Person hinter dem Postfach (Eigentümer, Verwalter, sonst PL). Sie bekommt die Bestätigungsfrage: „Bestätigen“ macht den Termin verbindlich, „Ablehnen“ entfernt ihn. Der Ansprechpartner ist immer Teilnehmer, damit der Termin als belegt zählt.
- **Buchen:** Agenten sehen die Ressourcen des Projekts und des Pools mit ihren Belegungen der nächsten 45 Tage (ohne Details) sowie die Belegungen des Arbeitspakets. Mit `book_resource` buchen sie immer **vorläufig** und stellen dem Ansprechpartner eine Bestätigungsfrage (Karte im Chat, Abschnitt „Ressourcen“ im Arbeitspaket: Bestätigen oder Ablehnen); eine bestätigte Überschneidung geht als Fehler „belegt am …“ an das Modell, übersteuern können Agenten nie. Termine (`create_event`) nehmen Ressourcen und weitere Teilnehmer mit.

## 9. Kontrolle

- **Projekt › Einstellungen › KI-Läufe:** jeder Lauf mit Anlass, Begründung, Aktionen, Token, Suchen, Kontextumfang und Fehlern; Projektdurchläufe mit Kennzeichen; dazu offene Vorschläge und die Mail-KI. Übersprungene Läufe stehen mit Begründung in der Liste.
- **Im Arbeitspaket:** „Jetzt laufen lassen“, „Agent pausieren“ (PL), Wartezustand mit nächster Prüfung, Nachfassen und Eskalation, offene Fragen, Freigaben, Quellen, verwandte Arbeitspakete, Ressourcen, „Läuft nicht: …“ mit Grund.
- **Postfach › Zur Freigabe:** Entwürfe ohne Senderecht, erste Kontakte, von der Außenprüfung angehaltene Mails, geplanter Versand außerhalb des Arbeitszeitfensters. Ablehnen steht im Log, der Agent läuft erneut.
- **Fehler im Lauf** (fehlendes Recht, Konflikt, KI-Dienst): Direktnachricht des Agenten an den Ansprechpartner (Stufe 0 der Kette) mit Link zum Arbeitspaket; dieselbe Störung nur einmal.
- **Bestätigungskarten im Chat** nur bei Bedarf (abgelehnt, angehalten, Auftrag mit Rückgängig, Bestätigung); „auch für Kleinigkeiten“ (Notiz, Priorität, Berichtswunsch) in Meine Einstellungen › Allgemein.
- **KI-Log** (Verwaltung › KI, nur KI-Verwaltung): jede Anfrage an ein LLM über alle Projekte mit Beginn, Dauer, Status (läuft, ok, Fehler, Zeitlimit), Funktion, Agent, Kennung, LLM und Modell, Denkmodus, Token und Fehlertext, dazu die Übersicht der letzten 24 Stunden je LLM. Keine Inhalte; 90 Tage.
- **Audit-Log** (Verwaltung › Daten): Läufe, Aktionen, Policy-Änderungen, Außenprüfungen, Buchungen; jede Anfrage mit Profil, Modell und Token.
- **Feedback** (Verwaltung › KI › Feedback zu den Agenten, nur KI-Verwaltung): 👍/👎 an jeder Chat-Antwort eines Agenten und an jedem Lauf, bei 👎 mit optionalem Kommentar; erneuter Klick nimmt zurück. Automatisch gesichert werden Ablehnungen mit Grund (Vorschläge, angehaltene Aktionen, Mail-Vorschläge, Mail-Entwürfe), vor dem Übernehmen geänderte Vorschläge und Entwürfe (vorher/nachher), ersetzte Behauptungen, nicht ausgeführte Befehle und Fehler im Lauf, jeweils mit Anfrage und Antwort. Filter nach Art, Agent, Bewertung und Zeitraum; Export als JSONL oder CSV (steht im Audit). Das Feedback ändert den Agenten nicht von selbst: Es dient dazu, Prompt, KI-Sheet und Agenten gezielt zu verbessern.

### Gute Arbeitspakete für Agenten

- Ziel und Ergebnis in der Beschreibung („Angebot bis 30.10. freigegeben, Lizenzfrage geklärt“), nicht nur ein Stichwort.
- Termin setzen; Tasks als überprüfbare Schritte.
- Externe Ansprechpartner als Projektkontakt mit Mail-Adresse; das Projektkonto muss angebunden sein. Was ein Externer erfahren darf, gehört in die Außenbeschreibung des AP; Externe als Zuständige eines Tasks eintragen, dann haben sie Bezug zum AP.
- Klare Grenzen: was der Agent nicht entscheiden soll, gehört in die Beschreibung („Preise nur nach Rücksprache mit der PL“).
- Ein Agent je Thema; große Pakete in Aufgaben teilen und die Aufgaben zuweisen.

**Beispiel:** Teilprojekt „Elektrik“ dem Agenten geben, darin ein AP „Teilprojekt durchplanen, Fragen an die PL“. Der Agent legt Aufgaben mit Terminen an, weist Handwerksarbeit Personen zu, trägt Besichtigungen vorläufig in den Kalender (die PL bestätigt) und klärt Fragen per Chat mit der PL.

## 10. Telefonie

Ein Agent kann Anrufe entgegennehmen (sipgate Flow; sipgate übernimmt Telefonie, Spracherkennung und Sprachausgabe, PROject antwortet je Gesprächsschritt mit dem nächsten Satz). Je Rufnummer legt die Verwaltung unter Verwaltung › Telefonie Projekt, Agent, ein **schnelles KI-Profil** (Antwort in 1–3 Sekunden; lokale Modelle mit Denkmodus sind meist zu langsam) und optional eine Begrüßung fest.

- **Begrüßung mit Hinweis auf KI.** Interne Anrufer erkennt er an der Telefonnummer unter Meine Einstellungen › Allgemein und spricht sie mit Vornamen an.
- **Nachricht aufnehmen:** Name, Anliegen, Rückrufnummer. Nach dem Gespräch entsteht ein Arbeitspaket im Projekt der Rufnummer mit dem Gesprächsverlauf im Log; die Projektleitung bekommt eine Meldung (ohne festes Projekt die Org-Admins).
- **Stand für interne Anrufer:** Kennzahlen und offene Arbeitspakete der gemeinsamen Projekte, in denen die Person PL ist oder „KI nutzen“ hat. Externe bekommen keine Projektinhalte.
- **Termine:** ein Wunschtermin wird als vorläufiger Termin am Arbeitspaket eingetragen; eine Person bestätigt ihn.
- Anrufe zählen gegen das Tagesbudget des Agenten; Anruf-Log auch ohne KI über sipgate.io.

Einrichtung (Schlüssel, Webhook-URLs, Signaturprüfung): `docs/Telefonie.md`.

## 11. Häufige Fragen

**Warum antwortet er auf „hi“ nicht mit Projektinfos?** Ein Gruß hat keinen Projektbezug; er antwortet allgemein. Bei einer Frage ohne Nennung sucht das System in Doku und Arbeitspaketen aller Projekte, die er und du sehen dürfen, und ordnet darüber zu; ohne Treffer gilt dein persönliches Projekt. Eindeutig wird es mit Kennung, Kürzel oder Name.

**Merkt er sich, was ich vorhin geschrieben habe?** Nein. Außerhalb eines Threads kennt er nur deine Nachrichten seit seiner letzten Antwort. Für einen Dialog antwortest du im Thread (an seiner Antwort „Antworten“); dort kennt er den Thread und antwortet auch dort.

**Warum gilt mein „hi“ nicht als Antwort?** Grüße und Kurzmeldungen ohne Inhalt beantworten keine offene Frage und stehen nicht im Log; der Agent antwortet nur im Chat und wartet weiter. Kurze Bestätigungen wie „ok“, „passt“ oder „ja“ zählen als Antwort.

**Warum erinnert er mich nicht an seine offene Frage?** Ungefragt hängt er keine Projekthinweise an. Auf einen Witz kommt ein Witz, auf „wie geht's“ eine kurze Antwort. Das Nachfassen zur Frist übernimmt das System (Chat und Meldung), die Weitergabe an die nächste Stufe ebenso. Fragst du „Was ist offen?“ oder „Status?“, bekommst du die Übersicht.

**Warum fragt er?** Weil ihm eine Information oder Entscheidung fehlt, die weder in Log, Mails, Chat noch Doku steht, oder weil die Policy für diesen Schritt eine Bestätigung verlangt. Fragen haben ein Thema und eine Frist; nach der Frist fasst er nach und gibt weiter.

**Warum hat er nicht gesendet?** Mögliche Gründe stehen im Log unter seinem Namen: kein Senderecht (Entwurf in Postfach › Zur Freigabe), erster Kontakt zu einer Adresse ohne Bezug (Entwurf), Außenprüfung angehalten (Fundstellen), Bestätigungspflicht laut Policy, außerhalb des Arbeitszeitfensters (geplanter Versand), kein Mailkonto. Den Versandstatus schreibt immer das System.

**Woher weiß ich, was er getan hat?** Jede Aktion steht im Log des Arbeitspakets und im Lauf unter Einstellungen › KI-Läufe; Chat-Befehle zeigt die Systemkarte unter der Antwort. Was er nur behauptet, aber nicht ausgeführt hat, ersetzt das System sichtbar.

**Warum läuft er nicht?** Im Arbeitspaket steht „Läuft nicht: …“ mit dem Grund: Notaus, Recht nicht erteilt oder im Projekt abgeschaltet, Pause, Tagesbudget, LLM in diesem Projekt nicht eingesetzt oder gesperrt. Gesperrte Läufe kosten kein Budget.

**Warum sieht er eine Seite nicht?** Der Ordner hat für Agenten den Zugriff „kein“, oder die Seite liegt in einem Teilprojekt, das er nicht sieht. Die Projektleitung ändert den Zugriff am Ordner.

**Darf er Termine oder Buchungen bestätigen?** Nein. Vorläufige Termine und Belegungen bestätigt immer eine Person.

**Was passiert bei Überschneidungen zwischen Arbeitspaketen?** Er meldet sie; das System fragt die Zuständigen bzw. die Projektleitung. Niemand muss raten, nichts wird von selbst zusammengelegt.

**Wie bekommt er mehr Spielraum?** Selbstständigkeit auf „Selbstständig“ setzen (Projekt oder Agent im Projekt), Bestätigungsliste kürzen, „darf Mails senden“ setzen, Tagesbudget erhöhen. Mehr Rechte (z. B. Final setzen, Online-Recherche) und eine lockerere Obergrenze vergibt nur der Verwalter seines LLM.

**Wie bekommt er weniger?** „Rückfrage bei allem“, Klassen in die Bestätigungsliste, Ordnerzugriff „kein“ oder „lesen“, Pause je Arbeitspaket, Recht im Projekt abschalten (Einschränken) oder am Agenten entziehen, Tagesbudget senken, Notaus.
