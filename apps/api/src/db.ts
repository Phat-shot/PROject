import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface QueryResult<T> {
  rows: T[];
  rowCount?: number | null;
}

export interface Db {
  kind: 'pg' | 'pglite';
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Mehrere Anweisungen in einem Skript (Migrationen). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  /** Alles in fn in einer Transaktion (eigene Verbindung); Fehler → Rollback. Fehlt bei Test-Doubles. */
  transaction?<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** Transaktion, wenn die Datenbank sie anbietet; sonst direkt (Test-Doubles). */
export async function withTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction ? db.transaction(fn) : fn(db);
}

function wrap(kind: Db['kind'], raw: { query: (sql: string, params?: unknown[]) => Promise<any>; exec?: (sql: string) => Promise<any> }, close: () => Promise<void>, transaction?: Db['transaction']): Db {
  const db: Db = {
    kind,
    async query(sql, params = []) {
      const res = await raw.query(sql, params as any[]);
      return { rows: res.rows as any[], rowCount: res.rowCount ?? res.affectedRows ?? null };
    },
    async one(sql, params = []) {
      const r = await db.query(sql, params);
      if (r.rows.length === 0) throw new Error('Expected one row, got none');
      return r.rows[0];
    },
    async maybeOne(sql, params = []) {
      const r = await db.query(sql, params);
      return r.rows[0] ?? null;
    },
    async exec(sql) {
      if (raw.exec) await raw.exec(sql);
      else await raw.query(sql);
    },
    close,
    transaction
  };
  return db;
}

/**
 * DATABASE_URL gesetzt → PostgreSQL (pg Pool).
 * DATABASE_URL = "memory" → PGlite im Speicher (Tests).
 * sonst → PGlite als Datei unter DATA_DIR/pglite (Entwicklung ohne Postgres).
 */
export async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url && url !== 'memory') {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url });
    const transaction = async <T,>(fn: (tx: Db) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const r = await fn(wrap('pg', client, async () => undefined));
        await client.query('commit');
        return r;
      } catch (e) {
        await client.query('rollback').catch(() => undefined);
        throw e;
      } finally { client.release(); }
    };
    return wrap('pg', pool, () => pool.end(), transaction);
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dataDir = url === 'memory' ? undefined : path.join(process.env.DATA_DIR ?? '.data', 'pglite');
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;
  const transaction = <T,>(fn: (tx: Db) => Promise<T>): Promise<T> => lite.transaction((t) => fn(wrap('pglite', t as any, async () => undefined))) as Promise<T>;
  return wrap('pglite', lite as any, () => lite.close(), transaction);
}

const here = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(db: Db, dir = path.resolve(here, '..', 'migrations')): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set((await db.query<{ name: string }>(`select name from schema_migrations`)).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    await db.exec(sql);
    await db.query(`insert into schema_migrations (name) values ($1)`, [f]);
    done.push(f);
  }
  return done;
}
