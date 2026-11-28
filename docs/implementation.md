# WishLink – Implementation & Operations Guide

## Repository layout

```
src/
  server.js       process entry (config, DB, listen, graceful shutdown)
  app.js          Express app factory: middleware, routes, error mapping
  repo.js         all SQL; owner vs. viewer access separated (privacy)
  db.js           schema + connection
  validation.js   input validation → ValidationError(code, field)
  security.js     scrypt, tokens, rate limiter
  preview.js      link preview (Open Graph) fetcher with SSRF protection
  oidc.js         minimal OIDC code-flow client
  config.js       env → config
public/           SPA (index.html, app.js, style.css, i18n/*.json)
test/unit/        node:test – validation, security, repo, API, OIDC, config, i18n
test/e2e/         Playwright – real browser, multi-user flows
k8s/              kustomize manifests for k3s
```

## Local development

```bash
npm ci
npm run dev          # http://localhost:3000, DB in ./data
npm test             # unit + API tests
npm run test:e2e     # Playwright (first time: npx playwright install chromium)
```

## API

All under `/api`, JSON, cookie session. Errors: `{ "error": "<code>", "field": "<field>"? }`.

| Method & path | Description |
|---|---|
| `POST /auth/register` `{username, firstName, lastName, password}` | create account + session (no e-mail needed) |
| `POST /auth/login` `{login, password}` | login by username (accounts created earlier with an e-mail can still use it) |
| `POST /auth/logout`, `GET /auth/me`, `GET /auth/config` | session / feature flags |
| `GET /auth/oidc/login`, `GET /auth/oidc/callback` | OIDC flow (when enabled) |
| `GET /wishes/mine` | own wishes, ordered by priority (**no claim data**) |
| `POST /wishes`, `PUT /wishes/:id` `{title, description?, links?: string[] (max 6), priority 1-3}` | create / edit own wish (draft on create); link previews are generated in the background |
| `POST /preview` `{url}` | live link preview for the wish form (rate limited, 30/min/user) |
| `PUT /wishes/:id/published` `{published: bool}` | publish / unpublish |
| `DELETE /wishes/:id` | delete own wish |
| `GET /users` | other users with ≥1 published wish |
| `GET /users/:id/wishes` | their published wishes **with claims** (404 for yourself) |
| `PUT /wishes/:id/claim` `{type: gift\|contribute\|purchased}` / `DELETE` | set / remove own mark |
| `PUT /auth/profile` `{firstName, lastName}` | change own first / last name |
| `POST /users/:id/ideas` / `PUT`, `DELETE /ideas/:id` | add an **idea** for another user (hidden from that user, visible to everyone else); only the suggester edits / deletes it |
| `POST /auth/password` `{currentPassword, newPassword}` | change own password (other sessions are signed out) |
| `GET /admin/users` | **admin** – all accounts (no wishes, no claims) |
| `POST /admin/users/:id/password` `{password?}` | **admin** – reset password; empty = generated and returned once; user is signed out everywhere |
| `DELETE /admin/users/:id` | **admin** – delete user incl. wishes and claims (not yourself) |
| `GET /health` | liveness |

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `DATABASE_PATH` | `./data/wishlink.db` (`/data/wishlink.db` in image) | SQLite file (`:memory:` for tests) |
| `PUBLIC_URL` | `http://localhost:PORT` | external URL; https ⇒ `Secure` cookies; OIDC redirect base |
| `TRUST_PROXY` | `false` | set `true` behind a reverse proxy (correct client IP for rate limiting) |
| `SESSION_TTL_HOURS` | `336` | session lifetime |
| `PREVIEW_ALLOW_PRIVATE` | `false` | allow link previews of internal addresses (only for tests / fully trusted setups) |
| `OPERATOR_NAME` | – | who runs the instance; shown in the privacy notice on the login/registration page (generic text when empty) |
| `ADMIN_PASSWORD`, `ADMIN_USERNAME` (`admin`), `ADMIN_EMAIL` | – | creates the initial admin at startup (see *Administration*) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | – | enable OIDC login |
| `OIDC_REDIRECT_URI`, `OIDC_SCOPE` | `PUBLIC_URL/api/auth/oidc/callback`, `openid profile email` | overrides |

## Administration

