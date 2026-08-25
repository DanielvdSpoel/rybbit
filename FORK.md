# Fork maintenance

This is `DanielvdSpoel/rybbit`, a fork of `rybbit-io/rybbit`. The fork is kept
as a **small stack of commits rebased onto the latest upstream release tag**:

- `master` — mirrors upstream, no fork changes.
- `deploy` — `<upstream release tag>` + the fork commits below. This is what
  gets tagged and built.
- Release = tag `vX.Y.Z-fork[.N]` on `deploy` → `.github/workflows/docker-publish.yml`
  builds `ghcr.io/danielvdspoel/rybbit-{client,backend}`. Deployment lives in a
  separate K8s repo; bump the image tags there.

## Fork commits (in order)

| Commit | What | Watch for on upgrade |
|---|---|---|
| `feat(storage): support any S3-compatible provider` | `r2StorageService` → `s3StorageService` (`objectStorage`), generic `S3_*` env. Upstream's `r2StorageService.test.ts` (added 2.9.0) is carried as `s3StorageService.test.ts`. | Any new upstream file importing `r2Storage` / `r2StorageService.js` (e.g. `deleteUser.ts`, test mocks) must be pointed at `objectStorage` from `s3StorageService.js`. If upstream changes `r2StorageService.test.ts`, port the change into `s3StorageService.test.ts` (same cases, `S3_*` env, `[S3Storage]` log prefix, no `IS_CLOUD` gate). |
| `fix(cors): allow credentials on public endpoints` | `credentials: true` on the public-path branch of `server/src/lib/cors.ts`. | Upstream keeps re-restricting this (2.6: `false`, 2.8: trusted-origins-only). `@rybbit/js` uses `navigator.sendBeacon` (always credentialed) from customer origins, so it MUST stay `true` or SDK tracking silently dies. Upstream tests in `cors.test.ts` asserting `allow-credentials` is undefined for customer origins must be flipped. |
| `feat: add properties: and url_param: filter prefixes` | `properties:<key>` → `JSONExtractString(toString(props), '<key>')`, `url_param:<key>` accepted by `filterParamSchema` with a safe-key charset. | Upstream ships `url_param:` in `getSqlParam` but *rejects* it in `filterParamSchema` (and pins that in `query-validation.test.ts`). Keep the fork's union schema and flip that test. |
| `fix(filters): use JSONExtractString for properties:` | Numeric compares on properties wrap in `toFloat64OrNull(...)`. | Upstream wrapped the operand in `mapField(...)`; keep `mapField` on the non-properties branch. |
| `feat(api-playground): expose properties:/url_param:/feature_flag:` | Client filter builder UI. | Usually applies cleanly. |

Dropped in 2.8.0: the fork's root `.dockerignore` — upstream now ships its own.

Known-failing upstream test in local WSL runs (also fails on pristine v2.9.1, not
fork-related): `server/src/lib/oauth.test.ts` — "invalid code" / "OTP expired"
from the PGlite-backed Better Auth flow. CI (Docker, Node 24) is authoritative.
`@mongodb-js/zstd` prebuild download may fail locally; use
`npm ci --legacy-peer-deps --ignore-scripts` for tsc/vitest.

## Upgrading to a new upstream release

```bash
scripts/fork-upgrade.sh v2.10.0     # fetch, back up, rebase fork commits onto the tag
```

The script stops on the first conflict; resolve using the table above, then
`git rebase --continue`. After it finishes:

```bash
# verify
(cd shared && npm install && npm run build)
(cd server && npm ci --legacy-peer-deps && npx tsc --noEmit && npx vitest run)
(cd client && npm ci --legacy-peer-deps && npx tsc --noEmit)

# also look for new upstream code touching the fork's surface
git grep -n 'r2Storage' -- server/src
git diff <old-tag> <new-tag> -- .github/workflows/docker-publish.yml client/Dockerfile server/Dockerfile docker-compose.yml

# release
git push --force-with-lease origin deploy
git tag v2.10.0-fork && git push origin v2.10.0-fork
```

`deploy` is force-pushed on every upgrade (it is a rebased stack); the script
leaves `backup/deploy-<old-tag>` behind so nothing is lost.

## Deployment notes (K8s repo)

- **2.9.x (deployed as v2.9.1-fork, 2026-09):**
  - Redis is served by a DragonflyDB CR (`dragonfly-rybbit`, ns `rybbit`); backend
    reads `REDIS_PASSWORD` straight from the `dragonfly-user-rybbit` secret.
  - ClickHouse must be ≥ 25.3: the backend provisions the least-privilege
    `rybbit_query` user at startup with `enable_json_type = 1`, which 24.8 does not
    know. Cluster runs `clickhouse-server:26.3.17.4`; the CHI sets
    `default/access_management: "1"` so the SQL `CREATE USER` / `CREATE SETTINGS
    PROFILE` succeeds. Without it custom SQL / dashboard cards fail closed.
  - Optional env: `CLICKHOUSE_QUERY_USER` / `CLICKHOUSE_QUERY_PASSWORD` (defaults
    to `CLICKHOUSE_PASSWORD`), `API_RATE_LIMIT_OBSERVE_ONLY`.
  - Ingress routes `/.well-known/oauth-authorization-server`,
    `/.well-known/oauth-protected-resource`, `/.well-known/openid-configuration`
    to the backend (Better Auth 1.7 OAuth provider / MCP discovery), mirroring
    upstream's `Caddyfile`.
  - Postgres migration 0014 drops the uptime-monitoring tables; 0018 aborts on
    duplicate `(providerId, accountId)` rows in `account`; 0019 adds
    `invitation.createdAt`. Take a backup before rolling.
  - Removed env: `DISABLE_ORIGIN_CHECK`, `TWILIO_*`.

- **2.8.0 made Redis a core backend dependency** (session resolution, sticky
  user ids, bot anomaly scoring, feature flags) — previously it was only used
  by uptime monitoring. The server degrades rather than crashes without it, but
  run one: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`.
- New optional env in 2.8.0: `DISABLE_REDIS_ANOMALY`, `DISABLE_STICKY_IDENTITY`.
- Client `NEXT_PUBLIC_BACKEND_URL` is still baked empty at build time → the
  ingress must route `/api/*` to the backend on the same host.
