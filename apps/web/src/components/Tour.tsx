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
    { title: 'Dashboard', text: 'Ein Klick auf „PROject“ öffnet das Dashboard: Meine Arbeit (Soll/Ist, darunter „Offen für dich“ mit Fragen, Bestätigungen, KI-Vorschlägen, Mail-Entwürfen und Blockern, Termine, geklammert als Projekt › Teilprojekt › Arbeitspaket › Aufgabe › Task), Projekte (Ampel, Fortschritt, Auslastung) und Alle Arbeitspakete. Oben lässt es sich nach einem Projekt filtern; gefiltert ist es das Dashboard des Projekts.', target: '[data-tour="dashboard"]', go: '/dashboard' },
    { title: 'Projekte', text: 'Bis zu fünf angeheftete Projekte stehen immer in der Leiste (☆ anheften, ★ lösen). „Alle Projekte“ klappt die übrigen untereinander aus.', target: '[data-tour="projekte"]' },
    ...(base ? [
      { title: 'Ein Projekt', text: 'Ein Klick auf das Projekt öffnet direkt das Board. Alle Bereiche des Projekts stehen oben als Reiter: Board, Plan, Kalender, Besprechungen, Doku, Risiken, Zeiten, Auswertung, KI und Einstellungen (alle lesen, die Projektleitung ändert).', target: '[data-tour="projekt"]', go: `${base}/board` },
      { title: 'Bereiche des Projekts', text: 'Board mit Spalten, Swimlanes je Teilprojekt, Labels und WIP-Limits; Plan (Gantt), Kalender, Besprechungen; Doku als Wiki mit Protokollen und Berichten; Risiken als RAID-Register. Ein Arbeitspaket teilt sich in Aufgaben und Tasks. Tastatur: n neues Arbeitspaket, f filtern, q nur meine.', target: '.topbar .tabs', go: `${base}/board` }
    ] : []),
    { title: 'Postfach', text: 'Ein Postfach für alles: Mails aller Postfächer, die du lesen darfst, jede einmal; oben nach Postfach und Projekt filtern. „Zur Freigabe“ sammelt die Antwortentwürfe der KI-Agenten. Aus jeder Mail lassen sich Arbeitspakete und Doku-Seiten erzeugen.', target: '[data-tour="postfach"]', go: '/postfach' },
    { title: 'Kalender', text: 'Deadlines, Starts, Meilensteine und Besprechungen aller Projekte als Monat, Woche oder Agenda.', target: '[data-tour="kalender"]', go: '/kalender' },
    { title: 'Workflows', text: 'Vorlagen für feste Abläufe, mandantenweit. Läufe starten isoliert oder in einem Projekt; der Projektfilter zeigt die Läufe eines Projekts.', target: '[data-tour="workflows"]', go: '/workflows' },
    { title: 'Chat', text: 'Der reguläre Weg zwischen Projektbeteiligten: Projektkanäle mit Threads und Direktnachrichten, auch mit KI-Agenten (im Projektkanal per @Name). Am Desktop öffnet der Knopf unten rechts den Messenger mit Suche oben, Gesprächen links und Verlauf rechts.', target: '[data-tour="chat"]' },
    { title: 'Suche und Benachrichtigungen', text: 'Die Suche findet Arbeitspakete, Seiten und Mails. Die Glocke sammelt Zuweisungen, Erwähnungen, Fristen und Eskalationen.', target: '.topbar .search-box' },
    { title: 'Meine Einstellungen', text: 'Profil und Theme, eigene Mail-Konten, Benachrichtigungen, Kalender-Abo und Passwort. Projektpostfächer pflegt die PL in den Projekteinstellungen, die Organisation ihre in der Verwaltung; geteilt werden nie ganze Konten, sondern nur gefilterte Ansichten.', target: '[data-tour="benutzer"]' },
    ...(isAdmin ? [{ title: 'Verwaltung', text: 'Mandant in denselben Reitern wie Projekt und Person: Allgemein, Personen, Mail, Benachrichtigungen, KI, Planung und Board, Sicherheit, Daten.', target: '[data-tour="verwaltung"]' }] : []),
    { title: 'Hilfe', text: 'Kurzanleitung, Handbuch und das KI-Sheet der Agenten stehen unter „Hilfe“ unten links, immer passend zur installierten Version.', target: '[data-tour="hilfe"]' },
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
