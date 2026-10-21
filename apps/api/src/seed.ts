import { hashPassword } from './auth.js';
import { createDb, runMigrations, type Db } from './db.js';
import { BUILTIN_TEMPLATES, createDefaultFolders } from './docs/service.js';
import { newMailCode } from './tasks/service.js';
import { mdToHtml } from './docs/html.js';

export const DEMO_PASSWORD = 'demo1234';

/** Legt Demodaten an, wenn noch kein Mandant existiert. */
export async function seedIfEmpty(db: Db): Promise<boolean> {
  const any = await db.maybeOne(`select id from orgs limit 1`);
  if (any) return false;
  await seed(db);
  return true;
}

export async function seed(db: Db) {
  const org = await db.one(`insert into orgs (name) values ('Demo GmbH') returning id`);
  const pw = hashPassword(DEMO_PASSWORD);
  const mk = async (email: string, name: string, role: string) =>
    (await db.one(`insert into users (org_id, email, name, password_hash, global_role) values ($1,$2,$3,$4,$5) returning id`, [org.id, email, name, pw, role])).id as string;
  const admin = await mk('admin@demo.local', 'Alex Admin', 'org_admin');
  const pl = await mk('pl@demo.local', 'Petra Lenz', 'project_creator');
  const anna = await mk('anna@demo.local', 'Anna Berger', 'project_creator');
  const max = await mk('max@demo.local', 'Max Keller', 'user');
  const leser = await mk('leser@demo.local', 'Lea Reuter', 'user');

  for (const t of BUILTIN_TEMPLATES) {
    await db.query(`insert into doc_templates (org_id, key, name, content_md, content_html) values (null, $1, $2, $3, $4) on conflict do nothing`, [t.key, t.name, t.contentMd, mdToHtml(t.contentMd)]);
  }

  // Projekt 1: Website-Relaunch
  const web = await db.one(
    `insert into projects (org_id, key, name, description, mail_address, created_by, time_tracking_enabled, budget_hours) values ($1,'WEB','Website-Relaunch','Neue Unternehmenswebsite mit CMS, Go-Live Q1 2027.','projekt-web@demo.local',$2,true,1200) returning id`,
    [org.id, pl]
  );
  const member = (p: string, u: string, role: string, extra: Partial<Record<'is_deputy' | 'can_edit_plan' | 'can_approve' | 'can_finalize' | 'can_use_ai', boolean>> = {}) =>
    db.query(
      `insert into project_members (project_id, user_id, role, is_deputy, can_edit_plan, can_approve, can_finalize, can_use_ai) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [p, u, role, extra.is_deputy ?? false, extra.can_edit_plan ?? role === 'pl', extra.can_approve ?? role === 'pl', extra.can_finalize ?? role === 'pl', extra.can_use_ai ?? role !== 'reader']
    );
  await member(web.id, pl, 'pl');
  await member(web.id, anna, 'pl', { is_deputy: true });
  await member(web.id, max, 'member', { can_edit_plan: true });
  await member(web.id, leser, 'reader');

  const cols: Record<string, string> = {};
  for (const [i, [name, kind]] of ([['Geplant', 'backlog'], ['Offen', 'active'], ['In Arbeit', 'active'], ['In Prüfung', 'active'], ['Wartet', 'waiting'], ['Zurückgestellt', 'parked'], ['Erledigt', 'done']] as const).entries()) {
    const c = await db.one(`insert into board_columns (project_id, name, position, is_done, wip_limit, kind) values ($1,$2,$3,$4,$5,$6) returning id`, [web.id, name, i, kind === 'done', name === 'In Arbeit' ? 3 : null, kind]);
    cols[name] = c.id;
  }
  const labels: Record<string, string> = {};
  for (const [i, [name, color]] of [['Design', 'purple'], ['Technik', 'blue'], ['Vertrag', 'orange'], ['Blocker', 'red'], ['Content', 'green']].entries()) {
    labels[name] = (await db.one(`insert into labels (project_id, name, color, position) values ($1,$2,$3,$4) returning id`, [web.id, name, color, i])).id;
  }
  const sp = async (name: string, resp: string | null, start: string, end: string, pos: number) =>
    (await db.one(`insert into subprojects (project_id, name, responsible_user_id, start_date, end_date, position) values ($1,$2,$3,$4,$5,$6) returning id`, [web.id, name, resp, start, end, pos])).id as string;
  const konzept = await sp('Konzept & Design', max, '2026-10-01', '2026-11-15', 0);
  const umsetzung = await sp('Umsetzung CMS', null, '2026-11-01', '2027-01-31', 1);
  const golive = await sp('Go-Live', anna, '2027-02-01', '2027-02-28', 2);
  await db.query(`insert into milestones (project_id, subproject_id, name, date) values ($1,$2,'Design-Freigabe','2026-11-15'), ($1,$3,'Content Freeze','2027-01-20'), ($1,$4,'Go-Live','2027-02-25')`, [web.id, konzept, umsetzung, golive]);

  const task = async (t: { title: string; sp?: string | null; col: string; prio?: string; start?: string | null; due?: string | null; resp?: string | null; email?: string | null; desc?: string | null; pos?: number }) =>
    (await db.one(
      `insert into tasks (project_id, subproject_id, column_id, title, description, priority, start_date, due_date, responsible_user_id, responsible_email, position, mail_code, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id, mail_code`,
      [web.id, t.sp ?? null, cols[t.col], t.title, t.desc ?? null, t.prio ?? 'normal', t.start ?? null, t.due ?? null, t.resp ?? null, t.email ?? null, t.pos ?? 0, newMailCode(), pl]
    )) as { id: string; mail_code: string };

  const t1 = await task({ title: 'Zielgruppen und Personas beschreiben', sp: konzept, col: 'Erledigt', start: '2026-10-01', due: '2026-10-10', desc: 'Drei Personas aus den Interviews ableiten.' });
  const t2 = await task({ title: 'Wireframes Startseite und Produktseiten', sp: konzept, col: 'In Arbeit', prio: 'high', start: '2026-10-08', due: '2026-10-24', desc: 'Desktop und Mobil, Review mit Geschäftsführung.' });
  const t3 = await task({ title: 'Designsystem: Farben, Typografie, Komponenten', sp: konzept, col: 'Offen', start: '2026-10-20', due: '2026-11-12', resp: anna, pos: 1 });
  const t4 = await task({ title: 'Angebot Agentur Müller-Design prüfen', sp: konzept, col: 'In Prüfung', prio: 'high', due: '2026-10-18', email: 'k.mueller@mueller-design.de', desc: 'Angebot vom 12.10. liegt per Mail vor. Rückfragen zu Lizenzen klären.' });
  const t5 = await task({ title: 'CMS-Auswahl: Headless vs. klassisch', sp: umsetzung, col: 'Offen', prio: 'critical', start: '2026-11-01', due: '2026-11-10', resp: max, desc: 'Entscheidungsvorlage für den Lenkungskreis.' });
  const t6 = await task({ title: 'Hosting und Deployment einrichten', sp: umsetzung, col: 'Offen', start: '2026-11-05', due: '2026-11-30', pos: 1 });
  const t7 = await task({ title: 'Inhalte migrieren (120 Seiten)', sp: umsetzung, col: 'Offen', start: '2026-12-01', due: '2027-02-10', pos: 2, desc: 'Deadline liegt nach dem Teilprojekt-Ende: Konflikt wird markiert.' });
  const t8 = await task({ title: 'Lasttest und Security-Check', sp: golive, col: 'Offen', start: '2027-02-01', due: '2027-02-15' });
  const t9 = await task({ title: 'DNS-Umstellung und Go-Live-Kommunikation', sp: golive, col: 'Offen', prio: 'high', start: '2027-02-20', due: '2027-02-25', pos: 1 });
  await task({ title: 'Projektauftrag unterschreiben lassen', col: 'Erledigt', due: '2026-09-30', desc: 'Ohne Teilprojekt: Zuständigkeit geerbt vom PL.' });
  await db.query(`insert into task_dependencies (predecessor_id, successor_id) values ($1,$2), ($3,$4), ($5,$6)`, [t2.id, t3.id, t5.id, t6.id, t8.id, t9.id]);
  await db.query(`update tasks set estimate_minutes = 960 where id = $1`, [t2.id]);
  await db.query(`update tasks set estimate_minutes = 2400 where id = $1`, [t3.id]);
  await db.query(`update tasks set estimate_minutes = 1200 where id = $1`, [t5.id]);
  await db.query(`insert into time_entries (project_id, task_id, user_id, date, minutes, note) values ($1,$2,$3,current_date - 3, 240, 'Wireframes Startseite'), ($1,$2,$3,current_date - 1, 180, 'Produktübersicht'), ($1,$4,$5,current_date - 2, 90, 'Angebot gelesen, Rückfragen notiert')`, [web.id, t2.id, max, t4.id, pl]);
  const tag = (t: { id: string }, ...names: string[]) => Promise.all(names.map((n) => db.query(`insert into task_labels (task_id, label_id) values ($1,$2)`, [t.id, labels[n]])));
  await tag(t1, 'Design'); await tag(t2, 'Design'); await tag(t3, 'Design', 'Technik'); await tag(t4, 'Vertrag', 'Design'); await tag(t5, 'Technik', 'Blocker'); await tag(t6, 'Technik'); await tag(t7, 'Content'); await tag(t8, 'Technik'); await tag(t9, 'Technik', 'Content');
  // W6: wiederkehrende Arbeitspaket (Statusbericht jeden Freitag, nächste nach Erledigung)
  const friday = (() => { const d = new Date(); d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7)); return d.toISOString().slice(0, 10); })();
  await db.query(
    `insert into tasks (project_id, column_id, title, description, priority, due_date, responsible_user_id, position, mail_code, created_by, recurrence) values ($1,$2,'Wochen-Statusbericht an Geschäftsführung','Statusbericht aus Vorlage erstellen, final setzen, an Verteiler senden.','normal',$3,$4,5,$5,$4,$6)`,
    [web.id, cols['Offen'], friday, pl, newMailCode(), JSON.stringify({ freq: 'weekly', interval: 1, mode: 'after_done' })]
  );
  // Zusätzlich ein Konflikt: t6 startet vor Ende von t5.
  await db.query(`insert into task_dependencies (predecessor_id, successor_id) values ($1,$2)`, [t5.id, t7.id]);
  for (const [i, c] of ['Startseite', 'Produktübersicht', 'Produktdetail', 'Kontakt'].entries()) {
    await db.query(`insert into checklist_items (task_id, title, done, position) values ($1,$2,$3,$4)`, [t2.id, c, i < 2, i]);
  }
  await db.query(`insert into task_comments (task_id, user_id, body) values ($1,$2,'Erste Version der Wireframes liegt im Ordner Konzepte. Feedback bis Freitag.')`, [t2.id, max]);
  await db.query(`insert into project_contacts (project_id, email, name) values ($1,'k.mueller@mueller-design.de','Katrin Müller'), ($1,'it@hosting-partner.de','Hosting-Partner Support')`, [web.id]);

  // Doku
  await createDefaultFolders(db, web.id);
  const folders = await db.query(`select id, name from doc_folders where project_id = $1`, [web.id]);
  const fid = (n: string) => folders.rows.find((f: any) => f.name === n).id as string;
  await db.query(`update doc_folders set distribution_list = $2 where id = $1`, [fid('Protokolle'), JSON.stringify(['gf@demo.local', 'k.mueller@mueller-design.de'])]);
  const page = async (p: { title: string; folder: string; parent?: string | null; status: string; md: string; by: string; template?: string | null; versions?: string[]; settings?: Record<string, unknown> }) => {
    const r = await db.one(
      `insert into doc_pages (project_id, folder_id, parent_page_id, title, content_md, content_html, status, version, template_key, settings, created_by, updated_by, finalized_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11, case when $7 = 'final' then now() else null end) returning id`,
      [web.id, fid(p.folder), p.parent ?? null, p.title, p.md, mdToHtml(p.md), p.status, (p.versions?.length ?? 0) + 1, p.template ?? null, JSON.stringify(p.settings ?? {}), p.by]
    );
    let v = 1;
    for (const old of p.versions ?? []) {
      await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,$2,$3,$4,$5,'draft',$6)`, [r.id, v++, p.title, old, mdToHtml(old), p.by]);
    }
    await db.query(`insert into doc_page_versions (page_id, version, title, content_md, content_html, status, saved_by) values ($1,$2,$3,$4,$5,$6,$7)`, [r.id, v, p.title, p.md, mdToHtml(p.md), p.status, p.by]);
    return r.id as string;
  };
  // Oberseite der Besprechungsreihe: Zusammenfassung + Teilnehmer, Protokolle als Unterseiten mit vererbter Vorlage
  const jfTop = await page({
    title: 'JF Auftraggeber', folder: 'Protokolle', status: 'final', by: pl, template: 'reihe',
    settings: { kind: 'series', childTemplateKey: 'protokoll', showChildren: true, pdf: { headerText: 'Website-Relaunch · Jour fixe Auftraggeber', footerText: 'Protokoll · vertraulich' } },
    md: `# JF Auftraggeber

## Zusammenfassung

Wöchentlicher Jour fixe mit der Geschäftsführung. Entscheidungen zu Budget, Agentur und Terminen fallen hier. Stand: Agentur beauftragt, Go-Live 25.02.2027 bestätigt.

## Teilnehmer

| Name | Rolle | Organisation |
| --- | --- | --- |
| Petra Lenz | Projektleitung | Demo GmbH |
| Anna Berger | Stellvertretung | Demo GmbH |
| Geschäftsführung | Auftraggeber | Demo GmbH |
| Katrin Müller | Agentur (bei Bedarf) | Müller-Design |

## Rhythmus und Verteiler

- Rhythmus: freitags 10:00, 30 Minuten
- Verteiler: gf@demo.local, k.mueller@mueller-design.de
- Ablage der Protokolle: Unterseiten dieser Seite
`
  });
  const auftrag = await page({
    title: 'Projektauftrag Website-Relaunch', folder: 'Konzepte', status: 'final', by: pl,
    versions: ['# Projektauftrag\n\nEntwurf.'],
    md: `# Projektauftrag Website-Relaunch

## Ziel
Neue Unternehmenswebsite mit modernem CMS, mehrsprachig (DE/EN), barrierearm nach WCAG 2.1 AA. Go-Live bis **25.02.2027**.

## Umfang
- Konzept und Design (Personas, Wireframes, Designsystem)
- CMS-Auswahl und Umsetzung
- Migration von rund 120 Seiten
- Hosting, Betrieb, Lasttest

## Nicht im Umfang
- Online-Shop
- Kundenportal

## Organisation
| Rolle | Person |
| --- | --- |
| Projektleitung | Petra Lenz |
| Stellvertretung | Anna Berger |
| Design | Max Keller, Agentur Müller-Design |

## Budget
180.000 € zzgl. Hosting.`
  });
  await page({
    title: 'Anforderungen Barrierefreiheit', folder: 'Konzepte', parent: auftrag, status: 'review', by: max,
    md: `# Anforderungen Barrierefreiheit

Grundlage: WCAG 2.1 AA, BITV 2.0.

## Pflicht
- Kontrast mindestens 4,5:1 für Fließtext
- Vollständige Tastaturbedienung
- Alternativtexte für alle informativen Bilder
- Fokus sichtbar

## Prüfung
Automatisiert (axe) im Build, manuell vor Go-Live durch externen Prüfer.`
  });
  await page({
    title: 'Protokoll JF Auftraggeber 02.10.2026', folder: 'Protokolle', parent: jfTop, status: 'final', by: pl, template: 'protokoll',
    md: `# Protokoll 2026-10-02

**Besprechung:** JF Auftraggeber
**Datum:** 2026-10-02
**Teilnehmer:** Petra Lenz, Anna Berger, Geschäftsführung

## Agenda
1. Stand der Arbeitspakete
2. Agenturauswahl
3. Termine

## Beschlüsse
- Agentur Müller-Design wird angefragt, Entscheidung bis 18.10.
- Go-Live bleibt bei 25.02.2027.

## Arbeitspakete
| Arbeitspaket | Zuständig | Fällig |
| --- | --- | --- |
| Angebot Müller-Design prüfen | Petra Lenz | 18.10.2026 |
| Wireframes vorlegen | Max Keller | 24.10.2026 |

## Nächster Termin
16.10.2026, 10:00 Uhr`
  });
  await page({
    title: 'Protokoll JF Auftraggeber 16.10.2026', folder: 'Protokolle', parent: jfTop, status: 'draft', by: anna, template: 'protokoll',
    md: `# Protokoll 2026-10-16

**Besprechung:** JF Auftraggeber
**Datum:** 2026-10-16
**Teilnehmer:** 

## Agenda
1. Stand der Arbeitspakete
2. Offene Punkte: Angebot Müller-Design
3. Planänderungen

## Beschlüsse
- 

## Arbeitspakete
| Arbeitspaket | Zuständig | Fällig |
| --- | --- | --- |
|  |  |  |

## Nächster Termin
`
  });
  await page({
    title: 'Statusbericht KW 41', folder: 'Berichte', status: 'review', by: pl, template: 'statusbericht',
    md: `# Statusbericht KW 41

## Zusammenfassung
Ampel: 🟡 – Agenturentscheidung steht aus, Wireframes im Plan.

## Fortschritt seit letztem Bericht
- Personas abgeschlossen
- Wireframes Startseite und Produktübersicht fertig

## Nächste Schritte
- Angebot Müller-Design bewerten (bis 18.10.)
- Designsystem starten (20.10.)

## Risiken und Hindernisse
| Risiko | Auswirkung | Maßnahme |
| --- | --- | --- |
| Agentur nicht verfügbar | Design verzögert sich 3 Wochen | Zweite Agentur anfragen |
| Content-Migration unterschätzt | Go-Live gefährdet | Frühzeitig Redaktion einbinden |`
  });

  // Mail: Projektkonto (dev) mit Ansicht für alle Mitglieder
  const projAcc = await db.one(
    `insert into mail_accounts (org_id, type, project_id, managed_project_id, name, address, provider) values ($1,'project',$2,$2,'Projektpostfach WEB','projekt-web@demo.local','dev') returning id`,
    [org.id, web.id]
  );
  const projUse = await db.one(`insert into mail_account_uses (org_id, account_id, use, project_id, is_default) values ($1,$2,'project',$3,true) returning id`, [org.id, projAcc.id, web.id]);
  await db.query(`update projects set mail_address = 'projekt-web@demo.local' where id = $1`, [web.id]);
  const projView = await db.one(
    `insert into mail_views (account_id, use_id, project_id, name, filter, created_by) values ($1,$2,$3,'Projektpostfach',$4,$5) returning id`,
    [projAcc.id, projUse.id, web.id, JSON.stringify({}), pl]
  );
  await db.query(`insert into mail_view_rights (view_id, role, can_read, can_draft, can_send, can_ai, can_create_task) values ($1,'pl',true,true,true,true,true), ($1,'member',true,true,false,true,true), ($1,'reader',true,false,false,false,false)`, [projView.id]);
  const agenturView = await db.one(
    `insert into mail_views (account_id, use_id, project_id, name, filter, created_by) values ($1,$2,$3,'Agentur Müller-Design',$4,$5) returning id`,
    [projAcc.id, projUse.id, web.id, JSON.stringify({ from: ['@mueller-design.de'] }), pl]
  );
  await db.query(`insert into mail_view_rights (view_id, role, can_read, can_draft, can_send, can_ai, can_create_task) values ($1,'pl',true,true,true,true,true), ($1,'member',true,true,false,false,true)`, [agenturView.id]);

  // Persönliches Konto der PL mit einer geteilten Ansicht (nur Hosting-Partner)
  const orgAcc = await db.one(`insert into mail_accounts (org_id, type, name, address, provider) values ($1,'org','Org-Postfach','noreply@demo.local','dev') returning id`, [org.id]);
  await db.query(`insert into mail_account_uses (org_id, account_id, use) values ($1,$2,'org')`, [org.id, orgAcc.id]);
  const lenk = await db.one(`insert into groups (org_id, name, description) values ($1,'Lenkungskreis','Entscheider und Budgetverantwortliche') returning id`, [org.id]);
  await db.query(`insert into group_members (group_id, user_id) values ($1,$2), ($1,$3)`, [lenk.id, pl, anna]);
  const vertrag = await db.one(`insert into subprojects (project_id, name, responsible_user_id, position, restricted) values ($1,'Vertrag und Budget',$2,99,true) returning id`, [web.id, anna]);
  await db.query(`insert into subproject_access (subproject_id, group_id) values ($1,$2)`, [vertrag.id, lenk.id]);
  await db.query(`insert into tasks (project_id, subproject_id, column_id, title, description, priority, due_date, created_by, mail_code, position) select $1, $2, id, 'Agenturvertrag verhandeln', 'Vertraulich: Konditionen, Haftung, Laufzeit', 'high', $3, $4, $5, 50 from board_columns where project_id = $1 and kind = 'active' order by position limit 1`, [web.id, vertrag.id, '2026-11-15', pl, 'c0ffee11']);
  const persAcc = await db.one(
    `insert into mail_accounts (org_id, type, owner_user_id, managed_user_id, name, address, provider) values ($1,'personal',$2,$2,'Petra Lenz (persönlich)','pl@demo.local','dev') returning id`,
    [org.id, pl]
  );
  const persUse = await db.one(`insert into mail_account_uses (org_id, account_id, use, user_id) values ($1,$2,'personal',$3) returning id`, [org.id, persAcc.id, pl]);
  const hostingView = await db.one(
    `insert into mail_views (account_id, use_id, project_id, name, filter, created_by) values ($1,$2,$3,'Hosting-Partner (aus Postfach P. Lenz)',$4,$5) returning id`,
    [persAcc.id, persUse.id, web.id, JSON.stringify({ from: ['@hosting-partner.de'] }), pl]
  );
  await db.query(`insert into mail_view_rights (view_id, user_id, can_read, can_draft, can_send, can_ai, can_create_task) values ($1,$2,true,true,false,true,true)`, [hostingView.id, max]);

  // Projekt 2: ERP-Einführung (Anna PL, Petra Mitglied) für "Meine Arbeitspakete"
  const erp = await db.one(
    `insert into projects (org_id, key, name, description, created_by) values ($1,'ERP','ERP-Einführung','Ablösung des Altsystems durch ein neues ERP.',$2) returning id`,
    [org.id, anna]
  );
  await member(erp.id, anna, 'pl');
  await member(erp.id, pl, 'member');
  await member(erp.id, max, 'member');
  const erpCols: string[] = [];
  for (const [i, [name, kind]] of ([['Backlog', 'backlog'], ['Sprint', 'active'], ['Test', 'active'], ['Fertig', 'done']] as const).entries()) {
    erpCols.push((await db.one(`insert into board_columns (project_id, name, position, is_done, kind) values ($1,$2,$3,$4,$5) returning id`, [erp.id, name, i, kind === 'done', kind])).id);
  }
  await createDefaultFolders(db, erp.id);
  await db.query(
    `insert into tasks (project_id, column_id, title, priority, due_date, responsible_user_id, position, mail_code, created_by) values
     ($1,$2,'Anforderungsworkshop Einkauf','high','2026-10-22',$3,0,$4,$5),
     ($1,$2,'Schnittstellenliste Altsystem','normal','2026-10-30',$6,1,$7,$5),
     ($1,$8,'Lastenheft Finanzbuchhaltung','critical','2026-10-20',$5,0,$9,$5)`,
    [erp.id, erpCols[0], pl, newMailCode(), anna, max, newMailCode(), erpCols[1], newMailCode()]
  );

  // Aufgaben (Zwischenebene): CMS-Auswahl in zuweisbare Schritte mit eigenem Log geteilt
  const aufgabe = async (title: string, col: string, resp: string | null, due: string, pos: number) =>
    (await db.one(`insert into tasks (project_id, subproject_id, column_id, title, priority, due_date, responsible_user_id, position, mail_code, created_by, parent_id) values ($1,$2,$3,$4,'normal',$5,$6,$7,$8,$9,$10) returning id`,
      [web.id, umsetzung, cols[col], title, due, resp, pos, newMailCode(), pl, t5.id])).id as string;
  const a1 = await aufgabe('Anforderungen der Fachbereiche sammeln', 'In Arbeit', anna, '2026-11-04', 0);
  await aufgabe('Demos von drei Anbietern', 'Offen', null, '2026-11-08', 1);
  await db.query(`insert into task_comments (task_id, user_id, body) values ($1,$2,'Marketing und Vertrieb befragt, Einkauf folgt am Montag.')`, [a1, anna]);

  await db.query(`insert into audit_log (org_id, project_id, user_id, action, object_type, object_id, details) values ($1,$2,$3,'seed','system',null,'{"note":"Demodaten angelegt"}')`, [org.id, web.id, admin]);

  // Demo-Projekte verhalten sich wie Bestandsprojekte (Entscheidung 6): Agenten selbstständig; neue Projekte starten mit Rückfrage bei wichtigen Schritten
  await db.query(`update projects set agent_policy = '{"mode":"auto"}'::jsonb where org_id = $1`, [org.id]);
  return { org: org.id, users: { admin, pl, anna, max, leser }, projects: { web: web.id, erp: erp.id }, accounts: { project: projAcc.id, personal: persAcc.id }, views: { project: projView.id, agentur: agenturView.id, hosting: hostingView.id }, tasks: { t4: t4.id, t4Code: t4.mail_code, t2: t2.id } };
}

