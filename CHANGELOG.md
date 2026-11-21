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
- `docker/dns`: run `pnpm dev:dns --apply` where Node, `curl` or Playwright must resolve the zone;
  `--revert` undoes the rule.
- A platform restore without `SEAMNEX_PLATFORM_RESTORE_DB_URL` records `pnpm restore:platform-db` as
  an outstanding operator step, and the run cannot end `complete`.
- Audit retention has a 365-day floor: a shorter stored `audit_retention_days` is read as the floor.
- Image scanning now reads a seeded advisory database: run `pnpm scan:db:update` before the first
  deployment after upgrading, and on a schedule so the cache stays inside
  `SEAMNEX_SCAN_DB_MAX_AGE_HOURS` (a week by default). `SEAMNEX_SCAN_FAIL_OPEN=true` no longer hides
  the gap — a missing or expired cache blocks the deployment, and `SEAMNEX_SCAN_DB_MODE=online` is
  the opt-in that lets the scanner fetch advisories itself.

### Summary

This release makes the platform build the image it runs and start only that digest, and moves the edge
and the development stack to TLS on one zone. Around that it closes the operational gaps: registry
trust and image scanning, a restorable catalogue with one coverage number, observed instances and
measured capacity, a patch register fed by upstream releases, environment profiles reconciled against
the running container, and an export, backup and restore path that proves what it holds.

### Added

- **ERPNext signs people in through the platform identity provider** (`FR-2.16`, `FR-1.11`) — the
  product's own SSO is a `Social Login Key` row, which no environment variable can create, so the
  last step of its bootstrap writes that row from thirteen declared values and re-applies it on every
  start: client id derived as `seamnex-<slug>`, secret minted by the platform, applied to the instance
  before its definition is rendered and registered at the identity provider as the same value, the
  three realm endpoints split between the browser leg (published origin) and the server
  leg (instance network), `sub` as the account subject, `sign_ups` for provisioning,
  `Portal Settings.default_role` for the one role a social login can confer, and `session_expiry`
  set to the eight hours the entry claims. With `ERPNEXT_SSO_ENABLED=false`, or before a client
  secret exists, it writes nothing and password sign-in stays — the declared fallback. The entry's
  `SAML 2.0` label was wrong: Frappe v16 has no SAML, no PKCE, no OIDC discovery, no claim-to-role
  mapping and no back-channel logout, and each of those limits is now stated on the entry rather
  than implied by the class.
- **A host install is one idempotent command** (`NFR-6.2`, `NFR-6.3`, `S-9`, `AC-19`, `ADR-BE-35`) —
  `pnpm bootstrap` installs, brings the stack up, seeds the identity mirror and the catalogue and
  checks `/api/v1/readyz`; `pnpm bootstrap:check` repeats the checks read-only. It never rotates a
  credential, overwrites `.env` or deletes a volume, and `docs/dev-reference/operations/bootstrap.md`
  is the runbook inside AC-19's sixty minutes.
- **The six default catalogue documents can be put back** (`FR-1.1`, `S-2`, `ADR-BE-37`) —
  `pnpm catalog:restore` restores them, refusing a projection that holds any other key and naming the
  keys that do not line up.
- **Catalogue coverage is counted once** (`FR-2.6`, `FR-2.16`, `ADR-BE-37`) — Mautic, ERPNext and
  Metabase have entry documents, a declared deployment without one is refused rather than noted, and
  the console, the API and the floor gate read one number; lowering the floor is R1's recorded
  decision.
- **Environment profiles are staff-owned and validated against the catalogue** (`FR-1.26`, `AC-51`) —
  profiles are edited through the API behind a new capability, validated against what the catalogue
  declares, audited by variable name and never by value, and refused for deletion while a live
  instance depends on them.
- **Environment drift is routed to the side that can repair it** (`FR-1.29`, `AC-43`, `ADR-BE-28`) —
  each container's environment is compared with the declaration and one row per drifted variable
  records the direction; a declaration that moved after apply is repaired by a queued reconfigure, a
  change made in the container stays open. An uninspectable container is unobserved, never clean.
- **A deployment builds its own image** (`FR-1.5`, `FR-1.7`, `ADR-BE-40`) — `deploy`, `reconfigure` and
  `upgrade` gain a `build` stage before `apply`, now the only place an image comes into existence:
  every `dockerfile`, `scaffold` or Compose `build:` source is built once per candidate host, through
  BuildKit rather than the socket proxy.
- **`apply` starts only the digest this run built** (`FR-1.7`, `NFR-4.16`, `ADR-BE-40`) — the registry
  pin is compared with the repository digest and the local pin with the image id, before and after
  `up`, and a tag that is not this run's output fails with `IMAGE_DIGEST_MISMATCH` before a container
  exists.
