import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { isLegacySealed, isSealed, resetSecretKeyCache, seal, unseal } from '../src/secrets.js';

/** enc1-Wert so erzeugen, wie ihn der Bestand mit SECRET_KEY (SHA-256 der Zeichenkette) geschrieben hat */
function sealLegacy(secretKey: string, value: string): string {
  const key = createHash('sha256').update(secretKey).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return `enc1:${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

test('Geheimnisse: enc1-Bestand (SHA-256-Schlüssel) bleibt lesbar, neue Werte sind enc2 (scrypt/HKDF) und werden beim Schreiben umgepackt', () => {
  process.env.SECRET_KEY = 'kurzes-geheimnis';
  resetSecretKeyCache();
  try {
    const old = sealLegacy('kurzes-geheimnis', 'imap-passwort');
    assert.ok(isSealed(old) && isLegacySealed(old));
    assert.equal(unseal(old), 'imap-passwort', 'enc1 mit altem Schlüssel entschlüsselbar');
    const fresh = seal('neues-passwort')!;
    assert.match(fresh, /^enc2:/);
    assert.ok(!isLegacySealed(fresh));
    assert.equal(unseal(fresh), 'neues-passwort');
    assert.equal(seal(fresh), fresh, 'enc2 nicht doppelt verpackt');
    const repacked = seal(old)!;
    assert.match(repacked, /^enc2:/, 'enc1 wird beim Schreiben zu enc2');
    assert.equal(unseal(repacked), 'imap-passwort');
    // enc2 ist nicht mit dem alten Schlüssel verschlüsselt: anderer Schlüssel als SHA-256
    const [iv, tag, ct] = fresh.slice(5).split('.');
    assert.ok(iv && tag && ct);
    assert.equal(unseal('klartext'), 'klartext');
    // Anderer SECRET_KEY: weder enc1 noch enc2 lesbar
    process.env.SECRET_KEY = 'anderes-geheimnis';
    resetSecretKeyCache();
    assert.throws(() => unseal(old));
    assert.throws(() => unseal(fresh));
  } finally {
    delete process.env.SECRET_KEY;
    resetSecretKeyCache();
  }
});
