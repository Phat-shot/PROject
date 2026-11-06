import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import type { ReportBlock } from '@projekttool/shared';
import { DEFAULT_REPORT_BLOCKS } from '@projekttool/shared';
import { ReportBlocksEditor, describeReport, newBlock } from './ReportBlocks';

function Harness({ initial, graphic = true, onChange }: { initial: ReportBlock[]; graphic?: boolean; onChange?: (b: ReportBlock[]) => void }) {
  const [blocks, setBlocks] = useState(initial);
  return <ReportBlocksEditor blocks={blocks} graphic={graphic} onChange={(b) => { setBlocks(b); onChange?.(b); }} />;
}
const items = () => screen.getAllByRole('listitem');
const labels = () => items().map((li) => within(li).getByTitle('Blocktyp').textContent);

describe('Block-Editor des Management-Reports', () => {
  beforeEach(() => { window.confirm = () => true; });

  it('zeigt die Blöcke als Liste mit Standardtitel und bietet nur die passenden Optionen je Typ', () => {
    render(<Harness initial={[{ id: 'a', type: 'summary', chart: true }, { id: 'b', type: 'changes', period: 'since_last', limit: 15 }, { id: 'c', type: 'outlook', days: 14 }, { id: 'd', type: 'text', text: 'Hallo' }, { id: 'e', type: 'ai_summary' }]} />);
    expect(screen.getByRole('list', { name: 'Blöcke des Berichts' })).toBeInTheDocument();
    expect(labels()).toEqual(['Gesamtstand', 'Änderungen im Zeitraum', 'Ausblick', 'Freitext', 'Management-Summary (KI)']);
    const [summary, changes, outlook, text, ai] = items();
    expect(within(summary).getByLabelText('Diagramm „Gesamtstand“')).toBeChecked();
    expect(within(summary).queryByLabelText(/Zeitraum/)).toBeNull();
    expect(within(changes).getByLabelText('Zeitraum „Änderungen im Zeitraum“')).toHaveValue('since_last');
    expect(within(changes).getByLabelText('Maximale Einträge „Änderungen im Zeitraum“')).toHaveValue(15);
    expect(within(outlook).getByLabelText('Ausblick-Tage „Ausblick“')).toHaveValue(14);
    expect(within(outlook).queryByLabelText(/Diagramm/)).toBeNull();
    expect(within(text).getByLabelText('Text „Freitext“')).toHaveValue('Hallo');
    expect(within(ai).getByText(/KI-Text, wenn ein Agent mit Berichtsrecht/)).toBeInTheDocument();
  });

  it('Zeitraum „n Tage“ blendet das Zahlfeld ein; ohne „grafisch“ gibt es keine Diagramm-Option', () => {
    const { rerender } = render(<Harness initial={[{ id: 'b', type: 'changes', period: 'since_last' }]} />);
    fireEvent.change(screen.getByLabelText('Zeitraum „Änderungen im Zeitraum“'), { target: { value: 'days' } });
    expect(screen.getByLabelText('Tage „Änderungen im Zeitraum“')).toHaveValue(14);
    expect(screen.getByLabelText('Diagramm „Änderungen im Zeitraum“')).toBeInTheDocument();
    rerender(<Harness initial={[{ id: 'b', type: 'changes' }]} graphic={false} />);
    expect(screen.queryByLabelText('Diagramm „Änderungen im Zeitraum“')).toBeNull();
  });

  it('fügt Blöcke über das Menü hinzu, verschiebt sie mit Fokus auf dem Block, dupliziert und entfernt nach Rückfrage', async () => {
    const onChange = vi.fn();
    render(<Harness initial={[{ id: 'a', type: 'summary' }, { id: 'b', type: 'overdue' }]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Block hinzufügen' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Risiken und Entscheidungen/ }));
    expect(labels()).toEqual(['Gesamtstand', 'Überfällig', 'Risiken und Entscheidungen (RAID)']);
    expect(onChange.mock.lastCall![0][2]).toMatchObject({ type: 'risks', chart: true, limit: 10 });
    // Verschieben: nach unten, Fokus bleibt auf dem Knopf des verschobenen Blocks
    const up = screen.getByRole('button', { name: '„Überfällig“ nach oben' });
    fireEvent.click(up);
    expect(labels()).toEqual(['Überfällig', 'Gesamtstand', 'Risiken und Entscheidungen (RAID)']);
    const li = screen.getByRole('listitem', { name: /Block 1 von 3: Überfällig/ });
    expect(li.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('button', { name: '„Überfällig“ nach oben' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '„Risiken und Entscheidungen (RAID)“ nach unten' }).closest('li')!.querySelector('[data-action=up]')!);
    expect(labels()).toEqual(['Überfällig', 'Risiken und Entscheidungen (RAID)', 'Gesamtstand']);
    fireEvent.click(screen.getByRole('button', { name: '„Gesamtstand“ duplizieren' }));
    expect(labels()).toEqual(['Überfällig', 'Risiken und Entscheidungen (RAID)', 'Gesamtstand', 'Gesamtstand']);
    const ids = onChange.mock.lastCall![0].map((b: ReportBlock) => b.id);
    expect(new Set(ids).size).toBe(4);
    window.confirm = () => false;
    fireEvent.click(screen.getByRole('button', { name: '„Überfällig“ entfernen' }));
    await waitFor(() => expect(labels()).toHaveLength(4));
    window.confirm = () => true;
    fireEvent.click(screen.getByRole('button', { name: '„Überfällig“ entfernen' }));
    await waitFor(() => expect(labels()).toEqual(['Risiken und Entscheidungen (RAID)', 'Gesamtstand', 'Gesamtstand']));
  });

  it('Vorlagen ersetzen den Aufbau; eigene Überschrift und Freitext werden übernommen', () => {
    const onChange = vi.fn();
    render(<Harness initial={[]} onChange={onChange} />);
    expect(screen.getByText(/Keine Blöcke/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Aufbau wählen' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Kurzstatus/ }));
    expect(labels()).toEqual(['Gesamtstand', 'Überfällig', 'Blockiert und eskaliert', 'Ausblick']);
    fireEvent.click(screen.getByRole('button', { name: 'Aufbau wählen' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Monatsbericht/ }));
    const monthly = onChange.mock.lastCall![0] as ReportBlock[];
    expect(monthly.map((b) => b.type)).toEqual(['summary', 'ai_summary', 'changes', 'milestones', 'subprojects', 'risks', 'time', 'outlook']);
    expect(monthly[2]).toMatchObject({ period: 'month', chart: true });
    expect(monthly[7]).toMatchObject({ days: 30 });
    fireEvent.click(screen.getByRole('button', { name: 'Aufbau wählen' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Management-Report \(Standard\)/ }));
    expect((onChange.mock.lastCall![0] as ReportBlock[]).map((b) => b.type)).toEqual(DEFAULT_REPORT_BLOCKS.map((b) => b.type));
    fireEvent.change(screen.getByLabelText('Überschrift des Blocks „Gesamtstand“'), { target: { value: 'Lage' } });
    expect(onChange.mock.lastCall![0][0]).toMatchObject({ type: 'summary', title: 'Lage' });
    fireEvent.click(screen.getByRole('button', { name: 'Aufbau wählen' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Leer/ }));
    expect(onChange.mock.lastCall![0]).toEqual([]);
  });

  it('describeReport fasst Aufbau, Textquelle und Grafik in einer Zeile zusammen', () => {
    expect(describeReport([newBlock('summary'), { id: 'x', type: 'changes', period: 'since_last' }, { id: 'y', type: 'outlook', days: 30 }], 'ai', true))
      .toBe('Aufbau: Gesamtstand, Änderungen im Zeitraum (seit letztem Bericht), Ausblick (30 Tage) · Texte: KI · grafisch');
    expect(describeReport(undefined, undefined, false)).toMatch(/^Aufbau: Gesamtstand, Änderungen im Zeitraum \(seit letztem Bericht\), .* · Texte: regelbasiert · ohne Diagramme$/);
  });
});
