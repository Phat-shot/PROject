import { marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { parse } from 'node-html-parser';
import type { Db } from '../db.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', strongDelimiter: '**' });
turndown.use(gfm);
turndown.keep(['u']);

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

const ALLOWED_TAGS = new Set(['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'code', 'pre', 'blockquote', 'hr', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'img', 'a', 'span', 'div', 'sup', 'sub', 'mark', 'input', 'label']);
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'style', 'colspan', 'rowspan', 'colwidth', 'width', 'height', 'class', 'data-type', 'data-checked', 'type', 'checked', 'start', 'target', 'rel']);

/** Serverseitige Bereinigung: nur bekannte Tags/Attribute, keine Skripte, keine javascript:-Links, nur sichere Stile. */
export function sanitizeHtml(html: string): string {
  const root = parse(html ?? '', { blockTextElements: { script: true, style: true } });
  const walk = (node: any) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        const tag = child.rawTagName?.toLowerCase();
        if (!tag || !ALLOWED_TAGS.has(tag)) {
          if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') { child.remove(); continue; }
          // Unbekanntes Element: Inhalt behalten, Element entfernen
          child.replaceWith(...child.childNodes);
          continue;
        }
        for (const [name, value] of Object.entries(child.attributes as Record<string, string>)) {
          const n = name.toLowerCase();
          if (!ALLOWED_ATTRS.has(n) || n.startsWith('on')) { child.removeAttribute(name); continue; }
          if ((n === 'href' || n === 'src') && /^\s*(javascript|vbscript|data:text\/html)/i.test(value)) child.removeAttribute(name);
          if (n === 'style') {
            const safe = value.split(';').map((s) => s.trim()).filter((s) => /^(font-size|text-align|color|background-color|width|min-width|font-weight|font-style|text-decoration)\s*:/i.test(s)).join('; ');
            if (safe) child.setAttribute('style', safe); else child.removeAttribute('style');
          }
        }
        walk(child);
      }
    }
  };
  walk(root);
  return root.toString();
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
