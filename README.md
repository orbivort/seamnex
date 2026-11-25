# Seamnex

[![License: GPL-3.0-only](https://img.shields.io/badge/License-GPL--3.0--only-blue.svg)](LICENSE)
[![CI](https://github.com/orbivort/seamnex/actions/workflows/ci.yml/badge.svg)](https://github.com/orbivort/seamnex/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-24+-green.svg)](https://nodejs.org/)

**One front door to the applications you self-host.**

Seamnex is a self-hosted platform for the open-source business applications a small organisation runs:
one identity, one portal, one operator console, and an audit trail for every change — on hardware you
control, with no SaaS dependency.

The catalogue this platform serves is **not in this repository**. Entry documents, environment
declarations and upstream render sets are deployable product content, so they live in
[`orbivort/seamnex-catalog`](https://github.com/orbivort/seamnex-catalog) and reach a host as a
checkout at a **tag** (ADR-BE-42): `pnpm catalog:sync --ref <tag>`, or Catalog → "Sync from source" in
the console.
[`docs/operations/catalog-repo-format.md`](docs/operations/catalog-repo-format.md) defines the format.

The configured tag declares six entries today, one per domain:

| Entry    | Product     | Domain                      | Sign-in                                          |
| -------- | ----------- | --------------------------- | ------------------------------------------------ |
| `D01-01` | EspoCRM     | CRM & sales pipeline        | Native OIDC (authorization code + PKCE)          |
| `D02-01` | Mautic      | Marketing & lead generation | Proxy gate only; Mautic keeps its own login      |
| `D06-01` | ERPNext     | ERP & business operations   | Native OIDC (Frappe social login)                |
| `D07-01` | OrangeHRM   | HR & people operations      | Proxy gate only; OrangeHRM keeps its own login   |
| `D09-01` | OpenProject | Project & work management   | Proxy gate only; OpenProject keeps its own login |
| `D11-01` | Metabase    | Data, reporting & BI        | Proxy gate only; Metabase keeps its own login    |

A proxy-gated entry is protected by the edge but keeps its own credential, so it is never presented as
single sign-on. A fresh clone serves none of this until a tag is fetched: the platform starts, the
console reports that the catalogue has not been acquired, and `pnpm db:seed` projects whichever
checkout is present instead of shipping documents of its own.

## Prerequisites

| Requirement | Version                                  | Notes                                             |
| ----------- | ---------------------------------------- | ------------------------------------------------- |
| Node.js     | 24 LTS (`>= 24.15.0`)                    | `.nvmrc` pins the patch; installs fail otherwise  |
| pnpm        | 11.21.0                                  | Enable through Corepack; no global install needed |
| Docker      | Docker Desktop or Engine with Compose v2 | Needed by `pnpm dev` and `pnpm dev:stack`         |

## Install

```bash
corepack enable pnpm
pnpm install
pnpm mocks:init        # generates the MSW worker into both apps (not committed)
```

`pnpm mocks:init` is required on a clean clone: the generated service worker is deliberately not
committed.

### Get the catalogue

The install above ships no catalogue documents, so a clean clone serves an empty catalogue. Either
path below gives it one; both are idempotent, and both leave an existing catalogue alone rather than
topping it up.

1. **Fetch a tag — the supported path.** The API fetches the configured mirror, swaps the tree and
   reconciles the projection in one request:

   ```bash
   SEAMNEX_API_TOKEN=<R1 token> pnpm catalog:sync --ref catalog-2026.11.0
   ```

   Without a token, use Catalog → "Sync from source" in the console; it is the same server operation.

2. **Place a checkout by hand — air-gapped, or already reviewed.** Nothing needs a network:

   ```bash
   git clone --depth 1 --branch catalog-2026.11.0 https://github.com/orbivort/seamnex-catalog temp/catalog-repo
   pnpm db:seed              # projects the documents into an empty catalogue; it never tops one up
   pnpm catalog:project      # applies the environment declarations the checkout carries
   ```

   With a populated catalogue, Catalog → "Reload from repository" re-reads the tree instead.

`SEAMNEX_CATALOG_REPO_PATH` names the root either path writes; it must be writable, because the
platform also writes `instances/` there. Sync fetches only a tag or a commit, never a branch, so a
running installation cannot drift.

### Install on a host

`pnpm dev` is the developer loop. For a host that should actually run the platform, use the one
documented bootstrap:

```bash
pnpm bootstrap          # installs the workspace, brings up the stack, seeds data, verifies readiness
pnpm bootstrap:check    # verifies an existing install; changes nothing
```

It is idempotent: a second run converges instead of duplicating, and it never rotates a credential or
overwrites `.env`. It also does not fetch the catalogue — a clean host serves none until you run one of
the two acquisition paths above; the bootstrap says so on its last line rather than promising content.
Deployed products are served over TLS by the edge (`https://<slug>.seamnex.localhost:8443`
on the install, with the development CA's certificate). The step-by-step procedure, the timing budget, the
verification checklist, the recovery paths and the list of what this install does **not** do
(certificate issuance, production identities, a hosted console) are in
[`docs/operations/bootstrap.md`](docs/operations/bootstrap.md).

## Usage

Three modes; `pnpm dev` and `pnpm dev:stack` both bind `:8080`, so run one or the other.

| Command          | What it runs                                                                                      | Docker |
| ---------------- | ------------------------------------------------------------------------------------------------- | ------ |
| `pnpm dev:web`   | Both SPAs against an in-browser mock API — the fastest inner loop                                 | No     |
| `pnpm dev`       | Datastores in containers, migrations, whatever catalogue checkout exists, API and both SPAs local | Yes    |
| `pnpm dev:stack` | Keycloak, Traefik, n8n, the S3 target, Mailpit, the API and its workers                           | Yes    |

With the stack up, `pnpm dev:portal` and `pnpm dev:console` start just the SPAs against `:8080`; add
`--profile observability` to `pnpm dev:stack` for Prometheus, Grafana and Loki.

In mock mode the session is simulated: the role and scenario come from the URL, which makes any screen
bookmarkable — `/?role=R2&scenario=maintenance` for a read-only auditor, `/?role=R6` for the guest
surface.

### Against the real API

Set `VITE_API_MODE=live` in the root `.env`, restart the dev server, and open
<https://localhost:5174/sign-in>. Both dev servers speak TLS with a certificate issued by a development
CA generated into `temp/certs` on first start. Trust that CA once —
`certutil -user -addstore Root temp\certs\dev-ca.crt` on Windows,
`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain temp/certs/dev-ca.crt`
on macOS — and the warning stops for every port and every subsequent `pnpm dev`, because only the leaf
is reissued (yearly) while the CA is kept for ten. Sign-in is OIDC against Keycloak, which the container
stack provides (`AUTH_PROVIDER=stub` is a development-only fallback for a host without it).

The seeded realm ships six identities, one per platform role; the password matches the username:

| Username      | Role                |
| ------------- | ------------------- |
| `dev-admin`   | R1 Platform Admin   |
| `dev-auditor` | R2 Platform Auditor |
| `dev-owner`   | R3 Domain Owner     |
| `dev-product` | R4 Product Admin    |
| `dev-user`    | R5 End User         |
| `dev-guest`   | R6 External / Guest |

In live mode the role always comes from the server, never from the query string.

## Configuration

There is exactly one environment file: the repository-root `.env`. Vite reads it as `envDir`, the API
loads it through `loadRootEnv()`, and Compose receives it via `--env-file`. An `.env` inside
`apps/portal` or `apps/console` is never read. `pnpm dev` and `pnpm dev:stack` write it on first run
from [`.env.example`](.env.example), which documents every key and the values a production host must
change.

| Variable                     | Scope           | Effect                                                                        |
| ---------------------------- | --------------- | ----------------------------------------------------------------------------- |
| `VITE_API_MODE`              | portal, console | `mock` (development default) or `live`                                        |
| `VITE_API_BASE_URL`          | portal, console | Dev proxy target and production API origin                                    |
| `VITE_PORTAL_URL`            | console         | Portal origin used by the console's "Open the portal" control                 |
| `AUTH_PROVIDER`              | API             | `oidc` (Keycloak) or `stub` (development only, refused outside development)   |
| `SEAMNEX_CATALOG_REPO_PATH`  | API             | Writable catalogue checkout; a missing `catalog/` reads as "not acquired yet" |
| `SEAMNEX_CATALOG_SOURCE_URL` | API             | Mirror `POST /catalog/sync` fetches; empty disables the action                |
| `SEAMNEX_CATALOG_SOURCE_REF` | API             | Tag or commit the sync dialog pre-fills; empty means the caller must name one |
| `SEAMNEX_SOURCE_MIRROR_DIR`  | API             | Leave empty: a synced tag puts render sets under `<root>/upstream/`           |

## Commands

| Command                                    | Effect                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm dev:web`                             | Both SPAs against the in-browser mock API                                           |
| `pnpm bootstrap`                           | Installs or repairs a host; ends with `/readyz` verified                            |
| `pnpm bootstrap:check`                     | Verifies an existing install without changing anything                              |
| `pnpm dev`                                 | Datastores, migrations, the catalogue projection, then portal, console and API      |
| `pnpm dev:stack`                           | The platform in Compose; add `--profile observability` for metrics and logs         |
| `pnpm dev:stack:down`                      | Stops the Compose stack                                                             |
| `pnpm catalog:sync --ref <tag>`            | Fetches a catalogue tag through the API; needs `SEAMNEX_API_TOKEN`                  |
| `pnpm catalog:project`                     | Applies the checkout's environment declarations to `env_schema_var`                 |
| `pnpm db:seed`                             | Projects a checkout into an empty catalogue and seeds identity; writes no documents |
| `pnpm check:catalog`                       | Pairs documents with declarations in the checkout; fails when none is present       |
| `pnpm test`                                | All suites: unit, app and the contract golden file                                  |
| `pnpm test:integration`                    | Database and API suites against PostgreSQL and Redis                                |
| `pnpm typecheck` / `lint` / `format:check` | The workspace quality gates, as run in CI                                           |
| `pnpm build`                               | Typecheck, then production builds — mock platform excluded                          |

## Documentation

- [`docs/openapi.json`](docs/openapi.json) — generated OpenAPI document for `/api/v1`, produced from
  `packages/domain/src/contract.ts`.
- [`docs/operations/bootstrap.md`](docs/operations/bootstrap.md) — the host install runbook, and what
  the install deliberately does not do.
- [`docs/operations/catalog-repo-format.md`](docs/operations/catalog-repo-format.md) — the catalogue
  repository layout, the rules a file must satisfy, and how invalid files are reported.
- [`docs/operations/certificates.md`](docs/operations/certificates.md) — the development CA and leaf, how
  to trust them, what each TLS warning means, and the edge's certificate modes.
- [`docs/dev-reference/requirement-design/adr/ADR-BE-42-catalog-content-boundary.md`](docs/dev-reference/requirement-design/adr/ADR-BE-42-catalog-content-boundary.md)
  — why the catalogue left this repository, what a sync does, and why the swap is reported rather than
  assumed atomic.

## Contributing

Bug reports, specifications and review comments are welcome; external code contributions are not
accepted yet. [`CONTRIBUTING.md`](CONTRIBUTING.md) states the policy, the workflow and the quality
gates, and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) the community standard. Report security issues
privately as described in [`SECURITY.md`](SECURITY.md) — never in a public issue.

## License

Copyright (C) 2026 Orbivort.

Seamnex is licensed under the **GNU General Public License, version 3** (`GPL-3.0-only`); the full text
is in [`LICENSE`](LICENSE). The version is pinned — the "or any later version" option of GPL-3.0 §14
is not granted. Third-party components and notices are inventoried in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
