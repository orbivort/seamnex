# Seamnex

[![License: GPL-3.0-only](https://img.shields.io/badge/License-GPL--3.0--only-blue.svg)](LICENSE)
[![CI](https://github.com/orbivort/seamnex/actions/workflows/ci.yml/badge.svg)](https://github.com/orbivort/seamnex/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-24+-green.svg)](https://nodejs.org/)

**One front door to the applications you self-host.**

Seamnex is a self-hosted platform for the open-source business applications a small organisation runs:
one identity, one portal, one operator console, and an audit trail for every change — on hardware you
control, with no SaaS dependency. Three example catalogue entries ship today: EspoCRM (CRM), OrangeHRM (HRM),
OpenProject (Project Management).

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

## Usage

Three modes; `pnpm dev` and `pnpm dev:stack` both bind `:8080`, so run one or the other.

| Command          | What it runs                                                                   | Docker |
| ---------------- | ------------------------------------------------------------------------------ | ------ |
| `pnpm dev:web`   | Both SPAs against an in-browser mock API — the fastest inner loop              | No     |
| `pnpm dev`       | Datastores in containers, migrations and seed applied, API and both SPAs local | Yes    |
| `pnpm dev:stack` | Keycloak, Traefik, n8n, the S3 target, Mailpit, the API and its workers        | Yes    |

With the stack up, `pnpm dev:portal` and `pnpm dev:console` start just the SPAs against `:8080`; add
`--profile observability` to `pnpm dev:stack` for Prometheus, Grafana and Loki.

In mock mode the session is simulated: the role and scenario come from the URL, which makes any screen
bookmarkable — `/?role=R2&scenario=maintenance` for a read-only auditor, `/?role=R6` for the guest
surface.

### Against the real API

Set `VITE_API_MODE=live` in the root `.env`, restart the dev server, and open
<http://localhost:5174/sign-in>. Sign-in is OIDC against Keycloak, which the container stack provides
(`AUTH_PROVIDER=stub` is a development-only fallback for a host without it).

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

| Variable            | Scope           | Effect                                                                      |
| ------------------- | --------------- | --------------------------------------------------------------------------- |
| `VITE_API_MODE`     | portal, console | `mock` (development default) or `live`                                      |
| `VITE_API_BASE_URL` | portal, console | Dev proxy target and production API origin                                  |
| `VITE_PORTAL_URL`   | console         | Portal origin used by the console's "Open the portal" control               |
| `AUTH_PROVIDER`     | API             | `oidc` (Keycloak) or `stub` (development only, refused outside development) |

## Commands

| Command                                    | Effect                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `pnpm dev:web`                             | Both SPAs against the in-browser mock API                                   |
| `pnpm dev`                                 | Datastores, migrations, seed data, then portal, console and API             |
| `pnpm dev:stack`                           | The platform in Compose; add `--profile observability` for metrics and logs |
| `pnpm dev:stack:down`                      | Stops the Compose stack                                                     |
| `pnpm test`                                | All suites: unit, app and the contract golden file                          |
| `pnpm test:integration`                    | Database and API suites against PostgreSQL and Redis                        |
| `pnpm typecheck` / `lint` / `format:check` | The workspace quality gates, as run in CI                                   |
| `pnpm build`                               | Typecheck, then production builds — mock platform excluded                  |

## Documentation

- [`docs/openapi.json`](docs/openapi.json) — generated OpenAPI document for `/api/v1`, produced from
  `packages/domain/src/contract.ts`.

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
