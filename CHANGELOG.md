# Changelog

All notable changes to **Seamnex** — a self-hosted, open-source platform that gives a small business one
identity, one portal and one operator console for the products it runs — are recorded here.

Format: [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) · Versioning:
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) · Licence: [GPL-3.0-only](LICENSE). The
version is the git tag (`vX.Y.Z`). The entries under `## [Unreleased]` become the next released section
in the `release-prepare` pull request, which leaves a fresh empty `## [Unreleased]` above it and moves
the same number through every manifest and the link definitions at the foot of this file.

[Repository](https://github.com/orbivort/seamnex) · [Issues](https://github.com/orbivort/seamnex/issues) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## [Unreleased]

### Upgrade notes

Action required when upgrading an existing install; everything else is additive.

- Every catalogue entry: record the digest of the artefact actually published, in the same commit as
  the tag. A pin the registry no longer matches now blocks the deployment, as does a locally built
  image with no repository digest.
- Existing `.env`: point the product URL at the TLS edge and set `SEAMNEX_EDGE_TLS_MODE`. `pnpm dev`
  refuses to start until they agree, and the API refuses under `NODE_ENV=production`.
- Development hosts: the zone is now `seamnex.localhost`, so move the hosts stored on `instance_route`
  and trust `temp/certs/dev-ca.crt` once.
- `docker/dns`: run `pnpm dev:dns:apply` in an elevated shell where Node, `curl` or Playwright must
  resolve the zone; `pnpm dev:dns` reports whether the service and the operating system agree, and
  `pnpm dev:dns:revert` undoes the rule.
- A platform restore without `SEAMNEX_PLATFORM_RESTORE_DB_URL` records `pnpm restore:platform-db` as
  an outstanding operator step, and the run cannot end `complete`.
- Audit retention has a 365-day floor: a shorter stored `audit_retention_days` is read as the floor.
- Policy exceptions are scoped to one product: a row whose `scope` is not a catalogue entry key waives
  nothing, so re-file an exception approved before this upgrade, naming the product it belongs to.
- Image scanning now reads a seeded advisory database: run `pnpm scan:db:update` before the first
  deployment after upgrading, and on a schedule so the cache stays inside
  `SEAMNEX_SCAN_DB_MAX_AGE_HOURS` (a week by default). A missing or expired cache is an error, so it
  blocks the deployment; `SEAMNEX_SCAN_FAIL_OPEN=true` still lets a deployment run, but recorded as
  unscanned rather than as clean, and `SEAMNEX_SCAN_DB_MODE=online` is the opt-in that lets the
  scanner fetch advisories itself.
- The catalogue now comes from `orbivort/seamnex-catalog` (ADR-BE-42). An existing install keeps the
  checkout it already has, so nothing breaks on upgrade; to move it to a reviewed tag, set
  `SEAMNEX_CATALOG_SOURCE_URL` (it defaults to the mirror), then run one
  `pnpm catalog:sync --ref <tag>` — or Catalog → "Sync from source" — and reload. Leave
  `SEAMNEX_SOURCE_MIRROR_DIR` empty: a tag puts render sets under `<root>/upstream/`, and the old
  `./platform/upstream` path no longer exists. `pnpm catalog:restore` is gone and exits non-zero with
  the replacement; `pnpm db:seed` no longer writes documents, so a host with no checkout starts with
  an empty catalogue until one is fetched.
- Keycloak moves from 26.0.5 to 26.8.2. On an existing host the Keycloak schema migrates in place on
  the first start and does not migrate back, so a host that must stay on 26.0.5 recreates the
  `seamnex_keycloak` database rather than downgrading. 26.8.2 also validates the Admin API audience:
  `seamnex-platform-admin` now carries the `kc-admin-api` client scope, and a realm applied without
  it answers `401` on every call to `/admin/...`, including `pnpm kc:admin --check`. And 26.8.2
  requires `manage-realm` for protocol-mapper writes on clients and client scopes, so the `groups`
  scope the products need is owned by `platform/realm/realm.json`; re-apply the realm with
  `pnpm kc:admin` after upgrading, or a product's ID token arrives without the claim.

### Summary

This release makes the platform build the image it runs and start only that digest, and moves the edge
and the development stack to TLS on one zone. Around that it closes the operational gaps: registry
trust and image scanning, a restorable catalogue with one coverage number, observed instances and
measured capacity, a patch register fed by upstream releases, environment profiles reconciled against
the running container, and an export, backup and restore path that proves what it holds.

### Added

- **ERPNext signs people in through the platform identity provider** (`FR-2.16`, `FR-1.11`) — its SSO
  is a `Social Login Key` row no environment variable can create, so the bootstrap writes it from
  declared values and re-applies it on every start; without a client secret, password sign-in stays.
  Frappe v16 has no SAML, no PKCE, no discovery and no back-channel logout, and the entry now says so.
- **Mautic joins the relay** (`FR-2.16`, `AC-49`, `ADR-BE-22`) — D02-01 is the third relayed entry and
  the first whose rotation replaces the account, because Mautic's API drops `plainPassword` on edit.
  Provisioning waits on `api_enabled` and `api_enable_basic_auth`, lookup is an exact match, and a
  failed launch falls back to Mautic's own form — never called single sign-on.
- **A host install is one idempotent command** (`NFR-6.2`, `NFR-6.3`, `S-9`, `AC-19`, `ADR-BE-35`) —
  `pnpm bootstrap` installs, starts the stack, seeds identity and the catalogue and checks
  `/api/v1/readyz`; `pnpm bootstrap:check` repeats the checks read-only. It never rotates a credential,
  overwrites `.env` or deletes a volume; `docs/operations/bootstrap.md` is the runbook.
- **The catalogue is a checkout, not a release artefact** (`FR-1.18`, `AC-5`, `AC-6`, `AC-7`, `AC-8`,
  `AC-9`, `AC-22`, `AC-23`, `AC-24`, `ADR-BE-42`) — the six entry documents, six environment
  declarations and six render sets moved to `orbivort/seamnex-catalog`, so this repository no longer
  carries deployable product content. `GET /catalog/repository` reports the revision being served, the
  configured source, the last fetched commit and a mixed tree; `POST /catalog/sync` fetches a tag,
  swaps the tree's children into place and reconciles the projection in one request; the console gains
  "Sync from source" beside Reload, disabled with the command to run when no source is configured; and
  `pnpm catalog:sync --ref <tag>` performs the same request from a script.
- **`db:seed` projects a checkout and writes no file** (`AC-7`, `AC-8`, `AC-10`, `ADR-BE-42`) — it
  skips with exit 0 and names `catalog:sync` when no checkout exists, fails when a checkout exists but
  yields no parseable document, and reports one unreadable document without discarding its neighbours.
- **`check:catalog` reads the checkout** (`AC-9`) — the gate derives its key set from the documents and
  fails when no checkout is present instead of passing vacuously over an empty default set.
- **Catalogue coverage is counted once** (`FR-2.6`, `FR-2.16`, `ADR-BE-37`) — Mautic, ERPNext and
  Metabase have entry documents, a declared deployment without one is refused, and the console, the API
  and the floor gate read one number.
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
- **The development stack mints a certificate that covers every product** (`NFR-4.1`, `ADR-BE-39`) —
  the Vite servers mint a CA and leaf into `temp/certs`, trusted once, and advertise `https://`; the
  zone is `seamnex.localhost`, so one wildcard covers every product.
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

- **The dev stack pins images by digest** (`NFR-4.15`) — every registry reference in
  `docker/compose.dev.yml` now carries the `sha256` of its multi-platform manifest index, so a re-push
  of a tag cannot change what a developer runs; `redis` names 7.4.12 (RSALv2/SSPLv1) instead of the
  floating `7-alpine`, and `postgres` names 18.7 instead of the 18 line. The six observability images
  stay tag-only until a host with registry access records theirs.
- **The dev edge runs a Traefik line that still receives fixes** (`NFR-4.15`) — `traefik` moves from
  v3.3.7, whose line ended support on 2025-05-05, to v3.7.20, the line still taking security fixes,
  pinned to its manifest index. Routing, TLS and ACME behaviour is unchanged; the static config now
  states `aliasHeadersStrategy: keep` instead of accepting the startup warning v3.7 raises without it.
- **The dev DNS server runs a CoreDNS release that still receives fixes** (`NFR-4.15`) — `1.12.0` was
  pinned in November 2024 and predated the listener fixes that shipped in `1.14.7`; `1.15.0`, current
  since 2026-10-21, is built with Go 1.27.3 and closes several CVEs. The zone configures `template`,
  `forward` and `errors` only, and `forward` targets `/etc/resolv.conf` rather than a hostname, so the
  change `1.15.0` makes to upstream hostnames does not apply.
- **The dev identity provider runs a Keycloak line that still receives security fixes**
  (`NFR-4.15`) — `26.0.5` was pinned in November 2024, before the 26.8.2 security release, whose notes
  list roughly 35 CVEs (SAML parser DoS/OOM, stored XSS on the login page, IdP email auto-linking,
  DCR/CIBA/UMA token handling). The realm-as-code CLI moves with it to `6.6.0-26.8.1`, the newest
  build target that release ships; its start-up check compares the major segment only, so the
  one-patch gap is accepted rather than hidden. Hostname v2, the management-port health probe and the
  realm import are unchanged, and `seamnex-platform-admin` gains the `kc-admin-api` scope 26.8.2
  requires before it accepts an Admin API token from a custom client.
- **The dev socket proxy runs a HAProxy line that still receives fixes** (`NFR-4.15`) — `0.3.0` was
  built on `haproxy:2.2-alpine`, a branch upstream left unmaintained in 2025-Q2, and its tag family is
  itself retired: `v0.6.0` dropped `:vX.Y.Z` and `:edge` for `lts`, `latest` and the major-minor
  lines. The pin names `3.4`, the line that stays on 3.4 when `lts` moves to 3.6, and carries the
  digest of its manifest index so a rebuild of that tag cannot change what a developer runs. The
  allow-list is unchanged — every toggle this stack sets still exists, the routes still match, and
  `EXEC=0` with `BUILD=1` mean what they meant on `0.3.0`.
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
- **A volume quota is stated against the disk it will consume** (`FR-1.9`, `AC-13`) — the catalog
  entry, the deploy wizard and the instance panel now show the quota beside the reservation.

### Removed

- **The plain-HTTP development path is gone** (`NFR-4.1`, `ADR-BE-39`) — no product is
  served on `http://…:8020`, a `.env` that still points at it is refused, and the origins and routers
  the old switch left behind are removed.

### Fixed

- **A product's sign-in survives the identity provider being re-created** (`FR-2.16`, `NFR-4.17`) — the
  IdP side of a product's identity is runtime state: `registerIdentity` creates the client during a
  deployment, realm-as-code never carries it, and a Keycloak upgrade or a `compose up` on a fresh
  volume leaves the next sign-in dying in the popup on "Client not found" with every recorded check
  still green. The scheduler pass now re-applies each stored registration before it measures — the
  same reasoning as the network attachment — and the check does it too, so the repair takes one
  interval instead of one deployment. The pass also counts a failed re-application as a broken login
  instead of leaving the last "ok" row standing.
- **A refused identity registration fails the deployment instead of reporting a capability**
  (`FR-2.16`) — every non-2xx from the Admin API is reduced to `ADAPTER_UNAVAILABLE`, and
  `registerIdentity` exempted that code wholesale as "this host has no admin client", so a `403` from
  the provider registered nothing and the deployment stayed green. The exemption now covers only a
  host with no admin client configured; with one configured, a refusal is raised.
- **The group-claim scope is realm-as-code, not a runtime write** (`FR-2.16`, `NFR-4.17`) — Keycloak
  26.8.2 requires `manage-realm` to create, update or delete a protocol mapper on a client _or a
  client scope_ unless the type is allow-listed for client administrators, and the platform admin
  client holds `manage-clients`. The `groups` scope and its mapper therefore stay declared in
  `platform/realm/realm.json` (now byte-for-byte what the platform used to write), the platform
  reuses a scope that already mints the claim, and a refusal names the release and the one change
  that avoids it instead of surfacing as a bare `403`.
- **ERPNext's single sign-on is the flow the portal claims** (`FR-2.16`, `NFR-4.17`) — four defects
  made the entry a label and the platform's own check passed them: the minted secret reached the
  secret store but never `instance_env_value`, and was minted after `apply`, so no container saw it;
  the `Social Login Key` was named `seamnex` where Frappe resolves by document name; `auth_url_data`
  omitted `response_type`; and `sso_login` asked only the identity provider. The secret now lands
  before the render set, the row is created as `Keycloak`, and the check reads the product's `/login`
  page; the script runs from `sites/` and the site's MariaDB account follows the container's address.
- **A cron expression the engine cannot compile is refused where it is typed** (`FR-5.4`) — only an
  empty one was checked, so `61 * * * *` saved, validated clean and failed at activation with n8n's
  bare `400`; panel and `validate()` now share one check (`TRIGGER_CRON_INVALID`).
- **The workflow list describes every definition state** (`FR-5.4`, `FR-5.5`, `FR-5.6`) — the inventory
  badges summarise every state instead of three and stay blank until the list answers, a save retires
  the stale "Validation passed" banner, and a stale link keeps its way back to the list.
- **The workflow panels describe what the definition holds** (`FR-5.4`, `FR-5.5`) — the target panel
  lists the fields the operation accepts, and the trigger panel names the stored mode beside the
  edited one and labels a schedule from its cron and timezone.
- **The entry node no longer warns about mappings nobody reads** (`FR-5.6`) — validation raised
  `EMPTY_MAPPINGS` on a trigger that takes no mapping, so every definition carried a warning from its
  first edit.
- **A read's answer is parsed before the next step sees it** (`FR-5.5`) — OpenProject answers
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
- **A product and the development surface present the scheme they serve** (`NFR-4.1`) — the relay
  sends the public scheme, so a product no longer rejects its own credential POST as cross-site
  forgery, and the default TLS store serves the development leaf instead of a wrong-host certificate.
- **A dead worker no longer blocks its instance** (`NFR-6.5`, `ADR-BE-34`) — a job silent
  for `SEAMNEX_JOB_STALE_AFTER_MS` is settled `JOB_ABANDONED` after its own failure handling runs, and
  a failed job keeps its remediation in the step, the log and the error.
- **The guest can use the portal** (`FR-3.3`, `AC-35`) — the launcher and product page are
  open to the guest role, which answered `403` while mock mode hid it; "My access" stays closed to it.
- **Sign-out ends the products' sessions too** (`FR-3.8`, `ADR-BE-32`) — `POST /me/logout`
  ends the identity-provider session, firing the registered back-channel logout, and reports which
  products were reached instead of claiming them all.
- **Two authorities the screens enforced are now enforced by the API** (`FR-4.11`, `FR-5.9`, `AC-47`,
  `NFR-4.4`) — approval is bounded by access mode and scope on the locked row, and a workflow write
  requires authority over every product it writes to; both audit an `access.denied` row.
- **A domain owner can compose again** (`FR-5.9`, `NFR-4.4`) — the workflow pickers read the registry
  that owner may see instead of answering empty.
- **An upgrade applies the version the operator confirmed** (`FR-1.7`, `AC-06`) — it travels into the
  job, is re-asserted against the pin, and is named in the audit events and in what the instance runs.
- **An `apply` no longer waits hours on a filtered registry path** (`FR-1.5`, `NFR-4.16`) — the
  Engine's own pulls had no mirror, so D06-01 spent hours on ~940 MB of `frappe/erpnext` at 50–100 KB/s;
  `SEAMNEX_PULL_MIRROR` prefixes the reference and retags it onto the canonical name, the pinned digest
  still decides, and every attempt is bounded by `SEAMNEX_PULL_TIMEOUT_MS`.
- **A sidecar image is fetched before the scan that asks about it** (`NFR-4.6`, `S-10`) — `apply`
  scanned every image the definition starts while only the entry's own image had been pulled, so a host
  that had never fetched `mariadb:11.4.13@sha256:…` failed the first deployment of D01-01 at the scan
  with the daemon's `no such image` and no stage had tried to fetch it; the images the definition names
  are now pulled before the scan, and a reference that names its own digest is checked by that pull.

### Internal

- **The default catalogue's documents live beside what they are reviewed against** (`AC-01`, `S-1`,
  `ADR-BE-21`) — the six documents moved to `platform/default-catalog/`, beside the declarations and
  vendored sources. `pnpm check:catalog` imports the same keys, schemas and coverage arithmetic the
  API serves, and now runs in CI.
- **The mock catalogue's quotas fit its reservation** (`AC-13`) — the fixture no longer declares more
  than the disk the mock reserves.

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
