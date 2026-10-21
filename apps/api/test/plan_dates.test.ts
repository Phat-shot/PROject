import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, ymd } from '../src/ai/plan.js';

test('Datum aus Modellen und Menschen: ISO, deutsch, Spannen, Jahreswechsel, Unsinn', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  assert.equal(ymd('2026-11-08'), '2026-11-08');
  assert.equal(ymd('2026-11-08T10:00'), '2026-11-08');
  assert.equal(ymd('8.11.2026'), '2026-11-08');
  assert.equal(ymd('08.11.26'), '2026-11-08');
  assert.equal(ymd('8.11.', 'end', now), '2026-11-08');
  assert.equal(ymd('6.–8.11.', 'end', now), '2026-11-08');
  assert.equal(ymd('6.–8.11.', 'start', now), '2026-11-06');
  assert.equal(ymd('6.-8.11.2026', 'start', now), '2026-11-06');
  assert.equal(ymd('28.11. bis 3.12.', 'start', now), '2026-11-28');
  assert.equal(ymd('5.1.', 'end', now), '2027-01-05', 'liegt mehr als zwei Monate zurück: nächstes Jahr');
  assert.equal(ymd('', 'end', now), null);
  assert.equal(ymd('nächste Woche', 'end', now), undefined);
  assert.equal(ymd('31.2.2026'), undefined);
});

test('Titel: vorangestellte Kennungen entfernt die Vergabe des Systems', () => {
  assert.equal(cleanTitle('AGP-0: Termin Hardwareauslagerung AirGPU'), 'Termin Hardwareauslagerung AirGPU');
  assert.equal(cleanTitle('[WEB-12] Angebot prüfen'), 'Angebot prüfen');
  assert.equal(cleanTitle('Angebot WEB-12 prüfen'), 'Angebot WEB-12 prüfen');
});

test('Kalender im Prompt: Wochentag, KW, morgen, Ende der Woche, Wochenende', async () => {
  const { calendarText } = await import('../src/ai/plan.js');
  const c = calendarText(new Date('2026-10-21T15:00:00Z'));
  assert.match(c, /^Mi 21\.10\.2026 \(KW 43/);
  assert.match(c, /Do 22\.10\. \(morgen\), Fr 23\.10\. \(Ende der Woche\), Sa 24\.10\. \(Wochenende\), So 25\.10\. \(Wochenende\), Mo 26\.10\. \(nächste Woche\)/);
});
