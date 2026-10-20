import { test, expect, type Page } from '@playwright/test';

async function login(page: Page, email = 'pl@demo.local') {
  await page.goto('/');
  // Die Anmeldeseite belegt im Demo-Modus die Felder nach /setup/status vor; erst danach ausfüllen
  await page.waitForLoadState('networkidle');
  await page.getByLabel('E-Mail').fill(email);
  await page.getByLabel('Passwort').fill('demo1234');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const skip = page.getByRole('button', { name: 'Überspringen' });
  if (await skip.count()) await skip.first().click();
}

test('Anmelden, Projekt öffnen, Arbeitspaket anlegen und im Drawer bearbeiten', async ({ page }) => {
  await login(page);
  // Ein Klick auf das Projekt öffnet direkt die Arbeitspakete (oberster Bereich des Projekts)
  await page.getByRole('link', { name: /Website-Relaunch/ }).first().click();
  await expect(page.locator('.task-card').first()).toBeVisible();
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
  await expect(page.locator('.topbar .tabs')).toContainText('Daten');
  await page.getByRole('link', { name: 'Daten', exact: true }).click();
  await expect(page.locator('.content')).toContainText('Papierkorb');
});

test('Bestehendes Arbeitspaket aus dem Board öffnen zeigt den Drawer mit Feldern', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: /Website-Relaunch/ }).first().click();
  await page.getByRole('link', { name: 'Arbeitspakete', exact: true }).click();
  await page.locator('.task-card').first().click();
  await expect(page.locator('.drawer')).toContainText('Zuständig');
  await expect(page.locator('.drawer')).toContainText('Log und Kommentare');
  await page.locator('.drawer').getByRole('button', { name: 'Schließen' }).click();
  await expect(page.locator('.drawer')).toHaveCount(0);
});

test('Leser darf nichts anlegen', async ({ page }) => {
  await login(page, 'leser@demo.local');
  await page.getByRole('link', { name: /Website-Relaunch/ }).first().click();
  await page.getByRole('link', { name: 'Arbeitspakete', exact: true }).click();
  await expect(page.getByRole('button', { name: /Neues Arbeitspaket/ })).toHaveCount(0);
});

test('Dashboard nach Projekt filtern, Reiter Projekte, Aufgabe im Arbeitspaket anlegen', async ({ page }) => {
  await login(page);
  await page.getByLabel('Projektfilter').selectOption({ label: 'WEB · Website-Relaunch' });
  await expect(page.getByText('Fortschritt je Teilprojekt')).toBeVisible();
  await page.getByRole('link', { name: 'Projekte', exact: true }).click();
  await expect(page.locator('table.portfolio tbody tr')).toHaveCount(1);
  await page.getByRole('link', { name: /Website-Relaunch/ }).first().click();
  await page.locator('.task-card', { hasText: 'CMS-Auswahl' }).click();
  await expect(page.locator('.drawer')).toContainText('Aufgaben');
  const title = `E2E Aufgabe ${Date.now()}`;
  await page.locator('.drawer input[placeholder^="Neue Aufgabe"]').fill(title);
  await page.locator('.drawer input[placeholder^="Neue Aufgabe"]').press('Enter');
  await page.locator('.drawer .subtasks li', { hasText: title }).locator('.st-title').click();
  await expect(page.locator('.drawer')).toContainText('Aufgabe im Arbeitspaket');
  await expect(page.locator('.drawer')).toContainText('Log und Kommentare');
});

test('Messenger: Knopf unten rechts, Projektkanal öffnen, Nachricht senden, Suche', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Chat öffnen' }).click();
  await page.locator('.messenger-overlay .msg-item', { hasText: 'Website-Relaunch' }).click();
  const text = `E2E Nachricht ${Date.now()}`;
  await page.locator('.messenger-overlay textarea').fill(text);
  await page.locator('.messenger-overlay').getByRole('button', { name: 'Senden' }).click();
  await expect(page.locator('.messenger-overlay .chat-list')).toContainText(text);
  await page.getByLabel('Chat durchsuchen').fill(text);
  await expect(page.locator('.messenger-overlay .msg-hit')).toContainText(text);
  await page.getByRole('button', { name: 'Chat schließen' }).click();
  await expect(page.locator('.messenger-overlay')).toHaveCount(0);
});

test('HTML-Mail läuft isoliert: kein Skript, externe Bilder erst auf Klick', async ({ page }) => {
  await login(page);
  const subject = `E2E HTML ${Date.now()}`;
  await page.evaluate(async (s) => {
    const { accounts } = await (await fetch('/api/mail/accounts')).json();
    const acc = accounts.find((a: { type: string }) => a.type === 'project');
    await fetch('/api/dev/mail/inject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: acc.id, from: 'angreifer@example.com', subject: s, html: '<p>Hallo</p><img src="x" onerror="window.top.__xss=1"><img src="https://example.com/pixel.png">' }) });
  }, subject);
  await page.goto('/postfach');
  await page.locator('.mail-item', { hasText: subject }).click();
  await expect(page.locator('iframe.mail-html')).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  await expect(page.getByText('Externe Bilder sind blockiert')).toBeVisible();
  await expect(page.frameLocator('iframe.mail-html').getByText('Hallo')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await page.getByRole('button', { name: 'Bilder laden' }).click();
  await expect(page.getByText('Externe Bilder sind blockiert')).toHaveCount(0);
});
