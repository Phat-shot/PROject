import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** TOTP nach RFC 6238 (SHA-1, 6 Stellen, 30 s), wie Google Authenticator, Microsoft Authenticator, 1Password. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | ALPHABET.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function newSecret(): string { return base32Encode(randomBytes(20)); }

export function totpCode(secret: string, time = Date.now(), step = 30): string {
  const counter = Math.floor(time / 1000 / step);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** Prüft den Code mit einem Schritt Toleranz in beide Richtungen (Uhrzeitabweichung). */
export function verifyTotp(secret: string, code: string, time = Date.now()): boolean {
  const given = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  for (const d of [0, -1, 1]) {
    const expect = totpCode(secret, time + d * 30_000);
    if (expect.length === given.length && timingSafeEqual(Buffer.from(expect), Buffer.from(given))) return true;
  }
  return false;
}

export function otpauthUrl(secret: string, account: string, issuer = 'PROject'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
