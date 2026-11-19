# Changelog

All notable changes to **Seamnex** — a self-hosted, open-source platform that gives a small business one
identity, one portal and one operator console for the products it runs — are recorded here.

Format: [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) · Versioning:
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) · Licence: [GPL-3.0-only](LICENSE). The
version is the git tag (`vX.Y.Z`). The entries under `## [Unreleased]` become the next released section
in the `release-prepare` pull request, which leaves a fresh empty `## [Unreleased]` above it and moves
the same number through every manifest and the link definitions at the foot of this file. Each entry
states one reader-visible outcome in at most four lines, names the requirement ids and ADR it
implements, and puts what an operator must do under `### Upgrade notes`.

[Repository](https://github.com/orbivort/seamnex) · [Issues](https://github.com/orbivort/seamnex/issues) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## [Unreleased]

### Upgrade notes

Action required when upgrading an existing install; everything else is additive.

- Every catalogue entry: record the digest of the artefact actually published, in the same commit as
  the tag. A pin that no longer matches its registry now blocks the deployment instead of being
  ignored, as does a host holding a locally built image with no repository digest.
- Existing `.env`: point the product URL at the TLS edge and set `SEAMNEX_EDGE_TLS_MODE`. `pnpm dev`
  refuses to start until they match, and the API refuses under `NODE_ENV=production`.
- Development hosts: the zone is now `seamnex.localhost`, so the hosts stored on `instance_route`
  must move with it; trust `temp/certs/dev-ca.crt` once, and run `pnpm dev:dns --apply` where Node,
  `curl` or Playwright must resolve the zone (`--revert` undoes the rule).
- A platform restore without `SEAMNEX_PLATFORM_RESTORE_DB_URL` records `pnpm restore:platform-db` as
  an outstanding operator step, and the run cannot end `complete`.
- Audit retention now has a 365-day floor: a shorter stored `audit_retention_days` is read as the
  floor.

### Added

- **A deployment builds its own image, and starts only the digest the catalogue pinned** (`FR-1.5`,
  `FR-1.7`, `NFR-4.16`, `ADR-BE-40`) — `deploy`, `reconfigure` and `upgrade` gain a `build` stage
  between admission and `apply`, now the only place an image comes into existence: any `dockerfile`,
  `scaffold` or Compose `build:` source is built once, on every host that may run the container,
  through BuildKit rather than the socket proxy, which refuses a build session. `apply` verifies the
  ids the build produced before and after `up` and refuses a tag that is not this run's output with
  `IMAGE_DIGEST_MISMATCH`, before a container exists. The registry pin is compared with the
  repository digest and the local pin with the image id, and an absent build is a failure rather
  than a pass. The recorded digest is a trust-on-first-use baseline reported as drift — a rebuild
  legitimately changes it, a substituted tag does not — and an appliance export carries the image.
- **A registry is trusted because a revision says so, and every image is scanned before it starts**
  (`NFR-4.16`, `NFR-4.6`, `S-10`, `ADR-BE-36`) — one parser for an image reference and one
  append-only `trusted_registry_revision` allow-list, enforced in the catalogue, the policy
  evaluators, pre-flight and the engine client, so a queued job cannot bypass it; the rule is
  non-waivable, because the only remedy is a new revision. Before containers start the image is
  scanned, the report is kept per digest and reused while the digest is unchanged, a critical
  finding blocks the deployment unless `SEAMNEX_SCAN_FAIL_OPEN=true`, and the instance screen gains
  an Image security tab whose "never scanned" is a state, not a pass.
- **The catalogue can be restored, and can prove its own coverage** (`FR-1.1`, `FR-2.6`, `FR-2.16`,
  `S-2`, `ADR-BE-37`) — `pnpm catalog:restore` puts the six default entry documents back, and only
  when the projection holds exactly those keys; anything else is refused with the keys that do not
  line up. Mautic, ERPNext and Metabase now have entry documents, a declared deployment without one
  is refused instead of noted, and `computeCatalogCoverage()` counts deployments, so the console,
  the API and `pnpm check:catalog --require-floor` cannot disagree about "6 of 12". Lowering the
  floor is a recorded decision taken by R1.
- **The edge, the dev servers and the portal link are HTTPS on one certificate and one zone**
  (`NFR-4.1`, `FR-2.5`, `AC-42`, `ISSUE-07`, `ADR-BE-39`) — `websecure` on `:443` with a permanent
  redirect on `:80` that carries only the ACME challenge, a resolver persisting to
  `/acme/acme.json`, and a TLS-only dev stack. `SEAMNEX_EDGE_TLS_MODE` is written onto every route
  and into each generated router instead of a constant, and `SEAMNEX_TRAEFIK_ACME_EMAIL` is consumed
  rather than dead configuration. The Vite servers mint a development CA and leaf into `temp/certs`
  (trusted once) and advertise `https://`; the zone is `seamnex.localhost`, so one wildcard
  certificate covers every product, and `docker/dns` with `pnpm dev:dns` resolves it for Node,
  `curl` and Playwright. `pnpm dev` refuses a `.env` that still points at `http` + `8020`, and the
  API refuses the same mismatch in production.
- **A host install is one idempotent command, with a runbook that can be measured** (`NFR-6.2`,
  `NFR-6.3`, `S-9`, `AC-19`, `ADR-BE-35`) — `pnpm bootstrap` installs, creates what is missing,
  brings the stack up, seeds the identity mirror and the catalogue, and verifies `/api/v1/readyz`;
  `pnpm bootstrap:check` repeats the checks without changing anything. It never rotates a
  credential, overwrites `.env` or deletes a volume, so a failed step is repaired by re-running it,
  and its posture pass names what a working install can still be wrong about.
  `docs/dev-reference/operations/bootstrap.md` is the procedure, with a timing budget inside AC-19's
  sixty minutes.
- **Every instance is observed, and capacity reports what is consumed** (`FR-4.5`, `FR-4.6`,
  `AC-39`, `AC-45`, `ADR-BE-31`) — each entry's dashboards and alert rules are derived and
  persisted, and one Prometheus target is published per instance and withdrawn with it; metrics and
  masked logs are served per instance, and logging that is not configured says so instead of showing
  an empty console. The status sampler reads real container and volume usage, so `GET /capacity`
  reports consumed beside allocated at the thresholds R1 edits in settings (75/90/85 by default),
  and the same read raises a warning at the threshold and a critical ten points past it. A daemon
  failure is reported as unmeasured, never as idle.
- **The patch register advances by observation, not by editing an entry document** (`FR-2.12`,
  `NFR-4.7`, `ADR-BE-38`) — a scheduler pass reads each entry's releases and advisories, writes the
  versions, the release link and the lead advisory per instance, derives the age of the oldest
  unapplied security update and audits as `system`; a failed feed keeps the previous observation, so
  an outage never reads as "nothing pending". `POST /patch-register/observe` runs it on demand, and
  `catalog_entry` is never rewritten.
- **Governance records name the person responsible** (`FR-4.11`, `AC-47`, `ADR-BE-25`) — the auditor
  records licence obligations and restriction flags through `PUT /licenses/:instanceId/review`, with
  the reviewer, date and evidence shown on every cleared row, and a break-glass notice names the
  domain owner and the product and records who it was addressed to, so "the owner was told" is
  answerable from the row.
- **A mapping's conversion and missing-value policy are compiled, not just stored** (`FR-5.5`,
  `FR-5.6`, `ADR-BE-29`) — seventeen conversions are compiled into the body expression, with `fail`
  throwing, `skip` omitting the parameter and `default` substituting a value typed as the
  conversion's output, while a mapping that declares nothing still compiles byte-identically.
  Activation refuses an unknown conversion, a missing or invalid default, and a required field
  nothing maps.
