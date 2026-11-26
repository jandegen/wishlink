# Releases & GitHub mirror

A release is a tag `vX.Y.Z` (`git tag v1.2.3 && git push origin v1.2.3`). The tag pipeline runs the tests, then:

| Job | Result |
|---|---|
| `build-release-image` | Image `<registry>/wishlink:X.Y.Z` (+ `:stable`, + `:<commit>`) in the GitLab registry |
| `release-assets` | `docker-compose.yml` and `wishlink-X.Y.Z-k8s.tar.gz` (both pinned to the version), CycloneDX SBOM `wishlink-X.Y.Z.cdx.json`, `SHA256SUMS` – uploaded to the package registry and kept as artifacts |
| `create-release` | GitLab release with these assets as download links |
| `mirror-github` | **Source**: one commit per release in the GitHub repository, plus the tag |
| `release-github-images` | **Images**: copies the release image (same digest, no rebuild) to `ghcr.io/<owner>/<repo>` as `X.Y.Z`, `X.Y`, `X`, `latest`, `<commit>` |
| `release-github` | **Release + artifacts**: GitHub release for the tag with compose file, k8s manifests, SBOM and checksums |

The GitHub jobs run only when `GITHUB_MIRROR_URL` and `GITHUB_MIRROR_TOKEN` exist; without `GITHUB_GHCR_TOKEN` the image is not published.
The GitLab history is **never** pushed: the mirror receives one commit per release, built from the tagged tree (`git archive`). The
`LICENSE` that already exists in the GitHub repository is kept.

## Keeping secrets and internal data out

Everything that leaves GitLab goes through `scripts/mirror/guard.js` (and `publish-github-release.js`, which uses it) first:

1. **Rewrite** – `MIRROR_REWRITES` (one `internal=>public` rule per line, applied top to bottom, specific rules first) replaces
   installation-specific names, e.g. the internal registry or host names, in all text files, the SBOM, compose and manifests.
2. **Scan** – the result is refused (job fails, **nothing is pushed**) when it still contains
   - a built-in secret pattern (`scripts/mirror/secret-patterns.txt`: private keys, GitLab/GitHub/AWS/Slack tokens, kubeconfig credentials),
   - the literal value of a known secret CI/CD variable (`ADMIN_PASSWORD`, `OIDC_CLIENT_SECRET`, the GitHub tokens, registry and job tokens),
   - a match of `MIRROR_FORBIDDEN_PATTERNS` (extended regex with the strings that must never appear, e.g. your domain and user names).
   The log lists file names only, never the matched content.
3. **Images** – only the application files (`/app` without the third-party `node_modules`) and the image configuration/manifest are scanned.
   Nothing is baked into the image at build time (secrets are runtime environment variables), the scan is a safety net.
4. `*.tar.gz` assets are scanned including their contents. Compose file and k8s manifests for GitHub are built from the already sanitised snapshot.

The unit test `this repository: every internal string is rewritten…` runs the same guard over the working tree, so a new file with
installation-specific data fails the normal test run instead of the first release. Secret-looking fixtures in tests are assembled at runtime for the same reason.

## CI/CD variables (all protected; tags `v*` are protected so only release pipelines can read them)

| Variable | Purpose |
|---|---|
| `GITHUB_MIRROR_URL` | `https://github.com/<owner>/<repo>.git` |
| `GITHUB_MIRROR_TOKEN` | fine-grained token, repository access: only the mirror repository, **Contents: Read and write** (masked) |
| `GITHUB_GHCR_TOKEN` | optional, classic token with **`write:packages`** (masked); fine-grained tokens do not work with ghcr.io |
| `MIRROR_FORBIDDEN_PATTERNS` | extended regex of internal strings, kept in the variable so they do not appear in the repository |
| `MIRROR_REWRITES` | optional rewrite rules (see above) |

`node scripts/mirror/setup.js` shows which variables exist and are correctly protected/masked, asks for (hidden input) and writes only what is
missing, validates new tokens against GitHub (write access to the repository / scope `write:packages`) and protects the tag pattern `v*`.
Tokens can also come from the environment (`GITHUB_MIRROR_TOKEN`, `GITHUB_GHCR_TOKEN`). `--dry-run` shows the plan, `--force` rewrites existing values.

### Creating the tokens on GitHub

1. **Mirror token**: GitHub → *Settings* → *Developer settings* → *Fine-grained tokens* → *Generate new token*. *Repository access*: only the mirror
   repository. *Permissions*: **Contents: Read and write** (the release and its assets go through it). Copy the `github_pat_…` value once.
2. **ghcr.io token**: *Tokens (classic)* → *Generate new token (classic)* → scope **`write:packages`**. Copy the `ghp_…` value once.
3. Run `node scripts/mirror/setup.js` and paste the tokens when asked. If a token expires, the job fails: create a new one and run the script again.

On the first push ghcr.io creates the package as **private**: once, under *Package settings*, set it to *Public* and link it to the repository.

## Local checks

```bash
npm test                      # includes the guard, rewrite and publish tests
sh scripts/mirror/build-release-assets.sh . /tmp/assets 1.2.3 ghcr.io/owner/wishlink
```
