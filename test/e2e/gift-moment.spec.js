'use strict';
const { test, expect } = require('@playwright/test');

for (const theme of ['default', 'christmas']) {
  test(`gift promises feel special in ${theme}, with truthful quantities and owner privacy`, async ({ browser, baseURL }) => {
    const owner = await browser.newContext({ baseURL, locale: 'de-DE' });
    const giver = await browser.newContext({ baseURL, locale: 'de-DE' });
    const observer = await browser.newContext({ baseURL, locale: 'de-DE' });
    try {
      const register = async (context, prefix) => {
        const response = await context.request.post('/api/auth/register', { data: {
          username: prefix + Math.random().toString(36).slice(2, 10), firstName: prefix, lastName: 'Tester', password: 'test-password1',
        } });
        expect(response.ok()).toBe(true);
        return (await response.json()).user;
      };
      const person = await register(owner, 'owner');
      await register(giver, 'giver');
      await register(observer, 'observer');
      const response = await owner.request.post('/api/wishes', { data: { title: 'Ein kleines Glück', quantity: 3 } });
      const wish = (await response.json()).wish;
      await owner.request.put(`/api/wishes/${wish.id}/published`, { data: { published: true } });
      // Each visual variant uses the real claims API; only the instance appearance is controlled locally.
      for (const context of [giver, observer, owner]) {
        await context.route('**/api/settings', (route) => route.fulfill({ json: { theme } }));
      }
      const page = await giver.newPage();
      await page.goto(`/#/users/${person.id}`);
      await expect(page.getByTestId('gift-moment')).toHaveCount(0);
      await page.getByTestId('claim-contribute').click();
      await expect(page.getByTestId('claim-contribute')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('gift-moment')).toHaveCount(0);
      await page.getByTestId('claim-gift').click();
      const moment = page.getByTestId('gift-moment');
      await expect(moment).toContainText('Teilweise vergeben');
      await expect(moment).toHaveClass(/gift-celebrate/);
      await expect(page.getByTestId('other-wish')).toHaveClass(/has-gift/);
      await expect(page.getByTestId('toast')).toContainText(theme === 'christmas' ? 'Weihnachtszauber' : 'Wie lieb von dir');
      await expect(moment.locator(theme === 'christmas' ? '.gift-star' : '.gift-heart')).toBeVisible();
      await expect(moment.locator(theme === 'christmas' ? '.gift-heart' : '.gift-star')).toBeHidden();
      await expect(page.getByTestId('other-wish').locator('.media').getByTestId('gift-moment')).toBeVisible();
      await expect(page.getByTestId('other-wish').locator('.body, .foot').getByTestId('gift-moment')).toHaveCount(0);
      expect((await moment.boundingBox()).height).toBeLessThan(45);
      await expect(page.getByTestId('stock')).toContainText('1 von 3 vergeben');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/gift-${theme}-mobile.png`, fullPage: true, animations: 'disabled' });
      const other = await observer.newPage();
      await other.goto(`/#/users/${person.id}`);
      await expect(other.getByTestId('gift-moment')).toContainText('Teilweise vergeben');
      await expect(other.locator('.gift-celebrate')).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId('gift-moment')).toBeVisible();
      await expect(page.locator('.gift-celebrate')).toHaveCount(0);
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.getByTestId('claim-gift').click();
      await expect(moment).toHaveCount(0);
      await page.getByTestId('claim-gift').click();
      await expect(moment).toBeVisible();
      await expect(page.locator('.gift-confetti')).toBeHidden();
      await expect(page.locator('.gift-icon')).toHaveCSS('animation-name', 'none');
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.screenshot({ path: `test-results/gift-${theme}-dark.png`, fullPage: true });
      await page.getByTestId('claim-amount').fill('3');
      await page.getByTestId('claim-amount').press('Tab');
      await expect(moment).toContainText('Wird geschenkt');
      await expect(page.getByTestId('stock')).toContainText('3 von 3 vergeben');
      const ownPage = await owner.newPage();
      await ownPage.goto('/#/mine');
      await expect(ownPage.getByTestId('my-wish')).toBeVisible();
      await expect(ownPage.locator('.gift-moment, .has-gift')).toHaveCount(0);
      const ownResponse = await owner.request.get('/api/wishes/mine');
      const ownWish = (await ownResponse.json()).wishes[0];
      expect(ownWish).not.toHaveProperty('claims');
      expect(ownWish).not.toHaveProperty('taken');
      await page.getByTestId('claim-gift').click();
      await expect(moment).toHaveCount(0);
      await expect(page.getByTestId('other-wish')).not.toHaveClass(/has-gift/);
      await other.reload();
      await expect(other.getByTestId('gift-moment')).toHaveCount(0);
    } finally {
      await Promise.all([owner.close(), giver.close(), observer.close()]);
    }
  });
}
