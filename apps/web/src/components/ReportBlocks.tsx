import { useEffect, useRef, useState } from 'react';
import type { ReportBlock, ReportBlockType, ReportPeriod } from '@projekttool/shared';
import { DEFAULT_REPORT_BLOCKS, REPORT_BLOCK_LABEL } from '@projekttool/shared';
import { Button, Dropdown, IconButton, Modal, SafeHtml, useDialog } from './ui';
import { IconArrowDown, IconArrowUp, IconArrowUpRight, IconCopy, IconX } from './icons';

/**
 * Aufbau des Management-Reports: Blöcke untereinander als Karten. Je Block nur die Optionen, die der Typ unterstützt
 * (Zeitraum, Diagramm, maximale Einträge, Ausblick-Tage, Freitext); Vorlagen setzen eine ganze Blockliste.
 * Die Tastatur bedient alles: Verschieben hält den Fokus auf dem Block.
 */
export interface BlockMeta { period?: boolean; chart?: boolean; limit?: boolean; outlook?: boolean; text?: boolean; ai?: boolean; description: string }

export const BLOCK_META: Record<ReportBlockType, BlockMeta> = {
  summary: { chart: true, description: 'Ampel, Fortschritt Soll/Ist, Kennzahlen' },
  changes: { period: true, chart: true, limit: true, description: 'Erledigt, neu, Termine verschoben, Statuswechsel im Zeitraum' },
  overdue: { limit: true, description: 'Überfällige Arbeitspakete mit Zuständigkeit' },
  blocked: { limit: true, description: 'Blockierte Arbeitspakete und laufende Eskalationen' },
  milestones: { period: true, chart: true, limit: true, description: 'Nächste und erreichte Meilensteine, Zeitstrahl' },
  subprojects: { chart: true, description: 'Fortschritt je Teilprojekt' },
  risks: { chart: true, limit: true, description: 'Offene Risiken, Issues und Entscheidungen (RAID), Risikomatrix' },
  time: { period: true, chart: true, description: 'Gebuchte Zeit je Person und Teilprojekt im Zeitraum' },
  decisions: { period: true, limit: true, description: 'Entscheidungen und Meldungen aus dem Log im Zeitraum' },
  outlook: { outlook: true, limit: true, description: 'Fällig in den nächsten n Tagen, Meilensteine, Termine' },
  ai_summary: { ai: true, description: 'Management-Summary als Text aus den Zahlen der anderen Blöcke' },
  text: { text: true, description: 'Eigener Text der Projektleitung (Markdown)' }
};

export const BLOCK_TYPES = Object.keys(BLOCK_META) as ReportBlockType[];

export const PERIOD_LABEL: Record<ReportPeriod, string> = { since_last: 'seit letztem Bericht', week: 'letzte Woche', month: 'letzter Monat', quarter: 'letztes Quartal', days: 'n Tage' };

let seq = 0;
export const newBlockId = () => `b${Date.now().toString(36)}${(++seq).toString(36)}`;

/** Neuer Block eines Typs mit sinnvollen Vorgaben. */
export function newBlock(type: ReportBlockType): ReportBlock {
  const b: ReportBlock = { id: newBlockId(), type };
  const m = BLOCK_META[type];
  if (m.period) b.period = 'since_last';
  if (m.chart) b.chart = true;
  if (m.limit) b.limit = type === 'changes' || type === 'decisions' ? 15 : type === 'milestones' ? 5 : 10;
  if (m.outlook) b.days = 14;
  if (m.text) b.text = '';
  return b;
}

const fresh = (xs: Partial<ReportBlock>[]): ReportBlock[] => xs.map((x) => ({ ...(x as ReportBlock), id: newBlockId() }));

export interface ReportTemplate { key: string; label: string; description: string; blocks: () => ReportBlock[] }
export const REPORT_TEMPLATES: ReportTemplate[] = [
  { key: 'standard', label: 'Management-Report (Standard)', description: 'Gesamtstand, Änderungen, Überfällig, Blockiert, Meilensteine, Risiken, Ausblick', blocks: () => fresh(DEFAULT_REPORT_BLOCKS) },
  { key: 'short', label: 'Kurzstatus', description: 'Gesamtstand, Überfällig, Blockiert, Ausblick', blocks: () => fresh([{ type: 'summary', chart: true }, { type: 'overdue', limit: 10 }, { type: 'blocked', limit: 10 }, { type: 'outlook', days: 14, limit: 10 }]) },
  { key: 'monthly', label: 'Monatsbericht', description: 'Mit KI-Summary, Teilprojekten, Zeiten und Ausblick 30 Tage', blocks: () => fresh([
    { type: 'summary', chart: true }, { type: 'ai_summary' }, { type: 'changes', period: 'month', chart: true, limit: 15 }, { type: 'milestones', limit: 5, chart: true },
    { type: 'subprojects', chart: true }, { type: 'risks', limit: 10 }, { type: 'time', period: 'month', chart: true }, { type: 'outlook', days: 30, limit: 10 }
  ]) },
  { key: 'empty', label: 'Leer', description: 'Ohne Blöcke, selbst zusammenstellen', blocks: () => [] }
];