/** Demo-Mails ins Dev-Postfach spielen (nach dem Seed, wenn der MailService steht). */
export async function seedDevMails(db: Db, inject: (accountId: string, m: any) => void, sync: (accountId: string) => Promise<unknown>) {
  const projAcc = await db.maybeOne(`select id, address from mail_accounts where address = 'projekt-web@demo.local'`);
  const persAcc = await db.maybeOne(`select id, address from mail_accounts where address = 'pl@demo.local'`);
  if (!projAcc || !persAcc) return;
  const already = await db.maybeOne(`select id from mails where account_id = $1 limit 1`, [projAcc.id]);
  if (already) return;
  const t4 = await db.maybeOne(`select mail_code from tasks where title like 'Angebot Agentur%'`);
  const d = (daysAgo: number, h = 9) => { const x = new Date(); x.setDate(x.getDate() - daysAgo); x.setHours(h, 0, 0, 0); return x; };
  inject(projAcc.id, { from: { address: 'k.mueller@mueller-design.de', name: 'Katrin Müller' }, to: [projAcc.address], subject: 'Angebot Website-Relaunch – Design und Umsetzung', date: d(4, 10),
    text: 'Guten Tag Frau Lenz,\n\nanbei unser Angebot für Konzept, Design und Frontend-Umsetzung. Gesamtsumme 86.400 € netto, Laufzeit Oktober bis Februar.\n\nZwei Punkte zur Klärung: Schriftlizenzen (ca. 1.200 €/Jahr) und ob die Bildsprache intern produziert wird.\n\nViele Grüße\nKatrin Müller', hasAttachments: true });
  inject(projAcc.id, { from: { address: 'gf@demo.local', name: 'Geschäftsführung' }, to: [projAcc.address], subject: 'Re: Protokoll JF 02.10. – Go-Live-Termin', date: d(3, 14),
    text: 'Danke für das Protokoll. Der Go-Live am 25.02. ist fix, bitte keine Verschiebung einplanen. Für den Lenkungskreis brauche ich bis 10.11. die CMS-Entscheidungsvorlage.\n\nMfG' });
  inject(projAcc.id, { from: { address: 'it@hosting-partner.de', name: 'Hosting-Partner Support' }, to: [projAcc.address], subject: 'Ticket #4471: Staging-Umgebung bereitgestellt', date: d(2, 8),
    text: 'Hallo,\n\ndie Staging-Umgebung steht unter staging.demo.local bereit. Zugangsdaten folgen separat.\n\nSupport-Team' });
  inject(projAcc.id, { from: { address: 'newsletter@cms-vendor.example', name: 'CMS Vendor' }, to: [projAcc.address], subject: 'Webinar: Headless CMS in 30 Minuten', date: d(2, 12),
    text: 'Melden Sie sich jetzt an.' });
  if (t4) {
    inject(projAcc.id, { from: { address: 'k.mueller@mueller-design.de', name: 'Katrin Müller' }, to: [`projekt-web+t${t4.mail_code}@demo.local`], subject: 'Re: Rückfrage Angebot – Lizenzen', date: d(1, 16),
      text: 'Hallo Frau Lenz,\n\ndie Schriftlizenzen können wir alternativ einmalig für 3.900 € einkaufen. Bildsprache: wir schlagen zwei Shootingtage vor.\n\nViele Grüße\nKatrin Müller' });
  }
  inject(persAcc.id, { from: { address: 'it@hosting-partner.de', name: 'Hosting-Partner Support' }, to: [persAcc.address], subject: 'Vertragsverlängerung Hosting 2027', date: d(5, 11),
    text: 'Sehr geehrte Frau Lenz,\n\nIhr Hostingvertrag läuft zum 31.12.2026 aus. Anbei das Angebot zur Verlängerung mit 10 % Rabatt bei 24 Monaten Laufzeit.\n\nMit freundlichen Grüßen' });
  inject(persAcc.id, { from: { address: 'privat@family.example', name: 'Familie' }, to: [persAcc.address], subject: 'Wochenende', date: d(1, 19),
    text: 'Kommst du am Samstag? Diese Mail trifft keine Ansicht und wird nicht gespeichert.' });
  inject(persAcc.id, { from: { address: 'hr@demo.local', name: 'Personalabteilung' }, to: [persAcc.address], subject: 'Urlaubsantrag genehmigt', date: d(6, 9),
    text: 'Ihr Urlaubsantrag wurde genehmigt. Diese Mail trifft keine Ansicht und wird nicht gespeichert.' });
  await sync(projAcc.id);
  await sync(persAcc.id);
}

// Direktaufruf: npm run seed
if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  const db = await createDb();
  await runMigrations(db);
  const did = await seedIfEmpty(db);
  console.log(did ? 'Demodaten angelegt.' : 'Daten vorhanden, kein Seed.');
  await db.close();
}
