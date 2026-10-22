import { expect, type Page } from '@playwright/test';

/**
 * Anmeldung über die Oberfläche, die Sitzung wird je Benutzer wiederverwendet: die API drosselt Anmeldungen
 * (10 je Minute und Adresse), die Suite meldet sich sonst öfter an.
 */
const sessions = new Map<string, { name: string; value: string; domain: string; path: string }[]>();

export async function login(page: Page, email = 'pl@demo.local') {
  const saved = sessions.get(email);
  if (saved) {
    await page.context().addCookies(saved);
    await page.goto('/dashboard');
  } else {
    await page.goto('/');
    // Die Anmeldeseite belegt im Demo-Modus die Felder nach /setup/status vor; erst danach ausfüllen
    await page.waitForLoadState('networkidle');
    await page.getByLabel('E-Mail').fill(email);
    await page.getByLabel('Passwort').fill('demo1234');
    await page.getByRole('button', { name: 'Anmelden' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  if (!saved) sessions.set(email, (await page.context().cookies()).filter((c) => c.name === 'pt_session').map(({ name, value, domain, path }) => ({ name, value, domain, path })));
  const skip = page.getByRole('button', { name: 'Überspringen' });
  if (await skip.count()) await skip.first().click();
}