- **A workflow retries, alerts, rotates its credentials and keeps a finite history** (`FR-5.7`,
  `FR-5.8`, `NFR-4.14`, `AC-27`, `ADR-BE-30`) — compiled nodes carry their retry settings, the run
  history reports the attempts n8n actually made, and after a threshold of consecutive failures the
  owner is alerted once per milestone with the failing step, recorded even when no channel could be
  reached. History is retained for 90 days and a failed run for twice that; a credential expiring
  inside the rotation window is replaced and the old scope revoked only after the new one is
  committed, and an already-expired token heals on the next pass. Every secret the platform mints
  now comes from the CSPRNG.
- **Pre-flight refuses with the blocker, before anything starts** (`FR-1.11`, `FR-1.23`, `AC-07`) —
  `POST /instances/preview` returns the checks that previously ran only inside a job — entry,
  source, image pin, field violations, secrets, capacity, route — and `admissible` is false while
  any blocks. The policy verdict is read from the recorded resolution and reported with its evidence
  instead of being hard-coded `allowed`, so an unevaluated deployment is no longer reported as a
  permitted one. The wizard shows each blocker on the step that can fix it.
- **Environment profiles are staff-owned, and the environment they declare is reconciled**
  (`FR-1.26`, `FR-1.29`, `AC-43`, `AC-51`, `ADR-BE-28`) — profiles are edited through the API behind
  a new capability, validated against what the catalogue declares, audited by variable name and
  never by value, and refused when a live instance depends on the one being deleted. Drift is now
  observed: every container's environment is compared with the declaration and one row per drifted
  variable records the direction, so a declaration that moved after apply is repaired by a queued
  reconfigure while a change made in the container stays open for an operator. An instance whose
  containers cannot be inspected is reported unobserved, never clean.
