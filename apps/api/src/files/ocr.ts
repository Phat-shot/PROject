import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Texterkennung (OCR) für gescannte PDFs und Bilder der Dateiquellen: tesseract.js (WebAssembly, eigener Worker-Thread, keine
 * Systempakete) mit den Sprachen deu+eng aus den npm-Paketen @tesseract.js-data/deu und /eng (nie aus dem Netz). PDF-Seiten
 * rendert unpdf (pdf.js) mit @napi-rs/canvas (Prebuilds für glibc und musl, x64 und arm64).
 *
 * Grenzen: FILE_OCR=off schaltet ab; FILE_OCR_MAX_PAGES (Standard 30) Seiten je Datei; FILE_OCR_PER_RUN (Standard 20) Dateien je
 * Sync-Lauf (der Rest folgt im nächsten Lauf); FILE_OCR_TIMEOUT_MS (Standard 120 s) je Datei. Eine Sitzung (OcrSession) hält den
 * Worker für einen Lauf und wird danach beendet; die Seiten werden nacheinander erkannt.
 */
export const OCR_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff']);
export const OCR_NOTE = 'per Texterkennung (OCR)';
/** Hinweise, bei denen ein späterer Lauf mit OCR die Datei erneut verarbeitet (gleiches etag). */
export const OCR_PENDING_NOTES = new Set(['PDF ohne Textebene (Scan?)', 'Dateityp ohne Textauszug', 'Texterkennung (OCR) folgt im nächsten Lauf', 'Texterkennung (OCR) abgeschaltet']);
export const ocrEnabled = () => !/^(off|0|false|no|aus)$/i.test(String(process.env.FILE_OCR ?? '').trim());
const num = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
export const ocrMaxPages = () => num(process.env.FILE_OCR_MAX_PAGES, 30);
export const ocrPerRun = () => num(process.env.FILE_OCR_PER_RUN, 20);
export const ocrTimeoutMs = () => num(process.env.FILE_OCR_TIMEOUT_MS, 120_000);
/** Mindestzahl Zeichen je Seite, ab der ein PDF als „mit Textebene“ gilt. */
export const PDF_MIN_CHARS_PER_PAGE = 20;

const require = createRequire(import.meta.url);
let langDir: string | null = null;
/**
 * Sprachdaten in EINEN Ordner legen (tesseract.js liest alle Sprachen aus einem langPath): FILE_OCR_LANG_PATH, sonst eine Kopie
 * der gzip-Dateien aus node_modules im Temp-Ordner (einmal je Prozess, ca. 6 MB).
 */
function languageDir(): string {
  if (process.env.FILE_OCR_LANG_PATH) return process.env.FILE_OCR_LANG_PATH;
  if (langDir) return langDir;
  const dir = path.join(os.tmpdir(), 'projekttool-tessdata-4.0.0_best_int');
  fs.mkdirSync(dir, { recursive: true });
  for (const code of ['deu', 'eng']) {
    const dst = path.join(dir, `${code}.traineddata.gz`);
    const src = require.resolve(`@tesseract.js-data/${code}/4.0.0_best_int/${code}.traineddata.gz`);
    if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
  }
  langDir = dir;
  return dir;
}

/** Dateikopf prüfen, bevor das Bild an die Texterkennung geht. */
export function imageMagic(b: Buffer): 'png' | 'jpg' | 'tiff' | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return 'tiff';
  return null;
}

export class OcrTimeout extends Error {}
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new OcrTimeout(`${what}: Zeitlimit von ${Math.round(ms / 1000)} s überschritten`)), ms); })]).finally(() => clearTimeout(t));
};
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

export interface OcrResult { text: string; pages: number; totalPages: number }

/** Eine OCR-Sitzung je Sync-Lauf: Worker bei Bedarf, Zähler der erkannten Dateien, close() beendet den Worker. */
export class OcrSession {
  private worker: any = null;
  used = 0;
  constructor(readonly perRun = ocrPerRun(), readonly maxPages = ocrMaxPages(), readonly timeoutMs = ocrTimeoutMs()) {}
  get left() { return Math.max(0, this.perRun - this.used); }

