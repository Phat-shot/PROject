import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Thumbs, useRating } from './Rating';

function Harness({ value, send }: { value: 1 | -1 | null; send: (id: string, v: 1 | -1 | 0, c?: string) => Promise<void> }) {
  const r = useRating(send);
  return <>{r.modal}<Thumbs value={value} onRate={(v) => r.rate('m1', value, v)} /></>;
}

describe('KI-Feedback: Daumen', () => {
  it('👍 sofort, 👎 mit Kommentar, erneuter Klick nimmt zurück', () => {
    const send = vi.fn(async () => undefined);
    const { rerender } = render(<Harness value={null} send={send} />);
    fireEvent.click(screen.getByTitle('Hilfreich'));
    expect(send).toHaveBeenLastCalledWith('m1', 1);
    fireEvent.click(screen.getByTitle('Nicht hilfreich (mit Kommentar)'));
    fireEvent.change(screen.getByLabelText('Kommentar (optional)'), { target: { value: 'Kennung erfunden' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bewerten' }));
    expect(send).toHaveBeenLastCalledWith('m1', -1, 'Kennung erfunden');
    rerender(<Harness value={-1} send={send} />);
    expect(screen.getByTitle('Bewertung zurücknehmen')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTitle('Bewertung zurücknehmen'));
    expect(send).toHaveBeenLastCalledWith('m1', 0);
  });
});
