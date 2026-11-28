'use strict';
const { test, expect } = require('@playwright/test');

test('admin enables Christmas for visitors, decoration stays in the background, and theme can be disabled', async ({ page, browser }) => {
  await page.goto('/#/login');
  await page.fill('input[name=login]', 'admin');
  await page.fill('input[name=password]', 'admin-e2e-pass1');
  await page.click('button[type=submit]');
  const toggle = page.getByTestId('christmas-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const visitor = await browser.newContext({ locale: 'de-DE' });
  try {
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'christmas');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const guest = await visitor.newPage();
    await guest.goto('/');
    await expect(guest.getByTestId('christmas-atmosphere')).toBeVisible();
    await expect(guest.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
    await expect(guest.getByTestId('christmas-motion')).toHaveCount(0);
    await expect(guest.locator('.christmas-banner')).toHaveCount(0);
    await expect(guest.getByTestId('christmas-atmosphere')).toHaveCSS('pointer-events', 'none');
    await guest.fill('input[name=login]', 'winterguest');
    await expect(guest.locator('input[name=login]')).toHaveValue('winterguest');
    await guest.setViewportSize({ width: 390, height: 844 });
    await expect(guest.getByTestId('christmas-atmosphere')).toBeVisible();
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await guest.screenshot({ path: 'test-results/christmas-mobile.png', fullPage: true });
    await guest.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await expect(guest.locator('.christmas-snow')).toBeHidden();
    await expect(guest.locator('.christmas-stars')).toBeHidden();
    await guest.setViewportSize({ width: 1440, height: 1000 });
    await guest.screenshot({ path: 'test-results/christmas-desktop-dark.png', fullPage: true });
    const asset = await guest.request.get('/images/christmas-village.webp');
    expect(asset.ok()).toBe(true);
    expect(asset.headers()['content-type']).toContain('image/webp');
    await guest.getByTestId('lang').selectOption('en');
    await expect(guest.getByRole('heading', { name: 'Log in' })).toBeVisible();
    await page.reload();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'default');
    await guest.reload();
    await expect(guest.getByTestId('christmas-atmosphere')).toBeHidden();
  } finally {
    await page.request.put('/api/admin/settings', { data: { theme: 'default' } });
    await visitor.close();
  }
});
