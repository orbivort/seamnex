# Changelog

All notable changes to **Seamnex** — a self-hosted, open-source platform that gives a small business one
identity, one portal and one operator console for the products it runs — are recorded here.

Format: [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) · Versioning:
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) · Licence: [GPL-3.0-only](LICENSE). The
version is the git tag (`vX.Y.Z`). The entries under `## [Unreleased]` become the next released section
in the `release-prepare` pull request, which leaves a fresh empty `## [Unreleased]` above it and moves
the same number through every manifest and the link definitions at the foot of this file.

Two sections precede Keep a Changelog's types: `Summary` states in one paragraph what the release does,
and `Upgrade notes` lists what an existing host must do before or after it. The `0.1.0` section is
grouped by area and carries no requirement ids, which was the first release's shape; every section
after it gives one outcome per bullet, states it for the operator who reads it rather than by the
symbol that implements it, and cites the requirement and decision ids (`FR-*`, `NFR-*`, `AC-*`,
`ADR-*`, `S-*`, `DA-*`) whose behaviour moved.

[Repository](https://github.com/orbivort/seamnex) · [Issues](https://github.com/orbivort/seamnex/issues) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## [Unreleased]

### Summary

This release makes the platform build the image it runs and start only that digest, and moves the edge
to TLS on one zone. Around that it closes the operational gaps: registry trust and image scanning, a
restorable catalogue with one coverage number, observed instances and measured capacity, a patch
register fed by upstream releases, environment profiles reconciled against the running container, and
an export, backup and restore path that proves what it holds. It also narrows authorization to what a
grant reaches — collection reads filter rows, and the console marks the surfaces a narrower scope can
serve — and makes workflow triggers, mappings and retries things the engine compiles and the screens
describe.

### Upgrade notes

Action required when upgrading an existing install; everything else is additive.

- **Catalogue entries** — record the digest of the artefact actually published, in the same commit as
  the tag. A pin the registry no longer matches now blocks the deployment, as does a locally built
  image with no repository digest.
- **Existing `.env`** — point the product URL at the TLS edge and set `SEAMNEX_EDGE_TLS_MODE`;
  `pnpm dev` refuses to start until they agree, and the API refuses under `NODE_ENV=production`.
- **Platform restore** — without `SEAMNEX_PLATFORM_RESTORE_DB_URL`, `pnpm restore:platform-db` is
  recorded as an outstanding operator step, and the run cannot end `complete`.
- **Audit retention** — 365 days is a floor: a shorter stored `audit_retention_days` is read as the
  floor.
- **Policy exceptions** — scoped to one product: a row whose `scope` is not a catalogue entry key
  waives nothing, so re-file an exception approved before this upgrade, naming the product it belongs
  to.
- **Image scanning** — reads a seeded advisory database: run `pnpm scan:db:update` before the first
  deployment after upgrading, and on a schedule so the cache stays inside
  `SEAMNEX_SCAN_DB_MAX_AGE_HOURS` (a week by default). A missing or expired cache blocks the
  deployment; `SEAMNEX_SCAN_FAIL_OPEN=true` records it as unscanned rather than clean, and
  `SEAMNEX_SCAN_DB_MODE=online` lets the scanner fetch advisories itself.
- **Catalogue source** — the catalogue now comes from `orbivort/seamnex-catalog` (ADR-BE-42). An
  existing install keeps the checkout it already has; to move it to a reviewed tag, set
  `SEAMNEX_CATALOG_SOURCE_URL` (it defaults to the mirror), run one `pnpm catalog:sync --ref <tag>` —
  or Catalog → "Sync from source" — and reload. Leave `SEAMNEX_SOURCE_MIRROR_DIR` empty: a tag puts
  render sets under `<root>/upstream/`, and a host with no checkout starts with an empty catalogue
  until one is fetched.
- **Keycloak 26.8.2** — moves from 26.0.5. The schema migrates in place on the first start and does
  not migrate back, so a host that must stay on 26.0.5 recreates the `seamnex_keycloak` database
  rather than downgrading. Re-apply the realm with `pnpm kc:admin` after upgrading: 26.8.2 validates
  the Admin API audience — `seamnex-platform-admin` now carries the `kc-admin-api` client scope,
  without which every `/admin/...` call answers `401` — and requires `manage-realm` for the `groups`
  scope, which `platform/realm/realm.json` now owns.

### Added

- **A host install is one idempotent command** (`NFR-6.2`, `NFR-6.3`, `S-9`, `AC-19`, `ADR-BE-35`) —
  `pnpm bootstrap` installs, starts the stack, seeds identity and the catalogue and checks
  `/api/v1/readyz`; `pnpm bootstrap:check` repeats the checks read-only. It never rotates a credential,
  overwrites `.env` or deletes a volume; `docs/operations/bootstrap.md` is the runbook.
- **The catalogue is a checkout, not a release artefact** (`FR-1.18`, `AC-5`, `AC-6`, `AC-7`, `AC-8`,
  `AC-9`, `AC-10`, `AC-22`, `AC-23`, `AC-24`, `ADR-BE-42`) — the six entry documents, six environment
  declarations and six render sets moved to `orbivort/seamnex-catalog`, so this repository no longer
  carries deployable product content. `GET /catalog/repository` reports the revision being served and
  the configured source; `POST /catalog/sync` fetches a tag, swaps the tree into place and reconciles
  the projection; the console gains "Sync from source" beside Reload; and one
  `pnpm catalog:sync --ref <tag>` performs the same request from a script. `pnpm db:seed` skips with
  exit 0 naming `catalog:sync` when no checkout exists, and fails when one yields no parseable
  document.
- **Environment profiles are staff-owned** (`FR-1.26`, `AC-51`) — edited through the API behind a new
  capability, validated against the catalogue, audited by variable name and never by value, and refused
  for deletion while a live instance depends on them.
- **Environment drift is routed to the side that can repair it** (`FR-1.29`, `AC-43`, `ADR-BE-28`) — a
  declaration that moved is repaired by a queued reconfigure, a change made in the container stays
  open, and an uninspectable container is unobserved, never clean.
- **A deployment builds its own image** (`FR-1.5`, `FR-1.7`, `ADR-BE-40`) — `deploy`, `reconfigure` and
  `upgrade` gain a `build` stage before `apply`, the only place an image comes into existence: every
  `dockerfile`, `scaffold` or Compose `build:` source is built once per host, through BuildKit.
- **`apply` starts only the digest this run built** (`FR-1.7`, `NFR-4.16`, `ADR-BE-40`) — the pin is
  compared before and after `up`, and a tag that is not this run's output fails with
  `IMAGE_DIGEST_MISMATCH` before a container exists.
- **Product volumes are recorded against a quota and measured** (`FR-1.9`, `FR-1.12`, `AC-13`) — a
  deployment registers the volumes Compose created, the sampler flags the first crossing, and quotas
  over the reserved disk are refused before it starts. The limit is soft (`DA-2`).
- **Pre-flight refuses with the blocker, before anything starts** (`FR-1.11`, `FR-1.23`, `AC-07`) —
  `POST /instances/preview` returns entry, source, image pin, field violations, secrets, capacity and
  route, and the verdict comes from the recorded resolution, so nothing unevaluated is permitted.
- **A policy exception is scoped to the product that asked for it** (`FR-1.20`, `NFR-4.15`, `AC-33`) —
  filed with a product, rule, justification and expiry, and resolved by entry key, so one product's
  exception no longer waives the rule for all. A lapsed one reports `expired`.
- **A Dockerfile or scaffold source is checked like a Compose file** (`FR-1.20`, `AC-33`) — both pass
  the same blocking policy check, and the console gained the dialog that files an exception.
- **Registry trust is an append-only allow-list no job can bypass** (`NFR-4.16`, `S-10`, `ADR-BE-36`) —
  one parser and one `trusted_registry_revision` list, enforced in the catalogue, the evaluators,
  pre-flight and the engine client. The rule is non-waivable.
- **An image is scanned before its container starts** (`NFR-4.6`, `S-10`, `ADR-BE-36`) — the report is
  kept per digest and reused while the digest holds, a critical finding blocks the deployment unless
  `SEAMNEX_SCAN_FAIL_OPEN=true`, and "never scanned" is a state on the instance screen, not a pass. The
  scanner keeps no network: `pnpm scan:db:update` seeds the advisory database it reads.
- **The edge serves HTTPS on one certificate for one zone** (`NFR-4.1`, `FR-2.5`, `AC-42`,
  `ADR-BE-39`) — `websecure` on `:443` with a permanent `:80` redirect carrying only the ACME
  challenge, and a resolver persisting to `/acme/acme.json`; `SEAMNEX_EDGE_TLS_MODE` is written onto
  every route and router.
- **Capacity reports what is consumed beside what is allocated** (`FR-4.5`, `AC-39`, `ADR-BE-31`) — the
  sampler reads real container and volume usage, warning at a threshold and critical ten points past
  it; a daemon failure is unmeasured, never idle.
- **Every instance is observed, in metrics and in logs** (`FR-4.6`, `AC-45`, `ADR-BE-31`) — dashboards
  and alert rules are derived per entry, one Prometheus target is published per instance and withdrawn
  with it, and masked logs are served per instance.
- **The patch register advances by observation** (`FR-2.12`, `NFR-4.7`, `ADR-BE-38`) — a scheduler pass
  reads each entry's releases and advisories, writes the versions and the lead advisory and ages the
  oldest unapplied security update, auditing as `system`; a failed feed keeps the last observation.
- **Governance records name the person responsible** (`FR-4.11`, `AC-47`, `ADR-BE-25`) — licence review
  carries reviewer, date and evidence on every cleared row, and a break-glass notice names the domain
  owner, the product and who it was addressed to.
- **Each closed audit day is anchored once, signed and copied off-host** (`NFR-4.10`, `AC-15`,
  `ADR-BE-33`) — one Ed25519-signed row per day, written once and copied daily with the public half in
  the export, and a proof operation that answers whether the signature verifies.
- **Identity propagation reaches the product itself** (`FR-2.4`, `AC-11`, `AC-48`, `S-8`) — a push
  adapter calls the instance's verified API on its own network with a credential that never reaches a
  log; without a declared admin API a change stays `pending` with its reason.
- **A mapping's conversion and missing-value policy are compiled** (`FR-5.5`, `FR-5.6`,
  `ADR-BE-29`) — seventeen conversions compile into the body expression, with `fail` throwing, `skip`
  omitting the parameter and `default` substituting a typed value; a mapping that declares nothing
  compiles byte-identically.
