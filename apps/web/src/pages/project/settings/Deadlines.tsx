import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../../../lib/api';
import { useAsync } from '../../../components/ui';
import type { DocPage, DocTemplate, ReportingPolicy } from '@projekttool/shared';
import { useProject } from '../../ProjectPage';
import { useData } from '../../../lib/useData';
import { SettingsCard, ReadOnlyNote } from '../../../components/settings/Settings';

function EscalationForm() {
  const { detail, users, reload } = useProject();
  const me = detail.project.myMembership;
  const p = detail.project.escalation!;
  const [f, setF] = useState({ enabled: p.enabled, d1: p.stageDays[0], d2: p.stageDays[1], d3: p.stageDays[2], staleDays: p.staleDays, contactUserId: p.contactUserId ?? '', contactEmail: p.contactEmail ?? '', externalMode: p.externalMode });
  const { busy, error, run } = useAsync();
  const members = users.filter((u) => u.active);
  if (me.role !== 'pl') {
    return <p className="small muted">Stufe 1 nach {p.stageDays[0]} Tagen Verzug oder {p.staleDays} Tagen Stillstand (Teilprojekt-Verantwortung), Stufe 2 nach {p.stageDays[1]} Tagen (PL), Stufe 3 nach {p.stageDays[2]} Tagen ({members.find((u) => u.id === p.contactUserId)?.name ?? p.contactEmail ?? 'kein Kontakt'}). Hohe Kritikalität halbiert die Fristen.</p>;
  }
  return (
    <div className="form">
      <p className="muted small">Verzug, Stillstand und Blockaden eskalieren entlang Zuständig → Teilprojekt-Verantwortung → PL → Eskalationskontakt. Hohe Kritikalität halbiert die Fristen.</p>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Eskalation aktiv</label>
      <div className="row small">
        <span>Stufe 1 nach</span><input type="number" min={0} value={f.d1} onChange={(e) => setF({ ...f, d1: Number(e.target.value) })} style={{ width: 60 }} />
        <span>Stufe 2 nach</span><input type="number" min={0} value={f.d2} onChange={(e) => setF({ ...f, d2: Number(e.target.value) })} style={{ width: 60 }} />
        <span>Stufe 3 nach</span><input type="number" min={0} value={f.d3} onChange={(e) => setF({ ...f, d3: Number(e.target.value) })} style={{ width: 60 }} /><span>Tagen Verzug</span>
      </div>
      <div className="row small"><span>„Hängt“ ab</span><input type="number" min={1} value={f.staleDays} onChange={(e) => setF({ ...f, staleDays: Number(e.target.value) })} style={{ width: 60 }} /><span>Tagen ohne Aktivität in einer aktiven Spalte</span></div>
      <label className="field"><span>Eskalationskontakt intern (z. B. Vorgesetzte/r, Auftraggeber im Haus)</span><select value={f.contactUserId} onChange={(e) => setF({ ...f, contactUserId: e.target.value })}><option value="">– keiner –</option>{members.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      <label className="field"><span>Eskalationskontakt extern (Mail über Projektkonto)</span><input type="email" value={f.contactEmail} onChange={(e) => setF({ ...f, contactEmail: e.target.value })} placeholder="gf@kunde.de" /></label>
      {f.contactEmail && <label className="field"><span>Externe Eskalationsmail</span><select value={f.externalMode} onChange={(e) => setF({ ...f, externalMode: e.target.value as any })}><option value="proposal">als Entwurf zur Freigabe durch PL</option><option value="direct">direkt senden</option></select></label>}
      {error && <div className="error">{error}</div>}
      <div><button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { escalation: { enabled: f.enabled, stageDays: [f.d1, f.d2, f.d3], staleDays: f.staleDays, contactUserId: f.contactUserId || null, contactEmail: f.contactEmail || null, externalMode: f.externalMode } }); await reload(); })}>Speichern</button></div>
    </div>
  );
}

const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

