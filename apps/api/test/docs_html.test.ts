import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testApp } from './helpers.js';
import { sanitizeHtml, htmlToMd, mdToHtml } from '../src/docs/html.js';
import { htmlToPdf } from '../src/docs/pdfHtml.js';

let t: Awaited<ReturnType<typeof testApp>>;
before(async () => { t = await testApp(); });
after(async () => { await t.close(); });

test('HTML-Bereinigung entfernt Skripte und unsichere Stile, erhält Schriftgrößen und Tabellen', () => {
  const dirty = '<h2 style="font-size: 20px; position: fixed">T</h2><script>alert(1)</script><p onclick="x()">a <span style="font-size: 18px">groß</span> <a href="javascript:evil()">l</a></p><table><tr><th>A</th></tr><tr><td>1</td></tr></table><iframe src="x"></iframe>';
  const clean = sanitizeHtml(dirty);
  assert.ok(!/script|iframe|onclick|position|javascript/i.test(clean));
  assert.ok(clean.includes('font-size: 18px'));
  assert.ok(clean.includes('<table>'));
  assert.match(htmlToMd('<h2>Titel</h2><p>Text mit <strong>fett</strong></p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'), /## Titel[\s\S]*\*\*fett\*\*[\s\S]*\| A \| B \|/);
  assert.match(mdToHtml('# H\n\n- a\n- b'), /<h1>H<\/h1>[\s\S]*<ul>/);
});

test('Seite im WYSIWYG-Format anlegen, bearbeiten, Version und Markdown abgeleitet', async () => {
  const pl = await t.login('pl@demo.local');
  const docs = (await t.api(pl).get(`/projects/${t.ids.projects.web}/docs`)).json();
  const folder = docs.folders.find((f: any) => f.name === 'Konzepte');
  const created = await t.api(pl).post(`/projects/${t.ids.projects.web}/docs/pages`, { title: 'Editor-Test', folderId: folder.id, contentHtml: '<h1>Editor-Test</h1><p>Erster <em>Absatz</em> <span style="font-size: 20px">groß</span></p><script>x()</script>' });
  assert.equal(created.statusCode, 200, created.body);
  const page = created.json().page;
  assert.ok(page.contentHtml.includes('font-size: 20px'));
  assert.ok(!page.contentHtml.includes('<script'));
  assert.match(page.contentMd, /\*Absatz\*/);
  const upd = await t.api(pl).patch(`/docs/pages/${page.id}`, { contentHtml: page.contentHtml + '<table><tr><th>Spalte</th></tr><tr><td>Wert</td></tr></table>', baseVersion: 1 });
  assert.equal(upd.statusCode, 200, upd.body);
  assert.equal(upd.json().page.version, 2);
  assert.match(upd.json().page.contentMd, /\| Spalte \|/);
  const detail = (await t.api(pl).get(`/docs/pages/${page.id}`)).json();
  assert.equal(detail.versions.length, 2);
  const v1 = (await t.api(pl).get(`/docs/pages/${page.id}/versions/1`)).json().version;
  assert.ok(v1.contentHtml.includes('Erster'));
  // Suche findet den Text über den abgeleiteten Markdown
  const search = (await t.api(pl).get('/search?q=Absatz')).json();
  assert.ok(search.pages.some((p: any) => p.id === page.id));
});

test('Oberseite: Vorlage für Unterseiten wird vererbt, Index und Einstellungen', async () => {
  const pl = await t.login('pl@demo.local');
  const docs = (await t.api(pl).get(`/projects/${t.ids.projects.web}/docs`)).json();
  const jf = docs.pages.find((p: any) => p.title === 'JF Auftraggeber');
  assert.ok(jf, 'Oberseite aus Seed');
  assert.equal(jf.settings.childTemplateKey, 'protokoll');
  assert.equal(jf.childCount, 2);
  const detail = (await t.api(pl).get(`/docs/pages/${jf.id}`)).json();
  assert.equal(detail.children.length, 2);
  // Unterseite ohne templateKey → Protokoll-Vorlage, Ordner der Oberseite
  const child = await t.api(pl).post(`/projects/${t.ids.projects.web}/docs/pages`, { title: 'Protokoll JF 23.10.2026', parentPageId: jf.id });
  assert.equal(child.statusCode, 200, child.body);
  assert.equal(child.json().page.templateKey, 'protokoll');
  assert.equal(child.json().page.folderId, jf.folderId);
  assert.match(child.json().page.contentHtml, /Beschlüsse/);
  // Enkel erbt ebenfalls
  const grand = await t.api(pl).post(`/projects/${t.ids.projects.web}/docs/pages`, { title: 'Anlage', parentPageId: child.json().page.id });
  assert.equal(grand.json().page.templateKey, 'protokoll');
  const childDetail = (await t.api(pl).get(`/docs/pages/${child.json().page.id}`)).json();
  assert.equal(childDetail.inheritedTemplateKey, 'protokoll');
  // Einstellungen ändern (auch auf finaler Oberseite erlaubt), PDF-Layout wird vererbt
  const set = await t.api(pl).patch(`/docs/pages/${jf.id}`, { settings: { childTemplateKey: 'statusbericht', pdf: { accentColor: '#aa0000', headerText: 'JF-Kopf' } } });
  assert.equal(set.statusCode, 200, set.body);
  assert.equal(set.json().page.version, jf.version, 'Einstellungen erzeugen keine Version');
  const next = await t.api(pl).post(`/projects/${t.ids.projects.web}/docs/pages`, { title: 'Bericht', parentPageId: jf.id });
  assert.equal(next.json().page.templateKey, 'statusbericht');
  const pdf = await t.api(pl).get(`/docs/pages/${child.json().page.id}/pdf`);
  assert.equal(pdf.statusCode, 200);
  assert.ok(pdf.rawPayload.length > 2000);
  // Zyklus verhindern
  assert.equal((await t.api(pl).patch(`/docs/pages/${jf.id}`, { parentPageId: jf.id })).statusCode, 400);
});

test('PDF aus HTML mit Schriftgrößen, Tabelle, Bild und Freigabe-Bearbeitung in HTML', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const html = `<h1>Bericht</h1><p style="text-align: center"><span style="font-size: 20px"><strong>Groß und fett</strong></span></p><ul><li>eins<ul><li>eins a</li></ul></li><li>zwei</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><img src="data:image/png;base64,${png.toString('base64')}" alt="Pixel"><blockquote><p>Zitat</p></blockquote>`;
  const pdf = await htmlToPdf(t.db, html, { title: 'Bericht', project: 'Demo', version: 1, status: 'final' }, { accentColor: '#aa0000', headerText: 'Kopf', footerText: 'Fuß' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 1500);
  const pl = await t.login('pl@demo.local');
  const docs = (await t.api(pl).get(`/projects/${t.ids.projects.web}/docs`)).json();
  const draft = docs.pages.find((p: any) => p.title === 'Statusbericht KW 41');
  const sh = await t.api(pl).post(`/docs/pages/${draft.id}/shares`, { email: 'extern@partner.de', mode: 'write', includeChildren: false });
  const token = sh.json().share.url.split('/s/')[1];
  const tree = (await t.app.inject({ method: 'GET', url: `/api/share/${token}` })).json();
  assert.ok(tree.root.contentHtml.length > 0);
  const edit = await t.app.inject({ method: 'PATCH', url: `/api/share/${token}/pages/${draft.id}`, payload: { contentHtml: tree.root.contentHtml + '<h2>Extern</h2><p>Ergänzt</p><script>x()</script>', baseVersion: tree.root.version } });
  assert.equal(edit.statusCode, 200, edit.body);
  assert.ok(edit.json().page.contentHtml.includes('<h2>Extern</h2>'));
  assert.ok(!edit.json().page.contentHtml.includes('<script'));
  assert.match(edit.json().page.contentMd, /## Extern/);
});

test('Ordner sind eine Seite: beim ersten Öffnen angelegt, Umbenennen folgt, Löschen nur ohne weitere Seiten', async () => {
  const pl = await t.login('pl@demo.local');
  const web = t.ids.projects.web;
  const docs = (await t.api(pl).get(`/projects/${web}/docs`)).json();
  const folder = docs.folders.find((f: any) => f.name === 'Allgemein');
  assert.ok(folder && !folder.pageId);
  const first = await t.api(pl).post(`/projects/${web}/docs/folders/${folder.id}/page`);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().created, true);
  assert.equal(first.json().page.title, 'Allgemein');
  const second = await t.api(pl).post(`/projects/${web}/docs/folders/${folder.id}/page`);
  assert.equal(second.json().created, false);
  assert.equal(second.json().page.id, first.json().page.id);
  const listed = (await t.api(pl).get(`/projects/${web}/docs`)).json();
  assert.equal(listed.folders.find((f: any) => f.id === folder.id).pageId, first.json().page.id);
  assert.equal(listed.pages.find((p: any) => p.id === first.json().page.id).isFolderPage, true);
  await t.api(pl).patch(`/projects/${web}/docs/folders/${folder.id}`, { name: 'Sonstiges' });
  assert.equal((await t.api(pl).get(`/docs/pages/${first.json().page.id}`)).json().page.title, 'Sonstiges');
  const delPage = await t.api(pl).del(`/docs/pages/${first.json().page.id}`);
  assert.equal(delPage.statusCode, 400, 'Ordnerseite nicht direkt löschbar');
  const delFolder = await t.api(pl).del(`/projects/${web}/docs/folders/${folder.id}`);
  assert.equal(delFolder.statusCode, 200, delFolder.body);
  assert.equal((await t.api(pl).get(`/docs/pages/${first.json().page.id}`)).statusCode, 404);
});