- **A failed workflow retries, and its owner is told once per milestone** (`FR-5.7`, `AC-27`,
  `ADR-BE-30`) — compiled nodes carry their retry settings, the run history reports the attempts, and
  after a threshold of consecutive failures the owner is alerted with the failing step.
- **Run history is retained for 90 days** (`FR-5.8`, `ADR-BE-30`) — a failed run for twice as long,
  with per-node outcome, duration and error payload quotable after the fact.
- **A workflow credential is rotated before it expires** (`NFR-4.14`, `ADR-BE-30`) — replaced inside
  the rotation window, the old scope revoked only after the new one commits, and an expired token heals
  on the next pass.
- **A scheduled workflow can be started by hand** (`FR-5.4`) — a `schedule`/`poll` definition compiled
  to a schedule node only answered `503` on a manual run; it now carries a second entry point that
  re-activation applies.
- **A product event can start a bound workflow** (`FR-5.4`, `NFR-2.8`, `AC-26`) — a declared, throttled
  ingress authenticates the exact bytes received, starts the bound workflow once per delivery and
  records the outcome; a delivery nothing is bound to is refused, not acknowledged.
- **An instance export holds what it names** (`FR-1.13`, `AC-20`, `ADR-BE-26`) — `export` dumps the
  databases in plain SQL, archives the volumes, the render set and the non-secret environment, and
  writes a manifest digesting each file; secrets are named, never included, and an incomplete set fails
  before anything runs.
