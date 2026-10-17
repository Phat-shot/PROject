import { defineConfig } from '@playwright/test';

/** E2E-Smoke gegen eine laufende Instanz (Standard http://localhost:3000, Demodaten mit SEED=true). */
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    viewport: { width: 1400, height: 900 },
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : undefined
  }
});
