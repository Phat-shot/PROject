import { unzipSync, strFromU8 } from 'fflate';
import { parse as parseHtml } from 'node-html-parser';

/**
 * Textauszug aus Dateien der Dateiquellen für die Suche: .txt, .md, .csv, .html, .pdf (unpdf), .docx (word/document.xml
 * per fflate). Andere Typen werden nur über den Namen gefunden (skipped). Größenlimit 20 MB, Text gekürzt auf 200 kB.
 */
export const MAX_EXTRACT_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 200_000;
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'log']);
const HTML_EXT = new Set(['html', 'htm']);
export const extOf = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '');
/** Lohnt sich das Laden der Datei für einen Textauszug? */
export const extractable = (name: string) => { const e = extOf(name); return TEXT_EXT.has(e) || HTML_EXT.has(e) || e === 'pdf' || e === 'docx'; };

const clean = (s: string) => s.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const limit = (s: string) => (s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s);

export async function extractText(name: string, buf: Buffer): Promise<{ status: 'ok' | 'skipped' | 'error'; text: string | null; note?: string }> {
  const e = extOf(name);
  try {
    if (TEXT_EXT.has(e)) return { status: 'ok', text: limit(clean(buf.toString('utf8'))) };
    if (HTML_EXT.has(e)) {
      const root = parseHtml(buf.toString('utf8'));
      root.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
      return { status: 'ok', text: limit(clean(root.structuredText ?? root.textContent)) };
    }
    if (e === 'pdf') {
      const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const r = await pdfText(pdf, { mergePages: true });
      const text = clean(String(Array.isArray(r.text) ? r.text.join('\n') : r.text));
      return text ? { status: 'ok', text: limit(text) } : { status: 'skipped', text: null, note: 'PDF ohne Textebene (Scan?)' };
    }
    if (e === 'docx') {
      const files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name === 'word/document.xml' && f.originalSize <= 50 * 1024 * 1024 });
      const xml = files['word/document.xml'];
      if (!xml) return { status: 'skipped', text: null, note: 'kein word/document.xml (oder zu groß)' };
      const s = strFromU8(xml).replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      return { status: 'ok', text: limit(clean(s)) };
    }
    return { status: 'skipped', text: null, note: 'Dateityp ohne Textauszug' };
  } catch (err: any) {
    return { status: 'error', text: null, note: String(err?.message ?? err).slice(0, 200) };
  }
}
