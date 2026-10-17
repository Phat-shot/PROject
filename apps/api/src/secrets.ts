import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Verschlüsselung gespeicherter Geheimnisse (Mail-Passwörter, OAuth-Tokens, KI-Schlüssel) mit AES-256-GCM.
 * Schlüssel: SECRET_KEY aus der Umgebung (beliebige Zeichenkette, wird gehasht) oder eine beim ersten Start erzeugte
 * Datei DATA_DIR/secret.key. Werte ohne Präfix „enc1:“ gelten als Klartext (Bestand) und werden beim nächsten
 * Schreiben verschlüsselt. Ohne den Schlüssel sind die Werte unbrauchbar; Backup der Datei gehört zum Betrieb.
 */
const PREFIX = 'enc1:';
let key: Buffer | null = null;

function loadKey(): Buffer {
  if (key) return key;
  if (process.env.SECRET_KEY) { key = createHash('sha256').update(process.env.SECRET_KEY).digest(); return key; }
  if (process.env.DATABASE_URL === 'memory' || process.env.NODE_ENV === 'test') { key = randomBytes(32); return key; }
  const dir = process.env.DATA_DIR ?? '.data';
  const file = path.join(dir, 'secret.key');
  if (existsSync(file)) key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  else {
    mkdirSync(dir, { recursive: true });
    key = randomBytes(32);
    writeFileSync(file, key.toString('hex') + '\n', { mode: 0o600 });
  }
  return key;
}

/** Verschlüsselt einen Wert; null/leer bleibt unverändert, bereits verschlüsselte Werte werden nicht doppelt verpackt. */
export function seal(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (value.startsWith(PREFIX)) return value;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

/** Entschlüsselt; Klartext (Bestand) wird unverändert zurückgegeben. */
export function unseal(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  if (!value.startsWith(PREFIX)) return value;
  const [iv, tag, ct] = value.slice(PREFIX.length).split('.');
  const d = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export const isSealed = (value: string | null | undefined) => Boolean(value?.startsWith(PREFIX));
