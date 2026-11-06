import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DateInput } from './DateInput';
import { DialogProvider, Modal } from './ui';
import { todayIso } from '../lib/dates';

function Harness({ initial = '', onChange }: { initial?: string; onChange?: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return <><DateInput aria-label="Deadline" value={v} onChange={(x) => { setV(x); onChange?.(x); }} /><output data-testid="v">{v}</output></>;
}

describe('DateInput', () => {
  it('zeigt TT.MM.JJJJ, übernimmt Kurzformen erst mit Enter bzw. beim Verlassen; Wert bleibt ISO', () => {
    const onChange = vi.fn();
    render(<Harness initial="2026-11-06" onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Deadline' });
    expect(input).toHaveValue('06.11.2026');
    expect(input).toHaveAttribute('title', expect.stringContaining('KW 45'));
    fireEvent.change(input, { target: { value: '12.11.2026' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('2026-11-12');
    expect(input).toHaveValue('12.11.2026');
    fireEvent.change(input, { target: { value: '1.2.27' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('v')).toHaveTextContent('2027-02-01');
    fireEvent.change(input, { target: { value: 'heute' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('v')).toHaveTextContent(todayIso());
    // Pfeil hoch: einen Tag weiter
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('ungültige Eingabe: aria-invalid und Hinweis, Verlassen stellt den alten Wert her; leer löscht', () => {
    const onChange = vi.fn();
    render(<Harness initial="2026-11-06" onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Deadline' });
    fireEvent.change(input, { target: { value: '31.02.2026' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Kein gültiges Datum');
    fireEvent.blur(input);
    expect(input).toHaveValue('06.11.2026');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('Kalender: Dialog mit Raster und KW, Tastatur (Pfeile, Bild ab, Enter), Heute und Löschen', () => {
    const onChange = vi.fn();
    render(<Harness initial="2026-11-06" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Kalender öffnen: Deadline' }));
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByText('November 2026')).toBeInTheDocument();
    const grid = within(dlg).getByRole('grid');
    expect(within(grid).getByRole('rowheader', { name: '45' })).toBeInTheDocument();
    const sel = within(grid).getByRole('button', { name: /Freitag, 06\.11\.2026/ });
    expect(sel).toHaveFocus();
    expect(sel.closest('[role=gridcell]')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(sel, { key: 'ArrowRight' });
    expect(within(grid).getByRole('button', { name: /Samstag, 07\.11\.2026/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'PageDown' });
    expect(within(dlg).getByText('Dezember 2026')).toBeInTheDocument();
    fireEvent.click(document.activeElement!);
    expect(onChange).toHaveBeenLastCalledWith('2026-12-07');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Kalender öffnen: Deadline' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Löschen' }));
    expect(onChange).toHaveBeenLastCalledWith('');
    fireEvent.click(screen.getByRole('button', { name: 'Kalender öffnen: Deadline' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Heute' }));
    expect(onChange).toHaveBeenLastCalledWith(todayIso());
  });

  it('Esc im Kalender schließt nur den Kalender, nicht den Dialog darunter', () => {
    const onClose = vi.fn();
    render(<DialogProvider><Modal title="Formular" onClose={onClose}><DateInput aria-label="Frist" value="2026-11-06" onChange={() => undefined} /></Modal></DialogProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Kalender öffnen: Frist' }));
    const cal = screen.getAllByRole('dialog').find((d) => d.className.includes('date-pop'))!;
    fireEvent.keyDown(within(cal).getByRole('button', { name: /06\.11\.2026/ }), { key: 'Escape' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('min/max: Tage außerhalb gesperrt, Eingabe außerhalb ungültig', () => {
    const onChange = vi.fn();
    render(<DateInput aria-label="Ab" value="2026-11-10" min="2026-11-09" onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: 'Ab' });
    fireEvent.change(input, { target: { value: '01.11.2026' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Kalender öffnen: Ab' }));
    expect(screen.getByRole('button', { name: /08\.11\.2026/ })).toBeDisabled();
  });
});
