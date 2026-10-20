import { useRef } from 'react';
import { useParams } from 'react-router-dom';
import kurz from '../../../../docs/Kurzanleitung.md?raw';
import handbuch from '../../../../docs/Handbuch.md?raw';
import sheet from '../../../../docs/KI-Sheet.md?raw';
import kiHandbuch from '../../../../docs/KI-Handbuch.md?raw';
import { TopBar } from '../components/Layout';
import { Markdown } from '../components/ui';

const DOCS: Record<string, { label: string; md: string }> = {
  '': { label: 'Kurzanleitung', md: kurz },
  handbuch: { label: 'Handbuch', md: handbuch },
  'ki-agenten': { label: 'KI-Agenten', md: kiHandbuch },
  'ki-sheet': { label: 'KI-Sheet', md: sheet }
};

/**
 * Hilfe: Kurzanleitung, Handbuch, KI-Handbuch („KI-Agenten“) und KI-Sheet aus docs/ (beim Build eingebunden, passt damit immer zur
 * installierten Version). Handbuch und KI-Handbuch bekommen ein Inhaltsverzeichnis aus ihren Kapiteln.
 */
export function HelpPage() {
  const { doc = '' } = useParams<{ doc?: string }>();
  const d = DOCS[doc] ?? DOCS[''];
  const body = useRef<HTMLDivElement>(null);
  const chapters = [...d.md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const jump = (i: number) => body.current?.querySelectorAll('h2')[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <>
      <TopBar title="Hilfe" tabs={[{ to: '/hilfe', label: 'Kurzanleitung', end: true }, { to: '/hilfe/handbuch', label: 'Handbuch' }, { to: '/hilfe/ki-agenten', label: 'KI-Agenten' }, { to: '/hilfe/ki-sheet', label: 'KI-Sheet' }]} />
      <div className="content help-page">
        {(doc === 'handbuch' || doc === 'ki-agenten') && chapters.length > 0 && (
          <nav className="help-toc card" aria-label="Inhalt">
            <strong className="small">Inhalt</strong>
            {chapters.map((c, i) => <button key={c} className="btn sm link" onClick={() => jump(i)}>{c}</button>)}
          </nav>
        )}
        <div className="card" ref={body}><Markdown md={d.md} /></div>
      </div>
    </>
  );
}