- **A platform backup captures the platform's own state** (`FR-1.35`, `ADR-BE-26`) — platform and
  identity databases, realm, routes, anchors and the catalogue fallback, each with a byte count and a
  digest; the root key and edge material are recorded as references.
- **A restore proves the set before it writes** (`FR-1.36`, `NFR-3.9`, `AC-30`, `AC-52`,
  `ADR-BE-27`) — it brings the identity provider back first, needs an owner credential for the platform
  database, reopens the gate and restores the products at the operator's concurrency, failing unless
  every one is running; an administrative login no longer completes it.
- **A transient job failure queues its own successor** (`NFR-6.5`, `ADR-BE-34`) — a deployment retries
  only while its `apply` stage has not started, and a restore or a data-subject request never retries.

### Changed

- **Every image the platform starts names its digest** (`NFR-4.6`, `NFR-4.15`, `S-10`) — the
  `SEAMNEX_SCANNER_IMAGE` default, the `alpine` and `busybox` helpers, and the `pg_dump`/`pg_restore`
  helper are `tag@sha256:…`, and `docker/images.json` is the single authority those pins come from.
  The tag stays in front of the digest so a retained report names the scanner that produced it; a host
  that overrides `SEAMNEX_SCANNER_IMAGE` with a bare tag keeps its own pin.
