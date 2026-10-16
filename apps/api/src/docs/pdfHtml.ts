import PDFDocument from 'pdfkit';
import { parse, HTMLElement, Node, TextNode } from 'node-html-parser';
import { readFile } from 'node:fs/promises';
import type { Db } from '../db.js';
import type { PdfMeta, PdfStyle } from './pdf.js';

type Run = { text: string; bold?: boolean; italic?: boolean; underline?: boolean; code?: boolean; size?: number; color?: string; link?: string };
const BASE = 10.5;

export interface PageLayout extends PdfStyle {
  /** Metadatenblock (Projekt, Version, Datum …) anzeigen */
  showMeta?: boolean;
  /** Kopfzeilentext überschreibt „Firma · Projekt · Titel“ */
  headerText?: string;
}

/**
 * HTML (aus dem WYSIWYG-Editor) → PDF mit pdfkit. Unterstützt Überschriften, Absätze mit Schriftgrößen,
 * Fett/Kursiv/Unterstrichen, Listen (verschachtelt), Tabellen, Bilder (Anhänge, Data-URLs), Zitate, Linien, Links.
 */
export async function htmlToPdf(db: Db, html: string, meta: PdfMeta, layout: PageLayout = {}): Promise<Buffer> {
  const accent = /^#[0-9a-fA-F]{6}$/.test(layout.accentColor ?? '') ? layout.accentColor! : '#1f5eff';
  const doc = new PDFDocument({ bufferPages: true, size: 'A4', margins: { top: 70, bottom: 64, left: 56, right: 56 }, info: { Title: meta.title, Author: meta.author ?? meta.project } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const root = parse(html ?? '');

  // Titel: erste H1 wird Titel, sonst Seitentitel
  let title = meta.title;
  const firstH1 = root.querySelector('h1');
  if (firstH1 && isFirstBlock(root, firstH1)) { title = firstH1.textContent.trim() || title; firstH1.remove(); }
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#111').text(title, left, doc.y, { width });
  doc.moveDown(0.4);
  if (layout.showMeta !== false) {
    const rows: [string, string][] = [['Projekt', meta.project], ['Version', `${meta.version} · ${statusLabel(meta.status)}`], ['Datum', (meta.date ?? new Date()).toLocaleDateString('de-DE')]];
    if (meta.author) rows.push(['Erstellt von', meta.author]);
    if (meta.folder) rows.push(['Ablage', meta.folder]);
    const top = doc.y;
    doc.rect(left, top, width, rows.length * 15 + 10).fillColor('#f3f5f9').fill();
    doc.fillColor('#333').fontSize(9);
    rows.forEach(([k, v], i) => {
      doc.font('Helvetica-Bold').text(k, left + 10, top + 6 + i * 15, { width: 90, lineBreak: false });
      doc.font('Helvetica').text(v, left + 100, top + 6 + i * 15, { width: width - 110, lineBreak: false });
    });
    doc.y = top + rows.length * 15 + 22;
  }
  doc.x = left;
  doc.fillColor('#111').font('Helvetica').fontSize(BASE);

  const ctx: Ctx = { db, doc, accent, width, left, images: new Map() };
  await renderChildren(ctx, root, width, left);

  const range = doc.bufferedPageRange();
  const header = layout.headerText ?? `${layout.company ? layout.company + ' · ' : ''}${meta.project} · ${title}`;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor('#777').text(header, left, 30, { width: width - 120, lineBreak: false, ellipsis: true });
    doc.rect(left, 44, width, 1.5).fillColor(accent).fill();
    doc.fillColor('#777').text(`Seite ${i - range.start + 1} von ${range.count}`, left, doc.page.height - 40, { width, align: 'right', lineBreak: false });
    if (layout.footerText) doc.text(layout.footerText, left, doc.page.height - 40, { width: width - 100, lineBreak: false, ellipsis: true });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

interface Ctx { db: Db; doc: PDFKit.PDFDocument; accent: string; width: number; left: number; images: Map<string, Buffer | null> }

function statusLabel(s: string) { return s === 'final' ? 'Final' : s === 'review' ? 'In Prüfung' : 'Entwurf'; }

function isFirstBlock(root: HTMLElement, el: HTMLElement): boolean {
  for (const c of root.childNodes) {
    if (c.nodeType === 3 && !c.textContent.trim()) continue;
    return c === el;
  }
  return false;
}

const strip = (t: string) => t.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ');

function fontSizeOf(style: string | undefined): number | undefined {
  const m = /font-size:\s*([\d.]+)(px|pt|em|rem)?/i.exec(style ?? '');
  if (!m) return undefined;
  const v = parseFloat(m[1]);
  const unit = (m[2] ?? 'px').toLowerCase();
  const px = unit === 'pt' ? v * 1.333 : unit === 'em' || unit === 'rem' ? v * 14 : v;
  return Math.max(6, Math.min(40, px * 0.75));
}

/** Inline-Knoten zu Läufen. */
function inlineRuns(node: Node, ctx: Omit<Run, 'text'> = {}): Run[] {
  if (node.nodeType === 3) return [{ ...ctx, text: (node as TextNode).rawText.replace(/&nbsp;/g, ' ') }].map((r) => ({ ...r, text: decode(r.text) }));
  const el = node as HTMLElement;
  const tag = el.rawTagName?.toLowerCase();
  let next: Omit<Run, 'text'> = { ...ctx };
  if (tag === 'strong' || tag === 'b') next.bold = true;
  if (tag === 'em' || tag === 'i') next.italic = true;
  if (tag === 'u') next.underline = true;
  if (tag === 'code') next.code = true;
  if (tag === 'a') next.link = el.getAttribute('href') ?? undefined;
  const fs = fontSizeOf(el.getAttribute('style'));
  if (fs) next.size = fs;
  const cm = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{6})/i.exec(el.getAttribute('style') ?? '');
  if (cm) next.color = cm[1];
  if (tag === 'br') return [{ ...next, text: '\n' }];
  if (tag === 'img') return [{ ...next, text: `[Bild${el.getAttribute('alt') ? ': ' + el.getAttribute('alt') : ''}]` }];
  const out: Run[] = [];
  for (const c of el.childNodes) out.push(...inlineRuns(c, next));
  return out;
}

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function fontFor(r: Run): string {
  if (r.code) return 'Courier';
  if (r.bold && r.italic) return 'Helvetica-BoldOblique';
  if (r.bold) return 'Helvetica-Bold';
  if (r.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

function writeRuns(doc: PDFKit.PDFDocument, rs: Run[], opts: { width: number; x: number; size?: number; lineGap?: number; color?: string; align?: 'left' | 'center' | 'right' }) {
  const lines: Run[][] = [[]];
  for (const r of rs) {
    r.text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([]);
      const text = strip(part);
      if (!text.trim() && !text) return;
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last.bold === r.bold && last.italic === r.italic && last.underline === r.underline && last.code === r.code && last.size === r.size && last.color === r.color && last.link === r.link) last.text += text;
      else line.push({ ...r, text });
    });
  }
  for (const line of lines) {
    const segs = line.map((r, i) => ({ ...r, text: i === 0 ? r.text.replace(/^\s+/, '') : r.text })).filter((r) => r.text.length);
    if (segs.length === 0) { doc.moveDown(0.6); continue; }
    segs.forEach((r, i) => {
      const size = r.size ?? opts.size ?? BASE;
      doc.font(fontFor(r)).fontSize(r.code ? size - 1 : size).fillColor(r.color ?? opts.color ?? '#111');
      const o: PDFKit.Mixins.TextOptions = { width: opts.width, lineGap: opts.lineGap ?? 2, continued: i < segs.length - 1, underline: Boolean(r.underline), link: r.link, align: opts.align };
      if (i === 0) doc.text(r.text, opts.x, doc.y, o); else doc.text(r.text, o);
    });
  }
  doc.font('Helvetica').fontSize(BASE).fillColor('#111');
}

function alignOf(el: HTMLElement): 'left' | 'center' | 'right' | undefined {
  const m = /text-align:\s*(left|center|right)/i.exec(el.getAttribute('style') ?? '');
  return (m?.[1] as any) ?? undefined;
}

async function renderChildren(ctx: Ctx, parent: Node, width: number, x: number) {
  for (const child of parent.childNodes) await renderBlock(ctx, child, width, x);
}

async function renderBlock(ctx: Ctx, node: Node, width: number, x: number) {
  const { doc, accent } = ctx;
  if (node.nodeType === 3) {
    const t = (node as TextNode).rawText;
    if (t.trim()) { writeRuns(doc, [{ text: decode(t) }], { width, x }); doc.moveDown(0.5); }
    return;
  }
  const el = node as HTMLElement;
  const tag = el.rawTagName?.toLowerCase();
  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const depth = Number(tag[1]);
      const sizes = [18, 14.5, 12.5, 11.5, 11, 11];
      if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
      doc.moveDown(depth <= 2 ? 0.8 : 0.5);
      doc.font('Helvetica-Bold').fontSize(sizes[depth - 1]).fillColor(depth <= 2 ? accent : '#111').text(strip(el.textContent).trim(), x, doc.y, { width, align: alignOf(el) });
      if (depth === 2) { doc.rect(x, doc.y + 2, width, 0.6).fillColor('#d9dee7').fill(); doc.y += 6; }
      doc.moveDown(0.3).fillColor('#111').font('Helvetica').fontSize(BASE);
      break;
    }
    case 'p': {
      const img = el.querySelector('img');
      if (img && !el.textContent.trim()) { await renderImage(ctx, img, width, x); break; }
      const runs = inlineRuns(el);
      if (runs.every((r) => !r.text.trim())) { doc.moveDown(0.6); break; }
      writeRuns(doc, runs, { width, x, align: alignOf(el) });
      doc.moveDown(0.55);
      break;
    }
    case 'ul': case 'ol': {
      const items = el.childNodes.filter((c) => c.nodeType === 1 && (c as HTMLElement).rawTagName?.toLowerCase() === 'li') as HTMLElement[];
      const start = Number(el.getAttribute('start') ?? 1) || 1;
      let i = 0;
      for (const li of items) {
        const task = li.getAttribute('data-type') === 'taskItem' || li.querySelector('input[type=checkbox]');
        const checked = li.getAttribute('data-checked') === 'true' || Boolean(li.querySelector('input[checked]'));
        const bullet = task ? (checked ? '☑' : '☐') : tag === 'ol' ? `${start + i}.` : '•';
        i++;
        const inline: Node[] = [];
        const nested: HTMLElement[] = [];
        for (const c of li.childNodes) {
          const t = c.nodeType === 1 ? (c as HTMLElement).rawTagName?.toLowerCase() : '';
          if (t === 'ul' || t === 'ol') nested.push(c as HTMLElement);
          else if (t === 'p' || t === 'div' || t === 'label') inline.push(...(c as HTMLElement).childNodes.filter((n) => !(n.nodeType === 1 && (n as HTMLElement).rawTagName?.toLowerCase() === 'input')));
          else if (!(t === 'input')) inline.push(c);
        }
        const y = doc.y;
        doc.font('Helvetica').fontSize(BASE).fillColor('#111').text(bullet, x + 6, y, { width: 20, lineBreak: false });
        doc.y = y;
        const runs = inline.flatMap((n) => inlineRuns(n));
        if (runs.some((r) => r.text.trim())) writeRuns(doc, runs, { width: width - 24, x: x + 24, lineGap: 1 }); else doc.moveDown(0.8);
        for (const n of nested) await renderBlock(ctx, n, width - 16, x + 16);
      }
      doc.x = x;
      doc.moveDown(0.5);
      break;
    }
    case 'table': {
      const rows = el.querySelectorAll('tr');
      if (!rows.length) break;
      const cols = Math.max(...rows.map((r) => r.querySelectorAll('th, td').length));
      const colW = width / cols;
      doc.font('Helvetica').fontSize(9.5);
      const cellText = (c: HTMLElement) => strip(c.textContent).trim();
      rows.forEach((row, ri) => {
        const cells = row.querySelectorAll('th, td');
        const isHead = cells.length > 0 && cells.every((c) => c.rawTagName.toLowerCase() === 'th');
        const texts = cells.map(cellText);
        const h = Math.max(...texts.map((t) => doc.heightOfString(t || ' ', { width: colW - 10 })), 10) + 9;
        if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
        const y = doc.y;
        if (isHead) doc.rect(x, y, width, h).fillColor(accent).fillOpacity(0.12).fill().fillOpacity(1);
        else if (ri % 2 === 0) doc.rect(x, y, width, h).fillColor('#f6f7fa').fill();
        doc.rect(x, y + h, width, 0.5).fillColor('#d9dee7').fill();
        doc.font(isHead ? 'Helvetica-Bold' : 'Helvetica');
        texts.forEach((t, i) => doc.fillColor('#111').text(t || ' ', x + i * colW + 5, y + 4.5, { width: colW - 10 }));
        doc.y = y + h;
      });
      doc.x = x;
      doc.moveDown(0.8).font('Helvetica').fontSize(BASE);
      break;
    }
    case 'blockquote': {
      const startY = doc.y;
      await renderChildren(ctx, el, width - 14, x + 14);
      doc.rect(x + 2, startY, 2.5, Math.max(4, doc.y - startY - 4)).fillColor(accent).fill();
      doc.x = x; doc.fillColor('#111');
      break;
    }
    case 'pre': {
      const text = decode(el.textContent);
      doc.rect(x, doc.y - 2, width, doc.heightOfString(text, { width: width - 16 }) + 12).fillColor('#f3f5f9').fill();
      doc.font('Courier').fontSize(9).fillColor('#222').text(text, x + 8, doc.y + 4, { width: width - 16, lineGap: 1 });
      doc.x = x; doc.font('Helvetica').fontSize(BASE).fillColor('#111').moveDown(0.7);
      break;
    }
    case 'hr':
      doc.moveDown(0.3).rect(x, doc.y, width, 0.8).fillColor('#d9dee7').fill(); doc.moveDown(0.8);
      break;
    case 'img':
      await renderImage(ctx, el, width, x);
      break;
    case 'div': case 'section': case 'article': case 'body': case 'html':
      await renderChildren(ctx, el, width, x);
      break;
    case 'br':
      doc.moveDown(0.6);
      break;
    default: {
      const runs = inlineRuns(el);
      if (runs.some((r) => r.text.trim())) { writeRuns(doc, runs, { width, x }); doc.moveDown(0.5); }
    }
  }
}