- **Identity propagation can reach the product, and is timed where it lands** (`FR-2.4`, `AC-11`,
  `AC-48`, `S-8`) — a mapping carries the role the product itself holds and the entitlement records
  it. A new push adapter calls the instance's verified API on its own network with a credential that
  never reaches a log, inert for entries that declare no admin API, where a change stays `pending`
  with its reason rather than being reported as propagation that never happened. Latency is measured
  to the applied entitlement and stored with the number of changes it was measured across, so a
  figure cannot be quoted without one.
- **A portable artefact holds what it names** (`FR-1.13`, `FR-1.35`, `FR-1.36`, `AC-20`, `AC-30`,
  `AC-52`, `ADR-BE-26`, `ADR-BE-27`) — the `export` action dumps the databases in plain SQL,
  archives the volumes, the render set and the non-secret environment, and writes a manifest with a
  digest per file, all in one archive beside a record of what it holds and omits; secrets are named,
  never included, and an instance that cannot produce a complete set fails before the first helper
  runs. A platform backup captures the same kind of set — platform and identity databases, realm,
  routes, anchors, catalogue fallback — with a byte count and a digest each, and records the root
  key and edge material as references, never bundled. The restore proves the set before the first
  write, brings the identity provider back first, needs an owner credential for the platform
  database, and no longer completes on an administrative login: it reopens the gate and restores the
  products at the configured concurrency, failing unless every one is running.
- **Product data volumes are recorded, measured and captured** (`FR-1.9`, `FR-1.12`, `AC-13`) — a
  deployment registers the volumes Compose created with the catalogue's quota, the sampler measures
  them and flags a quota the first time it is crossed, and a deploy whose declared quotas exceed the
  disk the instance reserves is refused before anything is created. The limit is soft, as `DA-2`
  allows.
- **The compose policy exception path works, and is scoped** (`FR-1.20`, `NFR-4.15`, `AC-33`) — an
  R1 files an exception through the API naming a product, rule, justification and expiry; the
  deviation granted is read from the platform's own refused resolution rather than the request body,
  and the waiver is resolved by entry key, so one product's exception no longer waives the rule for
  all of them. A lapsed exception is reported `expired` and quoted in the refusal. Dockerfile and
  scaffold sources now pass the same blocking check as Compose, and the console gained the request
  dialog.

### Changed

- **"Prefetch images" prepares the artefact instead of assuming it must be downloaded** (`FR-1.7`,
  `ADR-BE-40`) — an entry whose tree declares `build:` is built, not pulled, because pulling would
  fetch the registry's idea of the tag and guarantee that the next deployment refuses it. Everything
  else is pulled and verified as before, a missing mirror falls back to the pull, and a job with no
  entry fails with `VALIDATION_FAILED` instead of resolving the empty key.
- **The default catalogue's documents live beside the artefacts they pair with, and its gate is a
  real gate** (`AC-01`, `S-1`, `ADR-BE-21`) — the six documents moved to
  `platform/default-catalog/`, beside the declarations and vendored sources they are reviewed
  against, so a persistence package no longer carries product content. `pnpm check:catalog` imports
  the same keys, schemas and coverage arithmetic the API serves instead of restating them, so it
  cannot drift, and it now runs in CI.
- **Verification and backup claims are read from the record** (`FR-2.10`, `FR-2.14`, `FR-2.15`,
  `AC-41`, `AC-50`) — `PATCH /catalog/:key/integration-metadata` accepts every measured fact,
  refuses a request that changes nothing, and treats an omitted field as unchanged, so the review
  clock moves only because a fact arrived. A backup is "verified" only when every named dump and
  archive exists, refusing with `BACKUP_UNUSABLE` naming what is missing, and the recovery panel is
  generated from the newest manifest rather than asserted.
