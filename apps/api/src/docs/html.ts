import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { parse } from 'node-html-parser';
import sanitize from 'sanitize-html';
import type { Db } from '../db.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', strongDelimiter: '**' });
turndown.use(gfm);
turndown.keep(['u']);
// Diagramme (SVG der Berichte) haben im Markdown keine Entsprechung: ihre Beschriftungen würden als Textsalat landen
turndown.remove(['svg'] as any);

/** Markdown → HTML (Vorlagen, Altbestand, Mail-Aktionen). */
export function mdToHtml(md: string): string {
  return sanitizeHtml(marked.parse(md ?? '', { async: false, breaks: true, gfm: true }) as string);
}

/** HTML → Markdown (abgeleitet für Suche, Mail-Aktionen, Export). */
export function htmlToMd(html: string): string {
  try {
    return turndown.turndown(html ?? '');
  } catch {
    return htmlToText(html);
  }
}

export function htmlToText(html: string): string {
  return parse(html ?? '').textContent.replace(/\s+/g, ' ').trim();
}

/** Vektorgrafik der Berichte (Diagramme): nur Grundformen und Text, keine Skripte, Ereignisse oder foreignObject. */
const SVG_TAGS = ['svg', 'g', 'rect', 'text', 'tspan', 'line', 'circle', 'path'];
const SVG_PRESENTATION = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'opacity', 'fill-opacity', 'font-size', 'font-weight', 'font-family', 'text-anchor', 'dominant-baseline'];
const SVG_ATTRS: Record<string, string[]> = {
  svg: ['width', 'height', 'viewbox', 'viewBox', 'xmlns', 'role', 'aria-label', ...SVG_PRESENTATION],
  g: ['transform', ...SVG_PRESENTATION],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry', ...SVG_PRESENTATION],
  text: ['x', 'y', 'dx', 'dy', ...SVG_PRESENTATION],
  tspan: ['x', 'y', 'dx', 'dy', ...SVG_PRESENTATION],
  line: ['x1', 'y1', 'x2', 'y2', ...SVG_PRESENTATION],
  circle: ['cx', 'cy', 'r', ...SVG_PRESENTATION],
  path: ['d', ...SVG_PRESENTATION]
};
const ALLOWED_TAGS = [...SVG_TAGS, 'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'code', 'pre', 'blockquote', 'hr', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'img', 'a', 'span', 'div', 'sup', 'sub', 'mark'];
/** Beliebiger Wert ohne Verschachtelung oder Funktionsaufrufe (url(), expression()) */
const STYLE_VALUE = [/^(?!.*(?:url|expression|javascript)\s*\()[^;{}\\<>]+$/i];
const ALLOWED_STYLES: Record<string, RegExp[]> = Object.fromEntries(['font-size', 'text-align', 'color', 'background-color', 'width', 'min-width', 'font-weight', 'font-style', 'text-decoration'].map((k) => [k, STYLE_VALUE]));
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);/i;

/**
 * Serverseitige Bereinigung (sanitize-html): nur bekannte Tags/Attribute, keine Skripte, keine javascript:-Links, nur sichere
 * Stile. Bilder nur eigene (relativ, z. B. Anhänge) oder eingebettet als data:image; externe http(s)-Bilder werden entfernt
 * und durch einen Hinweis ersetzt (Tracking-Pixel, CSP img-src 'self' data: blob:). Links mit target=_blank bekommen
 * rel="noopener noreferrer". input/label (Checklisten) nutzt der Editor nicht und fallen weg.
 */
export function sanitizeHtml(html: string): string {
  return sanitize(html ?? '', {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { ...SVG_ATTRS, '*': ['style', 'class', 'title', 'data-type'], a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height'], td: ['colspan', 'rowspan', 'colwidth'], th: ['colspan', 'rowspan', 'colwidth'], col: ['colwidth', 'width'], ol: ['start'] },
    allowedStyles: { '*': ALLOWED_STYLES },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    // Unbekannte Elemente: Inhalt behalten, Element weg; Skripte & Co. samt Inhalt weg
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template', 'title', 'iframe', 'object', 'embed'],
    transformTags: {
      a: (tagName, attribs) => {
        const out = { ...attribs };
        if (out.target && out.target !== '_blank') delete out.target;
        if (out.target === '_blank') out.rel = 'noopener noreferrer'; else delete out.rel;
        return { tagName, attribs: out };
      },
      img: (tagName, attribs) => {
        const src = String(attribs.src ?? '').trim();
        if (/^https?:/i.test(src)) {
          let host = ''; try { host = new URL(src).hostname; } catch { /* unlesbar */ }
          return { tagName: 'span', attribs: { class: 'img-removed', title: src.slice(0, 200) }, text: `[externes Bild entfernt${host ? `: ${host}` : ''}]` };
        }
        if (/^data:/i.test(src) && !DATA_IMAGE.test(src)) delete attribs.src;
        return { tagName, attribs };
      }
    }
  });
}

/** Altbestand ohne HTML einmalig aus Markdown erzeugen (Seiten, Versionen, Vorlagen). */
export async function ensureHtmlContent(db: Db) {
  const pages = await db.query(`select id, content_md from doc_pages where content_html is null`);
  for (const p of pages.rows) await db.query(`update doc_pages set content_html = $2 where id = $1`, [p.id, mdToHtml(p.content_md ?? '')]);
  const versions = await db.query(`select id, content_md from doc_page_versions where content_html is null`);
  for (const v of versions.rows) await db.query(`update doc_page_versions set content_html = $2 where id = $1`, [v.id, mdToHtml(v.content_md ?? '')]);
  const templates = await db.query(`select id, content_md from doc_templates where content_html is null`);
  for (const t of templates.rows) await db.query(`update doc_templates set content_html = $2 where id = $1`, [t.id, mdToHtml(t.content_md ?? '')]);
  return pages.rows.length + versions.rows.length + templates.rows.length;
}

export function renderTemplateHtml(html: string): string {
  const d = new Date().toLocaleDateString('de-DE');
  return html.replaceAll('{{datum}}', d);
}
