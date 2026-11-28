'use strict';
const { test, expect } = require('@playwright/test');

const SHOP = `http://127.0.0.1:${process.env.FIXTURE_PORT || 3101}`;
const uid = () => Math.random().toString(36).slice(2, 8);

async function register(page, name) {
  await page.goto('/#/register');
  await page.fill('input[name=username]', name);
  await page.fill('input[name=firstName]', name);
  await page.fill('input[name=lastName]', 'Tester');
  await page.fill('input[name=password]', 'password123');
  await page.click('button[type=submit]');
  await expect(page.getByTestId('whoami')).toHaveText(name);
}

const card = (page, name) => page.locator('[data-testid=user-card]', { hasText: name });

async function newUser(browser, prefix) {
  const ctx = await browser.newContext({ locale: 'de-DE' });
  const page = await ctx.newPage();
  const name = `${prefix}${uid()}`;
  await register(page, name);
  return { ctx, page, name };
}

test('UI is German by default and switchable to English', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
  await page.getByTestId('lang').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
});

test('login errors are shown', async ({ page }) => {
  await page.goto('/');
  await page.fill('input[name=login]', 'nobody');
  await page.fill('input[name=password]', 'wrongwrong');
  await page.click('button[type=submit]');
  await expect(page.getByTestId('auth-error')).toHaveText('Benutzername oder Passwort falsch.');
});

test('full flow: owner publishes wish, others claim, owner sees nothing', async ({ browser }) => {
  const owner = await newUser(browser, 'own');
  const bob = await newUser(browser, 'bob');
  const carol = await newUser(browser, 'car');

  // Owner creates a draft wish with prio high
  await owner.page.getByTestId('add-wish').click();
  await owner.page.fill('input[name=title]', 'Fahrrad');
  await owner.page.fill('textarea[name=description]', 'Rot, 28 Zoll');
  await owner.page.fill('input[name=link]', `${SHOP}/bike-a`);
  await owner.page.getByTestId('add-link').click();
  await owner.page.locator('input[name=link]').nth(1).fill(`${SHOP}/bike-b`);
  await owner.page.locator('input[name=link]').nth(1).blur();
  await expect(owner.page.getByTestId('wish-dialog').getByText('Produkt bike-b')).toBeVisible(); // live preview in form
  await owner.page.selectOption('select[name=priority]', '1');
  await owner.page.getByRole('button', { name: 'Speichern' }).click();
  const mine = owner.page.getByTestId('my-wish');
  await expect(mine).toContainText('Fahrrad');
  await expect(mine).toContainText('Entwurf');
  // two links, previews generated in the background
  await expect(mine.getByTestId('wish-link')).toHaveCount(2);
  await expect(mine).toContainText('Produkt bike-a');
  await expect(mine).toContainText('Produkt bike-b');
  await expect(mine.locator('img').first()).toBeVisible();

  // Draft invisible to others
  await bob.page.getByRole('link', { name: 'Wünsche anderer' }).click();
  await expect(card(bob.page, owner.name)).toContainText('0 Wünsche'); // draft: listed, but nothing visible

  // Publish -> visible
  await owner.page.getByTestId('toggle-publish').click();
  await expect(mine).toContainText('Freigegeben');
  await bob.page.reload();
  await card(bob.page, owner.name).click();
  const wish = bob.page.getByTestId('other-wish');
  await expect(wish).toContainText('Fahrrad');
  await expect(wish).toContainText('Hoch');
  await expect(wish.getByTestId('wish-link')).toHaveCount(2);
  await expect(wish).toContainText('Fixture Shop');

  // Bob claims, Carol sees Bob's claim and contributes
  await bob.page.getByTestId('claim-gift').click();
  await expect(bob.page.getByTestId('claims')).toContainText('du (schenkt)');
  await carol.page.getByRole('link', { name: 'Wünsche anderer' }).click();
  await card(carol.page, owner.name).click();
  await expect(carol.page.getByTestId('claims')).toContainText(`${bob.name} Tester (schenkt)`);
  await carol.page.getByTestId('claim-contribute').click();
  await expect(carol.page.getByTestId('claims')).toContainText('du (beteiligt sich)');

  // Owner sees no trace of any interaction - UI and network
  const requests = [];
  owner.page.on('response', async (r) => { if (r.url().includes('/api/')) requests.push(await r.text().catch(() => '')); });
  await owner.page.reload();
  await expect(owner.page.getByTestId('my-wish')).toBeVisible();
  const html = await owner.page.content();
  for (const s of [bob.name, carol.name, 'schenkt', 'beteiligt', 'gekauft']) {
    expect(html).not.toContain(s);
    expect(requests.join('\n')).not.toContain(s);
  }
  await owner.page.goto('/#/users');
  await expect(card(owner.page, owner.name)).toHaveCount(0); // never lists themself

  // Bob removes his mark
  await bob.page.getByTestId('claim-remove').click();
  await expect(bob.page.getByTestId('claims')).not.toContainText('du');

  // Owner unpublishes -> hidden again
  await owner.page.goto('/#/mine');
  await owner.page.getByTestId('toggle-publish').click();
  await carol.page.reload();
  await carol.page.goto('/#/users');
  await expect(card(carol.page, owner.name)).toContainText('0 Wünsche');

  await Promise.all([owner, bob, carol].map((u) => u.ctx.close()));
});

