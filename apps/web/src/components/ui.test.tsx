import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DialogProvider, Modal, ToastProvider, toast, useAsync, useToast } from './ui';
import { ApiError } from '../lib/api';

describe('Toast', () => {
  it('zeigt Meldungen im Stapel: Fehler assertive, Rest polite; Schließen entfernt sie', async () => {
    function Btn() { const t = useToast(); return <><button onClick={() => t.error('Kaputt')}>err</button><button onClick={() => t.ok('Gespeichert')}>ok</button></>; }
    render(<ToastProvider><Btn /></ToastProvider>);
    fireEvent.click(screen.getByText('err'));
    fireEvent.click(screen.getByText('ok'));
    expect(screen.getByRole('alert')).toHaveTextContent('Kaputt');
    expect(screen.getByRole('status')).toHaveTextContent('Gespeichert');
    fireEvent.click(screen.getAllByRole('button', { name: 'Meldung schließen' })[0]);
    await waitFor(() => expect(screen.queryByText('Kaputt')).toBeNull());
    act(() => toast('Von außen'));
    expect(screen.getByText('Von außen')).toBeInTheDocument();
  });

  it('useAsync mit toast: true zeigt den Fehler als Toast und liefert Feldfehler', async () => {
    function Form() {
      const { error, fieldErrors, run } = useAsync({ toast: true });
      return <><button onClick={() => void run(async () => { throw new ApiError(400, 'Ungültige Eingabe', { name: 'fehlt' }); })}>go</button><span data-testid="e">{error}</span><span data-testid="f">{fieldErrors.name}</span></>;
    }
    render(<ToastProvider><Form /></ToastProvider>);
    fireEvent.click(screen.getByText('go'));
    await waitFor(() => expect(screen.getByTestId('f')).toHaveTextContent('fehlt'));
    expect(screen.getByTestId('e')).toHaveTextContent('Ungültige Eingabe');
    expect(screen.getByRole('alert')).toHaveTextContent('Ungültige Eingabe');
  });
});

describe('Modal: Dialog-Semantik, Fokus, Esc, Dirty', () => {
  it('hat role=dialog mit Titel, fokussiert das erste Element, Tab bleibt im Dialog, Esc schließt, Fokus kehrt zurück', async () => {
    const onClose = vi.fn();
    function Page() {
      const [open, setOpen] = useState(false);
      return <>
        <button onClick={() => setOpen(true)}>öffnen</button>
        {open && <Modal title="Testdialog" onClose={() => { onClose(); setOpen(false); }}><input aria-label="A" /><button>B</button></Modal>}
      </>;
    }
    render(<DialogProvider><Page /></DialogProvider>);
    const opener = screen.getByText('öffnen');
    opener.focus();
    fireEvent.click(opener);
    const dlg = screen.getByRole('dialog', { name: 'Testdialog' });
    expect(dlg).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Schließen' })).toHaveFocus();
    // Tab vom letzten Element springt zum ersten (Fokusfalle)
    screen.getByText('B').focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Schließen' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
  });

  it('Esc schließt nur die oberste Ebene; dirty fragt vor dem Schließen nach', async () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(<DialogProvider>
      <Modal title="Außen" onClose={closeOuter} dirty><p>außen</p>
        <Modal title="Innen" onClose={closeInner}><p>innen</p></Modal>
      </Modal>
    </DialogProvider>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
    // Außen schließen (dirty): Rückfrage erscheint, „Abbrechen“ hat den Fokus, „Verwerfen“ schließt
    fireEvent.click(screen.getAllByRole('button', { name: 'Schließen' })[0]);
    const ask = await screen.findByRole('dialog', { name: 'Eingaben verwerfen?' });
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    await waitFor(() => expect(ask).not.toBeInTheDocument());
    expect(closeOuter).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Schließen' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Verwerfen' }));
    await waitFor(() => expect(closeOuter).toHaveBeenCalledTimes(1));
  });
});
