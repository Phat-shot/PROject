import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OrgSettings, User } from '@projekttool/shared';
import type { Db } from './db.js';
import { unauthorized } from './errors.js';

export const SESSION_COOKIE = 'pt_session';
const SESSION_DAYS = 14;

/**
 * Passwort-Hashes: „scrypt2$N$salt$hash“ mit N=2^17, r=8, p=1 (Parameter im Hash, 256 MiB maxmem); Bestand „scrypt$salt$hash“
 * (Node-Standard N=2^14) wird weiter geprüft und bei erfolgreicher Anmeldung neu gehasht (needsRehash).
 */
export const SCRYPT_N = 131072;
const SCRYPT_OPTS = { r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
/** Arbeitsfaktor; PASSWORD_SCRYPT_N (Zweierpotenz ≥ 2^14) senkt ihn nur für Tests oder sehr schwache Hardware. */
export function scryptN(): number {
  const n = Number(process.env.PASSWORD_SCRYPT_N);
  return Number.isInteger(n) && n >= 16384 && n <= 1 << 20 && (n & (n - 1)) === 0 ? n : SCRYPT_N;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const N = scryptN();
  const hash = scryptSync(password, salt, 64, { N, ...SCRYPT_OPTS }).toString('hex');
  return `scrypt2$${N}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = String(stored ?? '').split('$');
  let salt: string, hash: string, N: number;
  if (parts[0] === 'scrypt2' && parts.length === 4) { N = Number(parts[1]); salt = parts[2]; hash = parts[3]; }
  else if (parts[0] === 'scrypt' && parts.length === 3) { N = 16384; salt = parts[1]; hash = parts[2]; }
  else return false;
  if (!salt || !hash || !Number.isInteger(N) || N < 1024 || N > 1 << 20) return false;
  const calc = scryptSync(password, salt, 64, { N, ...SCRYPT_OPTS });
  const given = Buffer.from(hash, 'hex');
  return calc.length === given.length && timingSafeEqual(calc, given);
}

/** Hash im Altformat oder mit schwächeren Parametern: nach erfolgreicher Anmeldung neu hashen. */
export function needsRehash(stored: string): boolean {
  const parts = String(stored ?? '').split('$');
  return !(parts[0] === 'scrypt2' && Number(parts[1]) >= scryptN());
}

export function mapUser(row: any): User {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    name: row.name,
    globalRole: row.global_role,
    orgRights: row.org_rights ?? [],
    active: row.active,
    settings: row.settings ?? {},
    totpEnabled: Boolean(row.totp_enabled),
    kind: row.kind === 'agent' ? 'agent' : 'person',
    ...(row.kind === 'agent' && row.agent_project_id ? { agentProjectId: row.agent_project_id } : {}),
    ...(row.kind === 'agent' ? { agentRole: row.agent_role === 'assistant' ? 'assistant' : 'project' } : { personalProjectAllowed: typeof row.personal_project_allowed === 'boolean' ? row.personal_project_allowed : null })
  };
}

/** Mandantenschalter „Persönliche Projekte“: alle dürfen sich selbst eins anlegen (Freigabe je Person geht vor, projectPolicy.personalAllowed). */
export async function orgAllowsPersonal(db: Db, orgId: string): Promise<boolean> {
  return Boolean((await db.one(`select settings from orgs where id = $1`, [orgId])).settings?.personalProjects);
}

/** Verwaltet die Person mindestens eine Gruppe (group_members.is_manager)? Für den Menüpunkt Verwaltung. */
/** Teil der Mandanten-Einstellungen, den jede angemeldete Person sieht (Module, Darstellung); Rest nur über Org-Admin-Endpoints. */
export function publicOrgSettings(settings: any): OrgSettings {
  const s = settings ?? {};
  return { company: s.company, accentColor: s.accentColor, timeTracking: s.timeTracking, personalProjects: s.personalProjects, ai: s.ai ? { enabled: s.ai.enabled } : undefined };
}

export async function withManagedGroups(db: Db, user: User): Promise<User> {
  const r = await db.maybeOne(`select 1 from group_members where user_id = $1 and is_manager limit 1`, [user.id]);
  return { ...user, managesGroups: Boolean(r) };
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.query(`insert into sessions (token, user_id, expires_at) values ($1, $2, $3)`, [token, userId, expires]);
  return token;
}

export async function userFromToken(db: Db, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const row = await db.maybeOne(
    `select u.* from sessions s join users u on u.id = s.user_id
     where s.token = $1 and s.expires_at > now() and u.active`,
    [token]
  );
  return row ? mapUser(row) : null;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: SESSION_DAYS * 86400
  });
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}
