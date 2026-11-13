# Third-Party Notices

**Last reviewed:** 2026-11-13 · **Applies to:** the pnpm workspace at the pins recorded below · **Maintained by:** platform maintainers

## 1. Scope

This project — `apps/portal`, `apps/console`, `apps/api` and the `packages/*` libraries — is built on
open-source software written by other people. This document records what that software is, the
licence each component is made available under, and what each licence obliges this project to do. It
is an inventory, not legal advice, and it does not reproduce licence texts (§8 says where they are).

| Category                | Covered                                                                      | Source of truth                     |
| ----------------------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| Direct npm dependencies | 52 packages: 26 runtime (`dependencies`), 26 development (`devDependencies`) | `catalog:` in `pnpm-workspace.yaml` |
| Container images        | 15, all third-party and pinned to a full version                             | `docker/compose.dev.yml`            |
| Vendored webfonts       | 3 families, committed as `.woff2`                                            | `packages/ui/src/assets/fonts/`     |

**Not covered.** Three things are deliberately outside this document:

- **First-party code.** This project's own licence is declared in [`LICENSE`](LICENSE):
  **GNU General Public License v3.0**, SPDX `GPL-3.0-only`, also stated in every `package.json` and in
  the README's [License](README.md#license) section. The version is pinned — the GPL-3.0 §14 "or any
  later version" option is not granted (ADR-BE-19). Nothing here grants rights to first-party code or
  narrows the GPL's terms.
- **Transitive dependencies.** A transitive package is a dependency of a package already listed, and
  that package's licence and notices govern it. The tree also changes on almost every install, so a
  hand-maintained copy would be stale within a week. Two cases still need a reviewer:
  - first-party code importing a package it does not declare — that package must be added to a
    manifest and to §3 or §4, because it is no longer transitive;
  - a transitive package under a copyleft or source-available licence that reaches a distributed
    artefact — add an explicit row and a note saying why it is acceptable under §7.

  For an audit or a shipped `licenses.json`, generate the list rather than writing it:
  `pnpm licenses list --prod --json > third-party-licenses.json` (production tree only) or
  `pnpm licenses list --json` (everything installed).

- **Licence texts themselves.** §8 names the four places the canonical text lives.

