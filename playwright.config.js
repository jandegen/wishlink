'use strict';
const { defineConfig } = require('@playwright/test');

const PORT = process.env.E2E_PORT || 3100;
const FIXTURE_PORT = process.env.FIXTURE_PORT || 3101;

module.exports = defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'test-results/e2e-junit.xml' }]] : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', locale: 'de-DE' },
  webServer: [
    {
      command: 'node test/e2e/fixture-server.js',
      url: `http://127.0.0.1:${FIXTURE_PORT}/health`,
      reuseExistingServer: false,
      env: { FIXTURE_PORT: String(FIXTURE_PORT) },
    },
    {
      command: 'node src/server.js',
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: false,
      env: { PORT: String(PORT), DATABASE_PATH: ':memory:', PREVIEW_ALLOW_PRIVATE: 'true', AUTH_RATE_LIMIT: '1000', OPERATOR_NAME: 'Max Mustermann', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-e2e-pass1' },
    },
  ],
});