test('owner can edit and delete wishes; user content is escaped', async ({ browser }) => {
  const u = await newUser(browser, 'ed');
  await u.page.getByTestId('add-wish').click();
  await u.page.fill('input[name=title]', '<img src=x onerror=window.__xss=1>');
  await u.page.getByRole('button', { name: 'Speichern' }).click();
  await expect(u.page.getByTestId('my-wish')).toContainText('<img src=x');
  expect(await u.page.evaluate(() => window.__xss)).toBeUndefined();

  await u.page.getByRole('button', { name: 'Bearbeiten' }).click();
  await u.page.fill('input[name=title]', 'Buch');
  await u.page.getByRole('button', { name: 'Speichern' }).click();
  await expect(u.page.getByTestId('my-wish')).toContainText('Buch');

  u.page.once('dialog', (d) => d.accept());
  await u.page.getByRole('button', { name: 'Löschen' }).click();
  await expect(u.page.getByTestId('my-wish')).toHaveCount(0);
  await u.ctx.close();
});

test('logout returns to login; session persists across reload', async ({ browser }) => {
  const u = await newUser(browser, 'lo');
  await u.page.reload();
  await expect(u.page.getByTestId('whoami')).toHaveText(u.name);
  await u.page.getByTestId('logout').click();
  await expect(u.page.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
  await u.ctx.close();
});

test('typing a link and saving immediately keeps the click (preview must not shift the layout)', async ({ browser }) => {
  const u = await newUser(browser, 'sv');
  await u.page.getByTestId('add-wish').click();
  await u.page.fill('input[name=title]', 'Sofort');
  await u.page.fill('input[name=link]', `${SHOP}/sofort`);
  await u.page.getByRole('button', { name: 'Speichern' }).click();
  await expect(u.page.getByTestId('my-wish')).toContainText('Sofort');
  await expect(u.page.getByTestId('my-wish').getByTestId('wish-link')).toHaveCount(1);
  await u.ctx.close();
});

test.describe('mobile (360px)', () => {
  const noOverflow = async (page, label) => {
    const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    expect(w.doc, `horizontal overflow on ${label}`).toBeLessThanOrEqual(w.win);
  };

  test('no horizontal overflow on any view; claim buttons stay reachable', async ({ browser }) => {
    const mk = async (prefix) => {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, locale: 'de-DE' });
      const page = await ctx.newPage();
      const name = `${prefix}${uid()}`;
      await register(page, name);
      return { ctx, page, name };
    };
    const owner = await mk('mo');
    const viewer = await mk('mv');
    await noOverflow(owner.page, 'mine (empty)');

    await owner.page.getByTestId('add-wish').click();
    await noOverflow(owner.page, 'wish dialog');
    await owner.page.fill('input[name=title]', 'Zusatzakku für Balkonkraftwerk mit einem sehr langen Titel');
    await owner.page.fill('input[name=link]', `${SHOP}/products/solakon-one-zusatzakku-extrem-langer-pfad-ohne-umbruch-und-noch-mehr`);
    await owner.page.getByRole('button', { name: 'Speichern' }).click();
    await expect(owner.page.getByTestId('my-wish')).toBeVisible();
    await noOverflow(owner.page, 'mine');
    await owner.page.getByTestId('toggle-publish').click();
    await expect(owner.page.getByTestId('my-wish')).toContainText('Freigegeben');

    await viewer.page.getByRole('link', { name: 'Wünsche anderer' }).click();
    await noOverflow(viewer.page, 'users');
    await card(viewer.page, owner.name).click();
    await expect(viewer.page.getByTestId('other-wish')).toBeVisible();
    await noOverflow(viewer.page, 'user wishes');
    for (const type of ['gift', 'contribute', 'purchased']) {
      const btn = viewer.page.getByTestId(`claim-${type}`);
      const box = await btn.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(360);
      expect(box.height).toBeGreaterThanOrEqual(44); // touch target
    }
    await viewer.page.getByTestId('claim-purchased').tap();
    await expect(viewer.page.getByTestId('claims')).toContainText('du (hat gekauft)');
    await noOverflow(viewer.page, 'user wishes (claimed)');
    await Promise.all([owner, viewer].map((u) => u.ctx.close()));
  });

  test('auth pages fit', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, locale: 'de-DE' });
    const page = await ctx.newPage();
    await page.goto('/');
    await noOverflow(page, 'login');
    await page.goto('/#/register');
    await noOverflow(page, 'register');
    await ctx.close();
  });
});