- **"Prefetch images" builds a `build:` entry instead of pulling its tag** (`FR-1.7`, `ADR-BE-40`) —
  pulling would fetch the registry's tag the next deployment then refuses; everything else is still
  pulled and verified, and a job with no entry fails `VALIDATION_FAILED`.
- **A rebuild moves the recorded digest legitimately; a substituted tag does not** (`NFR-4.16`,
  `ADR-BE-40`) — the pin is kept as a trust-on-first-use baseline and reported as drift, not as a
  mismatch.
- **An unreviewed licence refuses a hosted-service approval** (`FR-4.11`, `AC-47`, `ADR-BE-25`) —
  `PUT /licenses/:instanceId/hosted-service` answers `409` and audits the attempt instead of treating
  the missing review as permissive.
- **A verification date moves only when a fact arrives** (`FR-2.10`, `FR-2.15`, `AC-41`) —
  `PATCH /catalog/:key/integration-metadata` accepts every measured fact, refuses a request that
  changes nothing, and treats an omitted field as unchanged.
- **A backup is verified only when its files exist** (`FR-2.14`, `AC-50`) — every named dump and
  archive must be present, or the claim is refused with `BACKUP_UNUSABLE` naming what is missing, and
  the recovery panel is generated from the newest manifest rather than asserted.
- **An environment value is accepted only in the spelling its type allows** (`AC-28`, `AC-51`) — a
  `boolean` takes its two spellings and renders a checkbox, a profile value over a `none` ceiling is a
  field error naming the profile, and the callout reads `Reconfigure queued`, not `Restart required`.
- **A volume quota is quoted against the disk it will consume** (`FR-1.9`, `AC-13`) — the catalogue
  entry, the deploy wizard and the instance panel now show the quota beside the reservation.
- **A scoped list answers with the rows the grant reaches** (`AC-38`, `ADR-BE-44`) — `GET /instances`,
  `GET /jobs`, `GET /capacity` and `GET /capacity/forecast` apply the grant as a row filter, so a
  domain-scoped operator reads their own fleet instead of a `403` that said an unaddressed read has no
  domain to resolve. A collection allow is never cached, an unresolved scope still denies and audits,
  and the compiled `policy_version` now covers the scope rules and the collection set; a denial
  recorded before the upgrade keeps the version it named.
