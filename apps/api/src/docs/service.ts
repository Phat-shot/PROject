import type { DocFolder, DocPage, DocPageVersion, DocTemplate } from '@projekttool/shared';
import type { Db } from '../db.js';

export const DEFAULT_FOLDERS = ['Protokolle', 'Berichte', 'Konzepte', 'Allgemein'];

export async function createDefaultFolders(db: Db, projectId: string) {
  for (const [i, name] of DEFAULT_FOLDERS.entries()) {
    await db.query(`insert into doc_folders (project_id, name, position) values ($1,$2,$3)`, [projectId, name, i]);
  }
}

export function mapFolder(r: any): DocFolder {
  return { id: r.id, projectId: r.project_id, parentId: r.parent_id, name: r.name, position: r.position, distributionList: r.distribution_list ?? [] };
}

export function mapPage(r: any): DocPage {
  return {
    id: r.id,
    projectId: r.project_id,
    folderId: r.folder_id,
    parentPageId: r.parent_page_id,
    title: r.title,
    contentMd: r.content_md,
    status: r.status,
    version: r.version,
    templateKey: r.template_key,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    updatedByName: r.updated_by_name ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finalizedAt: r.finalized_at
  };
}

export function mapVersion(r: any): DocPageVersion {
  return { id: r.id, pageId: r.page_id, version: r.version, title: r.title, contentMd: r.content_md, status: r.status, savedBy: r.saved_by, savedByName: r.saved_by_name ?? '', savedAt: r.saved_at };
}

export function mapTemplate(r: any): DocTemplate {
  return { id: r.id, key: r.key, name: r.name, contentMd: r.content_md };
}

export const BUILTIN_TEMPLATES: { key: string; name: string; contentMd: string }[] = [
  {
    key: 'protokoll',
    name: 'Besprechungsprotokoll',
    contentMd: `# Protokoll {{datum}}

**Besprechung:** Jour fixe
**Datum:** {{datum}}
**Teilnehmer:** 

## Agenda

1. Stand der Aufgaben
2. Offene Punkte
3. Planänderungen

## Beschlüsse

- 

## Aufgaben

| Aufgabe | Zuständig | Fällig |
| --- | --- | --- |
|  |  |  |

## Nächster Termin

`
  },
  {
    key: 'statusbericht',
    name: 'Statusbericht',
    contentMd: `# Statusbericht {{datum}}

## Zusammenfassung

Ampel: 🟢

## Fortschritt seit letztem Bericht

- 

## Nächste Schritte

- 

## Risiken und Hindernisse

| Risiko | Auswirkung | Maßnahme |
| --- | --- | --- |
|  |  |  |
`
  },
  {
    key: 'konzept',
    name: 'Konzept / Entscheidungsvorlage',
    contentMd: `# Titel

## Ausgangslage

## Ziel

## Optionen

| Option | Vorteile | Nachteile |
| --- | --- | --- |
|  |  |  |

## Empfehlung

## Entscheidung

`
  }
];

export function renderTemplate(md: string): string {
  const d = new Date().toISOString().slice(0, 10);
  return md.replaceAll('{{datum}}', d);
}