export const blockTitle = (b: ReportBlock) => b.title?.trim() || REPORT_BLOCK_LABEL[b.type];

/** Kurzbeschreibung eines Blocks („Änderungen (seit letztem Bericht)“) für Zusammenfassungen. */
export function blockSummary(b: ReportBlock): string {
  const m = BLOCK_META[b.type];
  const extra: string[] = [];
  if (m.period) extra.push(b.period === 'days' ? `${b.days ?? 7} Tage` : PERIOD_LABEL[b.period ?? 'since_last']);
  if (m.outlook) extra.push(`${b.days ?? 14} Tage`);
  return extra.length ? `${blockTitle(b)} (${extra.join(', ')})` : blockTitle(b);
}

/** Eine Zeile für Leser ohne Änderungsrecht: „Aufbau: … · Texte: KI · grafisch“. */
export function describeReport(blocks: ReportBlock[] | undefined, textSource: 'rules' | 'ai' | undefined, graphic: boolean | undefined): string {
  const list = (blocks?.length ? blocks : DEFAULT_REPORT_BLOCKS).map(blockSummary).join(', ');
  return `Aufbau: ${list} · Texte: ${textSource === 'ai' ? 'KI' : 'regelbasiert'} · ${graphic === false ? 'ohne Diagramme' : 'grafisch'}`;
}

export interface ReportBlocksProps {
  blocks: ReportBlock[];
  onChange: (blocks: ReportBlock[]) => void;
  /** Globaler Schalter „grafisch“: ohne ihn gibt es keine Diagramm-Option je Block */
  graphic: boolean;
  disabled?: boolean;
}

export function ReportBlocksEditor({ blocks, onChange, graphic, disabled }: ReportBlocksProps) {
  const dialog = useDialog();
  const listRef = useRef<HTMLUListElement>(null);
  // Nach dem Verschieben: Fokus auf denselben Knopf des verschobenen Blocks (sonst auf die Karte)
  const [focus, setFocus] = useState<{ id: string; action: string } | null>(null);
  useEffect(() => {
    if (!focus) return;
    const card = listRef.current?.querySelector<HTMLElement>(`[data-block-id="${focus.id}"]`);
    const btn = card?.querySelector<HTMLButtonElement>(`[data-action="${focus.action}"]`);
    (btn && !btn.disabled ? btn : card)?.focus();
    setFocus(null);
  }, [focus, blocks]);

  const update = (id: string, patch: Partial<ReportBlock>) => onChange(blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setFocus({ id: blocks[i].id, action: d < 0 ? 'up' : 'down' });
  };
  const remove = async (b: ReportBlock) => {
    if (!(await dialog.confirm({ title: 'Block entfernen', text: `„${blockTitle(b)}“ aus dem Bericht entfernen?`, confirmLabel: 'Entfernen', danger: true }))) return;
    onChange(blocks.filter((x) => x.id !== b.id));
  };
  const duplicate = (i: number) => {
    const copy = { ...blocks[i], id: newBlockId() };
    onChange([...blocks.slice(0, i + 1), copy, ...blocks.slice(i + 1)]);
    setFocus({ id: copy.id, action: 'card' });
  };
  const add = (type: ReportBlockType) => { const b = newBlock(type); onChange([...blocks, b]); setFocus({ id: b.id, action: 'card' }); };

  return (
    <div className="report-blocks">
      <div className="row between">
        <strong className="small">Aufbau des Berichts</strong>
        <div className="row gap-1">
          <Dropdown label="Aufbau wählen" icon={false} items={REPORT_TEMPLATES.map((t) => ({ label: <><span>{t.label}</span><span className="desc">{t.description}</span></>, disabled, onClick: () => onChange(t.blocks()) }))} />
          <Dropdown label="Block hinzufügen" icon={false} items={BLOCK_TYPES.map((t) => ({ label: <><span>{REPORT_BLOCK_LABEL[t]}</span><span className="desc">{BLOCK_META[t].description}</span></>, disabled, onClick: () => add(t) }))} />
        </div>
      </div>
      {blocks.length === 0 && <p className="muted small">Keine Blöcke: der Bericht wäre leer. Vorlage wählen oder Block hinzufügen.</p>}
      <ul className="report-block-list" role="list" aria-label="Blöcke des Berichts" ref={listRef}>
        {blocks.map((b, i) => <BlockCard key={b.id} block={b} index={i} count={blocks.length} graphic={graphic} disabled={disabled} onPatch={(p) => update(b.id, p)} onMove={(d) => move(i, d)} onRemove={() => void remove(b)} onDuplicate={() => duplicate(i)} />)}
      </ul>
    </div>
  );
}

