import type { ProjectContact } from '@projekttool/shared';
import { useData } from './useData';

/** Kontakte des Projekts: externe Personen ohne Login, die Arbeitspakete und Tasks bekommen. */
export function useContacts(projectId: string) {
  const d = useData<{ contacts: ProjectContact[] }>(`/projects/${projectId}/contacts`, [projectId]);
  return { contacts: d.data?.contacts ?? [], reload: d.reload };
}

export const contactLabel = (c: { name: string | null; email: string; organization?: string | null }) => `${c.name ?? c.email}${c.organization ? ` (${c.organization})` : ''}${c.name ? ` <${c.email}>` : ''}`;
