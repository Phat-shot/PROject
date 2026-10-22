import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { PdfStyle } from './pdf.js';
import { htmlToPdf, type PageLayout } from './pdfHtml.js';
import { mdToHtml, renderTemplateHtml } from './html.js';

export const uploadDir = path.resolve(process.env.DATA_DIR ?? '.data', 'uploads');

/** Mandanten-Stil (Firma, Akzentfarbe, Fußzeile) für PDFs eines Projekts. */
export async function styleFor(db: Db, projectId: string): Promise<PdfStyle> {
  const o = await db.one(`select o.name, o.settings from projects p join orgs o on o.id = p.org_id where p.id = $1`, [projectId]);
  const st = o.settings ?? {};
  return { company: st.company ?? o.name, accentColor: st.accentColor, footerText: st.footerText };
}

/** Layout einer Seite: Mandanten-Stil, überschrieben von Oberseiten (von oben nach unten) und der Seite selbst. */
export async function layoutFor(db: Db, pageId: string): Promise<PageLayout> {
  const page = await db.one(`select project_id from doc_pages where id = $1`, [pageId]);
  const base: PageLayout = await styleFor(db, page.project_id);
  const chain = await db.query(
    `with recursive anc as (select id, parent_page_id, settings, 0 as depth from doc_pages where id = $1
       union all select p.id, p.parent_page_id, p.settings, a.depth + 1 from doc_pages p join anc a on p.id = a.parent_page_id)
     select settings from anc order by depth desc`,
    [pageId]
  );
  for (const r of chain.rows) Object.assign(base, Object.fromEntries(Object.entries(r.settings?.pdf ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '')));
  return base;
}

/** Vorlage für Unterseiten: nächste Oberseite mit childTemplateKey. */
export async function inheritedTemplate(db: Db, parentPageId: string | null): Promise<string | null> {
  if (!parentPageId) return null;
  const chain = await db.query(
    `with recursive anc as (select id, parent_page_id, settings, 0 as depth from doc_pages where id = $1
       union all select p.id, p.parent_page_id, p.settings, a.depth + 1 from doc_pages p join anc a on p.id = a.parent_page_id)
     select settings from anc order by depth`,
    [parentPageId]
  );
  for (const r of chain.rows) if (r.settings?.childTemplateKey) return r.settings.childTemplateKey;
  return null;
}

export const loadTemplate = (db: Db, key: string, orgId: string) =>
  db.maybeOne(`select * from doc_templates where key = $1 and (org_id = $2 or org_id is null) order by org_id nulls last limit 1`, [key, orgId]);

export const templateHtml = (t: any) => renderTemplateHtml(t.content_html ?? mdToHtml(t.content_md ?? ''));

export const folderName = async (db: Db, folderId: string | null) =>
  folderId ? (await db.maybeOne(`select name from doc_folders where id = $1`, [folderId]))?.name ?? null : null;

/** PDF einer Seite als Mailanhang (Agent, angehaltener PDF-Versand), Dateiname Titel_vVersion.pdf. */
export async function pagePdf(db: Db, page: any, author: string): Promise<{ filename: string; content: Buffer; contentType: string }> {
  const project = await db.one(`select name from projects where id = $1`, [page.project_id]);
  const content = await htmlToPdf(db, page.content_html ?? mdToHtml(page.content_md), { title: page.title, project: project.name, projectId: page.project_id, version: page.version, status: page.status, author, date: new Date(), folder: await folderName(db, page.folder_id) }, await layoutFor(db, page.id));
  return { filename: `${String(page.title).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80)}_v${page.version}.pdf`, content, contentType: 'application/pdf' };
}

/** Versandte PDF an der Seite ablegen (nachvollziehbar, was hinausging). */
export async function storePagePdf(db: Db, page: { id: string; project_id: string }, pdf: { filename: string; content: Buffer }, userId: string): Promise<void> {
  await mkdir(uploadDir, { recursive: true });
  const storage = path.join(uploadDir, `${randomUUID()}.pdf`);
  await writeFile(storage, pdf.content);
  await db.query(`insert into attachments (project_id, page_id, filename, mime, size, storage_path, uploaded_by) values ($1,$2,$3,'application/pdf',$4,$5,$6)`, [page.project_id, page.id, pdf.filename, pdf.content.length, storage, userId]);
}
