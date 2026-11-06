import { Fragment, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useIsMobile } from '../lib/useMedia';
import { IconChevronRight, IconMore } from './icons';

export interface Crumb {
  label: ReactNode;
  /** Ziel (Link); ohne to und onClick ist die Ebene nur Text */
  to?: string;
  onClick?: () => void;
  title?: string;
}

/**
 * Brotkrumen: Projekt › Teilprojekt › Arbeitspaket › Aufgabe, Projekt › Doku › Ordner › Oberseite › Seite, Projekt › Doku ›
 * Dateien › Einbindung › Ordner. Jede Ebene außer der letzten ist klickbar; die letzte trägt aria-current. Mobil (schmal)
 * gekürzt auf die letzten zwei Ebenen mit „…“ davor, das die übrigen aufklappt.
 */
export function Breadcrumbs({ items, label = 'Brotkrumen', compact, className = '' }: { items: Crumb[]; label?: string; /** erzwingt (true) oder verhindert (false) die Kürzung; ohne Angabe: mobil */ compact?: boolean; className?: string }) {
  const mobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const shorten = (compact ?? mobile) && !expanded && items.length > 2;
  const shown = shorten ? items.slice(-2) : items;
  const hidden = shorten ? items.slice(0, -2) : [];
  return (
    <nav className={`crumbs ${className}`.trim()} aria-label={label}>
      <ol>
        {shorten && <li className="crumb-more"><button type="button" className="btn sm link" aria-label={`Weitere Ebenen: ${hidden.map((h) => (typeof h.label === 'string' ? h.label : '')).filter(Boolean).join(' › ')}`} title="Alle Ebenen zeigen" onClick={() => setExpanded(true)}><IconMore size={14} /></button><span className="sep" aria-hidden="true"><IconChevronRight size={12} /></span></li>}
        {shown.map((c, i) => {
          const last = i === shown.length - 1;
          const body = last ? <span aria-current="page" title={c.title}>{c.label}</span>
            : c.to ? <Link to={c.to} title={c.title} onClick={c.onClick}>{c.label}</Link>
            : c.onClick ? <button type="button" className="btn sm link" title={c.title} onClick={c.onClick}>{c.label}</button>
            : <span title={c.title}>{c.label}</span>;
          return <Fragment key={i}><li>{body}{!last && <span className="sep" aria-hidden="true"><IconChevronRight size={12} /></span>}</li></Fragment>;
        })}
      </ol>
    </nav>
  );
}
