import { useEffect, useState } from 'react';
import type { MailView } from '@projekttool/shared';
import { api } from '../lib/api';
import { Button, FieldError, Loading, Modal, useAsync, useDirty } from './ui';

/**
 * Mail im Popup schreiben und direkt senden, ohne ins Postfach zu wechseln.
 * Konto: bevorzugt eine Ansicht mit Senderecht (Projektkonto zuerst); ohne Senderecht geht die Mail als Entwurf zur Freigabe.
 */
export function QuickMail({ projectId, taskId, checklistItemId, to, subject, body, title, onClose, onSent }: {
  projectId: string; taskId?: string | null; checklistItemId?: string | null; to: string; subject: string; body: string; title?: string; onClose: () => void; onSent?: () => void;
}) {
  const [views, setViews] = useState<MailView[] | null>(null);
  const [f, setF] = useState({ viewId: '', to, cc: '', subject, body });
  const { busy, error, fieldErrors, run } = useAsync();
  const { dirty } = useDirty({ to: f.to, cc: f.cc, subject: f.subject, body: f.body });
  useEffect(() => {
    api.get<{ views: MailView[] }>(`/projects/${projectId}/mail/views`).then((r) => {
      const writable = r.views.filter((v) => v.myRights.canSend || v.myRights.canDraft)
        .sort((a, b) => Number(b.myRights.canSend) - Number(a.myRights.canSend) || Number(b.accountType === 'project') - Number(a.accountType === 'project'));
      setViews(writable);
      setF((x) => ({ ...x, viewId: x.viewId || writable[0]?.id || '' }));
    }).catch(() => setViews([]));
  }, [projectId]);
  const view = views?.find((v) => v.id === f.viewId);
  const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const send = () => run(async () => {
    await api.post('/mail/drafts', { viewId: f.viewId, projectId, taskId: taskId ?? null, checklistItemId: checklistItemId ?? null, to: split(f.to), cc: split(f.cc), subject: f.subject, body: f.body, send: true });
    onSent?.();
    onClose();
  });
  return (
    <Modal title={title ?? 'Mail senden'} onClose={onClose} dirty={dirty}>
      {views && views.length === 0 && <div className="empty">Keine Ansicht mit Entwurfs- oder Senderecht in diesem Projekt. Die PL legt Ansichten unter Einstellungen › Mail an.</div>}
      {views && views.length > 0 && (
        <form className="form" onSubmit={(e) => { e.preventDefault(); void send(); }} noValidate>
          <label className="field"><span>Senden über</span>
            <select value={f.viewId} onChange={(e) => setF({ ...f, viewId: e.target.value })}>{views.map((v) => <option key={v.id} value={v.id}>{v.name} – {v.accountAddress}{v.myRights.canSend ? '' : ' (nur Entwurf, Versand nach Freigabe)'}</option>)}</select></label>
          <label className="field"><span className="req">An</span><input type="text" value={f.to} required aria-required="true" aria-invalid={Boolean(fieldErrors.to) || undefined} onChange={(e) => setF({ ...f, to: e.target.value })} placeholder="mehrere mit Komma" autoFocus={!to} /><FieldError error={fieldErrors.to} /></label>
          <label className="field"><span>Cc</span><input type="text" value={f.cc} onChange={(e) => setF({ ...f, cc: e.target.value })} /><FieldError error={fieldErrors.cc} /></label>
          <label className="field"><span className="req">Betreff</span><input type="text" value={f.subject} required aria-required="true" aria-invalid={Boolean(fieldErrors.subject) || undefined} onChange={(e) => setF({ ...f, subject: e.target.value })} /><FieldError error={fieldErrors.subject} /></label>
          <label className="field"><span>Text</span><textarea className="mail-body" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
          {taskId && <p className="muted small">Die Antwortadresse trägt den Arbeitspaket-Code, Antworten landen automatisch im Arbeitspaket.</p>}
          {error && !Object.keys(fieldErrors).length && <div className="error" role="alert">{error}</div>}
          <div className="row">
            <Button type="submit" variant="primary" loading={busy} disabled={!f.to.trim() || !f.subject.trim()}>{view?.myRights.canSend ? 'Senden' : 'Zur Freigabe einreichen'}</Button>
            <Button onClick={onClose}>Abbrechen</Button>
          </div>
        </form>
      )}
      {!views && <Loading />}
    </Modal>
  );
}