test.describe('sharing', () => {
  test('share link is copied; a visitor logs in/registers and lands on the shared list', async ({ browser }) => {
    const ownerCtx = await browser.newContext({ locale: 'de-DE', permissions: ['clipboard-read', 'clipboard-write'] });
    const ownerPage = await ownerCtx.newPage();
    const ownerName = `sh${uid()}`;
    await register(ownerPage, ownerName);
    await ownerPage.getByTestId('add-wish').click();
    await ownerPage.fill('input[name=title]', 'Geteilter Wunsch');
    await ownerPage.getByRole('button', { name: 'Speichern' }).click();
    await ownerPage.getByTestId('toggle-publish').click();
    await expect(ownerPage.getByTestId('my-wish')).toContainText('Freigegeben');

    await ownerPage.getByTestId('share-list').click();
    await expect(ownerPage.getByTestId('toast')).toContainText('Link kopiert');
    const link = await ownerPage.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/\/#\/users\/\d+$/);

    // not logged in: the link leads to the login, then (after registering) to the shared list
    const guestCtx = await browser.newContext({ locale: 'de-DE' });
    const guest = await guestCtx.newPage();
    await guest.goto(link);
    await expect(guest.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
    await guest.getByTestId('auth-switch').click();
    const guestName = `gu${uid()}`;
    await guest.fill('input[name=username]', guestName);
    await guest.fill('input[name=firstName]', guestName);
    await guest.fill('input[name=lastName]', 'Gast');
    await guest.fill('input[name=password]', 'password123');
    await guest.click('button[type=submit]');
    await expect(guest.getByRole('heading', { name: new RegExp(`Wünsche von ${ownerName}`) })).toBeVisible();
    await expect(guest.getByTestId('other-wish')).toContainText('Geteilter Wunsch');

    // the owner opening their own share link ends up on their own list
    await ownerPage.goto(link);
    await expect(ownerPage.getByRole('heading', { name: 'Meine Wünsche' })).toBeVisible();
    await Promise.all([ownerCtx.close(), guestCtx.close()]);
  });

  test('uses the native share sheet when available', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'de-DE' });
    await ctx.addInitScript(() => { navigator.share = async (d) => { window.__shared = d; }; });
    const page = await ctx.newPage();
    await register(page, `ns${uid()}`);
    await page.getByTestId('share-list').click();
    const shared = await page.evaluate(() => window.__shared);
    expect(shared.url).toMatch(/\/#\/users\/\d+$/);
    expect(shared.text).toContain('WishLink');
    await ctx.close();
  });
});

