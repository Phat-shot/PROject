import PDFDocument from 'pdfkit';
import { marked, type Token, type Tokens } from 'marked';

/**
 * Markdown → PDF mit pdfkit (reines JS, keine Browser-Abhängigkeit).
 * Deckt Überschriften, Absätze, Listen, Tabellen, Code, Zitate und Linien ab.
 * Fett/kursiv werden als Text übernommen; Emojis entfernt (Standardschriften sind Latin-1).
 */
export async function markdownToPdf(md: string, meta: { title: string; project: string; version: number; status: string; author?: string | null; date?: Date }): Promise<Buffer> {
  const doc = new PDFDocument({ bufferPages: true, size: 'A4', margins: { top: 64, bottom: 64, left: 56, right: 56 }, info: { Title: meta.title, Author: meta.author ?? meta.project } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // Kopfzeile
  doc.font('Helvetica').fontSize(9).fillColor('#666')
    .text(`${clean(meta.project)} · ${clean(meta.title)} · Version ${meta.version} · ${statusLabel(meta.status)} · ${(meta.date ?? new Date()).toLocaleDateString('de-DE')}`, { width });
  doc.moveDown(0.6);
  doc.moveTo(doc.x, doc.y).lineTo(doc.x + width, doc.y).strokeColor('#ccc').stroke();
  doc.moveDown(0.8);
  doc.fillColor('#111');

  const tokens = marked.lexer(md, { breaks: true, gfm: true });
  for (const t of tokens) renderToken(doc, t, width);

  // Fußzeilen mit Seitenzahl
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // sonst löst die Fußzeile einen Seitenumbruch aus
    doc.fontSize(8).fillColor('#888').text(`Seite ${i - range.start + 1} von ${range.count}`, doc.page.margins.left, doc.page.height - 40, { width, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}

function statusLabel(s: string) {
  return s === 'final' ? 'Final' : s === 'review' ? 'In Prüfung' : 'Entwurf';
}

function clean(s: string): string {
  // Zeilenumbrüche (harte Umbrüche aus Markdown) bleiben erhalten, nur Mehrfach-Leerzeichen werden gekürzt
  return s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

function inline(tokens?: Token[]): string {
  if (!tokens) return '';
  return tokens.map((t: any) => {
    switch (t.type) {
      case 'text': return t.tokens ? inline(t.tokens) : t.text;
      case 'strong': case 'em': case 'del': return inline(t.tokens);
      case 'codespan': return t.text;
      case 'link': return `${inline(t.tokens)} (${t.href})`;
      case 'br': return '\n';
      case 'escape': return t.text;
      case 'image': return `[Bild: ${t.text}]`;
      default: return t.raw ?? '';
    }
  }).join('');
}

function renderToken(doc: PDFKit.PDFDocument, t: Token, width: number) {
  switch (t.type) {
    case 'heading': {
      const sizes = [20, 15, 13, 12, 11, 11];
      doc.moveDown(t.depth === 1 ? 0.2 : 0.6).font('Helvetica-Bold').fontSize(sizes[t.depth - 1]).text(clean(decode(inline(t.tokens))), { width });
      doc.moveDown(0.3).font('Helvetica').fontSize(10.5);
      break;
    }
    case 'paragraph':
      doc.font('Helvetica').fontSize(10.5).text(clean(decode(inline(t.tokens))), { width, lineGap: 2 });
      doc.moveDown(0.5);
      break;
    case 'list': {
      const list = t as Tokens.List;
      list.items.forEach((item, i) => {
        const bullet = list.ordered ? `${(Number(list.start) || 1) + i}.` : '•';
        const text = clean(decode(item.tokens.map((x: any) => (x.type === 'text' || x.type === 'paragraph' ? inline(x.tokens ?? [x]) : '')).join(' ')));
        const prefix = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
        const y = doc.y;
        doc.font('Helvetica').fontSize(10.5).text(bullet, doc.page.margins.left + 6, y, { width: 16, continued: false });
        doc.text(prefix + text, doc.page.margins.left + 22, y, { width: width - 22, lineGap: 1 });
        const nested = item.tokens.find((x: any) => x.type === 'list');
        if (nested) { doc.x = doc.page.margins.left + 16; renderToken(doc, nested, width - 16); doc.x = doc.page.margins.left; }
      });
      doc.x = doc.page.margins.left;
      doc.moveDown(0.5);
      break;
    }
    case 'table': {
      const tb = t as Tokens.Table;
      const cols = tb.header.length;
      const colW = width / cols;
      const rowH = (cells: string[]) => Math.max(...cells.map((c) => doc.heightOfString(c || ' ', { width: colW - 8 }))) + 8;
      const drawRow = (cells: string[], bold: boolean) => {
        const h = rowH(cells);
        if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
        const y = doc.y;
        cells.forEach((c, i) => {
          const x = doc.page.margins.left + i * colW;
          doc.rect(x, y, colW, h).strokeColor('#bbb').lineWidth(0.5).stroke();
          if (bold) doc.rect(x, y, colW, h).fillOpacity(0.06).fill('#000').fillOpacity(1);
          doc.fillColor('#111').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).text(c || ' ', x + 4, y + 4, { width: colW - 8 });
        });
        doc.y = y + h;
      };
      doc.font('Helvetica').fontSize(9.5);
      drawRow(tb.header.map((h) => clean(decode(inline(h.tokens)))), true);
      for (const row of tb.rows) drawRow(row.map((c) => clean(decode(inline(c.tokens)))), false);
      doc.x = doc.page.margins.left;
      doc.moveDown(0.7);
      break;
    }
    case 'code':
      doc.font('Courier').fontSize(9).fillColor('#222').text(t.text, { width, lineGap: 1 });
      doc.font('Helvetica').fontSize(10.5).fillColor('#111').moveDown(0.5);
      break;
    case 'blockquote': {
      const x = doc.x;
      doc.moveTo(x, doc.y).lineTo(x, doc.y + 2).stroke();
      doc.fillColor('#555');
      for (const sub of (t as Tokens.Blockquote).tokens) { doc.x = x + 12; renderToken(doc, sub, width - 12); }
      doc.x = x; doc.fillColor('#111');
      break;
    }
    case 'hr':
      doc.moveDown(0.3).moveTo(doc.x, doc.y).lineTo(doc.x + width, doc.y).strokeColor('#ccc').stroke().moveDown(0.6);
      break;
    case 'space':
      break;
    default:
      if ((t as any).text) { doc.font('Helvetica').fontSize(10.5).text(clean(decode((t as any).text)), { width }); doc.moveDown(0.4); }
  }
}

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
