import { useCallback, useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { Image } from '@tiptap/extension-image';
import { TextStyle, FontSize } from '@tiptap/extension-text-style';
import { Placeholder } from '@tiptap/extensions';
import { api } from '../lib/api';

const SIZES: [string, string][] = [['', 'Normal'], ['12px', 'Klein'], ['16px', 'Groß'], ['20px', 'Sehr groß'], ['26px', 'Riesig']];

export interface RichEditorProps {
  html: string;
  onChange: (html: string) => void;
  /** Bild-Uploads landen als Anhang an dieser Seite (sonst Data-URL). */
  pageId?: string | null;
  /** Upload-Endpunkt für Freigabe-Links o. Ä. */
  uploadUrl?: string | null;
  placeholder?: string;
  minimal?: boolean;
  onSave?: () => void;
}

export function RichEditor({ html, onChange, pageId, uploadUrl, placeholder, minimal, onSave }: RichEditorProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    extensions: [
      // Tiptap 3: Link und Unterstreichen sind Teil des StarterKits
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener', target: '_blank' } } }),
      TextStyle, FontSize,
      Image.configure({ inline: false, allowBase64: true }),
      Table.configure({ resizable: true }), TableRow, TableHeader, TableCell,
      Placeholder.configure({ placeholder: placeholder ?? 'Schreiben … (Überschriften, Tabellen und Bilder über die Leiste)' })
    ],
    content: html,
    // Leiste zeigt aktive Formate: bei jeder Änderung neu rendern (Standard in Tiptap 2)
    shouldRerenderOnTransaction: true,
    onUpdate: ({ editor }) => onChange(editor.getHTML())
  });
  useEffect(() => {
    if (editor && html !== editor.getHTML() && !editor.isFocused) editor.commands.setContent(html, { emitUpdate: false });
  }, [html]);
  useEffect(() => {
    if (!onSave) return;
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); onSave(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onSave]);

  const upload = useCallback(async (file: File) => {
    if (!editor) return;
    const target = uploadUrl ?? (pageId ? `/attachments?pageId=${pageId}` : null);
    if (!target) {
      const reader = new FileReader();
      reader.onload = () => editor.chain().focus().setImage({ src: String(reader.result), alt: file.name }).run();
      reader.readAsDataURL(file);
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    const r = await api.post<{ attachment: { id: string; url?: string } }>(target, fd);
    editor.chain().focus().setImage({ src: r.attachment.url ?? `/api/attachments/${r.attachment.id}`, alt: file.name }).run();
  }, [editor, pageId, uploadUrl]);

  if (!editor) return null;
  const headingValue = [1, 2, 3, 4].find((l) => editor.isActive('heading', { level: l })) ?? 0;
  const sizeValue = editor.getAttributes('textStyle').fontSize ?? '';
  return (
    <div className="editor-wrap" onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f && f.type.startsWith('image/')) { e.preventDefault(); void upload(f); } }} onPaste={(e) => { const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); void upload(f); } }}>
      <div className="editor-toolbar">
        <select value={headingValue} onChange={(e) => { const l = Number(e.target.value); l ? editor.chain().focus().setHeading({ level: l as 1 | 2 | 3 | 4 }).run() : editor.chain().focus().setParagraph().run(); }} title="Absatzformat">
          <option value={0}>Text</option><option value={1}>Überschrift 1</option><option value={2}>Überschrift 2</option><option value={3}>Überschrift 3</option><option value={4}>Überschrift 4</option>
        </select>
        <select value={sizeValue} onChange={(e) => (e.target.value ? editor.chain().focus().setFontSize(e.target.value).run() : editor.chain().focus().unsetFontSize().run())} title="Schriftgröße">
          {SIZES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <span className="sep" />
        <Btn ed={editor} on={editor.isActive('bold')} title="Fett (Strg+B)" run={() => editor.chain().focus().toggleBold().run()}><b>F</b></Btn>
        <Btn ed={editor} on={editor.isActive('italic')} title="Kursiv (Strg+I)" run={() => editor.chain().focus().toggleItalic().run()}><i>K</i></Btn>
        <Btn ed={editor} on={editor.isActive('underline')} title="Unterstrichen (Strg+U)" run={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></Btn>
        <Btn ed={editor} on={editor.isActive('strike')} title="Durchgestrichen" run={() => editor.chain().focus().toggleStrike().run()}><s>S</s></Btn>
        <Btn ed={editor} on={editor.isActive('code')} title="Code" run={() => editor.chain().focus().toggleCode().run()}>{'<>'}</Btn>
        <span className="sep" />
        <Btn ed={editor} on={editor.isActive('bulletList')} title="Aufzählung" run={() => editor.chain().focus().toggleBulletList().run()}>• Liste</Btn>
        <Btn ed={editor} on={editor.isActive('orderedList')} title="Nummerierung" run={() => editor.chain().focus().toggleOrderedList().run()}>1. Liste</Btn>
        <Btn ed={editor} on={editor.isActive('blockquote')} title="Zitat" run={() => editor.chain().focus().toggleBlockquote().run()}>❝</Btn>
        <Btn ed={editor} title="Trennlinie" run={() => editor.chain().focus().setHorizontalRule().run()}>—</Btn>
        <span className="sep" />
        <Btn ed={editor} title="Tabelle einfügen (3×3)" run={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>▦ Tabelle</Btn>
        {editor.isActive('table') && <>
          <Btn ed={editor} title="Spalte rechts" run={() => editor.chain().focus().addColumnAfter().run()}>+Sp</Btn>
          <Btn ed={editor} title="Zeile unten" run={() => editor.chain().focus().addRowAfter().run()}>+Ze</Btn>
          <Btn ed={editor} title="Spalte löschen" run={() => editor.chain().focus().deleteColumn().run()}>−Sp</Btn>
          <Btn ed={editor} title="Zeile löschen" run={() => editor.chain().focus().deleteRow().run()}>−Ze</Btn>
          <Btn ed={editor} title="Kopfzeile umschalten" run={() => editor.chain().focus().toggleHeaderRow().run()}>Kopf</Btn>
          <Btn ed={editor} title="Tabelle löschen" run={() => editor.chain().focus().deleteTable().run()}>✕ Tab</Btn>
        </>}
        <span className="sep" />
        <Btn ed={editor} title="Bild einfügen (auch per Drag & Drop oder Einfügen)" run={() => fileRef.current?.click()}>🖼 Bild</Btn>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        <Btn ed={editor} on={editor.isActive('link')} title="Link" run={() => { const prev = editor.getAttributes('link').href ?? ''; const url = prompt('Link-Adresse', prev); if (url === null) return; url ? editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run() : editor.chain().focus().unsetLink().run(); }}>🔗</Btn>
        {!minimal && <>
          <span className="sep" />
          <Btn ed={editor} title="Rückgängig" run={() => editor.chain().focus().undo().run()}>↶</Btn>
          <Btn ed={editor} title="Wiederholen" run={() => editor.chain().focus().redo().run()}>↷</Btn>
        </>}
      </div>
      <div className="editor-content prose"><EditorContent editor={editor} /></div>
    </div>
  );
}

function Btn({ ed, on, title, run, children }: { ed: Editor; on?: boolean; title: string; run: () => void; children: React.ReactNode }) {
  void ed;
  return <button type="button" className={on ? 'on' : ''} title={title} onMouseDown={(e) => e.preventDefault()} onClick={run}>{children}</button>;
}

/** Gespeichertes HTML sicher anzeigen. */
export function HtmlView({ html }: { html: string }) {
  return <div className="prose" dangerouslySetInnerHTML={{ __html: sanitize(html) }} />;
}

let purify: typeof import('dompurify') | null = null;
import DOMPurify from 'dompurify';
purify = DOMPurify as any;
function sanitize(html: string): string {
  return (purify as any).sanitize(html, { ADD_ATTR: ['target', 'colwidth', 'data-type', 'data-checked'] });
}