test.describe('administration & account', () => {
  const login = async (page, who, password) => {
    await page.goto('/#/login');
    await page.fill('input[name=login]', who);
    await page.fill('input[name=password]', password);
    await page.click('button[type=submit]');
  };

  test('admin resets and deletes users; regular users get no admin access', async ({ browser }) => {
    const userCtx = await browser.newContext({ locale: 'de-DE' });
    const userPage = await userCtx.newPage();
    const name = `us${uid()}`;
    await register(userPage, name);
    await expect(userPage.getByTestId('nav-admin')).toHaveCount(0);
    await userPage.goto('/#/admin');
    await expect(userPage.getByRole('heading', { name: 'Meine Wünsche' })).toBeVisible(); // redirected
    expect((await userPage.request.get('/api/admin/users')).status()).toBe(403);

    const adminCtx = await browser.newContext({ locale: 'de-DE' });
    const admin = await adminCtx.newPage();
    await login(admin, 'admin', 'admin-e2e-pass1');
    await admin.getByTestId('nav-admin').click();
    const row = admin.locator(`[data-testid=admin-user][data-username="${name}"]`);
    await expect(row).toBeVisible();
    await expect(admin.locator('[data-testid=admin-user][data-username=admin]')).toContainText('Admin');

    // generated password: shown once, old session is invalidated, new password works
    await row.getByTestId('reset-password-btn').click();
    await admin.getByTestId('reset-confirm').click();
    const generated = (await admin.getByTestId('generated-password').textContent()).trim();
    expect(generated).toHaveLength(12);
    await admin.getByRole('button', { name: 'Fertig' }).click();
    await userPage.reload();
    await expect(userPage.getByRole('heading', { name: 'Anmelden' })).toBeVisible();
    await login(userPage, name, generated);
    await expect(userPage.getByTestId('whoami')).toHaveText(name);

    // chosen password
    await row.getByTestId('reset-password-btn').click();
    await admin.getByTestId('reset-password').fill('gewaehlt-pass-1');
    await admin.getByTestId('reset-confirm').click();
    await expect(admin.getByTestId('toast').first()).toContainText('Passwort gesetzt');

    // delete
    admin.once('dialog', (d) => d.accept());
    await row.getByTestId('delete-user-btn').click();
    await expect(row).toHaveCount(0);
    await login(userPage, name, 'gewaehlt-pass-1');
    await expect(userPage.getByTestId('auth-error')).toHaveText('Benutzername oder Passwort falsch.');
    // the admin cannot delete or reset themself from the list
    await expect(admin.locator('[data-testid=admin-user][data-username=admin]').getByTestId('delete-user-btn')).toHaveCount(0);
    await Promise.all([userCtx.close(), adminCtx.close()]);
  });

  test('user changes first and last name; admin has no wishes', async ({ browser }) => {
    const u = await newUser(browser, 'nm');
    await u.page.getByTestId('nav-account').click();
    await u.page.fill('input[name=firstName]', 'Erika');
    await u.page.fill('input[name=lastName]', 'Musterfrau');
    await u.page.getByRole('button', { name: 'Namen speichern' }).click();
    await expect(u.page.getByTestId('toast')).toContainText('Name geändert');
    await expect(u.page.locator('.sub')).toContainText('Erika Musterfrau');
    await u.page.reload();
    await expect(u.page.locator('input[name=firstName]')).toHaveValue('Erika');
    await u.ctx.close();

    const adminCtx = await browser.newContext({ locale: 'de-DE' });
    const admin = await adminCtx.newPage();
    await login(admin, 'admin', 'admin-e2e-pass1');
    await expect(admin).toHaveURL(/#\/admin$/);
    await expect(admin.getByRole('link', { name: 'Meine Wünsche' })).toHaveCount(0);
    await expect(admin.getByRole('link', { name: 'Wünsche anderer' })).toHaveCount(0);
    await admin.goto('/#/mine');
    await expect(admin).toHaveURL(/#\/admin$/);
    expect((await admin.request.get('/api/wishes/mine')).status()).toBe(403);
    expect((await admin.request.get('/api/users')).status()).toBe(403);
    await adminCtx.close();
  });

  test('user changes own password on the account page', async ({ browser }) => {
    const u = await newUser(browser, 'pw');
    await u.page.getByTestId('nav-account').click();
    await u.page.fill('input[name=currentPassword]', 'falsch-falsch');
    await u.page.fill('input[name=newPassword]', 'neues-passwort-1');
    await u.page.fill('input[name=repeat]', 'neues-passwort-1');
    await u.page.getByRole('button', { name: 'Passwort ändern' }).click();
    await expect(u.page.getByTestId('account-error')).toHaveText('Das aktuelle Passwort ist falsch.');
    await u.page.fill('input[name=currentPassword]', 'password123');
    await u.page.getByRole('button', { name: 'Passwort ändern' }).click();
    await expect(u.page.getByTestId('toast')).toContainText('Passwort geändert');
    await u.page.getByTestId('logout').click();
    await login(u.page, u.name, 'neues-passwort-1');
    await expect(u.page.getByTestId('whoami')).toHaveText(u.name);
    await u.ctx.close();
  });
});

test('ideas: users add ideas for others; the person concerned never sees them', async ({ browser }) => {
  const owner = await newUser(browser, 'io');
  const bob = await newUser(browser, 'ib');
  const carol = await newUser(browser, 'ic');

  await bob.page.goto('/#/users');
  await card(bob.page, owner.name).click();
  await bob.page.getByTestId('add-idea').click();
  await expect(bob.page.getByTestId('wish-dialog')).toContainText('sieht diese Idee nie');
  await bob.page.fill('input[name=title]', 'Geheime Gartenschere');
  await bob.page.getByRole('button', { name: 'Speichern' }).click();
  await expect(bob.page.getByTestId('idea-badge')).toContainText('Idee von dir');

  // carol sees it with the suggester and can claim it
  await carol.page.goto('/#/users');
  await card(carol.page, owner.name).click();
  await expect(carol.page.getByTestId('other-wish')).toContainText('Geheime Gartenschere');
  await expect(carol.page.getByTestId('idea-badge')).toContainText(`Idee von ${bob.name} Tester`);
  await expect(carol.page.getByTestId('edit-idea')).toHaveCount(0); // only the suggester edits
  await carol.page.getByTestId('claim-gift').click();
  await expect(carol.page.getByTestId('claims')).toContainText('du (schenkt)');

  // the owner: nothing, neither in the UI nor in API responses
  const seen = [];
  owner.page.on('response', async (r) => { if (r.url().includes('/api/')) seen.push(await r.text().catch(() => '')); });
  await owner.page.goto('/#/mine');
  await owner.page.reload();
  await expect(owner.page.getByTestId('my-wish')).toHaveCount(0);
  expect((await owner.page.content()) + seen.join('\n')).not.toContain('Gartenschere');

  // the suggester edits and deletes the idea
  await bob.page.reload();
  await bob.page.getByTestId('edit-idea').click();
  await bob.page.fill('input[name=title]', 'Geheime Heckenschere');
  await bob.page.getByRole('button', { name: 'Speichern' }).click();
  await expect(bob.page.getByTestId('other-wish')).toContainText('Heckenschere');
  bob.page.once('dialog', (d) => d.accept());
  await bob.page.getByTestId('delete-idea').click();
  await expect(bob.page.getByTestId('other-wish')).toHaveCount(0);
  await Promise.all([owner, bob, carol].map((u) => u.ctx.close()));
});

test.describe('first-time visitors and choices', () => {
  test('login page explains what to do: clear "create account" button, no e-mail, privacy notice with the operator', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Zum ersten Mal hier?')).toBeVisible();
    const create = page.getByTestId('auth-switch');
    await expect(create).toHaveText('Konto erstellen');
    await expect(page.locator('.lead')).toContainText('du siehst nie, wer');
    await expect(page.getByTestId('privacy-note')).toContainText('privaten Server von Max Mustermann');
    await expect(page.getByTestId('privacy-note')).toContainText('ohne Weitergabe an Dritte');

    await create.click();
    await expect(page.getByRole('heading', { name: 'Konto erstellen' })).toBeVisible();
    await expect(page.locator('input[name=email]')).toHaveCount(0);
    await expect(page.getByText('eine E-Mail-Adresse brauchst du nicht')).toBeVisible();
    await expect(page.getByTestId('privacy-note')).toContainText('Max Mustermann');
    await expect(page.getByTestId('auth-switch')).toHaveText('Zur Anmeldung');

    // registering needs exactly: username, first name, last name, password
    const name = `fv${uid()}`;
    await page.fill('input[name=username]', name);
    await page.fill('input[name=firstName]', 'Erst');
    await page.fill('input[name=lastName]', 'Besucher');
    await page.fill('input[name=password]', 'password123');
    await page.getByRole('button', { name: 'Konto erstellen' }).click();
    await expect(page.getByTestId('whoami')).toHaveText(name);
  });

  test('privacy notice and sign-up are available in English too', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('lang').selectOption('en');
    await expect(page.getByText('First time here?')).toBeVisible();
    await expect(page.getByTestId('auth-switch')).toHaveText('Create account');
    await expect(page.getByTestId('privacy-note')).toContainText("Max Mustermann's private server");
  });

  test('a choice is clear and reversible: shown as "Your choice", taken back by the button or by clicking it again', async ({ browser }) => {
    const owner = await newUser(browser, 'ch');
    const viewer = await newUser(browser, 'cv');
    await owner.page.getByTestId('add-wish').click();
    await owner.page.fill('input[name=title]', 'Wahlwunsch');
    await owner.page.getByRole('button', { name: 'Speichern' }).click();
    await owner.page.getByTestId('toggle-publish').click();
    await expect(owner.page.getByTestId('my-wish')).toContainText('Freigegeben');

    await viewer.page.getByRole('link', { name: 'Wünsche anderer' }).click();
    await viewer.page.locator('[data-testid=user-card]', { hasText: owner.name }).click();
    await expect(viewer.page.locator('.privacy')).toContainText('sieht nie, wer sich hier eingetragen hat');
    await expect(viewer.page.getByTestId('claim-remove')).toHaveCount(0); // nothing chosen yet: no confusing button

    await viewer.page.getByTestId('claim-contribute').click();
    await expect(viewer.page.locator('.my-choice')).toContainText('Deine Auswahl: Ich beteilige mich');
    await expect(viewer.page.getByTestId('claim-contribute')).toHaveAttribute('aria-pressed', 'true');
    await viewer.page.getByRole('button', { name: /Auswahl zurücknehmen/ }).click();
    await expect(viewer.page.locator('.my-choice')).toHaveCount(0);
    await expect(viewer.page.getByTestId('claims')).toHaveCount(0);

    await viewer.page.getByTestId('claim-gift').click();            // choose again ...
    await expect(viewer.page.getByTestId('claims')).toContainText('du (schenkt)');
    await viewer.page.getByTestId('claim-gift').click();            // ... and take it back by clicking the active choice
    await expect(viewer.page.getByTestId('claims')).toHaveCount(0);
    await expect(viewer.page.locator('.my-choice')).toHaveCount(0);
    await Promise.all([owner, viewer].map((u) => u.ctx.close()));
  });
});
