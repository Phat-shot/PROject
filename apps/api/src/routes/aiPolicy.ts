import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth.js';
import { requireProject } from '../rights.js';
import { aiCapabilities } from '../ai/policy.js';

/**
 * Fähigkeiten der angemeldeten Person im Projekt (Knöpfe mit Begründung): je Assistenz-Funktion Person und ausführender Agent,
 * die Agenten des Projekts mit Läufen, Chat und Assistenz-Rechten. Rechte selbst stehen am Agenten (routes/agents.ts).
 */
export async function aiPolicyRoutes(app: FastifyInstance) {
  const db = app.db;
  app.get<{ Params: { id: string } }>('/projects/:id/ai/capabilities', async (req) => {
    const user = requireUser(req);
    await requireProject(db, user, req.params.id);
    return aiCapabilities(db, user, req.params.id);
  });
}
