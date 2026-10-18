import { useState } from 'react';
import type { Invitation } from '@projekttool/shared';
import { api, fmtDateTime } from '../../lib/api';
import { useData } from '../../lib/useData';
import { useAsync } from '../../components/ui';
import { useProject } from '../ProjectPage';

/** PL lädt eine neue Person per Mail direkt ins Projekt ein (Mitglied oder Leser, „KI nutzen“ je Rolle vorbelegt); offene Einladungen mit Link zum Kopieren. */
export function InviteCard() {
  const { detail } = useProject();
  const pid = detail.project.id;
  const inv = useData<{ invitations: Invitation[]; hasOrgAccount: boolean }>(`/invitations?projectId=${pid}`);
  const [f, setF] = useState({ name: '', email: '', projectRole: 'member' as 'member' | 'reader' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const { busy, error, run } = useAsync();
  const copy = async (link: string) => { try { await navigator.clipboard.writeText(link); setMsg({ ok: true, text: 'Link kopiert.' }); } catch { setMsg({ ok: false, text: link }); } };
  return (
    <div className="mt">
      <h3>Neue Person per Mail einladen</h3>
      {inv.data && !inv.data.hasOrgAccount && <p className="notice small">Kein Org-Postfach angebunden: Die Einladung geht nicht per Mail raus, der Link lässt sich aber kopieren und weitergeben.</p>}
      <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void run(async () => {
        const r = await api.post<{ invitation: Invitation; sent: boolean; error?: string }>('/invitations', { ...f, projectId: pid });
        setMsg(r.sent ? { ok: true, text: `Einladung an ${r.invitation.email} verschickt.` } : { ok: false, text: r.error ?? 'Nicht verschickt.', link: r.invitation.link });
        setF({ name: '', email: '', projectRole: 'member' });
        await inv.reload();
      }); }}>
        <label className="field"><span>Name</span><input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field"><span>E-Mail</span><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="field"><span>Projektrolle</span><select value={f.projectRole} onChange={(e) => setF({ ...f, projectRole: e.target.value as 'member' | 'reader' })} style={{ width: 'auto' }}><option value="member">Mitglied</option><option value="reader">Leser</option></select></label>
        <button className="btn sm primary" disabled={busy || !f.name.trim() || !f.email.trim()}>Einladen</button>
      </form>
      <p className="muted small">Nach der Annahme: Mitglieder mit „KI nutzen“, Leser ohne (einheitlich vorbelegt); weitere Einzelrechte danach unter „Rolle“. Ganze Teams nimmst du über „Gruppe hinzufügen“ auf.</p>
      {error && <div className="error mt small">{error}</div>}
      {msg && <div className={`mt small ${msg.ok ? 'muted' : ''}`} style={msg.ok ? undefined : { color: 'var(--warn)' }}>{msg.text}{msg.link && <> · <button className="btn sm link" onClick={() => void copy(msg.link!)}>Link kopieren</button></>}</div>}
      {inv.data && inv.data.invitations.length > 0 && (
        <table className="table mt"><thead><tr><th>Offen</th><th>Rolle</th><th>Status</th><th /></tr></thead><tbody>
          {inv.data.invitations.map((i) => <tr key={i.id}>
            <td>{i.name}<div className="muted small">{i.email}</div></td>
            <td className="small">{i.projectRole === 'reader' ? 'Leser' : 'Mitglied'}</td>
            <td className="small">{i.sentAt ? <>verschickt {fmtDateTime(i.sentAt)}</> : <span style={{ color: 'var(--warn)' }}>nicht verschickt</span>}<div className="muted">gültig bis {fmtDateTime(i.expiresAt)}</div></td>
            <td className="nowrap"><button className="btn sm link" onClick={() => void copy(i.link)}>Link</button><button className="btn sm link" disabled={busy} onClick={() => void run(async () => { const r = await api.post<{ sent: boolean; error?: string }>(`/invitations/${i.id}/resend`); setMsg(r.sent ? { ok: true, text: `Erneut an ${i.email} verschickt.` } : { ok: false, text: r.error ?? 'Nicht verschickt.', link: i.link }); await inv.reload(); })}>Erneut</button><button className="btn sm link" title="Einladung zurückziehen" onClick={() => void run(async () => { await api.del(`/invitations/${i.id}`); await inv.reload(); })}>✕</button></td>
          </tr>)}
        </tbody></table>
      )}
    </div>
  );
}