async function loadImage(ctx: Ctx, src: string): Promise<Buffer | null> {
  if (ctx.images.has(src)) return ctx.images.get(src)!;
  let buf: Buffer | null = null;
  try {
    const m = /\/api\/(?:share\/[^/]+\/)?attachments\/([0-9a-f-]{36})/i.exec(src);
    if (m) {
      const a = await ctx.db.maybeOne(`select storage_path, mime from attachments where id = $1`, [m[1]]);
      if (a && /image\/(png|jpe?g)/i.test(a.mime)) buf = await readFile(a.storage_path);
    } else if (/^data:image\/(png|jpe?g);base64,/i.test(src)) {
      buf = Buffer.from(src.split(',')[1], 'base64');
    }
  } catch { buf = null; }
  ctx.images.set(src, buf);
  return buf;
}

async function renderImage(ctx: Ctx, el: HTMLElement, width: number, x: number) {
  const { doc } = ctx;
  const src = el.getAttribute('src') ?? '';
  const buf = await loadImage(ctx, src);
  if (!buf) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#777').text(`[Bild${el.getAttribute('alt') ? ': ' + el.getAttribute('alt') : ''} – nicht eingebettet]`, x, doc.y, { width });
    doc.font('Helvetica').fontSize(BASE).fillColor('#111').moveDown(0.5);
    return;
  }
  const maxW = Math.min(width, Number(el.getAttribute('width')) || width);
  const maxH = 380;
  if (doc.y + 120 > doc.page.height - doc.page.margins.bottom) doc.addPage();
  try {
    doc.image(buf, x, doc.y, { fit: [maxW, maxH] });
    const img = (doc as any).openImage ? (doc as any).openImage(buf) : null;
    const h = img ? Math.min(maxH, (img.height * Math.min(maxW / img.width, maxH / img.height))) : maxH;
    doc.y += h + 8;
  } catch {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor('#777').text('[Bild konnte nicht gerendert werden]', x, doc.y, { width });
    doc.font('Helvetica').fontSize(BASE).fillColor('#111');
  }
  doc.x = x;
}
