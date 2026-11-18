# Fork maintenance

This is `DanielvdSpoel/rybbit`, a fork of `rybbit-io/rybbit`. The fork is kept
as a **small stack of commits rebased onto upstream** — normally the latest
release tag, or `upstream/master` when it carries fixes worth taking early:

- `master` — mirrors upstream, no fork changes.
- `deploy` — `<upstream tag or master commit>` + the fork commits below. This is what
  gets tagged and built.
- Release = tag `vX.Y.Z-fork[.N]` on `deploy` (`vX.Y.Z-fork.<upstream sha>` when
  based on an untagged upstream commit) → `.github/workflows/docker-publish.yml`
  builds `ghcr.io/danielvdspoel/rybbit-{client,backend}`. Deployment lives in a
  separate K8s repo; bump the image tags there.

## Fork commits (in order)

| Commit | What | Watch for on upgrade |
|---|---|---|
| `feat(storage): support any S3-compatible provider` | `r2StorageService` → `s3StorageService` (`objectStorage`), generic `S3_*` env. Upstream's `r2StorageService.test.ts` (added 2.9.0) is carried as `s3StorageService.test.ts`. | Any new upstream file importing `r2Storage` / `r2StorageService.js` (e.g. `deleteUser.ts`, `deleteUser.test.ts`, test mocks) must be pointed at `objectStorage` from `s3StorageService.js`. If upstream changes `r2StorageService.test.ts`, port the change into `s3StorageService.test.ts` (same cases, `S3_*` env, `[S3Storage]` log prefix, no `IS_CLOUD` gate). Upstream's replay-ingest changes (serialize-once, 50 MB session budget) conflict in `sessionReplayIngestService.ts`: keep upstream's logic, rename `r2Storage`/`r2BatchKey` → `objectStorage`/`batchKey`. |
| `fix(cors): allow credentials on public endpoints` | `credentials: true` on the public-path branch of `server/src/lib/cors.ts`. | Upstream keeps re-restricting this (2.6: `false`, 2.8: trusted-origins-only). `@rybbit/js` uses `navigator.sendBeacon` (always credentialed) from customer origins, so it MUST stay `true` or SDK tracking silently dies. Upstream tests in `cors.test.ts` asserting `allow-credentials` is undefined for customer origins must be flipped. Upstream 2026-10 added tracker preflight caching (`maxAge` via `isTrackerCorsPath`) in the same block — keep it. |
| `feat: add properties: and url_param: filter prefixes` | `properties:<key>` → `JSONExtractString(toString(props), '<key>')`, `url_param:<key>` accepted by `filterParamSchema` with a safe-key charset. | Upstream ships `url_param:` in `getSqlParam` but *rejects* it in `filterParamSchema` (and pins that in `query-validation.test.ts`). Keep the fork's union schema and flip that test. |
| `fix(filters): use JSONExtractString for properties:` | Numeric compares on properties wrap in `toFloat64OrNull(...)`; `assertFilterTypeCompatible` lets `properties:<key>` through the comparison guard. | Upstream wrapped the operand in `mapField(...)`; keep `mapField` on the non-properties branch. Upstream (2026-10 bug sweep) restricts `greater_than`/`less_than*` to `lat`/`lon` in `assertFilterTypeCompatible` — the fork exemption for `properties:` must survive, or numeric property filters 400 (pinned by the `properties:price greater_than` test). |
| `feat(api-playground): expose properties:/url_param:/feature_flag:` | Client filter builder UI. | Usually applies cleanly. |
| `docs(fork): add FORK.md and scripts/fork-upgrade.sh` | This file and the upgrade script. | — |
| `fix(filters): filter properties:/url_param: through session event subqueries` | `SESSION_EVENT_LEVEL_PARAMS` in `sessionFilters.ts` gets prefix entries `"properties:"` / `"url_param:"`, matched by `isParamInList` (an entry ending in `:` is a prefix). Session-scoped reports (overview, time-series, metric, sessions, users, funnels, goals, retention…) then filter them as "session has a matching event" instead of `argMax(properties:x, timestamp) AS properties:x` (a ClickHouse syntax error). Numeric compares in that subquery use `buildNumericComparison` (`toFloat64OrNull`). | Any upstream code checking `sessionLevelParams.includes(...)` or a `subqueryOnlyParams` set must use `isParamInList`, or these filters 500 again. Pinned by `sessionFilters.test.ts` and `sessionFilters.clickhouse.test.ts` (runs with `CLICKHOUSE_TEST_URL`). |