- **Refusals happen where the decision is made** — an unreviewed licence refuses
  `PUT /licenses/:instanceId/hosted-service` (409, audited) instead of being treated as permissive,
  and the catalog entry, the deploy wizard and the instance panel all state the volume quotas
  against the disk reservation.

### Fixed

- **The workflow screen stops contradicting itself** (`FR-5.4`, `FR-5.5`, `FR-5.6`) — the inventory
  badges summarise every definition state instead of three of them and stay blank until the list
  answers, a save retires the "Validation passed" banner it made stale, a stale link keeps its way
  back to the list, the target panel lists the fields the operation accepts, and the trigger panel
  names the stored mode beside the edited one and labels a schedule from its cron and timezone.
- **The entry node no longer warns about mappings nobody reads** (`FR-5.6`) — validation raised
  `EMPTY_MAPPINGS` on the trigger, which takes no mapping, so every definition carried a warning
  from its first edit and "passed with 1 warning" was the best a workflow could report.
- **Run now starts a scheduled workflow, and the run banner stops claiming a state** (`FR-5.4`) — a
  `schedule`/`poll` definition compiled to a schedule node only, so a manual run — the one thing an
  author wants before trusting a cron — answered `503 n8n has no webhook registered`; it now carries
  a second entry point the run can arrive at, and re-activation is what applies it. The banner after
  a run names where the outcome is instead of freezing `Run running` on screen after it failed.
- **Only an installed product is `ready`** (`FR-1.32`, `FR-2.9`) — a product serving its own
  installer was recorded ready while its first-boot install had been refused. It is now `degraded`
  with the installer named and the route still published, because finishing the install is the
  operator's next step; a product that declares no events no longer fails a webhook check it cannot
  satisfy, and single sign-on is not probed against an unfinished install.
- **Environment input is validated and described honestly** (`AC-28`, `AC-51`) — a `boolean` accepts
  only its two spellings and renders a checkbox, and the callout reads `Reconfigure queued` or
  `Stored — reconfigure required` instead of `Restart required`, which `docker restart` can never
  satisfy. A profile value over a `none` ceiling is a field error that names the profile to fix.
- **The product and development surfaces present the scheme they serve** (`NFR-4.1`, `ISSUE-07`) —
  the sign-in relay sends the public scheme, so a product no longer rejects its own credential POST
  as cross-site forgery; the default TLS store serves the development leaf instead of a self-signed
  certificate for the wrong host, the cache verifies the pair it minted, and the origins and routers
  the switch left behind are gone.
- **A transient job failure retries itself, and a dead worker no longer blocks its instance**
  (`NFR-6.5`, `ISSUE-31`, `ADR-BE-34`) — a successor job is queued for a transient failure, retrying
  a deployment only while its `apply` stage has not started and never retrying a restore or a
  data-subject request; a job silent for `SEAMNEX_JOB_STALE_AFTER_MS` is settled `JOB_ABANDONED`
  after its own failure handling runs.
- **An event can start a workflow, and a poll actually polls** (`FR-5.4`, `NFR-2.8`, `AC-26`) — the
  ingress is a declared, throttled operation authenticated over the exact bytes received, starting
  the bound workflow once per delivery and recording whether it was forwarded or failed; a delivery
  no definition is bound to is refused rather than acknowledged. A poll compiles to a schedule
  instead of a webhook waiting for an event the product cannot send, and the console gained a
  Trigger tab.
- **The guest can use the portal, and sign-out ends the products' sessions too** (`FR-3.3`,
  `FR-3.8`, `AC-35`, `ISSUE-28`, `ISSUE-29`) — the launcher and product page are open to the guest
  role, which answered `403` while mock mode hid it, and "My access" stays closed to it.
  `POST /me/logout` now ends the identity-provider session, which fires the registered back-channel
  logout, and reports which products were reached instead of claiming them all.
- **The audit anchor is signed, immutable, off-host and retained** (`NFR-4.10`, `AC-15`, `ISSUE-30`,
  `ADR-BE-33`) — one Ed25519-signed row per closed day, written once, copied daily with the public
  half in the export, and proof that answers whether the signature verifies instead of printing a
  string. Expired months are dropped under a 365-day floor.
