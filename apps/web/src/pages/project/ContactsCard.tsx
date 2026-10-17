import { useState } from 'react';
import type { ProjectContact } from '@projekttool/shared';
import { api } from '../../lib/api';
import { useData } from '../../lib/useData';
import { useAsync, useDialog } from '../../components/ui';
import { useProject } from '../ProjectPage';
import { InlineText } from './TaskDrawer';

/** Kontakte und Stakeholder des Projekts: Externe, die Arbeitspakete bekommen, Verteiler, Ansprechpartner. */
export function ContactsCard() {
  const { detail } = useProject();
  const pid = detail.project.id;
  const canEdit = detail.project.myMembership.role !== 'reader';
  const d = useData<{ contacts: ProjectContact[] }>(`/projects/${pid}/contacts`);
  const dialog = useDialog();
  const { busy, error, run } = useAsync();
  const [f, setF] = useState({ email: '', name: '', role: '', organization: '' });
  const save = (c: ProjectContact, body: Partial<ProjectContact>) => run(async () => { await api.patch(`/projects/${pid}/contacts/${c.id}`, body); await d.reload(); });
  return (
    <div>
      <p className="muted small">Kontakte sind externe Personen ohne Login (Kunde, Lieferant, Dienstleister). Mit Name und Mail angelegt, lassen sie sich wie Mitglieder als zuständig für Arbeitspakete und Tasks wählen; Nachfragen und Berichte gehen per Mail an sie. Adressen, die direkt an Arbeitspaketen eingetragen werden, landen hier automatisch.</p>
      {error && <div className="error mb">{error}</div>}
      <table className="table"><thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Organisation</th><th>Telefon</th><th /></tr></thead><tbody>
        {d.data?.contacts.map((c) => (
          <tr key={c.id} className="inline-row">
            <td><InlineText value={c.name ?? ''} canEdit={canEdit} onSave={(v) => void save(c, { name: v })} /></td>
            <td className="small"><a href={`mailto:${c.email}`}>{c.email}</a></td>
            <td><InlineText value={c.role ?? ''} canEdit={canEdit} onSave={(v) => void save(c, { role: v })} /></td>
            <td><InlineText value={c.organization ?? ''} canEdit={canEdit} onSave={(v) => void save(c, { organization: v })} /></td>
            <td><InlineText value={c.phone ?? ''} canEdit={canEdit} onSave={(v) => void save(c, { phone: v })} /></td>
            <td>{canEdit && <button className="btn sm link" title="Kontakt entfernen" onClick={() => void dialog.confirm({ title: 'Kontakt entfernen', text: `${c.name ?? c.email} aus der Kontaktliste entfernen? Zuweisungen an Arbeitspaketen bleiben.`, confirmLabel: 'Entfernen', danger: true }).then((ok) => { if (ok) void run(async () => { await api.del(`/projects/${pid}/contacts/${c.id}`); await d.reload(); }); })}>✕</button>}</td>
          </tr>
        ))}
        {d.data && d.data.contacts.length === 0 && <tr><td colSpan={6} className="muted small">Noch keine Kontakte.</td></tr>}
      </tbody></table>
      {canEdit && <form className="row mt" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.post(`/projects/${pid}/contacts`, f); setF({ email: '', name: '', role: '', organization: '' }); await d.reload(); }); }}>
        <input type="email" placeholder="E-Mail" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} style={{ width: 200 }} required />
        <input type="text" placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ width: 160 }} required />
        <input type="text" placeholder="Rolle" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} style={{ width: 140 }} />
        <input type="text" placeholder="Organisation" value={f.organization} onChange={(e) => setF({ ...f, organization: e.target.value })} style={{ width: 160 }} />
        <button className="btn sm" disabled={busy || !f.email}>Hinzufügen</button>
      </form>}
    </div>
  );
}