- **The console shows each surface as allowed, denied or scope-limited, from one registry**
  (`ADR-FE-01`) — a surface's capability is declared once and drives the sidebar, the router, the
  command palette and chunk prefetching; an entry held only within a narrower scope stays visible, is
  marked, and one line on the screen states the scope applied.

### Removed

- **`pnpm catalog:restore` and the seeded documents it restored** (`ADR-BE-42`) — the catalogue is a
  checkout at a tag now: `pnpm db:seed` projects one and writes no file, and fetching one is
  `pnpm catalog:sync --ref <tag>`.

### Fixed

- **A product's sign-in survives the identity provider being re-created** (`FR-2.16`, `NFR-4.17`) —
  a product's identity is provisioned during a deployment, so a Keycloak upgrade or a `compose up` on a
  fresh volume left the next sign-in dying in the popup on "Client not found" with every recorded
  check still green. The scheduler pass and the check now re-apply each stored registration before
  they measure, and a failed re-application counts as a broken login instead of leaving the last "ok"
  row standing.
- **A refused identity registration fails the deployment instead of reporting a capability**
  (`FR-2.16`) — registration treated `ADAPTER_UNAVAILABLE` wholesale as "this host has no admin
  client", so a `403` from the provider registered nothing and the deployment stayed green. The
  exemption now covers only a host with no admin client configured.
- **The group-claim scope is realm-as-code, not a runtime write** (`FR-2.16`, `NFR-4.17`) — 26.8.2
  requires `manage-realm` for protocol-mapper writes on a client or a client scope, which the platform
  admin client does not hold, so the `groups` scope and its mapper stay declared in
  `platform/realm/realm.json`; the platform reuses a scope that already mints the claim, and a refusal
  names the release and the one change that avoids it.
- **A cron expression the engine cannot compile is refused where it is typed** (`FR-5.4`) — only an
  empty one was checked, so `61 * * * *` saved, validated clean and failed at activation with n8n's
  bare `400`; the panel and the validator now share one check (`TRIGGER_CRON_INVALID`).
- **The workflow list describes every definition state** (`FR-5.4`, `FR-5.5`, `FR-5.6`) — the inventory
  badges summarise every state instead of three and stay blank until the list answers, a save retires
  the stale "Validation passed" banner, and a stale link keeps its way back to the list.
- **The workflow panels describe what the definition holds** (`FR-5.4`, `FR-5.5`) — the target panel
  lists the fields the operation accepts, and the trigger panel names the stored mode beside the
  edited one and labels a schedule from its cron and timezone.
- **The entry node no longer warns about mappings nobody reads** (`FR-5.6`) — validation raised
  `EMPTY_MAPPINGS` on a trigger that takes no mapping, so every definition carried a warning from its
  first edit.
- **A read's answer is parsed before the next step sees it** (`FR-5.5`) — App answers
  `application/hal+json`, which n8n does not parse, so a read arrived as `{ data: "<json string>" }` and
  the write posted an empty body; the broker relabels a JSON-parsable body, bytes untouched.
- **A mapping that resolves nothing is refused before activation** (`FR-5.5`) — validation compares
  mapped source paths with the newest stored item: none resolving blocks activation, some missing is
  advice.
- **The sample caption counts sample fields, not mapping rows** (`FR-5.5`) — four mappings against a
  one-field sample read "4 of 1 mapped", a ratio that cannot exist.
- **The banner after a run names where the outcome is** (`FR-5.4`) — it no longer freezes `Run running`
  on screen after the run failed.
- **A poll actually polls** (`FR-5.4`) — it compiles to a schedule instead of a webhook waiting for an
  event the product cannot send.
- **Only an installed product is `ready`** (`FR-1.32`, `FR-2.9`) — a product serving its own installer
  was recorded ready while its first-boot install had been refused; it is now `degraded`, installer
  named and route still published, because finishing the install is the operator's next step.
