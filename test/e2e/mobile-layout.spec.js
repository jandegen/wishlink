'use strict';
const { test, expect } = require('@playwright/test');

for (const theme of ['default', 'christmas']) {
  test(`mobile ${theme}: readable fields and contained cards after editing and rotation`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 320, height: 740 }, isMobile: true, hasTouch: true, locale: 'de-DE' });
    await context.route('**/api/settings', (route) => route.fulfill({ json: { theme } }));
    const page = await context.newPage();
    const checkFields = async () => {
      const small = await page.locator('input:visible, textarea:visible, select:visible').evaluateAll((els) =>
        els.filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => ({ name: el.name || el.getAttribute('aria-label'), font: getComputedStyle(el).fontSize })));
      expect(small, 'focused controls must not trigger iPhone small-text zoom').toEqual([]);
    };
    const checkBounds = async () => {
      const outside = await page.locator('.tile, .head-actions button, .owner-actions button, .auth, .panel, dialog[open], input:visible, textarea:visible, select:visible').evaluateAll((els) =>
        els.filter((el) => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > document.documentElement.clientWidth + 1; }).map((el) => el.className || el.tagName));
      expect(outside, 'visible cards and controls must stay inside the layout viewport').toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    };
    try {
      await page.goto('/#/register');
      await checkFields();
      const viewport = await page.locator('meta[name=viewport]').getAttribute('content');
      expect(viewport).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\D|$)/);
      await page.fill('input[name=username]', `mob${Math.random().toString(36).slice(2, 10)}`);
      await page.fill('input[name=firstName]', 'Mobile');
      await page.fill('input[name=lastName]', 'Tester');
      await page.fill('input[name=password]', 'mobile-password1');
      await page.locator('button[type=submit]').tap();
      await expect(page.getByTestId('add-wish')).toBeVisible();
      await page.getByTestId('add-wish').tap();
      await checkFields();
      await checkBounds();
      await page.fill('input[name=title]', 'Zusatzakku'.repeat(18));
      await page.fill('textarea[name=description]', 'LangeProduktbeschreibung'.repeat(15));
      await page.fill('input[name=quantity]', '3');
      await page.getByRole('button', { name: 'Speichern' }).tap();
      await expect(page.getByTestId('my-wish')).toBeVisible();
      await checkBounds();
      await page.getByRole('button', { name: 'Bearbeiten', exact: true }).tap();
      await checkFields();
      await page.locator('input[name=title]').tap();
      await page.getByRole('button', { name: 'Speichern' }).tap();
      await expect(page.getByTestId('wish-dialog')).toHaveCount(0);
      for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 740 }]) {
        await page.setViewportSize(viewport);
        await checkBounds();
        await checkFields();
      }
      await page.getByTestId('toggle-publish').tap();
      await expect(page.getByTestId('my-wish')).toContainText('Freigegeben');
      const ownerId = (await (await context.request.get('/api/auth/me')).json()).user.id;
      await page.getByTestId('nav-account').tap();
      await expect(page.locator('.panel').first()).toBeVisible();
      await checkFields();
      await checkBounds();
      const response = await context.request.post('/api/auth/register', { data: {
        username: `view${Math.random().toString(36).slice(2, 10)}`, firstName: 'Viewer', lastName: 'Tester', password: 'mobile-password1',
      } });
      expect(response.ok()).toBe(true);
      const viewer = (await response.json()).user;
      await page.reload(); // refresh the SPA session after registering through the API
      await expect(page.getByTestId('whoami')).toHaveText(viewer.username);
      await page.goto(`/#/users/${ownerId}`);
      await expect(page.getByTestId('claim-amount')).toBeVisible();
      await page.getByTestId('claim-contribute').tap();
      await expect(page.getByTestId('claim-contribution')).toBeVisible();
      await page.getByTestId('comments').locator('summary').tap();
      await expect(page.getByTestId('comment-input')).toBeVisible();
      await checkFields();
      await checkBounds();
    } finally { await context.close(); }
  });
}
