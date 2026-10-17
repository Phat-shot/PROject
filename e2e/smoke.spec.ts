import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, email = 'pl@demo.local') {
  await page.goto('/');
  await page.getByLabel('E-Mail').fill(email);
  await page.getByLabel('Passwort').fill('demo1234');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const skip = page.getByRole('button', { name: 'Überspringen' });
  if (await skip.count()) await skip.first().click();
}

test('Anmelden, Projekt öffnen, Arbeitspaket anlegen und im Drawer bearbeiten', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: /Website-Relaunch/ }).first().click();
  await expect(page.getByText('Fortschritt je Teilprojekt')).toBeVisible();
  await page.getByRole('link', { name: 'Arbeitspakete', exact: true }).click();
  await page.getByRole('button', { name: /Neues Arbeitspaket/ }).click();
  const title = `E2E ${Date.now()}`;
  await page.getByLabel('Titel').fill(title);
  await page.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.locator('.drawer')).toContainText('Tasks');
  await page.locator('.drawer input[placeholder^="Neuer Task"]').fill('Erster Schritt');
  await page.locator('.drawer input[placeholder^="Neuer Task"]').press('Enter');
  await expect(page.locator('.drawer .checklist input.inline-text').first()).toHaveValue('Erster Schritt');
  await page.getByRole('button', { name: 'Schließen' }).click();
  await expect(page.locator('.task-card', { hasText: title })).toBeVisible();
});

test('Suche nach Kennung, Kalender, Doku-Seite und Projekteinstellungen sind erreichbar', async ({ page }) => {
  await login(page);
  await page.getByPlaceholder(/Suchen/).fill('WEB-1');
  await expect(page.locator('.search-results .item').first()).toBeVisible();
  await page.getByRole('link', { name: 'Kalender', exact: true }).click();
  await expect(page.locator('.calendar')).toBeVisible();
  await page.getByRole('link', { name: /Website-Relaunch/ }).first().click();
  await page.getByRole('link', { name: 'Doku', exact: true }).click();
  await page.locator('.doc-tree .page').first().click();
  await expect(page.locator('.doc-view .doc-actions')).toBeVisible();
  await page.getByRole('link', { name: 'Einstellungen' }).first().click();
  await expect(page.locator('.section-nav')).toContainText('Papierkorb');
});

test('Leser darf nichts anlegen', async ({ page }) => {
  await login(page, 'leser@demo.local');
  await page.getByRole('link', { name: /Website-Relaunch/ }).first().click();
  await page.getByRole('link', { name: 'Arbeitspakete', exact: true }).click();
  await expect(page.getByRole('button', { name: /Neues Arbeitspaket/ })).toHaveCount(0);
});