  private async getWorker() {
    if (this.worker) return this.worker;
    const { createWorker } = await import('tesseract.js');
    // OEM 1 = nur LSTM (passt zu den best_int-Daten); kein Cache-Schreiben ins Arbeitsverzeichnis
    this.worker = await createWorker(['deu', 'eng'], 1, { langPath: languageDir(), gzip: true, cacheMethod: 'none', // ohne errorHandler wirft tesseract.js Fehler (z. B. defektes Bild) unabgefangen und beendet den Prozess; der Auftrag lehnt trotzdem ab
      errorHandler: () => {} } as any);
    return this.worker;
  }
  private async recognize(img: Buffer): Promise<string> {
    const w = await this.getWorker();
    try {
      const r = await w.recognize(img);
      return String(r?.data?.text ?? '');
    } catch (e: any) { throw new Error(`Texterkennung fehlgeschlagen: ${String(e?.message ?? e).replace(/^(Error:\s*)+/, '')}`.slice(0, 200)); }
  }
  /** Worker nach Zeitüberschreitung verwerfen (der laufende Auftrag lässt sich nicht abbrechen). */
  private async reset() { const w = this.worker; this.worker = null; if (w) await w.terminate().catch(() => {}); }

  /** Bild (png, jpg, tiff) erkennen. */
  async image(buf: Buffer): Promise<OcrResult> {
    if (!imageMagic(buf)) throw new Error('kein gültiges Bild (png, jpg oder tiff erwartet)');
    this.used++;
    try { return { text: await withTimeout(this.recognize(buf), this.timeoutMs, 'Texterkennung'), pages: 1, totalPages: 1 }; }
    catch (e) { if (e instanceof OcrTimeout) await this.reset(); throw e; }
  }

  /** PDF ohne Textebene: Seiten rendern (Faktor 2, ca. 150 dpi) und nacheinander erkennen, höchstens maxPages. */
  async pdf(data: Uint8Array): Promise<OcrResult> {
    this.used++;
    const started = Date.now();
    const { getDocumentProxy, renderPageAsImage } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(data));
    const total = doc.numPages;
    const n = Math.min(total, this.maxPages);
    const parts: string[] = [];
    try {
      for (let i = 1; i <= n; i++) {
        const left = this.timeoutMs - (Date.now() - started);
        if (left <= 0) throw new OcrTimeout(`Texterkennung: Zeitlimit von ${Math.round(this.timeoutMs / 1000)} s überschritten (nach ${i - 1} von ${n} Seiten)`);
        const img = await withTimeout(renderPageAsImage(doc, i, { canvasImport: () => import('@napi-rs/canvas'), scale: 2 }), left, 'Seite rendern');
        parts.push((await withTimeout(this.recognize(Buffer.from(img)), Math.max(1000, this.timeoutMs - (Date.now() - started)), 'Texterkennung')).trim());
        await yieldLoop();
      }
    } catch (e) { if (e instanceof OcrTimeout) await this.reset(); throw e; }
    finally { await (doc as any).destroy?.()?.catch?.(() => {}); }
    return { text: parts.filter(Boolean).join('\n\n'), pages: n, totalPages: total };
  }

  async close() { await this.reset(); }
}

/** Ist die Laufzeit für OCR vorhanden (tesseract.js und Canvas-Prebuild)? Für Tests und Diagnose. */
export async function ocrAvailable(): Promise<{ ok: boolean; reason?: string }> {
  try { await import('tesseract.js'); } catch (e: any) { return { ok: false, reason: `tesseract.js fehlt: ${e?.message ?? e}` }; }
  try { await import('@napi-rs/canvas'); } catch (e: any) { return { ok: false, reason: `@napi-rs/canvas (Prebuild) fehlt: ${e?.message ?? e}` }; }
  try { languageDir(); } catch (e: any) { return { ok: false, reason: `Sprachdaten fehlen: ${e?.message ?? e}` }; }
  return { ok: true };
}