function ReportingForm() {
  const { detail, reload } = useProject();
  const me = detail.project.myMembership;
  const p = detail.project.reporting!;
  const [f, setF] = useState({ ...p, recipientsText: p.recipients.join(', ') });
  const templates = useData<{ templates: DocTemplate[] }>('/docs/templates');
  const docs = useData<{ pages: DocPage[] }>(`/projects/${detail.project.id}/docs`);
  const { busy, error, run } = useAsync();
  const [last, setLast] = useState<string | null>(null);
  const tops = (docs.data?.pages ?? []).filter((x) => !x.parentPageId).sort((a, b) => a.title.localeCompare(b.title));
  const rhythm = p.interval === 'monthly' ? `monatlich am ${p.dayOfMonth}.` : `${p.interval === 'weekly' ? 'wöchentlich' : 'alle zwei Wochen'} am ${WEEKDAYS[p.weekday - 1]}`;
  const tplName = templates.data?.templates.find((t) => t.key === p.templateKey)?.name ?? p.templateKey;
  if (me.role !== 'pl') {
    return <p className="small muted">{p.enabled ? `„${tplName}“ ${rhythm} an ${p.recipients.join(', ') || 'niemanden'} (${p.mode === 'direct' ? 'direkt als PDF' : 'nach Prüfung durch PL'}).` : 'Kein automatisches Reporting.'}{p.lastRunOn && <> Zuletzt: {fmtDate(p.lastRunOn)}{p.lastPageId && <> · <Link to={`/projekte/${detail.project.id}/doku/${p.lastPageId}`}>Bericht</Link></>}.</>}</p>;
  }
  const save = (): Partial<ReportingPolicy> => ({ enabled: f.enabled, templateKey: f.templateKey, interval: f.interval, weekday: Number(f.weekday), dayOfMonth: Number(f.dayOfMonth), recipients: f.recipientsText.split(/[,;\s]+/).filter(Boolean), mode: f.mode, parentPageId: f.parentPageId || null });
  return (
    <div className="form">
      <p className="muted small">Im Rhythmus entsteht eine Seite aus der Vorlage mit Kennzahlen (Fortschritt, Verzug, Blockaden, Eskalationen, Meilensteine) und geht als PDF über das Projektkonto an den Empfängerkreis.</p>
      <label className="check"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Reporting aktiv</label>
      <div className="grid cols-2">
        <label className="field"><span>Vorlage</span><select value={f.templateKey} onChange={(e) => setF({ ...f, templateKey: e.target.value })}>{(templates.data?.templates ?? []).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>
        <label className="field"><span>Ablage unter Oberseite</span><select value={f.parentPageId ?? ''} onChange={(e) => setF({ ...f, parentPageId: e.target.value })}><option value="">– Ordner „Berichte“ –</option>{tops.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
        <label className="field"><span>Rhythmus</span><select value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value as ReportingPolicy['interval'] })}><option value="weekly">wöchentlich</option><option value="biweekly">alle zwei Wochen</option><option value="monthly">monatlich</option></select></label>
        {f.interval === 'monthly'
          ? <label className="field"><span>Tag im Monat</span><input type="number" min={1} max={28} value={f.dayOfMonth} onChange={(e) => setF({ ...f, dayOfMonth: Number(e.target.value) })} /></label>
          : <label className="field"><span>Wochentag</span><select value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>{WEEKDAYS.map((w, i) => <option key={w} value={i + 1}>{w}</option>)}</select></label>}
      </div>
      <label className="field"><span>Empfängerkreis (Mail-Adressen, durch Komma getrennt)</span><input type="text" value={f.recipientsText} onChange={(e) => setF({ ...f, recipientsText: e.target.value })} placeholder="gf@kunde.de, lenkungskreis@firma.de" /></label>
      <label className="field"><span>Versand</span><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value as ReportingPolicy['mode'] })}><option value="proposal">als Entwurf, PL prüft und versendet</option><option value="direct">direkt final setzen und als PDF senden</option></select></label>
      {!detail.project.mailAddress && <p className="small" style={{ color: 'var(--warn)' }}>Kein Projektkonto angebunden, Versand ist erst danach möglich.</p>}
      {error && <div className="error">{error}</div>}
      {last && <div className="muted small">{last}</div>}
      <div className="row">
        <button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { reporting: save() }); await reload(); setLast('Gespeichert.'); })}>Speichern</button>
        <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.patch(`/projects/${detail.project.id}`, { reporting: save() }); const r = await api.post<{ result: { pageId: string; title: string; sent: boolean; to: string[]; error?: string } }>(`/projects/${detail.project.id}/reporting/run`); await reload(); setLast(r.result.sent ? `„${r.result.title}“ versendet an ${r.result.to.join(', ')}.` : `„${r.result.title}“ angelegt${r.result.error ? `, nicht versendet: ${r.result.error}` : ' (Entwurf zur Prüfung)'}.`); })}>Jetzt erzeugen</button>
        {p.lastRunOn && <span className="muted small">Zuletzt {fmtDate(p.lastRunOn)}{p.lastPageId && <> · <Link to={`/projekte/${detail.project.id}/doku/${p.lastPageId}`}>Bericht öffnen</Link></>}</span>}
      </div>
    </div>
  );
}

/** Projekt › Einstellungen › Fristen und Berichte: Eskalationsregeln und Reporting. */
export function DeadlinesTab() {
  const { detail } = useProject();
  const isPl = detail.project.myMembership.role === 'pl';
  return (
    <>
      <SettingsCard title="Eskalationsregeln" hint={isPl ? undefined : undefined}>{!isPl && <ReadOnlyNote who="PL" />}<EscalationForm /></SettingsCard>
      <SettingsCard title="Reporting">{!isPl && <ReadOnlyNote who="PL" />}<ReportingForm /></SettingsCard>
    </>
  );
}