- **Product volumes are recorded against a quota and measured** (`FR-1.9`, `FR-1.12`, `AC-13`) — a
  deployment registers the volumes Compose created, the sampler flags the first crossing, and a
  deploy whose declared quotas exceed the reserved disk is refused before it starts. The limit is
  soft (`DA-2`).
- **Pre-flight refuses with the blocker, before anything starts** (`FR-1.11`, `FR-1.23`, `AC-07`) —
  `POST /instances/preview` returns the checks that ran only inside a job: entry, source, image pin,
  field violations, secrets, capacity, route. The policy verdict comes from the recorded resolution
  with its evidence, so an unevaluated deployment is no longer reported as permitted, and the wizard
  shows each blocker where it can be fixed.
- **A policy exception is scoped to the product that asked for it** (`FR-1.20`, `NFR-4.15`, `AC-33`) —
  an R1 files one through the API naming a product, rule, justification and expiry; the deviation
  comes from the platform's own refused resolution, and the waiver resolves by entry key, so one
  product's exception no longer waives the rule for all. A lapsed one reports `expired`.
- **A Dockerfile or scaffold source is checked like a Compose file** (`FR-1.20`, `AC-33`) — both now
  pass the same blocking policy check, and the console gained the dialog that files an exception.
- **Registry trust is an append-only allow-list no job can bypass** (`NFR-4.16`, `S-10`, `ADR-BE-36`) —
  one parser for an image reference and one `trusted_registry_revision` allow-list, enforced in the
  catalogue, the policy evaluators, pre-flight and the engine client. The rule is non-waivable; the
  only remedy is a new revision.
- **An image is scanned before its container starts** (`NFR-4.6`, `S-10`, `ADR-BE-36`) — the report is
  kept per digest and reused while the digest holds, and a critical finding blocks the deployment
  unless `SEAMNEX_SCAN_FAIL_OPEN=true`. The instance screen gains an Image security tab whose "never
  scanned" is a state, not a pass. The scanner keeps no network: `pnpm scan:db:update` seeds the
  advisory database it reads, an unseeded or expired cache is an `error` with that command in the
  remedy, and `SEAMNEX_SCAN_DB_MODE=online|mirror` is the opt-in for a host that would rather fetch
  it through the scanner container.
- **The edge serves HTTPS on one certificate for one zone** (`NFR-4.1`, `FR-2.5`, `AC-42`,
  `ADR-BE-39`) — `websecure` on `:443` with a permanent `:80` redirect that carries only the ACME
  challenge, and a resolver persisting to `/acme/acme.json`. `SEAMNEX_EDGE_TLS_MODE` is written onto
  every route and router instead of a constant, and `SEAMNEX_TRAEFIK_ACME_EMAIL` is consumed.
- **The development stack mints a certificate that covers every product** (`NFR-4.1`,
  `ADR-BE-39`) — the Vite servers mint a development CA and leaf into `temp/certs`, trusted once, and
  advertise `https://`. The zone is `seamnex.localhost`, so one wildcard covers every product, and
  `docker/dns` with `pnpm dev:dns` resolves it for Node, `curl` and Playwright.
- **Capacity reports what is consumed beside what is allocated** (`FR-4.5`, `AC-39`, `ADR-BE-31`) — the
  sampler reads real container and volume usage, so `GET /capacity` reports consumed beside allocated
  at the thresholds R1 edits (75/90/85 by default), warning at a threshold and critical ten points
  past it. A daemon failure is unmeasured, never idle.
- **Every instance is observed, in metrics and in logs** (`FR-4.6`, `AC-45`, `ADR-BE-31`) — each
  entry's dashboards and alert rules are derived and persisted, one Prometheus target is published per
  instance and withdrawn with it, and metrics and masked logs are served per instance. Unconfigured
  logging says so instead of showing an empty console.
- **The patch register advances by observation** (`FR-2.12`, `NFR-4.7`, `ADR-BE-38`) — a scheduler
  pass reads each entry's releases and advisories, writes the versions and the lead advisory, ages the
  oldest unapplied security update, auditing as `system`; a failed feed keeps the previous
  observation. `POST /patch-register/observe` runs it on demand, and `catalog_entry` is never written.
- **Governance records name the person responsible** (`FR-4.11`, `AC-47`, `ADR-BE-25`) — the auditor
  records licence obligations and restriction flags through `PUT /licenses/:instanceId/review`, with
  reviewer, date and evidence on every cleared row. A break-glass notice names the domain owner and
  the product and who it was addressed to.
