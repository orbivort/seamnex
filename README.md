# Seamnex

[![CI](https://github.com/orbivort/seamnex/actions/workflows/ci.yml/badge.svg)](https://github.com/orbivort/seamnex/actions/workflows/ci.yml)
[![License: GPL-3.0-only](https://img.shields.io/badge/License-GPL--3.0--only-blue.svg)](LICENSE)

**One front door to the business apps you run yourself.**

Seamnex is a self-hosted platform for the open-source business software a small company runs. It
gives you one sign-in, one portal, one operator console and an audit trail for every change — on
hardware you control, with no SaaS dependency.

It is not a Docker dashboard. It installs and manages the apps, and it sets up automated workflows
between them — so data moves without custom code.

## Who it is for

- **Small companies** (up to 250 staff) that would rather run their own tools than rent them.
- **The part-time IT operator** — one person, no platform team — who deploys, upgrades, backs up and
  audits them.
- **Staff and department leads** who want one link, one password and a clear view of who can see
  what.

## Why it matters

| Without a platform                | With Seamnex                         |
| --------------------------------- | ------------------------------------ |
| One login per app                 | One sign-in, one portal              |
| Each app fitted and wired by hand | Deploy from a tagged catalogue       |
| Access decided inside each app    | Roles set once, enforced at the edge |
| No record of who changed what     | A log of every change                |
| Rebuilds done from memory         | Backups and restores you can verify  |
| Data on someone else's servers    | Your hardware, your data             |

## What runs on it

Seamnex ships no apps of its own. The catalogue is not in this repository. It lives in
[`orbivort/seamnex-catalog`](https://github.com/orbivort/seamnex-catalog) and arrives as a tag.

| App         | Used for            | Sign-in     |
| ----------- | ------------------- | ----------- |
| EspoCRM     | CRM and sales       | Seamnex SSO |
| Mautic      | Marketing and leads | Own login   |
| ERPNext     | ERP and operations  | Seamnex SSO |
| OrangeHRM   | HR and people       | Own login   |
| OpenProject | Projects and work   | Own login   |
| Metabase    | Reporting and data  | Own login   |

An app with its own login is guarded by the platform edge, but never sold as single sign-on.

## Quick start

Needs Node.js 24, pnpm 11.21 through Corepack, and Docker with Compose v2.

```bash
corepack enable pnpm
pnpm install
pnpm mocks:init   # writes a worker that is not committed
```

Then fetch the catalogue — the platform ships none:

```bash
SEAMNEX_API_TOKEN=<R1 token> pnpm catalog:sync --ref catalog-2026.11.2
```

No token, or no network? Use Catalog → "Sync from source" in the console, or place a checkout at
`temp/catalog-repo` and run `pnpm db:seed` then `pnpm catalog:project`. That path is named by
`SEAMNEX_CATALOG_REPO_PATH` and must be writable, because the platform also writes `instances/`
there.

Then pick a mode:

| Command          | What runs                                       | Docker |
| ---------------- | ----------------------------------------------- | ------ |
| `pnpm dev:web`   | Portal and console against a mock API           | No     |
| `pnpm dev`       | Datastores, migrations, API, portal and console | Yes    |
| `pnpm dev:stack` | The whole platform in Compose                   | Yes    |

`pnpm dev` and `pnpm dev:stack` both use port 8080, so pick one; add `--profile observability` to
the stack for metrics and logs. Settings live in the root `.env`, written from `.env.example` on
first run; that file documents every key.

For a host real people will use, there is one documented install:

```bash
pnpm bootstrap
```

It is safe to run twice, and it does not fetch the catalogue.

## Documentation

- [`docs/operations/bootstrap.md`](docs/operations/bootstrap.md) — host install, and what it does
  not do.
- [`docs/operations/catalog-repo-format.md`](docs/operations/catalog-repo-format.md) — catalogue
  layout and rules.
- [`docs/operations/certificates.md`](docs/operations/certificates.md) — the dev CA and the edge's
  certificate modes.
- [`docs/openapi.json`](docs/openapi.json) — the `/api/v1` OpenAPI document.

## Contributing

Bug reports, specifications and review comments are welcome; external code contributions are not
accepted yet. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the workflow and quality gates,
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) the community standard. Report security issues privately
per [`SECURITY.md`](SECURITY.md) — never in a public issue.

## License

Copyright (C) 2026 Orbivort.

Seamnex is licensed under the **GNU General Public License, version 3** (`GPL-3.0-only`); the full
text is in [`LICENSE`](LICENSE). The version is pinned — the "or any later version" option of GPL-3.0
§14 is not granted. Third-party notices are in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
