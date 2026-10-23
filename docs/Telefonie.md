# Telefonie mit sipgate

Ein KI-Agent nimmt Anrufe an (sipgate Flow). sipgate übernimmt Telefonie, Spracherkennung und Sprachausgabe. PROject bekommt je Anruf Ereignisse (Gesprächsbeginn, gesprochener Text, Ende) und antwortet mit dem nächsten Satz.

Optional zeichnet sipgate.io zusätzlich Anrufe ohne KI im Anruf-Log auf.

## Was der Agent am Telefon tut

- **Begrüßung mit Hinweis auf KI.** Interne Anrufer erkennt er an der Telefonnummer unter *Meine Einstellungen* und spricht sie mit Vornamen an.
- **Nachricht aufnehmen:** Name, Anliegen und Rückrufnummer. Nach dem Gespräch entsteht ein Arbeitspaket im Projekt der Rufnummer, mit dem Gesprächsverlauf im Log. Die PL bekommt eine Meldung. Ohne festes Projekt geht die Meldung an die Org-Admins.
- **Stand für interne Anrufer:** Kennzahlen und offene Arbeitspakete der gemeinsamen Projekte, in denen die Person PL ist oder „KI nutzen“ hat. Externe bekommen keine Projektinhalte.
- **Termine:** Ein Wunschtermin wird als vorläufiger Termin am Arbeitspaket eingetragen. Eine Person bestätigt ihn.

## Einrichtung

1. **Verwaltung › KI:** ein schnelles KI-Profil anlegen, z. B. Anthropic Haiku. Am Telefon muss die Antwort in 1–3 Sekunden kommen, lokale Modelle mit Denkmodus sind dafür meist zu langsam.
2. **Verwaltung › KI › Agenten:** einen Agenten anlegen und im Projekt als Mitglied aufnehmen (Projekt › Einstellungen › KI).
3. **Verwaltung › Telefonie:**
   - Schlüssel erzeugen. Er wird nur dieses eine Mal angezeigt.
   - Telefonie aktivieren.
   - Rufnummer einrichten: Nummer, Agent, Projekt, KI-Profil, optional eine Begrüßung.
4. **sipgate Flow:** die angezeigte Webhook-URL eintragen und den Schlüssel als Header `x-api-token` setzen. Alternativ dient er als HMAC-Schlüssel für `x-sipgate-signature`.
5. **Optional, sipgate.io:** die angezeigte Push-URL für ein- und ausgehende Anrufe eintragen (sipgate-Konsole › Webhooks › URLs).

Die Instanz muss aus dem Internet erreichbar sein; über Traefik ist sie das.

## Hinweise

- **Protokoll:** Die Ereignisse und Aktionen von Flow folgen dem offiziellen SDK `@sipgate/ai-flow-sdk` (2.1). Die Absicherung per `x-api-token` bzw. `x-sipgate-signature` stammt aus dem Referenz-Client `sipgate/flow-io`, den sipgate als experimentell kennzeichnet.
- **Stimme:** Azure, `de-DE-KatjaNeural`. Die Spracherkennung ist auf Deutsch eingestellt.
- **Hängende Anrufe:** Kommt das Gesprächsende nicht an, schließt die Anrufliste den Anruf nach zwei Stunden ab.
