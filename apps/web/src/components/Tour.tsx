import { useEffect, useLayoutEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Project } from '@projekttool/shared';

interface Step { title: string; text: string; target?: string; go?: string }

/**
 * Interaktives Tutorial: hebt Elemente der Oberfläche hervor und führt durch die Bereiche.
 * Jederzeit überspringbar; Abschluss wird je Benutzer im Browser gemerkt und ist über „Tutorial“ in der Leiste neu startbar.
 */
export function Tour({ userId, isAdmin, projects, onDone }: { userId: string; isAdmin: boolean; projects: Project[]; onDone: () => void }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const first = projects[0];
  const base = first ? `/projekte/${first.id}` : null;
  const steps: Step[] = [
    { title: 'Willkommen bei PROject', text: 'In zwei Minuten durch die wichtigsten Bereiche. Du kannst jederzeit überspringen und das Tutorial später über „Tutorial“ unten links neu starten.' },
    { title: 'Dashboard', text: 'Soll und Ist deiner Arbeit über alle Projekte: offen, überfällig, fällig, blockiert. Darunter alles, was dir zugewiesen oder vererbt ist, geklammert als Projekt › Teilprojekt › Arbeitspaket › Task.', target: '[data-tour="dashboard"]', go: '/dashboard' },
    { title: 'Postfach', text: 'Das gemeinsame Postfach zeigt die Mails aller Ansichten, für die du Leserecht hast. Aus jeder Mail lassen sich Arbeitspakete und Doku-Seiten erzeugen.', target: '[data-tour="postfach"]', go: '/postfach' },
    { title: 'Kalender', text: 'Deadlines, Starts und Meilensteine aller Projekte als Monat, Woche oder Agenda.', target: '[data-tour="kalender"]', go: '/kalender' },
    { title: 'Projekte', text: 'Alle aktiven Projekte mit Fortschritt und nächstem Meilenstein. Ein Klick öffnet die Bereiche des Projekts. „Alle Arbeitspakete“ darunter listet die Arbeitspakete aller Projekte.', target: '[data-tour="projekte"]', go: '/projekte' },
    ...(base ? [
      { title: 'Ein Projekt', text: 'Ein Klick auf das Projekt öffnet seine Bereiche: Übersicht, Arbeitspakete, Postfach, Doku und, für die Projektleitung, Einstellungen.', target: '[data-tour="projekt"]', go: base },
      { title: 'Übersicht', text: 'Kennzahlen, Warnungen und Eskalationen des Projekts auf einen Blick.', target: '[data-tour="p-uebersicht"]', go: base },
      { title: 'Arbeitspakete', text: 'Board mit Spalten, Swimlanes je Teilprojekt, Labels und WIP-Limits. Darüber die Reiter Plan (Gantt), Kalender und Zeiten. Tastatur: n neues Arbeitspaket, f filtern, q nur meine.', target: '[data-tour="p-aufgaben"]', go: `${base}/board` },
      { title: 'Postfach des Projekts', text: 'Mail-Ansichten des Projektkontos und freigegebene persönliche Ansichten. Rechte hängen an der Ansicht.', target: '[data-tour="p-postfach"]', go: `${base}/mail` },
      { title: 'Doku', text: 'Seiten mit Unterseiten wie in einem Wiki: Protokolle, Berichte, Konzepte. Oberseiten geben Vorlage und PDF-Layout vor. Seiten lassen sich per Link freigeben und als PDF versenden.', target: '[data-tour="p-doku"]', go: `${base}/doku` }
    ] : []),
    { title: 'Suche und Benachrichtigungen', text: 'Die Suche findet Arbeitspakete, Seiten und Mails. Die Glocke sammelt Zuweisungen, Erwähnungen, Fristen und Eskalationen.', target: '.topbar .search-box' },
    { title: 'Benutzereinstellungen', text: 'Name, Theme (hell/dunkel), Sprache und Passwort.', target: '[data-tour="benutzer"]' },
    { title: 'Konfiguration', text: 'Mail-Konten anbinden: persönlich, je Projekt oder für die Organisation. Geteilt werden nie ganze Konten, sondern nur gefilterte Ansichten.', target: '[data-tour="mailkonten"]' },
    ...(isAdmin ? [{ title: 'Verwaltung', text: 'Benutzer einladen, Gruppen pflegen, PDF-Stil und Vorlagen des Mandanten, Audit-Export.', target: '[data-tour="verwaltung"]' }] : []),
    { title: 'Fertig', text: 'Viel Erfolg. Das Tutorial lässt sich jederzeit unten links neu starten.' }
  ];
  const step = steps[Math.min(i, steps.length - 1)];
  useEffect(() => { if (step.go && loc.pathname !== step.go) nav(step.go); }, [i]);
  useLayoutEffect(() => {
    const measure = () => {
      if (!step.target) { setRect(null); return; }
      const el = document.querySelector(step.target) as HTMLElement | null;
      if (!el) { setRect(null); return; }
      el.scrollIntoView({ block: 'nearest' });
      setRect(el.getBoundingClientRect());
    };
    measure();
    const h = setTimeout(measure, 350);
    window.addEventListener('resize', measure);
    return () => { clearTimeout(h); window.removeEventListener('resize', measure); };
  }, [i, loc.pathname, step.target]);
  const finish = () => { try { localStorage.setItem(`pt_tour_${userId}`, '1'); } catch { /* ignore */ } onDone(); };
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(); if (e.key === 'ArrowRight' || e.key === 'Enter') setI((x) => Math.min(x + 1, steps.length - 1)); if (e.key === 'ArrowLeft') setI((x) => Math.max(x - 1, 0)); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [steps.length]);
  const last = i >= steps.length - 1;
  // Tooltip rechts neben dem Ziel, sonst darunter, ohne Ziel mittig
  const pos: React.CSSProperties = rect
    ? rect.right + 380 < window.innerWidth
      ? { top: Math.max(12, Math.min(rect.top, window.innerHeight - 260)), left: rect.right + 14 }
      : { top: Math.min(rect.bottom + 12, window.innerHeight - 260), left: Math.max(12, Math.min(rect.left, window.innerWidth - 380)) }
    : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  return (
    <div className="tour">
      {rect ? <div className="tour-spot" style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} /> : <div className="tour-dim" />}
      <div className="tour-box" style={pos} role="dialog" aria-label="Tutorial">
        <div className="muted small">Schritt {i + 1} von {steps.length}</div>
        <h3>{step.title}</h3>
        <p>{step.text}</p>
        <div className="row">
          {!last && <button className="btn sm link" onClick={finish}>Überspringen</button>}
          <span className="right" />
          {i > 0 && <button className="btn sm" onClick={() => setI(i - 1)}>Zurück</button>}
          {last ? <button className="btn sm primary" onClick={finish}>Los geht’s</button> : <button className="btn sm primary" onClick={() => setI(i + 1)}>Weiter</button>}
        </div>
      </div>
    </div>
  );
}

export function tourDone(userId: string): boolean {
  try { return localStorage.getItem(`pt_tour_${userId}`) === '1'; } catch { return true; }
}
