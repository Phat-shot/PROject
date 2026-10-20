import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OrgSettings, User } from '@projekttool/shared';
import type { Db } from './db.js';
import { unauthorized } from './errors.js';

export const SESSION_COOKIE = 'pt_session';
const SESSION_DAYS = 14;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const calc = scryptSync(password, salt, 64);
  const given = Buffer.from(hash, 'hex');
  return calc.length === given.length && timingSafeEqual(calc, given);
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
    ...(row.kind === 'agent' && row.agent_project_id ? { agentProjectId: row.agent_project_id } : {})
  };
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