- **An unfinished install is not probed for what it cannot answer** (`FR-1.32`, `FR-2.9`) — a product
  that declares no events no longer fails a webhook check, and single sign-on is not attempted before
  the install finishes.
- **A product presents the scheme it is served on** (`NFR-4.1`) — the relay sends the public scheme,
  so a product no longer rejects its own credential POST as cross-site forgery.
- **A dead worker no longer blocks its instance** (`NFR-6.5`, `ADR-BE-34`) — a job silent
  for `SEAMNEX_JOB_STALE_AFTER_MS` is settled `JOB_ABANDONED` after its own failure handling runs, and
  a failed job keeps its remediation in the step, the log and the error.
- **The guest can use the portal** (`FR-3.3`, `AC-35`) — the launcher and product page are
  open to the guest role, which answered `403` while mock mode hid it; "My access" stays closed to it.
- **Sign-out ends the products' sessions too** (`FR-3.8`, `ADR-BE-32`) — `POST /me/logout`
  ends the identity-provider session, firing the registered back-channel logout, and reports which
  products were reached instead of claiming them all.
- **A domain-scoped role is no longer offered screens it cannot read** (`ADR-FE-01`) — the
  scope-limited marker is claimed only for a surface the platform can serve narrowed, so audit, patch
  register, posture, recovery and access requests — still platform-wide reads — are no longer listed
  as narrowed entries that answer `403`.
- **A domain owner can compose again** (`FR-5.9`, `NFR-4.4`) — the workflow pickers read the registry
  that owner may see instead of answering empty.
- **An upgrade applies the version the operator confirmed** (`FR-1.7`, `AC-06`) — it travels into the
  job, is re-asserted against the pin, and is named in the audit events and in what the instance runs.
- **An `apply` no longer waits hours on a filtered registry path** (`FR-1.5`, `NFR-4.16`) —
  `SEAMNEX_PULL_MIRROR` prefixes the Engine's own pulls and retags them onto the canonical name, the
  pinned digest still decides, and every attempt is bounded by `SEAMNEX_PULL_TIMEOUT_MS`.
- **A sidecar image is fetched before the scan that asks about it** (`NFR-4.6`, `S-10`) — `apply`
  scanned every image the definition starts while only the entry's own image had been pulled, so a
  first deployment failed at the scan with the daemon's `no such image`; those images are now pulled
  before the scan.

### Security

- **The identity provider runs a Keycloak line that still receives security fixes** (`NFR-4.15`) —
  26.0.5 predates 26.8.2, whose notes list roughly 35 CVEs (SAML parser DoS/OOM, stored XSS on the
  login page, IdP email auto-linking, DCR/CIBA/UMA token handling). The realm-as-code CLI moves to
  `6.6.0-26.8.1`, and `seamnex-platform-admin` gains the `kc-admin-api` scope 26.8.2 requires before
  it accepts an Admin API token from a custom client.
- **Two rules the screens enforced are now enforced by the API** (`FR-4.11`, `FR-5.9`, `AC-47`,
  `NFR-4.4`) — approval is bounded by access mode and scope on the locked row, and a workflow write
  requires authority over every product it writes to; both audit an `access.denied` row.
- **The portal guards the routes it serves** (`FR-3.5`) — `/entitlements` and `/product/:slug` had no
  route guard; both now check access before rendering, so an unentitled product is absent from the URL
  as well as from the launcher.

## [0.1.0] - 2026-11-13

Initial release — platform capabilities at the first tag, grouped rather than itemised by commit.

### Added

- **Portal (`apps/portal`) and console** (`apps/console`) — two React single-page apps: one
  identity and launcher for end users (entitlements, guarantee-class labels, plain-language status,
  global sign-out with residual-session disclosure), and operator screens for catalogue, deployment,
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
- **Catalog and deployment sources** — three of the thirteen domain entries,
  resolved through the fixed compose → Dockerfile → scaffold
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
