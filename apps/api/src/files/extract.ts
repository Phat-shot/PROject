import { unzipSync, strFromU8 } from 'fflate';
import { parse as parseHtml } from 'node-html-parser';
import { OCR_IMAGE_EXT, OCR_NOTE, PDF_MIN_CHARS_PER_PAGE, ocrEnabled, type OcrSession } from './ocr.js';

/**
 * Textauszug aus Dateien der Dateiquellen für die Suche: .txt, .md, .csv, .html, .pdf (unpdf), .docx (word/document.xml
 * per fflate); mit OCR-Sitzung zusätzlich gescannte PDFs (weniger als 20 Zeichen je Seite) und Bilder (png, jpg, tiff) per
 * Texterkennung (siehe ocr.ts). Andere Typen werden nur über den Namen gefunden (skipped). Größenlimit 20 MB, Text gekürzt auf 200 kB.
 */
export const MAX_EXTRACT_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 200_000;
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'log']);
const HTML_EXT = new Set(['html', 'htm']);
export const extOf = (name: string) => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '');
/** Lohnt sich das Laden der Datei für einen Textauszug? */
export const extractable = (name: string) => { const e = extOf(name); return TEXT_EXT.has(e) || HTML_EXT.has(e) || e === 'pdf' || e === 'docx' || (OCR_IMAGE_EXT.has(e) && ocrEnabled()); };
/** Kommt die Datei für Texterkennung in Frage (Bild oder PDF)? */
export const ocrCandidate = (name: string) => { const e = extOf(name); return e === 'pdf' || OCR_IMAGE_EXT.has(e); };
export const OCR_LATER_NOTE = 'Texterkennung (OCR) folgt im nächsten Lauf';

const clean = (s: string) => s.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const limit = (s: string) => (s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s);

export interface Extracted { status: 'ok' | 'skipped' | 'error'; text: string | null; note?: string }
const ocrNote = (pages: number, total: number) => (pages < total ? `${OCR_NOTE}, erste ${pages} von ${total} Seiten` : OCR_NOTE);

/** ocr: Sitzung des Sync-Laufs; ohne Sitzung (oder FILE_OCR=off) bleiben Scans und Bilder ohne Textauszug. */
export async function extractText(name: string, buf: Buffer, ocr?: OcrSession | null): Promise<Extracted> {
  const e = extOf(name);
  const useOcr = Boolean(ocr) && ocrEnabled();
  try {
    if (OCR_IMAGE_EXT.has(e)) {
      if (!useOcr) return { status: 'skipped', text: null, note: ocr ? 'Texterkennung (OCR) abgeschaltet' : 'Dateityp ohne Textauszug' };
      if (!ocr!.left) return { status: 'skipped', text: null, note: OCR_LATER_NOTE };
      const r = await ocr!.image(buf);
      const text = clean(r.text);
      return text ? { status: 'ok', text: limit(text), note: OCR_NOTE } : { status: 'skipped', text: null, note: 'Texterkennung (OCR): keine Schrift erkannt' };
    }
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
      const pages = Math.max(1, Number(r.totalPages ?? pdf.numPages ?? 1));
      await (pdf as any).destroy?.()?.catch?.(() => {});
      const text = clean(String(Array.isArray(r.text) ? r.text.join('\n') : r.text));
      // Textebene vorhanden (mindestens ~20 Zeichen je Seite): Text übernehmen; sonst Scan → Texterkennung
      if (text.replace(/\s+/g, '').length >= PDF_MIN_CHARS_PER_PAGE * pages) return { status: 'ok', text: limit(text) };
      if (!useOcr) return text ? { status: 'ok', text: limit(text) } : { status: 'skipped', text: null, note: ocr ? 'Texterkennung (OCR) abgeschaltet' : 'PDF ohne Textebene (Scan?)' };
      if (!ocr!.left) return text ? { status: 'ok', text: limit(text) } : { status: 'skipped', text: null, note: OCR_LATER_NOTE };
      const o = await ocr!.pdf(new Uint8Array(buf));
      const all = clean([text, o.text].filter(Boolean).join('\n\n'));
      return all ? { status: 'ok', text: limit(all), note: ocrNote(o.pages, o.totalPages) } : { status: 'skipped', text: null, note: 'Texterkennung (OCR): keine Schrift erkannt' };
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