- **Two authorities the screens enforced are now enforced by the API** (`FR-4.11`, `FR-5.9`,
  `AC-47`, `NFR-4.4`) — a break-glass approval is limited by access mode and by scope, decided on
  the row the decision transaction locks, and a workflow write requires authority over every product
  it writes to; both refuse with a code and an `access.denied` row, and the rule lives in
  `@seamnex/domain` so the console and the mock cannot hold a different one. A domain owner's
  workflow pickers read the registry they are allowed to see, so they can compose again.
- **An upgrade applies the version the operator confirmed** (`FR-1.7`, `AC-06`) — the version
  travels from the dialog into the job, is re-asserted against the pin, and is named in the audit
  events and in what the instance afterwards reports as running.
- **Smaller corrections** (`NFR-3.9`, `AC-52`, `NFR-4.6`, `S-10`) — a restore fans out at the
  operator's setting instead of an environment default; a failed job keeps its remediation in the
  step, the log and the error; the mock catalogue's quotas fit its disk reservation; the scanner
  writes to a host mount instead of a directory the process cannot create.

## [0.1.0] - 2026-11-13

Initial release — platform capabilities at the first tag, grouped rather than itemised by commit.

### Added

- **Portal (`apps/portal`) and console** (`apps/console`) — two React single-page apps: one
  identity and launcher for end users (entitlements, guarantee-class labels, plain-language status,
  global sign-out with residual-session disclosure), and operator screens for catalog, deployment,
  instances, jobs, backups, capacity, registry, workflows, governance, audit and recovery.
- **Control plane** (`apps/api`) — a modular monolith on PostgreSQL 18 and Redis 7, mounting all
  123 operations of `packages/domain` across ten process roles (`api`, `deploy-worker`,
  `sync-worker`, `status-sampler`, `backup-runner`, `scheduler`, `auth-gateway`, `broker-proxy`,
  `trigger-ingress`, `relay`).
- **Identity and authorisation** — Keycloak 26 realm-as-code, deny-by-default policy decisions
  through the PDP, IdP-to-product role propagation with session termination at offboarding,
  envelope-encrypted secrets and a hash-chained, append-only audit log.
- **Product access paths** — OIDC/SAML client registration per deployment, a forward-auth gateway
  for products without native SSO, and a sign-in relay for class (c) entries that provisions,
  rotates and removes a per-user credential, keeping the "sign-in required" label and never
  calling it single sign-on (`ADR-BE-22`).
- **Catalog and deployment sources** — three of the thirteen domain entries (D1 EspoCRM,
  D7 OrangeHRM, D9 OpenProject), resolved through the fixed compose → Dockerfile → scaffold
  precedence, with compose-policy rejection, a reviewable scaffold draft, and `ports:`→`expose:`
  normalisation asserted before apply.
- **Deployment and operations** — Docker Engine API execution through a socket proxy, plan and
  apply jobs with per-instance lanes and streamed logs, lifecycle actions (start, stop, restart,
  upgrade, rollback, delete, export), status sampling that separates running from ready, and
  capacity admission with a platform reserve.
- **Backup and recovery** — database-consistent dumps and volume archives to an S3-compatible
  target, scheduled and on-demand instance backups with restore and drill evidence, and
  platform-state backup with a gated restore that brings the identity provider back first and
  withholds product routes until an administrative login succeeds.
- **Cross-product workflows** — authoring with field mapping, pre-activation validation,
  operation-scoped credential brokering, HMAC-verified webhook ingress with replay dedupe, and
  run history, executed by n8n in queue mode.
- **Governance** — licence and patch registers, security posture, break-glass sessions with a
  named approver and a fixed access mode, data-subject requests with pseudonymised erasure,
  maintenance windows and policy exceptions.
- **Edge and observability** — a Traefik v3 edge with generated per-instance routes and a restore
  gate that leaves product routers unpublished until an administrative login succeeds, plus an
  opt-in Prometheus, Loki, Grafana, Alertmanager and Alloy profile in the `docker/` development
  topology.
- **Mock platform** — `VITE_API_MODE=mock` runs both apps with no Docker, through the same
  transport, hooks and screens as `live`, backed by MSW.
- **Developer experience** — shared packages (`domain`, `db`, `api-client`, `shell`, `ui`, `utils`,
  `config`, `mocks`), the quality gates, the control-plane image build with its Trivy
  vulnerability gate, and CI on Linux, macOS and Windows.
- **API contract** — `packages/domain/src/contract.ts` as the single source, with
  [`docs/openapi.json`](docs/openapi.json) generated and committed alongside it.

[Unreleased]: https://github.com/orbivort/seamnex/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/orbivort/seamnex/releases/tag/v0.1.0
