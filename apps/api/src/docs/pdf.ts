import PDFDocument from 'pdfkit';
import { marked, type Token, type Tokens } from 'marked';

export interface PdfStyle {
  company?: string;
  accentColor?: string;
  footerText?: string;
}

export interface PdfMeta {
  title: string;
  project: string;
  /** Bild-Anhänge werden nur aus diesem Projekt eingebettet (ohne: keine Anhang-Bilder) */
  projectId?: string;
  version: number;
  status: string;
  author?: string | null;
  date?: Date;
  folder?: string | null;
}

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

const BASE = 10.5;

/**
 * Markdown → PDF mit pdfkit (reines JS, keine Browser-Abhängigkeit).
 * Layout: Kopfzeile mit Firmenname und Akzentlinie, Titelblock mit Metadaten, Überschriften in Akzentfarbe,
 * Fett/Kursiv/Code als Schriftwechsel, Tabellen mit Kopfzeile und Zebra, Fußzeile mit Seitenzahl.
 * Inhalt und Struktur kommen aus der Doku-Seite bzw. Vorlage; der Stil aus den Mandanten-Einstellungen.
 */
export async function markdownToPdf(md: string, meta: PdfMeta, style: PdfStyle = {}): Promise<Buffer> {
  const accent = /^#[0-9a-fA-F]{6}$/.test(style.accentColor ?? '') ? style.accentColor! : '#1f5eff';
  const doc = new PDFDocument({ bufferPages: true, size: 'A4', margins: { top: 70, bottom: 64, left: 56, right: 56 }, info: { Title: meta.title, Author: meta.author ?? meta.project } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const tokens = marked.lexer(md, { breaks: true, gfm: true });

  // Titelblock: erste H1 wird zum Titel, sonst der Seitentitel
  let bodyTokens: Token[] = tokens;
  let title = meta.title;
  if (tokens[0]?.type === 'heading' && (tokens[0] as Tokens.Heading).depth === 1) {
    title = clean(inlineText((tokens[0] as Tokens.Heading).tokens));
    bodyTokens = tokens.slice(1);
  }
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#111').text(title, left, doc.y, { width });
  doc.moveDown(0.4);
  const metaRows: [string, string][] = [
    ['Projekt', meta.project],
    ['Version', `${meta.version} · ${statusLabel(meta.status)}`],
    ['Datum', (meta.date ?? new Date()).toLocaleDateString('de-DE')]
  ];
  if (meta.author) metaRows.push(['Erstellt von', meta.author]);
  if (meta.folder) metaRows.push(['Ablage', meta.folder]);
  const metaTop = doc.y;
  doc.rect(left, metaTop, width, metaRows.length * 15 + 10).fillColor('#f3f5f9').fill();
  doc.fillColor('#333').fontSize(9);
  metaRows.forEach(([k, v], i) => {
    doc.font('Helvetica-Bold').text(k, left + 10, metaTop + 6 + i * 15, { width: 90, lineBreak: false });
    doc.font('Helvetica').text(v, left + 100, metaTop + 6 + i * 15, { width: width - 110, lineBreak: false });
  });
  doc.y = metaTop + metaRows.length * 15 + 22;
  doc.x = left;
  doc.fillColor('#111').font('Helvetica').fontSize(BASE);

  for (const t of bodyTokens) renderToken(doc, t, width, accent);

  // Kopf- und Fußzeilen auf allen Seiten
  const range = doc.bufferedPageRange();
  const header = `${style.company ? style.company + ' · ' : ''}${meta.project} · ${title}`;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor('#777').text(header, left, 30, { width: width - 120, lineBreak: false, ellipsis: true });
    doc.rect(left, 44, width, 1.5).fillColor(accent).fill();
    doc.fillColor('#777').text(`Seite ${i - range.start + 1} von ${range.count}`, left, doc.page.height - 40, { width, align: 'right', lineBreak: false });
    if (style.footerText) doc.text(style.footerText, left, doc.page.height - 40, { width: width - 100, lineBreak: false, ellipsis: true });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

function statusLabel(s: string) {
  return s === 'final' ? 'Final' : s === 'review' ? 'In Prüfung' : 'Entwurf';
}

function clean(s: string): string {
  // Emojis entfernen (Standardschriften sind Latin-1), Leerraum normalisieren, harte Umbrüche erhalten
  return s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Inline-Tokens als Läufe mit Formatierung. */
function runs(tokens: Token[] | undefined, ctx: { bold?: boolean; italic?: boolean } = {}): Run[] {
  if (!tokens) return [];
  const out: Run[] = [];
  for (const t of tokens as any[]) {
    switch (t.type) {
      case 'text': if (t.tokens) out.push(...runs(t.tokens, ctx)); else out.push({ text: decode(t.text), ...ctx }); break;
      case 'strong': out.push(...runs(t.tokens, { ...ctx, bold: true })); break;
      case 'em': out.push(...runs(t.tokens, { ...ctx, italic: true })); break;
      case 'del': out.push(...runs(t.tokens, ctx)); break;
      case 'codespan': out.push({ text: decode(t.text), code: true }); break;
      case 'link': out.push(...runs(t.tokens, ctx)); if (t.href && !t.href.startsWith('#')) out.push({ text: ` (${t.href})`, ...ctx }); break;
      case 'br': out.push({ text: '\n', ...ctx }); break;
      case 'escape': out.push({ text: decode(t.text), ...ctx }); break;
      case 'image': out.push({ text: `[Bild: ${t.text}]`, ...ctx }); break;
      default: if (t.raw) out.push({ text: decode(t.raw), ...ctx });
    }
  }
  return out;
}

function inlineText(tokens?: Token[]): string {
  return runs(tokens).map((r) => r.text).join('');
}

function fontFor(r: Run): string {
  if (r.code) return 'Courier';
  if (r.bold && r.italic) return 'Helvetica-BoldOblique';
  if (r.bold) return 'Helvetica-Bold';
  if (r.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/** Schreibt formatierte Läufe als Absatz; harte Zeilenumbrüche werden zeilenweise gesetzt (pdfkit verschluckt Umbrüche in continued-Text). */
function writeRuns(doc: PDFKit.PDFDocument, rs: Run[], opts: { width: number; x?: number; size?: number; lineGap?: number; color?: string }) {
  const size = opts.size ?? BASE;
  const x = opts.x ?? doc.page.margins.left;
  const strip = (t: string) => t.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/[ \t]+/g, ' ');
  // In Zeilen zerlegen
  const lines: Run[][] = [[]];
  for (const r of rs) {
    const parts = r.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      const text = strip(part);
      if (!text) return;
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last.bold === r.bold && last.italic === r.italic && last.code === r.code) last.text += text;
      else line.push({ ...r, text });
    });
  }
  doc.fillColor(opts.color ?? '#111');
  for (const line of lines) {
    const segs = line.map((r, i) => ({ ...r, text: i === 0 ? r.text.replace(/^\s+/, '') : r.text })).filter((r) => r.text);
    if (segs.length === 0) { doc.moveDown(0.6); continue; }
    segs.forEach((r, i) => {
      doc.font(fontFor(r)).fontSize(r.code ? size - 1 : size);
      const o = { width: opts.width, lineGap: opts.lineGap ?? 2, continued: i < segs.length - 1 };
      if (i === 0) doc.text(r.text, x, doc.y, o); else doc.text(r.text, o);
    });
  }
  doc.font('Helvetica').fontSize(BASE);
}

function renderToken(doc: PDFKit.PDFDocument, t: Token, width: number, accent: string) {
  const left = doc.page.margins.left;
  switch (t.type) {
    case 'heading': {
      const h = t as Tokens.Heading;
      const sizes = [18, 14.5, 12.5, 11.5, 11, 11];
      if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
      doc.moveDown(h.depth <= 2 ? 0.8 : 0.5);
      doc.font('Helvetica-Bold').fontSize(sizes[h.depth - 1]).fillColor(h.depth <= 2 ? accent : '#111').text(clean(inlineText(h.tokens)), left, doc.y, { width });
      if (h.depth === 2) { doc.rect(left, doc.y + 2, width, 0.6).fillColor('#d9dee7').fill(); doc.y += 6; }
      doc.moveDown(0.3).fillColor('#111').font('Helvetica').fontSize(BASE);
      break;
    }
    case 'paragraph':
      writeRuns(doc, runs((t as Tokens.Paragraph).tokens), { width });
      doc.moveDown(0.55);
      break;
    case 'list': {
      const list = t as Tokens.List;
      list.items.forEach((item, i) => {
        const bullet = list.ordered ? `${(Number(list.start) || 1) + i}.` : '•';
        const prefix = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
        const inlineTokens: Token[] = [];
        let nested: Tokens.List | null = null;
        for (const x of item.tokens as any[]) {
          if (x.type === 'list') nested = x;
          else if (x.tokens) inlineTokens.push(...x.tokens);
          else inlineTokens.push(x);
        }
        const y = doc.y;
        doc.font('Helvetica').fontSize(BASE).fillColor('#111').text(bullet, left + 6, y, { width: 18, lineBreak: false });
        doc.y = y;
        writeRuns(doc, [{ text: prefix }, ...runs(inlineTokens)], { width: width - 24, x: left + 24, lineGap: 1 });
        if (nested) { const w = width - 16; doc.x = left + 16; renderNested(doc, nested, w, accent, left + 16); }
      });
      doc.x = left;
      doc.moveDown(0.5);
      break;
    }
    case 'table': {
      const tb = t as Tokens.Table;
      const cols = tb.header.length;
      const colW = width / cols;
      const cellText = (c: Tokens.TableCell) => clean(inlineText(c.tokens));
      const rowH = (cells: string[]) => Math.max(...cells.map((c) => doc.heightOfString(c || ' ', { width: colW - 10 }))) + 9;
      const drawRow = (cells: string[], kind: 'head' | 'odd' | 'even') => {
        doc.font(kind === 'head' ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
        const h = rowH(cells);
        if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
        const y = doc.y;
        if (kind === 'head') doc.rect(left, y, width, h).fillColor(accent).fillOpacity(0.12).fill().fillOpacity(1);
        else if (kind === 'even') doc.rect(left, y, width, h).fillColor('#f6f7fa').fill();
        doc.rect(left, y + h, width, 0.5).fillColor('#d9dee7').fill();
        cells.forEach((c, i) => {
          doc.fillColor('#111').text(c || ' ', left + i * colW + 5, y + 4.5, { width: colW - 10 });
        });
        doc.y = y + h;
      };
      drawRow(tb.header.map(cellText), 'head');
      tb.rows.forEach((row, i) => drawRow(row.map(cellText), i % 2 ? 'even' : 'odd'));
      doc.x = left;
      doc.moveDown(0.8).font('Helvetica').fontSize(BASE);
      break;
    }
    case 'code':
      doc.rect(left, doc.y - 2, width, doc.heightOfString((t as Tokens.Code).text, { width: width - 16 }) + 12).fillColor('#f3f5f9').fill();
      doc.font('Courier').fontSize(9).fillColor('#222').text((t as Tokens.Code).text, left + 8, doc.y + 4, { width: width - 16, lineGap: 1 });
      doc.x = left; doc.font('Helvetica').fontSize(BASE).fillColor('#111').moveDown(0.7);
      break;
    case 'blockquote': {
      const startY = doc.y;
      for (const sub of (t as Tokens.Blockquote).tokens) { doc.x = left + 14; renderNested(doc, sub, width - 14, accent, left + 14); }
      doc.rect(left + 2, startY, 2.5, doc.y - startY - 4).fillColor(accent).fill();
      doc.x = left; doc.fillColor('#111');
      break;
    }
    case 'hr':
      doc.moveDown(0.3).rect(left, doc.y, width, 0.8).fillColor('#d9dee7').fill(); doc.moveDown(0.8);
      break;
    case 'space':
      break;
    default:
      if ((t as any).text) { doc.font('Helvetica').fontSize(BASE).fillColor('#111').text(clean(decode((t as any).text)), left, doc.y, { width }); doc.moveDown(0.4); }
  }
}

function renderNested(doc: PDFKit.PDFDocument, t: Token, width: number, accent: string, x: number) {
  const saved = doc.page.margins.left;
  doc.page.margins.left = x;
  renderToken(doc, t, width, accent);
  doc.page.margins.left = saved;
}
