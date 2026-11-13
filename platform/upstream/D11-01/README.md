# D11-01 — Metabase (vendored definition)

| Field | Value |
| --- | --- |
| Product | Metabase |
| Pinned release | `metabase/metabase:v0.65.2` (GitHub release `v0.65.2`, 2026-10-30) |
| Image digest | `sha256:b62ac14872e9992d28218a2264d99484e0707064aae9fb594d8fbb3bc1518a9e` |
| Application database | `postgres:18-alpine` (PostgreSQL 18.6), sidecar `db` |
| Catalogue `httpPort` | `3000` — the port the container listens on |
| Repository | <https://github.com/metabase/metabase> |

## Why this tree exists

The D11-01 entry used to declare `packaging: dockerfile` with a repository clone as its source, and an
`imageDigest` that was not a digest (128 hex characters — two digests concatenated). Neither could
reach a running product:

- `metabase/metabase` ships a **build** Dockerfile — a multi-stage Clojure/Java and Yarn compile of
  the whole application. The executor runs `docker buildx build` inside the deploy-worker, and that
  needs a BuildKit session the scoped socket proxy refuses: the job reaches `apply` and dies with
  `unable to upgrade to tcp, received 403`.
- The repository ships no Compose file, so there is nothing to resolve to instead.
- The image reference `metabase:0.57.3` names no repository (`docker.io/library/metabase` does not
  exist). The project publishes `metabase/metabase`.

The published artefact of the project is the image `metabase/metabase`, which is what this tree
pins.

## Why PostgreSQL and not the embedded H2

The image will start with no database configured and keep its application database in an H2 file
under `/metabase-data`. Upstream restricts that to evaluation use: H2 serialises writes, corrupts
under the concurrent access a BI tool generates, and a corrupted file has no repair path. A BI
product whose saved questions, dashboards and users live in a corruptible file is not a deployed
product, so the definition runs the pinned PostgreSQL sidecar instead and the catalogue's
`database` dependency is served inside this definition.

`mb-pgdata` is mounted at `/var/lib/postgresql`, the path the PostgreSQL 18 image declares as its
VOLUME. That image keeps one data directory per major version
(`/var/lib/postgresql/18/docker`), so the older habit of mounting `/var/lib/postgresql/data` would
leave the real cluster outside the mount and every redeploy would start an empty database.

## Volumes

| Volume | Mount | Holds |
| --- | --- | --- |
| `mb-pgdata` | `/var/lib/postgresql` | the PostgreSQL cluster holding Metabase's application data |

## Operational notes

- **`MB_SITE_URL` must equal the published route.** Metabase builds every link it generates
  (password resets, subscriptions, alert links) from it. The image's fallback is the incoming `Host`
  header, which behind the edge is the slug plus the container port — links the browser cannot
  follow. It is a declared variable with the route as its default.
- **Three required secrets.** `MB_DB_PASS` (also interpolated into the sidecar as
  `POSTGRES_PASSWORD`), `MB_ENCRYPTION_SECRET_KEY` (64 hex characters) and `MB_SESSION_SECRET_KEY`
  (64 hex characters). None has a usable image default: without the first Metabase silently falls
  back to H2, without the second every data-source credential is stored in plaintext, and without
  the third the session records in the application database are unsigned — the instance's own log
  says anyone with read access to that database can forge a session and impersonate any user.
  Supply all three with `--env-file` (`temp/d11.env`, git-ignored).
- **Sample content is off.** `MB_LOAD_SAMPLE_CONTENT=false` stops first boot from registering the
  bundled `Sample Database` and its ~40 demo questions. Read once, while the instance is created:
  the setting does not remove content a previous boot already installed, and the image still
  extracts `sample-database.sqlite` into `/plugins` on every start regardless.
- **First boot is slow.** The sidecar initialises, then Metabase migrates its schema before
  `/api/health` answers `200`. The healthcheck's `start_period` is 300 s; the platform's `verify`
  stage waits `SEAMNEX_VERIFY_TIMEOUT_MS`.
- **`MB_DB_USER` and `MB_DB_PASS` are read only while the data directory is empty.** The sidecar's
  entrypoint creates the role on first boot; changing either later is a mismatch, not a rename.
- **First run opens the setup wizard.** `GET /` redirects to `/setup` until an administrator exists.
  That is a business-configuration step, not a deployment defect — the platform deploys and gates
  the product; it does not create accounts inside it.
- **Free edition.** Native SSO (JWT/SAML), sandboxing and audit logs are paid tiers. The entry's
  guarantee class is `fa_gate`: the edge gates the route with forward-auth and Metabase still shows
  its own sign-in form. That gap is the entry's recorded `deviation`, not a hidden one.

## Verified behaviour (0.65.2, route `insights.localhost:8020`)

| Probe | Result |
| --- | --- |
| `GET /api/health` from inside the container | `200`, `{"status":"ok"}` (~75 s after the container started) |
| Container health (`docker ps`) | `seamnex-insights-metabase-1` healthy, `seamnex-insights-db-1` healthy |
| `GET /` through the edge with a platform session | `200`, `Welcome to Metabase — Looks like everything is working.` (setup page; no administrator exists yet) |
| `GET /` through the edge without a platform session | `401` (forward-auth, as designed) |
| Platform integration checks | `dns` ok · `http` `200` on `:3000` · `sso_login` stages 1–2 passed · `backup_registered`, `webhook_registered` warn (non-blocking) |
| Application database | `postgres:18-alpine` · 202 tables migrated · cluster in `mb-pgdata` |
| Credential encryption | `Saved credentials encryption is ENABLED` in the boot log |
| Session signing | no `MB_SESSION_SECRET_KEY is not set` warning after the secret was added |

## What the first deployment taught (2026-10-31)

Five defects were found by running the entry end to end, not by reading the file:

1. **The catalogue `imageDigest` was not a digest.** 128 hex characters — two digests concatenated.
   `P8` refused the deploy, correctly: nothing verifies a digest that cannot be parsed.
2. **The catalogue `imageRef` named no repository.** `metabase:0.57.3` resolves to
   `docker.io/library/metabase`, which does not exist; the project publishes `metabase/metabase`.
   The pull could never have succeeded.
3. **`packaging: dockerfile` pointed at a clone of the repository.** That path ends in
   `docker buildx build` inside the deploy-worker, whose BuildKit session the scoped socket proxy
   refuses. This tree replaced it, as it did for D09-01.
4. **The entry declared no environment at all.** No site URL, no database password, no encryption
   key, no session key: the instance booted on its own defaults, which means an H2 file database, a
   site URL taken from the `Host` header, plaintext data-source credentials and unsigned sessions.
   All of that is silent — the product starts happily.
5. **`ready` is claimed while the product is still initialising.** Measured: the platform reported
   `ready`, `2/2 running` and integration `http 200` while `/api/health` still answered
   `503 {"status":"initializing","progress":0.3}` and `docker ps` still said `health: starting`. The
   edge probe only requires a status below 500 at `/`, and Metabase serves its loading page with
   `200`. The container healthcheck written here is the compensating control: it asks
   `/api/health` and stays `starting` until the schema is migrated. Treat `V1` as "the control plane
   finished", and the container health status as "the product is up".

A sixth point is not a defect but a limit worth knowing: `V6` in the check skill skipped the
through-the-edge probe on this host because Node's resolver never resolves `*.localhost` on
Windows. The skill now retries the same request against loopback with the route host in the `Host`
header (what `curl --resolve` does), so the probe reports `401` — the gate answering — instead of
`SKIP`. A browser resolves the name natively, which is why the launcher check below works.