function BlockCard({ block: b, index, count, graphic, disabled, onPatch, onMove, onRemove, onDuplicate }: {
  block: ReportBlock; index: number; count: number; graphic: boolean; disabled?: boolean; onPatch: (p: Partial<ReportBlock>) => void; onMove: (d: -1 | 1) => void; onRemove: () => void; onDuplicate: () => void;
}) {
  const m = BLOCK_META[b.type];
  const label = REPORT_BLOCK_LABEL[b.type];
  const name = blockTitle(b);
  return (
    <li className="report-block card" role="listitem" data-block-id={b.id} tabIndex={-1} aria-label={`Block ${index + 1} von ${count}: ${name}`}>
      <div className="row between">
        <div className="row gap-1 min-w-0">
          <span className="badge" title="Blocktyp">{label}</span>
          <input type="text" className="report-block-title" aria-label={`Überschrift des Blocks „${label}“`} placeholder={label} value={b.title ?? ''} disabled={disabled} onChange={(e) => onPatch({ title: e.target.value || undefined })} />
        </div>
        <div className="row gap-1">
          <IconButton label={`„${name}“ nach oben`} size="sm" data-action="up" disabled={disabled || index === 0} onClick={() => onMove(-1)}><IconArrowUp /></IconButton>
          <IconButton label={`„${name}“ nach unten`} size="sm" data-action="down" disabled={disabled || index === count - 1} onClick={() => onMove(1)}><IconArrowDown /></IconButton>
          <IconButton label={`„${name}“ duplizieren`} size="sm" data-action="copy" disabled={disabled} onClick={onDuplicate}><IconCopy /></IconButton>
          <IconButton label={`„${name}“ entfernen`} size="sm" data-action="remove" disabled={disabled} onClick={onRemove}><IconX /></IconButton>
        </div>
      </div>
      {(m.period || m.chart || m.limit || m.outlook) && (
        <div className="row small report-block-opts">
          {m.period && <>
            <label className="row gap-1"><span>Zeitraum</span>
              <select aria-label={`Zeitraum „${name}“`} value={b.period ?? 'since_last'} disabled={disabled} onChange={(e) => onPatch({ period: e.target.value as ReportPeriod, days: e.target.value === 'days' ? b.days ?? 14 : b.days })}>
                {(Object.keys(PERIOD_LABEL) as ReportPeriod[]).map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}
              </select></label>
            {b.period === 'days' && <label className="row gap-1"><input type="number" min={1} max={365} className="w-64" aria-label={`Tage „${name}“`} value={b.days ?? 14} disabled={disabled} onChange={(e) => onPatch({ days: Number(e.target.value) || 1 })} /><span>Tage</span></label>}
          </>}
          {m.outlook && <label className="row gap-1"><span>Ausblick</span><input type="number" min={1} max={365} className="w-64" aria-label={`Ausblick-Tage „${name}“`} value={b.days ?? 14} disabled={disabled} onChange={(e) => onPatch({ days: Number(e.target.value) || 1 })} /><span>Tage</span></label>}
          {m.limit && <label className="row gap-1"><span>Maximal</span><input type="number" min={1} max={100} className="w-64" aria-label={`Maximale Einträge „${name}“`} value={b.limit ?? 10} disabled={disabled} onChange={(e) => onPatch({ limit: Number(e.target.value) || 1 })} /><span>Einträge</span></label>}
          {m.chart && graphic && <label className="check"><input type="checkbox" aria-label={`Diagramm „${name}“`} checked={b.chart !== false} disabled={disabled} onChange={(e) => onPatch({ chart: e.target.checked })} /> Diagramm</label>}
        </div>
      )}
      {m.text && <label className="field"><span>Text (Markdown)</span><textarea rows={4} aria-label={`Text „${name}“`} value={b.text ?? ''} disabled={disabled} placeholder="Eigene Einschätzung, Hinweise für den Lenkungskreis …" onChange={(e) => onPatch({ text: e.target.value })} /></label>}
      {m.ai && <p className="muted small m-0">KI-Text, wenn ein Agent mit Berichtsrecht im Projekt ist (Texte: KI), sonst regelbasiert aus denselben Zahlen.</p>}
    </li>
  );
}

/** Query-String für die PDF-Endpunkte (blocks/projectIds als JSON, Booleans als true/false). */
export function reportQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return q.toString();
}

/** Vorschau eines Berichts (HTML aus der API, bereinigt mit SVG-Profil) mit Hinweis und „Als PDF“ in neuem Tab. */
export function ReportPreviewModal({ title, html, hint, pdfUrl, onClose }: { title: string; html: string; hint?: string; pdfUrl: string; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="row between mb">
        <span className="muted small">{hint ?? 'Entwurf, nicht gespeichert.'}</span>
        <Button size="sm" icon={<IconArrowUpRight />} onClick={() => window.open(pdfUrl, '_blank', 'noopener')}>Als PDF</Button>
      </div>
      <div className="report-preview"><SafeHtml html={html} /></div>
    </Modal>
  );
}
