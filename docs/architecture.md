# WishLink – Architecture

## Overview

WishLink is a small server-rendered-free SPA + JSON API in a single Node.js process.

```
Browser (vanilla JS SPA, i18n JSON)
   │  fetch /api/*  (cookie session, JSON)
   ▼
Express app (src/app.js)
   ├─ auth (password / optional OIDC)      src/security.js, src/oidc.js
   ├─ validation                           src/validation.js
   └─ data access layer                    src/repo.js
        ▼
   SQLite (node:sqlite, file on a volume)  src/db.js
```

| Choice | Rationale |
|---|---|
| Node.js 22 + Express | Minimal dependencies (only `express` at runtime), easy to containerise |
| `node:sqlite` | Built in, no native build step; one file to back up. Requires a single replica (see Deployment) |
| Vanilla JS SPA | No build step; user content only ever inserted via `textContent` (XSS safe) |
| `node:test` + Playwright | Unit/API tests with zero extra tooling; real-browser E2E |

## Data model

- `users` – username, first/last name, email, `password_hash` (scrypt, nullable for OIDC users), `oidc_sub`
- `sessions` – SHA-256 of the session token, `expires_at` (tokens themselves are only in the cookie)
- `wishes` – owner, title, description, url, `priority` (1 high … 3 low), `published`
- `wish_links` – up to 6 links per wish, ordered, with cached preview (`preview_status` pending/ok/failed, title, description, image, site)
- `claims` – `(wish_id, user_id)` primary key, `type` ∈ `gift | contribute | purchased`

## The privacy invariant (core requirement)

> The owner of a wish must never learn that somebody marked it, took part, or interacted with it in any way.

Enforced in layers:

1. **Data access (`src/repo.js`)** – owner-facing functions (`listOwnWishes`, `getOwnWish`) never query `claims`.
   `listWishesForViewer(ownerId, viewerId)` returns `null` when both are the same user.
2. **API** – `/api/users/:id/wishes`, `PUT/DELETE /api/wishes/:id/claim` answer `404` for own wishes, so even
   existence of the endpoint doesn't leak information. `/api/users` excludes the caller.
3. **Responses to the owner** – create/update/publish responses use the owner DTO (no claim fields).
4. **Tests** – unit tests on repo and API level, plus a Playwright test that checks UI HTML *and* every API
   response the owner's browser receives for the claimers' names and claim wording.

Other users see, per wish, a list of claimers with name and type (gift / contribute / purchased); a user holds at most one claim per wish and can change or remove it.

## Ideas

An idea is a row in `wishes` with `suggested_by` set (`owner_id` = the person it is for, `published` = 1). Every owner-side query and
mutation (`listOwnWishes`, `getOwnWish`, update / publish / delete, link lookup) filters `suggested_by IS NULL`, so the person concerned can
neither see nor modify, claim or delete it. Other users get it from `listWishesForViewer` together with `suggestedBy`; only the suggester can
edit or delete it (`/api/ideas/:id`). Deleting the suggester removes the idea (`ON DELETE CASCADE`).

## Administration

`users.is_admin` marks admins. The initial admin is created at startup from `ADMIN_*` variables (never promotes an existing user – otherwise
whoever registered the name first would win). Admin endpoints (`/api/admin/*`) manage accounts only and return no wish or claim data, so the
owner-privacy rule also holds against admins. Password resets sign the user out everywhere; deleting a user cascades to wishes, claims and sessions.

## Link previews

Saving a wish stores its links immediately and fetches previews **in the background** (`src/preview.js`): the server downloads the
page, reads Open Graph / Twitter / `<title>` metadata and caches title, description, image and site name per link. The UI polls
briefly while previews are pending; unchanged links keep their cached preview, failed ones are retried on the next edit.
The wish form also offers a live preview (`POST /api/preview`).

Because the server fetches user-supplied URLs, the fetcher is hardened against SSRF: http(s) only, DNS results are checked and
the checked IP is pinned (loopback, private, link-local, CGNAT, multicast are refused – also for redirects, max 3), 5 s timeout,
512 KB body limit, HTML content types only, rate limit on the live endpoint. Preview images are loaded by the viewer's browser
directly from the shop (`referrerpolicy=no-referrer`, CSP `img-src` allows http/https).

## Publishing

Wishes are created as drafts (`published = 0`). Drafts are only returned to their owner. Claiming a draft returns `404`.
Unpublishing hides the wish again (existing claims are kept and reappear if the wish is re-published).

## Sharing a wish list

"Meine Liste teilen" shares `<origin>/#/users/<id>` – via the native share sheet on devices that have one (`navigator.share`),
otherwise the link is copied to the clipboard. The link carries no secret: viewing a list always requires an account, and only
published wishes are shown. A visitor without a session is sent to login/registration; the target is kept in `sessionStorage`
(also across an OIDC redirect) and opened afterwards. The owner opening their own link is redirected to "My wishes".

## Authentication

- Registration: username, first name, last name, password (≥ 8 chars). No e-mail address is collected; `users.email` is optional (kept for accounts created earlier
  and for OIDC users) and the previous `NOT NULL` constraint was removed by a table-rebuild migration (`migrateEmailOptional` in `src/db.js`) that preserves ids, relations and sessions.
  Without e-mail there is no self-service reset: an admin resets passwords. Passwords hashed with scrypt + random salt.
- Session: random 256-bit token in an `HttpOnly; SameSite=Lax` cookie (`Secure` when `PUBLIC_URL` is https); only its hash is stored.
- CSRF: SameSite cookie + `Origin` header must match `Host` for state-changing requests.
- Brute force: in-memory rate limit on login/register (20/min/IP; per-process, adequate for a single replica).
- Security headers: strict CSP (`default-src 'self'`), `nosniff`, `X-Frame-Options: DENY`.
- **OIDC (Keycloak)**: enabled when `OIDC_ISSUER` and `OIDC_CLIENT_ID` are set. Authorization-code flow
  (`src/oidc.js`): discovery, `state`+`nonce` in a short-lived cookie, token exchange, check of `iss`/`aud`/`exp`/`nonce`.
  A first login creates a local user (no password) from the claims; an existing user with the same *verified* email is linked.
  Covered by unit tests with a mocked provider; see `docs/implementation.md` for the Keycloak setup.

## Internationalisation

All UI strings live in `public/i18n/<lang>.json`; German is the default, English is included.
Server errors are stable codes (`username_taken`, …) translated client-side (`error.<code>`).
A unit test enforces identical key sets across languages. Adding a language: add a JSON file and one entry in `LANGS` in `public/app.js`.

## Deployment

- **Docker**: multi-stage `Dockerfile`, non-root user, data in `/data` volume, healthcheck on `/api/health`.
- **Compose**: `docker-compose.yml` (optional Keycloak profile).
- **Kubernetes (k3s)**: `k8s/` kustomize – Deployment (1 replica, `Recreate`, PVC `local-path`), Service, nginx Ingress with cert-manager TLS, ConfigMap.
  Scaling horizontally would require replacing SQLite with a networked DB (and a shared rate-limit store).

## CI/CD (`.gitlab-ci.yml`)

`test` (lint, unit, Playwright E2E, audit) → `build` (docker-in-docker, default branch + tags) → `deploy` (`deploy-dev` to k3s namespace `wishlink-dev`, `stop-dev` manual) → `release` (tag `vX.Y.Z`: image, assets, GitLab release, then the sanitised GitHub mirror of source, image and release – see [release.md](release.md)).
