import { useState } from 'react';
import { PromptModal } from './ui';

/**
 * Daumen für Antworten und Läufe von Agenten (KI-Feedback): 👍 sofort, 👎 mit optionalem Kommentar, erneuter Klick nimmt zurück.
 * Gesichert wird für die KI-Verwaltung, um Prompt und Agenten zu verbessern.
 */
export function Thumbs({ value, onRate }: { value: 1 | -1 | null | undefined; onRate: (v: 1 | -1) => void }) {
  return (
    <span className="thumbs" role="group" aria-label="Antwort bewerten">
      <button type="button" className={`btn sm link ${value === 1 ? 'on' : ''}`} aria-pressed={value === 1} title={value === 1 ? 'Bewertung zurücknehmen' : 'Hilfreich'} onClick={() => onRate(1)}>👍</button>
      <button type="button" className={`btn sm link ${value === -1 ? 'on' : ''}`} aria-pressed={value === -1} title={value === -1 ? 'Bewertung zurücknehmen' : 'Nicht hilfreich (mit Kommentar)'} onClick={() => onRate(-1)}>👎</button>
    </span>
  );
}

/** Ablauf der Bewertung: Modal für den Kommentar zu 👎 liegt beim Aufrufer, damit Neuladen der Liste es nicht schließt. */
export function useRating(send: (id: string, rating: 1 | -1 | 0, comment?: string) => Promise<void>) {
  const [down, setDown] = useState<string | null>(null);
  const rate = (id: string, current: 1 | -1 | null | undefined, v: 1 | -1) => {
    if (current === v) { void send(id, 0); return; }
    if (v === -1) setDown(id); else void send(id, 1);
  };
  const modal = down
    ? <PromptModal title="Was war nicht gut?" label="Kommentar (optional)" placeholder="z. B. Kennung erfunden, falsches Projekt, zu lang" hint="Gesichert für die KI-Verwaltung, um den Agenten zu verbessern." submitLabel="Bewerten" onSubmit={(c) => void send(down, -1, c)} onClose={() => setDown(null)} />
    : null;
  return { rate, modal };
}