- **Each closed audit day is anchored once, signed and copied off-host** (`NFR-4.10`, `AC-15`,
  `ADR-BE-33`) — one Ed25519-signed row per day, written once and copied daily with the
  public half in the export, and a proof operation that answers whether the signature verifies instead
  of printing a string.
- **Identity propagation reaches the product itself** (`FR-2.4`, `AC-11`, `AC-48`, `S-8`) — a mapping
  carries the role the product holds, and a push adapter calls the instance's verified API on its own
  network with a credential that never reaches a log. Without a declared admin API a change stays
  `pending` with its reason, and latency is stored with the number of changes it was measured across.
- **A mapping's conversion and missing-value policy are compiled** (`FR-5.5`, `FR-5.6`, `ADR-BE-29`) —
  seventeen conversions are compiled into the body expression, with `fail` throwing, `skip` omitting
  the parameter and `default` substituting a value typed as the conversion's output; a mapping that
  declares nothing compiles byte-identically. Activation refuses an unknown conversion, a missing or
  invalid default, and a required field nothing maps.
- **A failed workflow retries, and its owner is told once per milestone** (`FR-5.7`, `AC-27`,
  `ADR-BE-30`) — compiled nodes carry their retry settings, the run history reports the attempts n8n
  made, and after a threshold of consecutive failures the owner is alerted with the failing step,
  recorded even when no channel was reached.
- **Run history is retained for 90 days** (`FR-5.8`, `ADR-BE-30`) — a failed run for twice as long, and
  a run's per-node outcome, duration and error payload stay quotable after the fact.
- **A workflow credential is rotated before it expires** (`NFR-4.14`, `ADR-BE-30`) — it is replaced
  inside the rotation window, the old scope revoked only after the new one commits, and an expired
  token heals on the next pass; every secret the platform mints comes from the CSPRNG.
- **A scheduled workflow can be started by hand** (`FR-5.4`) — a `schedule`/`poll` definition compiled
  to a schedule node only, so a manual run answered `503 n8n has no webhook registered`; it now
  carries a second entry point that re-activation applies.
- **A product event can start a bound workflow** (`FR-5.4`, `NFR-2.8`, `AC-26`) — the ingress is a
  declared, throttled operation authenticated over the exact bytes received, starting the bound
  workflow once per delivery and recording whether it was forwarded or failed. A delivery nothing is
  bound to is refused, not acknowledged, and the console gained a Trigger tab.
- **An instance export holds what it names** (`FR-1.13`, `AC-20`, `ADR-BE-26`) — `export` dumps the
  databases in plain SQL, archives the volumes, the render set and the non-secret environment, and
  writes a manifest digesting each file and naming what it omits; secrets are named, never included. An
  incomplete set fails before anything runs, and an appliance export carries the image.
- **A platform backup captures the platform's own state** (`FR-1.35`, `ADR-BE-26`) — platform and
  identity databases, realm, routes, anchors and the catalogue fallback, each with a byte count and a
  digest; the root key and edge material are recorded as references, never bundled.
- **A restore proves the set before it writes** (`FR-1.36`, `NFR-3.9`, `AC-30`, `AC-52`,
  `ADR-BE-27`) — it brings the identity provider back first, needs an owner credential for the
  platform database, reopens the gate and restores the products at the concurrency the operator set,
  failing unless every one is running. It no longer completes on an administrative login.
- **A transient job failure queues its own successor** (`NFR-6.5`, `ADR-BE-34`) — a deployment retries
  only while its `apply` stage has not started, and a restore or a data-subject request never retries.

### Changed

- **"Prefetch images" builds a `build:` entry instead of pulling its tag** (`FR-1.7`, `ADR-BE-40`) —
  pulling would fetch the registry's tag and guarantee the next deployment refuses it; everything else
  is still pulled and verified, a missing mirror falls back to the pull, and a job with no entry fails
  `VALIDATION_FAILED`.
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
  `boolean` takes its two spellings and renders a checkbox, and a profile value over a `none` ceiling
  is a field error naming the profile to fix. The callout reads `Reconfigure queued` or
  `Stored — reconfigure required`, not `Restart required`, which `docker restart` can never satisfy.
- **A volume quota is stated against the disk it will consume** (`FR-1.9`, `AC-13`) — the catalog
  entry, the deploy wizard and the instance panel now show the quota beside the reservation.

### Removed

- **The plain-HTTP development path is gone** (`NFR-4.1`, `ADR-BE-39`) — no product is
  served on `http://…:8020`, a `.env` that still points at it is refused, and the origins and routers
  the old switch left behind are removed.

### Fixed

