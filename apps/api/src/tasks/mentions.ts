/**
 * @-Erwähnungen: "@Vorname Nachname" wird gegen die Projektmitglieder aufgelöst
 * (längster Treffer zuerst, Groß-/Kleinschreibung egal). Liefert Benutzer-IDs.
 */
export function extractMentions(body: string, members: { userId: string; name: string }[]): string[] {
  const found = new Set<string>();
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  let lower = body.toLowerCase();
  for (const m of sorted) {
    const needle = '@' + m.name.toLowerCase();
    let idx = lower.indexOf(needle);
    while (idx !== -1) {
      const after = lower[idx + needle.length];
      if (after === undefined || !/[\p{L}\p{N}]/u.test(after)) {
        found.add(m.userId);
        // Treffer maskieren, damit kürzere Namen nicht im selben Bereich matchen
        lower = lower.slice(0, idx) + ' '.repeat(needle.length) + lower.slice(idx + needle.length);
      }
      idx = lower.indexOf(needle, idx + 1);
    }
  }
  return [...found];
}