**Reading the tables.** Component rows are alphabetical within each table, so a package can be found
without reading the whole inventory. **Version** is the exact pin, never a range — the same value a
`catalog:` lookup resolves, so a bump is one line there and one row here (§9.2). **Licence** is an
[SPDX identifier](https://spdx.org/licenses/); where a project offers a choice, the identifier used
in practice is listed. **Copyright** is abbreviated to the holder named in the package's own
`LICENSE` file, and long multi-party statements (RxJS, Lucide) are summarised — the full statement
always prevails. **Used for** states the role in _this_ project, which is what tells a maintainer
whether a removal is safe.

## 2. Components by licence

The inventory grouped by licence, so a licence question can be answered without reading six tables.
Names appear only where the licence carries an obligation beyond preserving a notice, or a review
step; MIT is a count because its obligation is uniform and its members are the bulk of §3 and §4.

| Licence                         | npm packages                                                                                                                                     | Images and fonts                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| MIT                             | 42 of the 52 packages in §3 and §4                                                                                                               | `axllent/mailpit`, `traefik`                 |
| Apache-2.0                      | `@aws-sdk/client-s3`, `class-variance-authority`, `dockerode`, `prom-client`, `reflect-metadata`, `rxjs`, `eslint-plugin-security`, `typescript` | 8 images (§5)                                |
| ISC                             | `lucide-react`, `yaml`                                                                                                                           | —                                            |
| AGPL-3.0                        | —                                                                                                                                                | `grafana/grafana`, `grafana/loki`            |
| SIL OFL-1.1                     | —                                                                                                                                                | the three font families in §6                |
| PostgreSQL Licence              | —                                                                                                                                                | `postgres`                                   |
| BSD-3-Clause / RSALv2 or SSPLv1 | —                                                                                                                                                | `redis` — depends on the resolved patch (§5) |
| Sustainable Use Licence         | —                                                                                                                                                | `n8nio/n8n`                                  |

## 3. Runtime dependencies

These packages are part of what actually runs: the control plane, the two single-page applications
and the shared libraries compiled into their bundles. Their licences must be honoured in any
deployment or redistribution of the platform.

### 3.1 Control plane and data layer

Declared by `apps/api`, `packages/db` and `packages/domain`.

| Component                  | Version  | Licence    | Copyright                                                   | Used for                                                                                                       | Source                                                                    |
| -------------------------- | -------- | ---------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `@aws-sdk/client-s3`       | 3.1168.0 | Apache-2.0 | Amazon.com, Inc. or its affiliates                          | Presigned URLs and object I/O for the off-host backup target (VersityGW in the dev stack)                      | [aws/aws-sdk-js-v3](https://github.com/aws/aws-sdk-js-v3)                 |
| `@nestjs/common`           | 12.5.0   | MIT        | Kamil Myśliwiec                                             | Modules, dependency-injection decorators, pipes and guards shared by the nine API process roles                | [nestjs/nest](https://github.com/nestjs/nest)                             |
| `@nestjs/core`             | 12.5.0   | MIT        | Kamil Myśliwiec                                             | Application container, lifecycle hooks and role bootstrap                                                      | [nestjs/nest](https://github.com/nestjs/nest)                             |
| `@nestjs/platform-fastify` | 12.5.0   | MIT        | Kamil Myśliwiec                                             | HTTP adapter that binds the 116-operation contract to Fastify                                                  | [nestjs/nest](https://github.com/nestjs/nest)                             |
| `bullmq`                   | 6.7.6    | MIT        | Taskforce.sh Inc.                                           | Deployment job queue: enqueue, retry, delayed work and progress over Redis                                     | [taskforcesh/bullmq](https://github.com/taskforcesh/bullmq)               |
| `dockerode`                | 5.0.1    | Apache-2.0 | dockerode contributors                                      | Docker Engine API client for product containers, images, networks and logs, reached through the socket proxy   | [apocas/dockerode](https://github.com/apocas/dockerode)                   |
| `fastify`                  | 5.12.8   | MIT        | Fastify team and contributors                               | HTTP server beneath NestJS: routing, schema validation, SSE for job progress                                   | [fastify/fastify](https://github.com/fastify/fastify)                     |
| `ioredis`                  | 6.0.0    | MIT        | Zihua Li and contributors                                   | Redis client: BullMQ backend, session store and rate-limit counters                                            | [redis/ioredis](https://github.com/redis/ioredis)                         |
| `pg`                       | 8.23.1   | MIT        | Brian Carlson                                               | PostgreSQL client and connection pooling for the schema-v1 data layer                                          | [brianc/node-postgres](https://github.com/brianc/node-postgres)           |
| `pino`                     | 10.4.0   | MIT        | Matteo Collina and contributors                             | Structured JSON logging with request correlation                                                               | [pinojs/pino](https://github.com/pinojs/pino)                             |
| `prom-client`              | 15.1.3   | Apache-2.0 | Simon Nyberg                                                | Prometheus metrics exposed on the `/metrics` endpoint                                                          | [siimon/prom-client](https://github.com/siimon/prom-client)               |
| `reflect-metadata`         | 0.2.2    | Apache-2.0 | Ron Buckton                                                 | Decorator metadata required by the NestJS DI container                                                         | [rbuckton/reflect-metadata](https://github.com/rbuckton/reflect-metadata) |
| `rxjs`                     | 7.8.2    | Apache-2.0 | Google LLC, Netflix, Inc., Microsoft Corp. and contributors | Observables used by NestJS internals and stream handling                                                       | [ReactiveX/rxjs](https://github.com/ReactiveX/rxjs)                       |
| `tsx`                      | 4.23.15  | MIT        | Hiroki Osame                                                | Executes TypeScript sources directly in the container and under `pnpm dev`, so there is no separate build step | [privatenumber/tsx](https://github.com/privatenumber/tsx)                 |
| `yaml`                     | 2.9.1    | ISC        | Eemeli Aro                                                  | Parses and writes catalog entries and per-instance manifests                                                   | [eemeli/yaml](https://github.com/eemeli/yaml)                             |
| `zod`                      | 4.6.7    | MIT        | Colin McDonnell                                             | Runtime validation of environment variables, request payloads and domain contracts                             | [colinhacks/zod](https://github.com/colinhacks/zod)                       |

### 3.2 Web clients and shared packages

Declared by `apps/portal`, `apps/console`, `packages/ui`, `packages/shell`, `packages/api-client`,
`packages/utils` and `packages/mocks`.

| Component                  | Version | Licence    | Copyright                                                                 | Used for                                                                                          | Source                                                              |
| -------------------------- | ------- | ---------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@tanstack/react-query`    | 5.107.1 | MIT        | Tanner Linsley                                                            | Server-state cache, mutations and polling behind the hooks in `packages/api-client`               | [TanStack/query](https://github.com/TanStack/query)                 |
| `class-variance-authority` | 0.7.1   | Apache-2.0 | Joe Bell                                                                  | Typed variant definitions for the UI primitives (button, badge, field)                            | [joe-bell/cva](https://github.com/joe-bell/cva)                     |
| `clsx`                     | 2.1.1   | MIT        | Luke Edwards                                                              | Conditional class-name composition in `cn()` and the primitives                                   | [lukeed/clsx](https://github.com/lukeed/clsx)                       |
| `lucide-react`             | 1.72.0  | ISC        | Lucide contributors; portions held by Cole Bemis as part of Feather (MIT) | The icon set used across `packages/ui`, `packages/shell` and both applications                    | [lucide-icons/lucide](https://github.com/lucide-icons/lucide)       |
| `msw`                      | 3.0.5   | MIT        | Artem Zakharchenko                                                        | Mock API worker for `VITE_API_MODE=mock` and the demo builds; the test server in `@seamnex/mocks` | [mswjs/msw](https://github.com/mswjs/msw)                           |
| `radix-ui`                 | 1.8.1   | MIT        | Radix UI contributors                                                     | Accessible primitives (dialog, tabs, tooltip, select, switch) layered under the design system     | [radix-ui/primitives](https://github.com/radix-ui/primitives)       |
| `react`                    | 19.3.1  | MIT        | Meta Platforms, Inc. and affiliates                                       | UI runtime for the portal and the console                                                         | [facebook/react](https://github.com/facebook/react)                 |
| `react-dom`                | 19.3.1  | MIT        | Meta Platforms, Inc. and affiliates                                       | DOM renderer for both single-page applications                                                    | [facebook/react](https://github.com/facebook/react)                 |
| `react-router`             | 8.5.1   | MIT        | Remix Software Inc.                                                       | Routing, data loading and navigation guards in both applications                                  | [remix-run/react-router](https://github.com/remix-run/react-router) |
| `tailwind-merge`           | 3.7.0   | MIT        | Dany Castillo                                                             | Resolves conflicting Tailwind utilities in composed class strings                                 | [dcastil/tailwind-merge](https://github.com/dcastil/tailwind-merge) |

> `msw` is a runtime dependency of `@seamnex/mocks` because the mock API is a real code path in
> mock-mode builds. It is never imported by the control plane, and the production API image does not
> contain it.

## 4. Development dependencies

Used to build, check and test the workspace. They are not part of any deployed artefact, so their
licences do not attach to the platform's runtime behaviour; they are recorded so a contributor knows
in one place what the toolchain is built from and under what terms.

### 4.1 Build and bundling

| Component              | Version | Licence    | Copyright                           | Used for                                                                      | Source                                                                  |
| ---------------------- | ------- | ---------- | ----------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `@tailwindcss/vite`    | 4.3.5   | MIT        | Tailwind Labs, Inc.                 | Tailwind v4 compiler wired into the Vite pipeline                             | [tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) |
| `@vitejs/plugin-react` | 6.3.0   | MIT        | VoidZero Inc. and Vite contributors | JSX transform and Fast Refresh for both applications                          | [vitejs/vite-plugin-react](https://github.com/vitejs/vite-plugin-react) |
| `tailwindcss`          | 4.3.5   | MIT        | Tailwind Labs, Inc.                 | Utility CSS engine and the design tokens in `packages/ui/src/styles`          | [tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) |
| `turbo`                | 2.11.11 | MIT        | Vercel, Inc.                        | Task graph and remote-cache-friendly orchestration for the monorepo           | [vercel/turborepo](https://github.com/vercel/turborepo)                 |
| `typescript`           | 6.0.3   | Apache-2.0 | Microsoft Corporation               | Type checking in strict mode, and declaration output for the shared libraries | [microsoft/TypeScript](https://github.com/microsoft/TypeScript)         |
| `vite`                 | 8.3.8   | MIT        | VoidZero Inc. and Vite contributors | Dev server, HMR and production bundler for the portal and console             | [vitejs/vite](https://github.com/vitejs/vite)                           |

### 4.2 Linting and formatting

| Component                   | Version | Licence    | Copyright                                | Used for                                                                       | Source                                                                                                |
| --------------------------- | ------- | ---------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `@eslint/js`                | 10.0.1  | MIT        | OpenJS Foundation and other contributors | ESLint's own recommended rule set, the base of `@seamnex/config`'s flat config | [eslint/eslint](https://github.com/eslint/eslint)                                                     |
| `eslint`                    | 10.14.0 | MIT        | OpenJS Foundation and other contributors | Linting across every workspace, with `--max-warnings=0`                        | [eslint/eslint](https://github.com/eslint/eslint)                                                     |
| `eslint-plugin-jsx-a11y`    | 6.10.2  | MIT        | Ethan Cohen                              | Accessibility rules for the React surfaces                                     | [jsx-eslint/eslint-plugin-jsx-a11y](https://github.com/jsx-eslint/eslint-plugin-jsx-a11y)             |
| `eslint-plugin-n`           | 18.5.0  | MIT        | eslint-plugin-n contributors             | Node.js correctness rules for the API and the `scripts/*.mjs` tooling          | [eslint-community/eslint-plugin-n](https://github.com/eslint-community/eslint-plugin-n)               |
| `eslint-plugin-react-hooks` | 7.1.1   | MIT        | Meta Platforms, Inc. and affiliates      | Rules-of-Hooks enforcement in the UI packages                                  | [facebook/react](https://github.com/facebook/react)                                                   |
| `eslint-plugin-security`    | 4.2.1   | Apache-2.0 | Node Security Project contributors       | Static checks for injection, ReDoS and unsafe evaluation                       | [eslint-community/eslint-plugin-security](https://github.com/eslint-community/eslint-plugin-security) |
| `globals`                   | 17.14.0 | MIT        | Sindre Sorhus                            | Environment global definitions (`node`, `browser`) for the ESLint configs      | [sindresorhus/globals](https://github.com/sindresorhus/globals)                                       |
| `prettier`                  | 3.10.1  | MIT        | James Long and contributors              | Formatting, enforced by `pnpm format:check`                                    | [prettier/prettier](https://github.com/prettier/prettier)                                             |
| `stylelint`                 | 18.0.0  | MIT        | stylelint contributors                   | CSS linting for the UI layer                                                   | [stylelint/stylelint](https://github.com/stylelint/stylelint)                                         |
| `stylelint-config-standard` | 41.0.0  | MIT        | stylelint contributors                   | Baseline CSS rules shared through `@seamnex/config`                            | [stylelint/stylelint-config-standard](https://github.com/stylelint/stylelint-config-standard)         |
| `typescript-eslint`         | 8.72.2  | MIT        | typescript-eslint contributors           | TypeScript parser and type-aware rules for ESLint                              | [typescript-eslint/typescript-eslint](https://github.com/typescript-eslint/typescript-eslint)         |

### 4.3 Testing

| Component                | Version | Licence | Copyright                             | Used for                                                                        | Source                                                                                            |
| ------------------------ | ------- | ------- | ------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@testing-library/react` | 16.3.3  | MIT     | Kent C. Dodds and contributors        | Component tests for `packages/ui`, `packages/shell`, the portal and the console | [testing-library/react-testing-library](https://github.com/testing-library/react-testing-library) |
| `@vitest/coverage-v8`    | 5.1.0   | MIT     | VoidZero Inc. and Vitest contributors | V8 coverage provider behind `pnpm test:coverage`                                | [vitest-dev/vitest](https://github.com/vitest-dev/vitest)                                         |
| `jsdom`                  | 31.0.1  | MIT     | jsdom contributors                    | DOM environment for the component and integration tests                         | [jsdom/jsdom](https://github.com/jsdom/jsdom)                                                     |
| `vitest`                 | 5.1.0   | MIT     | VoidZero Inc. and Vitest contributors | Unit, integration and workspace test runner, configured in `vitest.config.ts`   | [vitest-dev/vitest](https://github.com/vitest-dev/vitest)                                         |

### 4.4 Type definitions

| Component          | Version | Licence | Copyright                    | Used for                             | Source                                                                |
| ------------------ | ------- | ------- | ---------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `@types/dockerode` | 4.0.2   | MIT     | DefinitelyTyped contributors | Types for the Docker Engine client   | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/node`      | 24.19.2 | MIT     | DefinitelyTyped contributors | Node.js 24 runtime types             | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/pg`        | 8.23.1  | MIT     | DefinitelyTyped contributors | Types for the PostgreSQL client      | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/react`     | 19.3.0  | MIT     | DefinitelyTyped contributors | React 19 types for the UI packages   | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| `@types/react-dom` | 19.3.0  | MIT     | DefinitelyTyped contributors | React DOM types for the applications | [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) |

## 5. Container images

Every image below is referenced by `docker/compose.dev.yml` and pinned to a full version, never to a
bare major or `latest` — a floating tag makes "it worked yesterday" unreproducible. `pnpm
check:images` resolves each reference against its registry before a pin change is merged, so a
version here is verifiable rather than asserted.

| Image                           | Version      | Licence                                                     | Maintainer                          | Role in this project                                                                                                                                  | Source                                                                            |
| ------------------------------- | ------------ | ----------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `adorsys/keycloak-config-cli`   | 6.4.0-26.0.5 | Apache-2.0                                                  | adorsys                             | Applies `platform/realm/*.json` so the realm is reviewed code rather than a console click. Its suffix must match the Keycloak server version exactly. | [adorsys/keycloak-config-cli](https://github.com/adorsys/keycloak-config-cli)     |
| `axllent/mailpit`               | v1.32.0      | MIT                                                         | Ralph Slooten (axllent)             | Mail catcher for outbound-email flows during development                                                                                              | [axllent/mailpit](https://github.com/axllent/mailpit)                             |
| `grafana/alloy`                 | v1.6.1       | Apache-2.0                                                  | Grafana Labs                        | Log and metric collector feeding Loki (observability profile)                                                                                         | [grafana/alloy](https://github.com/grafana/alloy)                                 |
| `grafana/grafana`               | 11.5.1       | AGPL-3.0                                                    | Grafana Labs                        | Dashboards over Prometheus and Loki (observability profile)                                                                                           | [grafana/grafana](https://github.com/grafana/grafana)                             |
| `grafana/loki`                  | 3.4.2        | AGPL-3.0                                                    | Grafana Labs                        | Log aggregation store (observability profile)                                                                                                         | [grafana/loki](https://github.com/grafana/loki)                                   |
| `n8nio/n8n`                     | 1.123.87     | Sustainable Use Licence                                     | n8n GmbH                            | Workflow runtime; runs in queue mode with two workers                                                                                                 | [n8n-io/n8n](https://github.com/n8n-io/n8n)                                       |
| `postgres`                      | 18-alpine    | PostgreSQL Licence                                          | PostgreSQL Global Development Group | Primary datastore: platform, Keycloak and n8n databases in one cluster with separate roles                                                            | [docker-library/postgres](https://github.com/docker-library/postgres)             |
| `prom/alertmanager`             | v0.28.0      | Apache-2.0                                                  | Prometheus authors                  | Routes alerts raised by `docker/observability/alerts.yml`                                                                                             | [prometheus/alertmanager](https://github.com/prometheus/alertmanager)             |
| `prom/node-exporter`            | v1.8.2       | Apache-2.0                                                  | Prometheus authors                  | Host CPU, memory and disk metrics for the admission verdict                                                                                           | [prometheus/node_exporter](https://github.com/prometheus/node_exporter)           |
| `prom/prometheus`               | v3.1.0       | Apache-2.0                                                  | Prometheus authors                  | Metric store scraped from the API's `/metrics`                                                                                                        | [prometheus/prometheus](https://github.com/prometheus/prometheus)                 |
| `quay.io/keycloak/keycloak`     | 26.0.5       | Apache-2.0                                                  | Red Hat                             | Identity provider: OIDC issuer, realm `seamnex`, group-to-entitlement source                                                                          | [keycloak/keycloak](https://github.com/keycloak/keycloak)                         |
| `redis`                         | 7-alpine     | BSD-3-Clause for 7.2 and earlier; RSALv2 or SSPLv1 from 7.4 | Redis Ltd.                          | BullMQ broker, session store and rate-limit counters                                                                                                  | [redis/redis](https://github.com/redis/redis)                                     |
| `tecnativa/docker-socket-proxy` | 0.3.0        | Apache-2.0                                                  | Tecnativa                           | The only container that sees the Docker socket; exposes an allow-listed Engine API to the control plane                                               | [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) |
| `traefik`                       | v3.3         | MIT                                                         | Traefik Labs                        | Edge router: one entry point, per-product routers, forward-auth middleware                                                                            | [traefik/traefik](https://github.com/traefik/traefik)                             |
| `versity/versitygw`             | v1.10.0      | Apache-2.0                                                  | Versity                             | S3-compatible target for backups in the dev stack (replaced MinIO, see ADR-BE-11)                                                                     | [versity/versitygw](https://github.com/versity/versitygw)                         |

**Notes for reviewers**

- `redis:7-alpine` is the one pin whose licence depends on the resolved patch version: Redis moved
  from BSD-3-Clause to a source-available licence at 7.4, and the floating `7` tag can cross that
  boundary on a rebuild. Treat a Redis bump as a licence review, not a routine tag change, and record
  the resolved patch version here when the pin is tightened.
- `n8nio/n8n` is not OSI-approved. It runs as a separate service the platform calls over HTTP and is
  never linked into first-party code, which is what keeps it acceptable under §7.
- `grafana/grafana`, `grafana/loki` and `n8nio/n8n` are optional: Grafana and Loki sit behind the
  `observability` profile, and n8n is only required by workflow features.
- `apps/api/Dockerfile` builds `FROM node:24-alpine` — Node.js (MIT, plus the licences of its bundled
  dependencies) on Alpine Linux (mixed, predominantly MIT and BSD-2-Clause).

## 6. Vendored webfonts

The typography is self-hosted so the interface does not contact a third-party font service and
survives a venue with no internet access — a deliberate decision recorded in the README. The subsets
live in `packages/ui/src/assets/fonts/`.

| Font                  | Files                                       | Licence                   | Copyright                                         | Used for                                  |
| --------------------- | ------------------------------------------- | ------------------------- | ------------------------------------------------- | ----------------------------------------- |
| Barlow Semi Condensed | `barlow-semi-condensed-{500,600,700}.woff2` | SIL Open Font Licence 1.1 | Copyright 2017 The Barlow Project Authors         | Headings (industrial grotesque)           |
| JetBrains Mono        | `jetbrains-mono-{400,500}.woff2`            | SIL Open Font Licence 1.1 | Copyright 2020 The JetBrains Mono Project Authors | Identifiers, digests and tabular numerals |
| Source Sans 3         | `source-sans-3-{400,500,600}.woff2`         | SIL Open Font Licence 1.1 | Copyright 2010-2024 Adobe                         | Prose and interface text                  |

- Upstream: [jpt/barlow](https://github.com/jpt/barlow) ·
  [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) ·
  [adobe-fonts/source-sans](https://github.com/adobe-fonts/source-sans). The OFL text itself is at
  [openfontlicense.org](https://openfontlicense.org/).
- **Outstanding action:** OFL-1.1 requires the copyright notice and licence to accompany the font
  files, and `packages/ui/src/assets/fonts/` currently holds the `.woff2` files only. When the
  subsets are next regenerated, add an `OFL.txt` per family and record the upstream release version
  in the table above.

## 7. Licence policy and obligations

The inventory above is only maintainable if one rule says what may be added and what the presence of
each licence obliges this project to do. This is that table; it is the criterion a reviewer applies
to a new dependency before it is merged, and the source of the obligations the release and image
artefacts must satisfy.

| Licence family                                      | Status for a new dependency           | Obligation carried here                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD          | **Allowed**                           | Preserve the copyright notice and permission text with any copy of the code.                                                                             |
| Apache-2.0                                          | **Allowed**                           | As above, plus preserve a `NOTICE` file where the package ships one and state any modification of the files.                                             |
| PostgreSQL Licence, SIL OFL-1.1                     | **Allowed**                           | OFL additionally requires the copyright notice and licence to travel with the font files (§6).                                                           |
| MPL-2.0                                             | **Allowed with a check**              | File-level copyleft: a modified MPL file must be published under the MPL.                                                                                |
| LGPL-2.1, LGPL-3.0                                  | **Review required**                   | Permitted only as an unmodified dynamic dependency; no static linking into a distributed artefact.                                                       |
| GPL-2.0, GPL-3.0                                    | **Not permitted in first-party code** | Acceptable only for a separately deployed product that communicates over a network boundary.                                                             |
| AGPL-3.0                                            | **Review required**                   | Only as an independent service (Grafana, Loki), never linked into the platform; network users of a modified copy must be offered its source.             |
| SSPL-1.0, RSALv2, BUSL-1.1, Sustainable Use Licence | **Review required; never bundled**    | Source-available, not open source. Permitted only as an unmodified service the platform calls over HTTP — which is how n8n and Redis 7.4+ would be used. |
| No licence / unknown / `UNLICENSED`                 | **Not permitted**                     | A package without a licence grants no rights, regardless of whether it is published.                                                                     |

An exception the table does not cover is a decision worth recording: open an ADR before the
dependency lands and reference it from the row's note.

Two inbound cases follow from the project's own pin at `GPL-3.0-only` (ADR-BE-19):

- **A `GPL-3.0-or-later` dependency may be combined with it.** The recipient takes the v3 option the
  upstream package offers, and the combined work is still conveyed as v3-only, so the pin is not
  weakened by such a dependency.
- **A `GPL-2.0-only` dependency may never be combined with it.** GPLv2 and GPLv3 are mutually
  incompatible, so such a library can reach this platform only across a network boundary as a
  separately deployed product — which is what the table already requires for GPL-2.0.

## 8. Where the licence texts are

This document names licences; it does not reproduce them. The canonical text for a component is at
one of these, in descending order of authority for this repository:

1. **Installed packages** — `node_modules/<package>/LICENSE` (or `LICENSE.md`, `COPYING`),
   reproduced verbatim by the author. This is what applies to the code actually executing.
2. **The upstream repository** — the link in each row's **Source** column. This is what applies to a
   version not yet installed.
3. **SPDX** — [spdx.org/licenses](https://spdx.org/licenses/) for the standard text of an identifier
   used in the tables, when a package ships no file of its own.
4. **Container images** — inside the image at `/licenses` or alongside the project's own repository;
   the upstream link in §5 is the entry point.

To read a licence without leaving the terminal:

```bash
pnpm licenses list --prod                 # resolved licence per production package
cat node_modules/<package>/LICENSE        # the authoritative text
```

## 9. Maintaining this document

This file goes stale in one direction only: someone adds a dependency and forgets it. The three
sections below keep that from happening without turning it into a chore.

### 9.1 Adding a dependency

Follow these in order; the pull request is not ready until all of them are done.

1. **Check the licence before installing.** Read the `license` field in the registry metadata, then
   open the actual `LICENSE` file — a field can disagree with the text. Compare against §7.
2. **Add it through the catalogue**, so the pin lands in one place:
   ```bash
   pnpm --filter @seamnex/api add <package>          # exact pin, written to pnpm-workspace.yaml
   pnpm --filter @seamnex/portal add -D <package>    # development dependency
   ```
3. **Confirm what was resolved**, rather than what was requested: `pnpm licenses list --prod | grep
<package>`, then read `node_modules/<package>/LICENSE`.
4. **Add a row** to the correct table — §3.1 or §3.2 for anything that ships, §4.1–4.4 for tooling,
   §5 for an image, §6 for an asset — in alphabetical order, with the row template below, and add the
   name to its licence row in §2. Fill the **Used for** column with the role in _this_ project, not
   the package's tagline.
5. **Record the change** in §10 with the date and one line of context, then run the checks:
   `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.

```markdown
| `package-name` | 1.2.3 | MIT | Holder named in LICENSE | One clause on its role in this project | [owner/repo](https://github.com/owner/repo) |
```

### 9.2 Bumping or removing a dependency

- **A version bump** changes the **Version** cell only. Edit the pin in `pnpm-workspace.yaml`, never
  in a `package.json`, and update the row in the same commit. A release younger than
  `minimumReleaseAge` still installs, with a warning, and `pnpm` records it in
  `minimumReleaseAgeExclude`.
- **A licence change** upstream — a project moving to a source-available licence, as Redis did — is a
  review event even when the version is unchanged. Update the row, and raise it before merging if the
  new licence is not in §7.
- **A removal** deletes the row and the name from §2. If the package was the last user of a table,
  remove the heading with it.
- **A new container image** needs the licence of the image _and_ of its base image, plus a
  `pnpm check:images` run to prove the tag resolves.

### 9.3 Review gate

A pull request that touches any of the following **must** touch this document in the same commit:

- a `package.json` (adding, removing or moving a dependency between `dependencies` and
  `devDependencies`)
- the `catalog:` block of `pnpm-workspace.yaml`
- `docker/compose.dev.yml` or a `Dockerfile`
- `packages/ui/src/assets/fonts/`

A reviewer should treat "manifest changed, notices unchanged" as a blocking comment. That single rule
is what keeps this file honest.

## 10. Review record

| Date       | Change                                                                                                                                                                                                                                                                                      | Reviewer             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 2026-11-06 | Initial inventory: 52 direct npm packages (26 runtime, 26 development), 15 container images, 3 vendored font families, 7 deployed product definitions.                                                                                                                                      | Platform maintainers |
| 2026-11-13 | Major bumps: `dockerode` 4.0.7 → 5.0.1 (Apache-2.0; drops its `uuid` dependent, so the advisory override is gone), `@types/dockerode` 3.3.31 → 4.0.2, `jsdom` 30.1.3 → 31.0.0. Licences unchanged.                                                                                          | Platform maintainers |
| 2026-11-13 | Consolidated the inventory: one licence summary (§2), one policy-and-obligations table (§7), transitive and text-location policy folded into §1 and §8. Versions reconciled with the `catalog:` block, `jsdom` 31.0.0 → 31.0.1, product rows keyed by their `platform/upstream/` directory. | Platform maintainers |
| 2026-11-13 | Removed the deployed product definitions section: the inventory now covers npm packages, container images and vendored fonts only. Sections after it renumbered, and `platform/upstream/` dropped from the review gate.                                                                     | Platform maintainers |

Add a row whenever the inventory changes materially. One line is enough; the tables carry the detail.

---

_This document is an inventory maintained by the project's contributors. It is not legal advice. If
you are redistributing this software — as source, as a container image, or as a hosted service —
verify the obligations of each licence against your own distribution model._