An admin account is created at startup when `ADMIN_PASSWORD` is set (username `ADMIN_USERNAME`, default `admin`). It is only ever
*created*: an existing user with that name is never promoted and the password is never reset on later starts – change it on the
**Konto** page. The **Admin** tab lists all accounts and offers *reset password* (own choice or generated, shown once) and
*delete* (removes the user's wishes and claims). The admin tooling exposes no wish contents, claims or wish counts. Admins have no wishes of their own and cannot see anyone's: all wish endpoints answer `403 admin_no_wishes`, and the UI only shows *Konto* and *Admin*.
In the pipeline the initial password comes from the masked CI/CD variable `ADMIN_PASSWORD`.
Docker Compose: set `ADMIN_PASSWORD` in `.env`.

## Docker Compose deployment

`docker-compose.yml` always runs the **latest published release** (`ghcr.io/jandegen/wishlink:latest`, `pull_policy: always`):

```bash
cp .env.example .env     # optional – adjust PUBLIC_URL, ADMIN_PASSWORD etc.
docker compose up -d
# → http://localhost:3000
```

Pin a version with `WISHLINK_IMAGE=ghcr.io/jandegen/wishlink:1.2.3`. To build the image from a checkout instead, add the dev override:
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`. (The package on ghcr.io must be public for anonymous pulls.)

Data lives in the named volume `wishlink-data`. Backup: `docker run --rm -v wishlink_wishlink-data:/d -v $PWD:/b alpine tar czf /b/wishlink-backup.tgz -C /d .`
Update to the newest release: `docker compose pull && docker compose up -d`.
Behind a TLS reverse proxy set `PUBLIC_URL=https://your.host` and `TRUST_PROXY=true`.

### Behind Traefik

```bash
cat >> .env <<'ENV'
WISHLINK_HOST=wishlink.example.com
TRAEFIK_NETWORK=web            # the external network Traefik is attached to
ADMIN_PASSWORD=change-me-please
ENV
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d
```

`docker-compose.traefik.yml` adds the router/service labels, joins the Traefik network, sets `PUBLIC_URL=https://$WISHLINK_HOST` and
`TRUST_PROXY=true`, redirects `http://` to `https://` (entrypoint `TRAEFIK_HTTP_ENTRYPOINT`, default `web`) and does not publish port 3000. A plain **"404 page not found"** is Traefik's own answer (WishLink never returns that text)
and means no router matched. Typical causes: the page was opened with **`http://`** while the router only listens on the HTTPS entrypoint
(check with `curl -I https://host/` vs `curl -I http://host/`), or, visible in the Traefik log: the container is not attached to the network named in
`traefik.docker.network` (declaring `networks: web: external: true` is not enough, the service needs `networks: [web]`), the router references a
middleware that does not exist (`middleware "…@docker" does not exist` drops the whole router), or router/service names are copied from
another application and collide.

### Enabling Keycloak (OIDC)

1. In Keycloak create a realm and a **confidential** client `wishlink` (standard flow on).
2. Valid redirect URI: `<PUBLIC_URL>/api/auth/oidc/callback`.
3. Set `OIDC_ISSUER=https://<keycloak>/realms/<realm>`, `OIDC_CLIENT_ID=wishlink`, `OIDC_CLIENT_SECRET=<secret>`.
4. A "Log in with Keycloak" link appears on the login page.

(`docker compose --profile oidc up` starts a throw-away dev Keycloak on :8080.)

## Kubernetes / k3s (DEV)

DEV runs at **https://wishlink.example.com** (nginx ingress, TLS from cert-manager `my-cluster-issuer`).

- One-time bootstrap (cluster admin): `kubectl apply -f k8s/bootstrap.yaml` – creates namespace `wishlink-dev` and lets the GitLab runner deploy into it.
- Every push to `main`: the pipeline tests, builds the image (docker-in-docker on the `k3s` runner), pushes it to the project registry and runs `deploy-dev` (`kustomize edit set image` + `kubectl apply -k k8s`).
- Optional CI/CD variables for Keycloak: `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (masked).
- Data: PVC `wishlink-data` (local-path) -> SQLite; single replica, strategy `Recreate`.

## Releasing

1. Make sure `main` is green.
2. `git tag v1.2.3 && git push origin v1.2.3`
3. The pipeline tests, builds `<registry>/wishlink:1.2.3`, creates the GitLab release and – when configured – mirrors source, image,
   artifacts and the release to GitHub. Details, secret protection and token setup: [release.md](release.md).

## Testing strategy

- **Unit** (`test/unit`): validation, password/rate-limit logic, repository privacy rules, OIDC token checks.
- **API integration** (`test/unit/api.test.js`): real HTTP against in-memory DB, incl. the owner-can't-see-claims guarantees, CSRF/origin and auth.
- **E2E** (`test/e2e`, with a fixture shop serving Open Graph pages): Chromium, three simultaneous users; verifies publish flow, claims visibility and that the owner's page and network responses contain nothing about claims; XSS escaping; German/English switch.