- **ERPNext's single sign-on is the flow the portal claims** (`FR-2.16`, `NFR-4.17`) — four defects
  made the entry a label rather than a working path, and the platform's own login check passed through
  all of them: the minted client secret was written to the secret store but never to
  `instance_env_value`, which is the only thing the renderer and the executor resolve, and it was
  minted in `integrate` — after `apply` — so it could not reach a container at all. The site therefore
  booted without `ERPNEXT_SSO_CLIENT_SECRET`, took its documented fallback, wrote no
  `Social Login Key`, and offered a password form while the portal showed "Single sign-on".
  `ensureIdentitySecret` now puts that value on the instance before the render set is produced, so the
  first `apply` carries it. The `Social Login Key` was also named `seamnex`, and Frappe's
  `login_via_keycloak` resolves the provider by _document name_, so the callback would have raised
  `KeyError: 'keycloak'` after the browser returned with a code; the row is now created as
  `Keycloak` (name `keycloak`) and a row left by the old name is removed. The provider's
  `auth_url_data` omitted `response_type`, which rauth does not add, so the button pointed at an
  authorization request Keycloak rejects. And `sso_login` now reads the product's own `/login` page
  for the provider entry point and the credential's applied row, because a check that only asks the
  identity provider cannot fail when the product was never configured. Two defects in the same
  bootstrap were latent until the secret started arriving, because the block that touches the site's
  database had never run: Frappe resolves file logging relative to the process working directory, so
  `frappe.connect()` raised `FileNotFoundError: '/home/frappe/logs/database.log'` and the backend
  never became healthy; and `bench new-site` binds the site's MariaDB account to the _address of the
  container that ran it_, so the first recreate would have answered `Access denied`. The script now
  runs from `sites/` and converges that account for the current address on every start.
- **A cron expression the engine cannot compile is refused where it is typed** (`FR-5.4`) — only an
  empty one was checked, so `61 * * * *` saved, validated clean, then failed at activation with n8n's
  bare `400`, reported as a missing platform adapter. The trigger panel and `validate()` now share one
  five-field check (`TRIGGER_CRON_INVALID`) that names the field and its accepted values.
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
  `application/hal+json`, which n8n does not parse, so a read arrived as `{ data: "<json string>" }`,
  mappings resolved to nothing and the write posted an empty body. The broker relabels a JSON-parsable
  body as JSON, bytes untouched, and compiled reads ask n8n to parse.
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
- **A product and the development surface present the scheme they serve** (`NFR-4.1`) — the
  sign-in relay sends the public scheme, so a product no longer rejects its own credential POST as
  cross-site forgery; the default TLS store serves the development leaf instead of a certificate for
  the wrong host, and the cache verifies the pair it minted.
- **A dead worker no longer blocks its instance** (`NFR-6.5`, `ADR-BE-34`) — a job silent
  for `SEAMNEX_JOB_STALE_AFTER_MS` is settled `JOB_ABANDONED` after its own failure handling runs, and
  a failed job keeps its remediation in the step, the log and the error.
- **The guest can use the portal** (`FR-3.3`, `AC-35`) — the launcher and product page are
  open to the guest role, which answered `403` while mock mode hid it; "My access" stays closed to it.
- **Sign-out ends the products' sessions too** (`FR-3.8`, `ADR-BE-32`) — `POST /me/logout`
  ends the identity-provider session, firing the registered back-channel logout, and reports which
  products were reached instead of claiming them all.
- **Two authorities the screens enforced are now enforced by the API** (`FR-4.11`, `FR-5.9`, `AC-47`,
  `NFR-4.4`) — approval is bounded by access mode and scope, decided on the row the decision
  transaction locks, and a workflow write requires authority over every product it writes to; both
  refuse with a code and an `access.denied` row, and the rule lives in `@seamnex/domain`.
- **A domain owner can compose again** (`FR-5.9`, `NFR-4.4`) — the workflow pickers read the registry
  that owner may see instead of answering empty.
- **An upgrade applies the version the operator confirmed** (`FR-1.7`, `AC-06`) — the version travels
  from the dialog into the job, is re-asserted against the pin, and is named in the audit events and
  in what the instance reports as running.
- **An `apply` no longer waits hours on a filtered registry path** (`FR-1.5`, `NFR-4.16`) — the
  Engine's own pulls had no mirror at all: `SEAMNEX_REGISTRY_MIRROR` reaches BuildKit only, so D06-01
  spent hours on ~940 MB of `frappe/erpnext` at 50–100 KB/s inside its digest check. `SEAMNEX_PULL_MIRROR`
  names mirrors for that path — the reference is prefixed, then retagged onto the canonical name — and
  the pinned digest still decides: a mirror that serves other content is refused and the next attempt
  runs. Every attempt is bounded by `SEAMNEX_PULL_TIMEOUT_MS`, the registry stays the last attempt, and
  each fallback is a line in the job log.

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