Dropped in 2.8.0: the fork's root `.dockerignore` — upstream now ships its own.

Since 2026-09 upstream is a **pnpm workspace** (`client`, `server`, `shared`;
`docs` separate). Without a global pnpm, `corepack pnpm` works.
`pnpm install --ignore-scripts` skips the `@mongodb-js/zstd` native build, which
breaks `server/src/api/routes.test.ts` ("Cannot find module
'../build/Debug/zstd.node'"); fix with `npm run install` inside
`node_modules/.pnpm/@mongodb-js+zstd@*/node_modules/@mongodb-js/zstd`.
(`oauth.test.ts`, previously flaky locally, passed on the 2026-11 upgrade.)

## Upgrading to a new upstream release

```bash
scripts/fork-upgrade.sh v2.10.0          # fetch, back up, rebase fork commits onto the tag
scripts/fork-upgrade.sh upstream/master  # or onto unreleased upstream
```

Needs the `upstream` remote: `git remote add upstream https://github.com/rybbit-io/rybbit.git`.

The script stops on the first conflict; resolve using the table above, then
`git rebase --continue`. After it finishes:

```bash
# verify
pnpm install --frozen-lockfile
pnpm typecheck      # builds shared, then tsc for server + client
pnpm test           # shared, server, client vitest

# also look for new upstream code touching the fork's surface
git grep -n 'r2Storage' -- server/src
git diff <old-tag> <new-tag> -- .github/workflows/docker-publish.yml client/Dockerfile server/Dockerfile docker-compose.yml

# release (the script prints the exact tag)
git push --force-with-lease origin deploy
git tag v2.10.0-fork && git push origin v2.10.0-fork
```

`deploy` is force-pushed on every upgrade (it is a rebased stack); the script
leaves `backup/deploy-<old-tag>` behind so nothing is lost.

## Deployment notes (K8s repo)

- **upstream master 2026-11-18 (`6914a878b`, security bumps = 2.9.3 and more):**
  - next 16.4.6 (image-optimizer RCE, SSRF, middleware bypass), fastify 5.12.8
    (malformed-URL auth bypass), @fastify/static 10.1.11 (path traversal), MCP SDK
    1.32.2, better-auth 1.7.25 (2.9.3 itself keeps 1.7.3). `@better-auth/sso` dropped.
  - Also brings raw event export (`/export/events`, Site Settings → Export).
  - No migrations, no new env, Dockerfiles unchanged.
  - Upstream `v2.9.3` lives on `release/2.9` (older than our base), so the fork
    follows master instead. Later master commits (TypeScript 7, test pruning) were
    left for the next upgrade.

- **upstream master 2026-11-04 (`428820476`, after 2.9.2; includes 2.9.2's Node pin):**
  - Images are now built from the pnpm workspace; `docker-publish.yml` is
    unchanged, but the Dockerfiles moved to `pnpm` — check the build succeeds.
  - Postgres migrations 0020–0024 are additive (`sites.claim_expires_at`,
    `team_site_access.role`, `site_transfers` table, `sites.trackUrlFragments`,
    index `sites_id_idx`). Take a backup before rolling anyway.
  - ClickHouse: upstream compose pins `26.3.62.3` (CVE-2026-116366); bump the CHI.
  - Custom SQL / dashboard cards now read `events` through a per-site row policy
    for `rybbit_query` and answer **503** until `system.row_policies` shows it.
    Relies on `access_management: "1"` (already set) — check those pages after rollout.
  - New optional env: `DASHBOARD_CACHE_TTL_SECONDS` (default 30, shared via Redis),
    `SESSION_REPLAY_MAX_MB_PER_SESSION` (default 50; replays beyond are dropped),
    `APPSUMO_API_KEY` (cloud only).

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
