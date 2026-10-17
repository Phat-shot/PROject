import type { DocFolder, DocPage, DocPageVersion, DocTemplate } from '@projekttool/shared';
import type { Db } from '../db.js';

export const DEFAULT_FOLDERS = ['Protokolle', 'Berichte', 'Konzepte', 'Allgemein'];

export async function createDefaultFolders(db: Db, projectId: string) {
  for (const [i, name] of DEFAULT_FOLDERS.entries()) {
    await db.query(`insert into doc_folders (project_id, name, position) values ($1,$2,$3)`, [projectId, name, i]);
  }
}

export function mapFolder(r: any): DocFolder {
  return { id: r.id, projectId: r.project_id, parentId: r.parent_id, name: r.name, position: r.position, distributionList: r.distribution_list ?? [], pageId: r.page_id ?? null };
}

export function mapPage(r: any): DocPage {
  return {
    id: r.id,
    projectId: r.project_id,
    folderId: r.folder_id,
    parentPageId: r.parent_page_id,
    title: r.title,
    contentMd: r.content_md,
    contentHtml: r.content_html ?? '',
    settings: r.settings ?? {},
    childCount: r.child_count ?? undefined,
    isFolderPage: r.is_folder_page === undefined ? undefined : Boolean(r.is_folder_page),
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
  return { id: r.id, pageId: r.page_id, version: r.version, title: r.title, contentMd: r.content_md, contentHtml: r.content_html ?? undefined, status: r.status, savedBy: r.saved_by, savedByName: r.saved_by_name ?? '', savedAt: r.saved_at };
}

export function mapTemplate(r: any): DocTemplate {
  return { id: r.id, key: r.key, name: r.name, contentMd: r.content_md, contentHtml: r.content_html ?? '' };
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

1. Stand der Arbeitspakete
2. Offene Punkte
3. Planänderungen

## Beschlüsse

- 

## Arbeitspakete

| Arbeitspaket | Zuständig | Fällig |
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

BUILTIN_TEMPLATES.push(
  {
    key: 'raid',
    name: 'RAID-Log (Risiken, Annahmen, Issues, Entscheidungen)',
    contentMd: `# RAID-Log

Lebendes Dokument: bei jedem Jour fixe durchgehen und aktualisieren.

## Risiken

| Nr | Risiko | Eintritt (1–5) | Auswirkung (1–5) | Maßnahme | Verantwortlich | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R1 |  |  |  |  |  | offen |

## Annahmen

| Nr | Annahme | Gilt bis / Prüfung | Verantwortlich |
| --- | --- | --- | --- |
| A1 |  |  |  |

## Issues (eingetretene Probleme)

| Nr | Issue | Seit | Auswirkung | Nächster Schritt | Verantwortlich | Status |
| --- | --- | --- | --- | --- | --- | --- |
| I1 |  |  |  |  |  | offen |

## Entscheidungen

| Nr | Entscheidung | Datum | Entschieden von | Begründung | Betroffene Arbeitspakete |
| --- | --- | --- | --- | --- | --- |
| E1 |  | {{datum}} |  |  |  |
`
  },
  {
    key: 'aenderungsantrag',
    name: 'Änderungsantrag (Change Request)',
    contentMd: `# Änderungsantrag: Titel

**Antragsteller:**   **Datum:** {{datum}}   **Status:** eingereicht

## Beschreibung der Änderung

## Begründung / Nutzen

## Auswirkungen

| Bereich | Auswirkung |
| --- | --- |
| Umfang |  |
| Termine |  |
| Kosten |  |
| Risiken |  |

## Entscheidung

| Entschieden von | Datum | Ergebnis | Auflagen |
| --- | --- | --- | --- |
|  |  | offen |  |
`
  },
  {
    key: 'kickoff',
    name: 'Kickoff-Protokoll',
    contentMd: `# Kickoff {{datum}}

**Teilnehmer:** 

## Projektziel und Erfolgskriterien

## Umfang (in / out)

## Rollen und Verantwortung

| Rolle | Person | Vertretung |
| --- | --- | --- |
| PL |  |  |

## Meilensteine

| Meilenstein | Termin |
| --- | --- |
|  |  |

## Zusammenarbeit

- Jour fixe: Rhythmus, Teilnehmer
- Kommunikationswege, Verteiler
- Ablageorte

## Bekannte Risiken und offene Punkte

## Nächste Schritte

| Arbeitspaket | Zuständig | Fällig |
| --- | --- | --- |
|  |  |  |
`
  },
  {
    key: 'lessons',
    name: 'Lessons Learned',
    contentMd: `# Lessons Learned {{datum}}

**Teilnehmer:** 

## Was lief gut (beibehalten)

- 

## Was lief schlecht (abstellen)

- 

## Was probieren wir beim nächsten Mal

- 

## Kennzahlen

| Kennzahl | Plan | Ist |
| --- | --- | --- |
| Go-Live |  |  |
| Budget |  |  |

## Maßnahmen

| Maßnahme | Verantwortlich | Fällig |
| --- | --- | --- |
|  |  |  |
`
  }
);

BUILTIN_TEMPLATES.push(
  {
    key: 'reihe',
    name: 'Besprechungsreihe (Oberseite)',
    contentMd: `# Besprechungsreihe

## Zusammenfassung

Zweck der Reihe, Entscheidungsrahmen, aktueller Stand in zwei Sätzen.

## Teilnehmer

| Name | Rolle | Organisation |
| --- | --- | --- |
|  |  |  |

## Rhythmus und Verteiler

- Rhythmus: 
- Verteiler: 
- Ablage der Protokolle: Unterseiten dieser Seite
`
  },
  {
    key: 'teilprojekt',
    name: 'Teilprojekt (Oberseite)',
    contentMd: `# Teilprojekt

## Zusammenfassung

Ziel, Umfang, aktueller Stand.

## Beteiligte

| Name | Rolle |
| --- | --- |
|  |  |

## Meilensteine

| Meilenstein | Termin | Status |
| --- | --- | --- |
|  |  |  |

## Offene Punkte

- 
`
  }
);

/** Eingebaute Vorlagen nachziehen (für bestehende Datenbanken). */
export async function ensureBuiltinTemplates(db: Db) {
  const { mdToHtml } = await import('./html.js');
  for (const t of BUILTIN_TEMPLATES) {
    await db.query(`insert into doc_templates (org_id, key, name, content_md, content_html) values (null, $1, $2, $3, $4) on conflict do nothing`, [t.key, t.name, t.contentMd, mdToHtml(t.contentMd)]);
  }
}

export function renderTemplate(md: string): string {
  const d = new Date().toISOString().slice(0, 10);
  return md.replaceAll('{{datum}}', d);
}
