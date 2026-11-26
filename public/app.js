'use strict';
/* WishLink frontend – dependency-free SPA. All user content is inserted via textContent (no innerHTML). */
(() => {
  const LANGS = { de: 'Deutsch', en: 'English' }; // add a language: drop /i18n/<code>.json and list it here
  const DEFAULT_LANG = 'de';
  const MAX_LINKS = 6;
  const PRIO_ICON = { 1: '🔥', 2: '⭐', 3: '🌱' };
  let messages = {};
  let lang = DEFAULT_LANG;
  let user = null;
  let oidcEnabled = false;
  let operator = null; // who runs this instance (config OPERATOR_NAME), shown in the privacy notice
  let pollTimer = null;
  const root = document.getElementById('app');

  // ---------- i18n ----------
  const t = (key, params = {}) =>
    String(messages[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? params[k] : ''));

  async function loadLang(code) {
    const res = await fetch(`/i18n/${code}.json`);
    messages = await res.json();
    lang = code;
    document.documentElement.lang = code;
    try { localStorage.setItem('lang', code); } catch { /* ignore */ }
  }

  function initialLang() {
    let saved = null;
    try { saved = localStorage.getItem('lang'); } catch { /* ignore */ }
    if (saved && LANGS[saved]) return saved;
    const nav = (navigator.language || '').slice(0, 2);
    return LANGS[nav] ? nav : DEFAULT_LANG;
  }

  // ---------- helpers ----------
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  class ApiError extends Error {
    constructor(status, body) { super(body.error || 'generic'); this.status = status; this.body = body; }
  }

  async function api(method, url, body) {
    const res = await fetch(`/api${url}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  const fieldKey = (f) => ({
    title: 'wish.title', links: 'wish.links', description: 'wish.description', username: 'auth.username',
    firstName: 'auth.firstName', lastName: 'auth.lastName', password: 'auth.password',
    newPassword: 'account.newPassword',
  }[f] || f);

  function errorText(e) {
    const code = e.body?.error;
    const key = `error.${code}`;
    if (code && messages[key]) return t(key, { field: e.body.field ? t(fieldKey(e.body.field)) : '' });
    return t('error.generic');
  }

  const fullName = (u) => `${u.firstName} ${u.lastName}`;
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
  const initials = (u) => `${(u.firstName || u.username || '?')[0]}${(u.lastName || '')[0] || ''}`;

  function avatar(u, size = '') {
    return h('span', { class: `avatar ${size} av${(u.id ?? u.userId ?? 0) % 8}`, 'aria-hidden': 'true' }, initials(u));
  }

  function remoteImg(src, onFail) {
    return h('img', {
      src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer',
      onerror: (e) => { e.target.remove(); if (onFail) onFail(); },
    });
  }

  // Remember a shared link across login / registration / OIDC redirect.
  const RETURN_KEY = 'returnTo';
  const saveReturn = (hash) => { try { sessionStorage.setItem(RETURN_KEY, hash); } catch { /* ignore */ } };
  const takeReturn = () => {
    try { const v = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); return v; } catch { return null; }
  };

  function toast(message) {
    const el = h('div', { class: 'toast', role: 'status', 'data-testid': 'toast' }, message);
    document.body.append(el);
    setTimeout(() => el.remove(), 4500);
  }

  /** Shares the link to the user's own wish list: native share sheet if available, otherwise clipboard. */
  async function shareList() {
    const url = `${location.origin}/#/users/${user.id}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: t('app.name'), text: t('share.text', { name: user.firstName }), url });
        return;
      }
    } catch (e) { if (e.name === 'AbortError') return; }
    try {
      await navigator.clipboard.writeText(url);
      toast(t('share.copied'));
    } catch { window.prompt(t('share.copyManually'), url); }
  }

  // ---------- components ----------
  function linkItem(l) {
    const p = l.preview;
    const pending = l.status === 'pending';
    return h('a', {
      class: `link${pending ? ' loading' : ''}`, href: l.url, target: '_blank',
      rel: 'noopener noreferrer nofollow', 'data-testid': 'wish-link', title: l.url,
    },
    h('span', { class: 'thumb' }, p?.image ? remoteImg(p.image) : '🔗'),
    h('span', { class: 'txt' },
      h('span', { class: 'site' }, p?.siteName || hostOf(l.url)),
      h('span', { class: 'ttl' }, pending ? t('wish.previewLoading') : (p?.title || l.url))));
  }

  /** Tile cover: first available preview image, otherwise a gradient with an icon. */
  function cover(w, badges) {
    const img = w.links.map((l) => l.preview?.image).find(Boolean);
    return h('div', { class: `media p${w.priority}` },
      '🎁', img && remoteImg(img), h('div', { class: 'badges' }, badges));
  }

  const prioPill = (w) => h('span', { class: `pill prio${w.priority}` }, `${PRIO_ICON[w.priority]} ${t(`wish.priority.${w.priority}`)}`);

  function wishBody(w) {
    return h('div', { class: 'body' },
      h('h3', {}, w.title),
      w.description && h('p', { class: 'desc' }, w.description),
      w.links.length > 0 && h('div', { class: 'links' }, w.links.map(linkItem)));
  }

  /** Re-runs `reload` a few times while link previews are still being generated server-side. */
  function pollPending(wishes, reload, attempt = 0) {
    clearTimeout(pollTimer);
    if (attempt >= 5 || !wishes.some((w) => w.links.some((l) => l.status === 'pending'))) return;
    pollTimer = setTimeout(() => reload(), 2000);
  }

  // ---------- layout ----------
  function layout(active, content) {
    const langSel = h('select', {
      class: 'lang', 'aria-label': t('lang.label'), 'data-testid': 'lang',
      onchange: async (e) => { await loadLang(e.target.value); route(); },
    }, Object.entries(LANGS).map(([c, n]) => h('option', { value: c, selected: c === lang }, n)));
    root.replaceChildren(
      h('header', { class: 'top' }, h('div', { class: 'bar' },
        h('a', { class: 'brand', href: '#/' }, h('span', { class: 'logo' }, '🎁'), t('app.name')),
        user && h('nav', { class: 'tabs' },
          h('a', { href: '#/mine', class: active === 'mine' ? 'active' : '' }, t('nav.mine')),
          h('a', { href: '#/users', class: active === 'users' ? 'active' : '' }, t('nav.others')),
          h('a', { href: '#/account', class: active === 'account' ? 'active' : '', 'data-testid': 'nav-account' }, t('nav.account')),
          user.isAdmin && h('a', { href: '#/admin', class: active === 'admin' ? 'active' : '', 'data-testid': 'nav-admin' }, t('nav.admin'))),
        h('span', { class: 'spacer' }),
        langSel,
        user && h('div', { class: 'me' }, avatar(user),
          h('span', { class: 'name', 'data-testid': 'whoami' }, user.username),
          h('button', { class: 'ghost small', 'data-testid': 'logout', onclick: logout }, t('nav.logout'))))),
      h('main', {}, content));
  }

  async function logout() {
    await api('POST', '/auth/logout');
    user = null;
    location.hash = '#/login';
    route();
  }

  // ---------- views ----------
  function authView(mode) {
    const err = h('div', { class: 'error', role: 'alert', 'data-testid': 'auth-error' });
    const field = (name, key, type = 'text', extra = {}) =>
      h('label', {}, t(key), h('input', { name, type, required: true, ...extra }));
    const isReg = mode === 'register';
    const form = h('form', {
      'data-testid': `${mode}-form`,
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const data = Object.fromEntries(new FormData(form));
        try {
          const r = await api('POST', isReg ? '/auth/register' : '/auth/login', data);
          user = r.user;
          location.hash = takeReturn() || '#/mine';
          route();
        } catch (ex) { err.textContent = errorText(ex); }
      },
    },
    isReg ? [field('username', 'auth.username', 'text', { autocomplete: 'username' }),
      h('div', { class: 'two' }, field('firstName', 'auth.firstName', 'text', { autocomplete: 'given-name' }),
        field('lastName', 'auth.lastName', 'text', { autocomplete: 'family-name' })),
      field('password', 'auth.password', 'password', { autocomplete: 'new-password', minlength: 8 })]
      : [field('login', 'auth.username', 'text', { autocomplete: 'username' }),
        field('password', 'auth.password', 'password', { autocomplete: 'current-password' })],
    err,
    h('button', { class: 'primary', type: 'submit' }, t(isReg ? 'auth.createAccount' : 'auth.login')));
    // First-time visitors must see at once what to do: a clearly separate "new here" block with its own button.
    const switchBlock = isReg
      ? h('div', { class: 'switch-box' }, h('p', {}, t('auth.haveAccountQ')),
        h('a', { class: 'btn-secondary', href: '#/login', 'data-testid': 'auth-switch' }, t('auth.toLogin')))
      : h('div', { class: 'switch-box new-here' }, h('strong', {}, t('auth.newHere')), h('p', {}, t('auth.newHereText')),
        h('a', { class: 'btn-secondary', href: '#/register', 'data-testid': 'auth-switch' }, t('auth.createAccount')));
    layout(null, h('div', { class: 'auth-wrap' }, h('div', { class: 'auth' },
      h('div', { class: 'logo-lg' }, '🎁'),
      h('h1', {}, t(isReg ? 'auth.registerTitle' : 'auth.login')),
      h('p', { class: 'lead' }, t(isReg ? 'auth.registerSub' : 'auth.intro')),
      form,
      oidcEnabled && [h('div', { class: 'divider' }, t('auth.or')),
        h('a', { class: 'btn-secondary', href: '/api/auth/oidc/login', 'data-testid': 'oidc-login' }, t('auth.oidc'))],
      switchBlock,
      h('p', { class: 'privacy-note', 'data-testid': 'privacy-note' }, `🔒 ${operator ? t('privacy.notice', { operator }) : t('privacy.noticeGeneric')}`))));
  }

  /** Modal to create / edit a wish, with any number of links and live link previews. */
  function openWishDialog(wish, onDone) {
    const dlg = h('dialog', { 'data-testid': 'wish-dialog' });
    const err = h('div', { class: 'error', role: 'alert' });
    const linkBox = h('div', {});
    const addBtn = h('button', { type: 'button', class: 'small', 'data-testid': 'add-link' }, `+ ${t('wish.addLink')}`);

    const refreshAdd = () => { addBtn.disabled = linkBox.children.length >= MAX_LINKS; };

    function addLinkRow(value = '') {
      const preview = h('div', { class: 'preview' });
      let seq = 0;
      const input = h('input', { name: 'link', type: 'url', placeholder: 'https://…', value, maxlength: 2000, 'aria-label': t('wish.url') });
      const row = h('div', { class: 'link-edit' },
        h('div', { class: 'line' }, input,
          h('button', {
            type: 'button', class: 'ghost small', 'aria-label': t('wish.removeLink'), title: t('wish.removeLink'),
            onclick: () => { row.remove(); if (!linkBox.children.length) addLinkRow(); refreshAdd(); },
          }, '✕')),
        preview);
      const update = async () => {
        const url = input.value.trim();
        const mine = ++seq;
        preview.replaceChildren();
        if (!url || !input.checkValidity()) return;
        preview.append(linkItem({ url, status: 'pending', preview: null }));
        try {
          const { preview: p } = await api('POST', '/preview', { url });
          if (mine !== seq) return;
          preview.replaceChildren(p ? linkItem({ url, status: 'ok', preview: p }) : h('span', { class: 'muted' }, t('wish.previewNone')));
        } catch { if (mine === seq) preview.replaceChildren(); }
      };
      input.addEventListener('change', update);
      linkBox.append(row);
      if (value) update();
      refreshAdd();
    }
    addBtn.addEventListener('click', () => { addLinkRow(); linkBox.lastChild.querySelector('input').focus(); });
    (wish?.links.length ? wish.links.map((l) => l.url) : ['']).forEach((u) => addLinkRow(u));

    const form = h('form', {
      'data-testid': 'wish-form', method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const fd = new FormData(form);
        const body = {
          title: fd.get('title'), description: fd.get('description'), priority: Number(fd.get('priority')),
          links: fd.getAll('link').map((s) => String(s).trim()).filter(Boolean),
        };
        try {
          if (wish) await api('PUT', `/wishes/${wish.id}`, body); else await api('POST', '/wishes', body);
          dlg.close();
          onDone();
        } catch (ex) { err.textContent = errorText(ex); }
      },
    },
    h('h2', {}, t(wish ? 'wish.editTitle' : 'wish.newTitle')),
    h('label', {}, t('wish.title'), h('input', { name: 'title', required: true, maxlength: 200, value: wish?.title || '', autofocus: true })),
    h('label', {}, t('wish.description'), h('textarea', { name: 'description', rows: 3, maxlength: 5000 }, wish?.description || '')),
    h('label', {}, t('wish.priority'), h('select', { name: 'priority' },
      [1, 2, 3].map((p) => h('option', { value: p, selected: (wish?.priority ?? 2) === p }, `${PRIO_ICON[p]} ${t(`wish.priority.${p}`)}`)))),
    h('div', { class: 'field-title' }, t('wish.links')),
    h('p', { class: 'muted' }, t('wish.linksHint', { max: MAX_LINKS })),
    linkBox, addBtn, err,
    h('div', { class: 'row end' },
      h('button', { type: 'button', onclick: () => dlg.close() }, t('wish.cancel')),
      h('button', { class: 'primary', type: 'submit' }, t('wish.save'))));
    dlg.append(form);
    // Keep focus in the input while pressing a button: otherwise the blur triggers the link preview, the
    // layout shifts between mousedown and mouseup and the click gets lost.
    dlg.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
  }

  async function mineView(attempt = 0) {
    const { wishes } = await api('GET', '/wishes/mine');
    const refresh = () => mineView();
    layout('mine', [
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, t('mine.title')), h('p', { class: 'sub' }, t('mine.subtitle')),
          h('span', { class: 'privacy' }, `🔒 ${t('mine.privacy')}`)),
        h('div', { class: 'head-actions' },
          h('button', { 'data-testid': 'share-list', onclick: shareList }, `🔗 ${t('share.button')}`),
          h('button', { class: 'primary', 'data-testid': 'add-wish', onclick: () => openWishDialog(null, refresh) }, t('wish.add')))),
      wishes.length === 0
        ? h('div', { class: 'empty-state' }, h('div', { class: 'big' }, '✨'), t('wish.empty'))
        : h('div', { class: 'grid' }, wishes.map((w) => h('article', { class: 'tile', 'data-testid': 'my-wish' },
          cover(w, [prioPill(w),
            h('span', { class: `pill ${w.published ? 'live' : 'draft'}`, title: w.published ? '' : t('wish.draftHint') },
              t(w.published ? 'wish.published' : 'wish.draft'))]),
          wishBody(w),
          h('div', { class: 'foot' }, h('div', { class: 'row owner-actions' },
            h('button', {
              class: `publish ${w.published ? '' : 'primary'}`, 'data-testid': 'toggle-publish',
              onclick: async () => { await api('PUT', `/wishes/${w.id}/published`, { published: !w.published }); refresh(); },
            }, t(w.published ? 'wish.unpublish' : 'wish.publish')),
            h('button', { class: 'ghost small', onclick: () => openWishDialog(w, refresh) }, t('wish.edit')),
            h('button', {
              class: 'ghost small danger',
              onclick: async () => { if (confirm(t('wish.deleteConfirm'))) { await api('DELETE', `/wishes/${w.id}`); refresh(); } },
            }, t('wish.delete'))))))),
    ]);
    pollPending(wishes, () => mineView(attempt + 1), attempt);
  }

  async function usersView() {
    const { users } = await api('GET', '/users');
    layout('users', [
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('others.title')), h('p', { class: 'sub' }, t('others.subtitle')))),
      users.length === 0
        ? h('div', { class: 'empty-state' }, h('div', { class: 'big' }, '🎈'), t('others.empty'))
        : h('div', { class: 'grid' }, users.map((u) => h('a', { class: 'tile user-tile', href: `#/users/${u.id}`, 'data-testid': 'user-card' },
          avatar(u, 'lg'), h('h3', {}, fullName(u)), h('span', { class: 'muted' }, `@${u.username}`),
          h('span', { class: 'pill prio2 count' }, t(u.wishCount === 1 ? 'others.count.one' : 'others.count', { count: u.wishCount }))))),
    ]);
  }

  async function userWishesView(id, attempt = 0) {
    if (Number(id) === user.id) { location.replace('#/mine'); return; }
    const { owner, wishes } = await api('GET', `/users/${id}/wishes`);
    const refresh = () => userWishesView(id);
    layout('users', [
      h('a', { class: 'back', href: '#/users' }, t('others.back')),
      h('div', { class: 'page-head' }, h('div', { class: 'row' }, avatar(owner, 'lg'),
        h('div', {}, h('h1', {}, t('others.wishesOf', { name: fullName(owner) })),
          h('span', { class: 'privacy' }, `🔒 ${t('others.privacy', { name: owner.firstName })}`)))),
      wishes.length === 0
        ? h('div', { class: 'empty-state' }, h('div', { class: 'big' }, '🎈'), t('others.noWishes'))
        : h('div', { class: 'grid' }, wishes.map((w) => {
          const mine = w.claims.find((c) => c.userId === user.id);
          const btn = (type) => h('button', {
            class: mine?.type === type ? 'active' : '', 'data-testid': `claim-${type}`, 'aria-pressed': mine?.type === type ? 'true' : 'false',
            // clicking the chosen option again takes the choice back
            onclick: async () => {
              if (mine?.type === type) await api('DELETE', `/wishes/${w.id}/claim`); else await api('PUT', `/wishes/${w.id}/claim`, { type });
              refresh();
            },
          }, t(`claim.${type}`));
          return h('article', { class: 'tile', 'data-testid': 'other-wish' },
            cover(w, [prioPill(w)]),
            wishBody(w),
            h('div', { class: 'foot' },
              h('div', { class: 'claim-bar', role: 'group', 'aria-label': t('claim.title') }, btn('gift'), btn('contribute'), btn('purchased')),
              mine && h('div', { class: 'my-choice' },
                h('span', {}, t('claim.yourChoice', { choice: t(`claim.${mine.type}`) })),
                h('button', {
                  class: 'small', 'data-testid': 'claim-remove',
                  onclick: async () => { await api('DELETE', `/wishes/${w.id}/claim`); refresh(); },
                }, `↩ ${t('claim.remove')}`)),
              w.claims.length === 0
                ? h('p', { class: 'claimers empty' }, t('claim.none'))
                : h('ul', { class: 'claimers', 'data-testid': 'claims' }, w.claims.map((c) => h('li', {},
                  avatar({ id: c.userId, firstName: c.firstName, lastName: c.lastName }, 'sm'),
                  h('span', {}, t('claim.by', {
                    name: c.userId === user.id ? t('claim.you') : fullName(c),
                    type: t(`claim.type.${c.type}`),
                  })))))));
        })),
    ]);
    pollPending(wishes, () => userWishesView(id, attempt + 1), attempt);
  }


  // ---------- account & administration ----------
  async function accountView() {
    const err = h('div', { class: 'error', role: 'alert', 'data-testid': 'account-error' });
    const form = h('form', {
      'data-testid': 'password-form',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const d = Object.fromEntries(new FormData(form));
        if (d.newPassword !== d.repeat) { err.textContent = t('error.password_mismatch'); return; }
        try {
          await api('POST', '/auth/password', { currentPassword: d.currentPassword, newPassword: d.newPassword });
          form.reset();
          toast(t('account.passwordChanged'));
        } catch (ex) { err.textContent = errorText(ex); }
      },
    },
    h('label', {}, t('account.currentPassword'), h('input', { name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })),
    h('label', {}, t('account.newPassword'), h('input', { name: 'newPassword', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    h('label', {}, t('account.repeatPassword'), h('input', { name: 'repeat', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    err, h('button', { class: 'primary', type: 'submit' }, t('account.changePassword')));
    layout('account', [
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('account.title')),
        h('p', { class: 'sub' }, [fullName(user), `@${user.username}`, user.email].filter(Boolean).join(' · ')))),
      h('div', { class: 'panel' }, h('h3', {}, t('account.changePassword')),
        user.hasPassword ? form : h('p', { class: 'muted' }, t('account.managedExternally'))),
    ]);
  }

  function openResetDialog(target, onDone) {
    const dlg = h('dialog', { 'data-testid': 'reset-dialog' });
    const err = h('div', { class: 'error', role: 'alert' });
    const input = h('input', { name: 'password', type: 'text', minlength: 8, autocomplete: 'off', placeholder: t('admin.passwordPlaceholder'), 'data-testid': 'reset-password' });
    const body = h('div', {});
    const showForm = () => body.replaceChildren(
      h('p', { class: 'muted' }, t('admin.resetHint', { name: fullName(target) })),
      h('label', {}, t('admin.newPassword'), input), err,
      h('div', { class: 'row end' },
        h('button', { type: 'button', onclick: () => dlg.close() }, t('wish.cancel')),
        h('button', { class: 'primary', type: 'submit', 'data-testid': 'reset-confirm' }, t('admin.reset'))));
    const form = h('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          const r = await api('POST', `/admin/users/${target.id}/password`, { password: input.value.trim() || undefined });
          if (r.password) {
            body.replaceChildren(
              h('p', { class: 'muted' }, t('admin.generatedHint', { name: fullName(target) })),
              h('code', { class: 'secret', 'data-testid': 'generated-password' }, r.password),
              h('div', { class: 'row end' },
                h('button', { type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(r.password); toast(t('admin.copied')); } catch { /* ignore */ } } }, t('admin.copy')),
                h('button', { class: 'primary', type: 'button', onclick: () => dlg.close() }, t('admin.done'))));
          } else { dlg.close(); toast(t('admin.passwordSet')); }
          onDone();
        } catch (ex) { err.textContent = errorText(ex); }
      },
    }, h('h2', {}, t('admin.resetTitle', { name: target.username })), body);
    showForm();
    dlg.append(form);
    dlg.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
  }

  async function adminView() {
    if (!user.isAdmin) { location.replace('#/mine'); return; }
    const { users } = await api('GET', '/admin/users');
    const refresh = () => adminView();
    layout('admin', [
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, t('admin.title')), h('p', { class: 'sub' }, t('admin.subtitle')))),
      h('div', { class: 'list' }, users.map((u) => h('div', { class: 'user-row', 'data-testid': 'admin-user', 'data-username': u.username },
        avatar(u),
        h('div', { class: 'who' },
          h('strong', {}, fullName(u)),
          h('span', { class: 'muted' }, [`@${u.username}`, u.email].filter(Boolean).join(' · ')),
          h('span', { class: 'tags' },
            u.isAdmin && h('span', { class: 'tag' }, t('admin.tagAdmin')),
            u.oidc && h('span', { class: 'tag' }, 'Keycloak'),
            h('span', { class: 'tag' }, t(u.wishCount === 1 ? 'others.count.one' : 'others.count', { count: u.wishCount })))),
        u.id === user.id ? h('span', { class: 'muted' }, t('admin.you')) : h('div', { class: 'row actions' },
          h('button', { class: 'small', 'data-testid': 'reset-password-btn', onclick: () => openResetDialog(u, refresh) }, t('admin.resetPassword')),
          h('button', {
            class: 'small danger', 'data-testid': 'delete-user-btn',
            onclick: async () => {
              if (!confirm(t('admin.deleteConfirm', { name: `${fullName(u)} (@${u.username})` }))) return;
              await api('DELETE', `/admin/users/${u.id}`);
              toast(t('admin.deleted', { name: u.username }));
              refresh();
            },
          }, t('admin.delete')))))),
    ]);
  }

  // ---------- routing ----------
  async function route() {
    clearTimeout(pollTimer);
    const hash = location.hash || '#/';
    try {
      if (!user) {
        if (/^#\/users\/\d+$/.test(hash)) saveReturn(hash);
        return authView(hash === '#/register' ? 'register' : 'login');
      }
      if (hash === '#/' || hash === '#' || hash === '') {
        const back = takeReturn(); // e.g. after an OIDC round trip
        if (back) { location.hash = back; return; }
      }
      const m = hash.match(/^#\/users\/(\d+)$/);
      if (m) return await userWishesView(m[1]);
      if (hash === '#/users') return await usersView();
      if (hash === '#/account') return await accountView();
      if (hash === '#/admin') return await adminView();
      return await mineView();
    } catch (e) {
      if (e.status === 401) { user = null; return authView('login'); }
      layout(null, h('p', { class: 'error' }, errorText(e)));
    }
  }

  async function init() {
    await loadLang(initialLang());
    try { const c = await api('GET', '/auth/config'); oidcEnabled = c.oidc; operator = c.operator; } catch { /* ignore */ }
    try { user = (await api('GET', '/auth/me')).user; } catch { user = null; }
    window.addEventListener('hashchange', route);
    route();
  }
  init();
})();
