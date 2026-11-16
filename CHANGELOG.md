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

### Added

- **Pre-flight refuses with the blocker, before anything starts** (`FR-1.11`, `FR-1.23`, `AC-07`) —
  `POST /instances/preview` now returns a `blockers` list — each entry a `code`, the `field` or fact it
  refers to, a sentence and whether it blocks — and `admissible` is false while any of them does. The
  new `PreflightService` composes the checks that already existed but were only consulted once a job
  was running: the entry and the resolvability of its source, the image pin (`isPinnedImage`),
  `renderer.plan` for field-level `required`/`ceiling`/rule violations, each secret reference against
  the secret store, capacity, and the slug's route. The policy verdict stopped being hard-coded
  `allowed`: it is read from the entry's latest recorded `source_resolution` and reported as
  `allowed`, `blocked` or `unknown`, always with the `policyEvaluatedAt` and the `policySource` behind
  it, so a permitted deployment can name the evidence that permitted it and an unevaluated one is no
  longer reported as a permitted one. The wizard prints each blocker on the step that can fix it,
  anchors it to the field, and keeps submit disabled with the reason it is disabled.
- **Environment profiles are staff-owned, and editable where they are read** (`FR-1.26`, `AC-51`) — a
  profile was a row someone inserted by hand. `POST /env-profiles`, `PATCH /env-profiles/:key`,
  `PUT /env-profiles/:key/values` and `DELETE /env-profiles/:key` are now the way one is created,
  retargeted, filled and removed, behind the new `profile.manage` capability (R1); a domain owner (R3)
  gets `profile.request` instead, the same approval shape as every other scoped change, and the
  console shows the action disabled with that path as the reason. Writes are validated against what
  the catalogue declares: a variable no entry declares is refused, a secret-typed variable may only
  point at a stored secret rather than carry a value, and a value is rejected only when **every** entry
  that declares the variable caps it at `none`. Each write is audited (`profile.created`,
  `profile.updated`, `profile.values_replaced`, `profile.deleted`) with the variable names and never
  the values, reads mask secret references, and a delete a live instance depends on answers
  `STATE_CONFLICT` naming those instances instead of letting the foreign key surface as a 500.
  Migration `0035` adds the profile's display `name`. The console gained
  `/admin/environment-profiles`: the profiles with their lifecycle target, every variable they set
  with the entry that declares it and the ceiling that applies, so an operator can see why a value is
  ignored before deploying rather than after.
- **Identity propagation can reach the product, and is timed where it lands** (`FR-2.4`, `AC-11`,
  `AC-48`, `S-8`) — a mapping now carries the role the product itself holds
  (`group_mapping.product_role`, default `member`) and the entitlement records that role instead of the
  literal `member` it used to write. "Applied" is claimed only when the platform applied something:
  the identity client it configured, or a push the product acknowledged. The new `IDENTITY_PUSH` port
  has an HTTP adapter that targets the instance's verified `apiBaseUrl` on the instance's own network,
  authenticates with a secret-store credential that never reaches argv or a log, and makes one bounded
  call per changed (subject, instance); `SEAMNEX_IDENTITY_PUSH_ENABLED` (default off) and an optional
  `integration.rolePush` keep it inert for every entry that declares no admin API, and such a change
  stays `pending` with its reason recorded in `sync_run.errors` rather than being reported as a
  propagation that never happened. Migration `0035` adds `entitlement.applied_at`, the
  `propagation_sample` table and `sync_run.p95_propagation_ms`/`propagation_samples`: the latency is
  measured from the mirror's `idp_group_member.updated_at` to the applied entitlement, and the run
  stores its p95 **with the number of changes it was measured across**, so a figure without a sample
  count cannot be quoted. The mirror-write p95 stays a separate, correctly named diagnostic that is
  not the AC-48 figure. Samples older than 30 days are pruned by the worker. The identity screens show
  each entitlement's product role, state and applied time, and the sync screen refuses to report a
  five-minute pass when no change was measured.
- **Environment drift is observed, and the declarative half of it is repaired** (`FR-1.29`, `FR-1.35`,
  `NFR-3.6`, `AC-43`) — the drift endpoint, schema and console panel were complete while nothing
  wrote a per-variable row, so the panel could only ever answer "no drift". M22 now compares every
  running container's `Config.Env` against the declared environment and the applied render set, and
  records one open row per drifted variable — missing, mismatched, or present but undeclared within
  the product's own prefix — with the direction derived from that comparison (`repo_ahead` when the
  declaration moved after apply, `runtime_ahead` when the container did, `unknown` when there is no
  baseline) instead of a constant. Secrets are compared by presence only and recorded as
  `<secret>`; a variable that stops drifting has its row closed, so the panel reflects the present. A
  scheduler pass (`SEAMNEX_DRIFT_INTERVAL_MS`, 5 min) audits new findings and queues the instance's
  own `reconfigure` for `repo_ahead` only, under a per-instance cooldown, while `runtime_ahead` stays
  open for an operator because silently reverting it would erase the only trace of the change. The
  same pass re-commits `instances/<slug>/instance.yaml` from the recorded projection when the file
  drifted, which clears the flag that otherwise blocked `start` until the control plane restarted. An
  instance whose containers cannot be inspected is reported as unobserved, never as clean. The
  environment table's per-variable drift badge now reflects the open rows instead of a proxy, and the
  drift panel no longer shows definition hashes relabelled as an "environment" variable
  (`ADR-BE-28`; no route, contract or schema change).
- **A full data export is an archive, not a description of one** (`FR-1.13`, `AC-20`, `NFR-6.3`) —
  the `export` action now dumps every database service in plain SQL (readable and loadable without
  this platform's tooling), archives every registered data volume, copies the applied render set and
  the resolved non-secret environment, writes a manifest with a SHA-256 per file plus a read-me for
  restoring the parts by hand, and packs all of it into one `.tar.gz` beside a sidecar record under
  `<instance data>/<id>/exports/`. Secret values are named in `instance/env.json` and never
  included. The action refuses rather than lies: an instance that was never deployed, or a declared
  database that cannot be dumped because the instance is not running, fails the job before the first
  helper runs and leaves no artefact, and `includes`/`excluded` are computed from what was written.
  Two reads make the archive reachable — `GET /instances/:id/exports` and `GET
/instances/:id/exports/:exportId/archive`, both `instance.lifecycle` (R1, the same capability that
  creates it) — with the archive streamed under `Content-Disposition`, the manifest's byte count,
  `no-store`, and an `instance.export.downloaded` audit row; the console gained an Exports tab
  listing each archive with what it holds, what it leaves out and its checksum. The engine, dump and
  restore knowledge moved to `common/engine/database.ts` so the backup runner and the export read
  the same rules instead of two copies of them (`docs/openapi.json` regenerated; delete-with-export
  ordering remains ISSUE-37).
- **The compose policy exception path works, and is scoped** (`FR-1.20`, `NFR-4.15`, `AC-33`,
  `FR-4.11`) — an R1 can now file an exception through `POST /admin/policy-exceptions` (new
  `exception.request` capability) instead of a hand-written `INSERT`; the request names a product, a
  rule, a written justification and an expiry, and the deviation the approver grants is read from the
  platform's own refused `source_resolution` rather than from the request body. The waiver is
  resolved by the catalog entry key, so an exception for one product no longer waives the rule for
  every product, and a lapsed one is reported as `expired` and quoted in the refusal. Migration `0034`
  adds `source_resolution.patch_diff` and `source_resolution.policy_violations` (design §10.1 step 5
  and §11.5 already promised the former): a blocked attempt is recorded with the violations it found
  and the substitutions it would have applied, and the applied patch is written into the render set as
  `policy-patch.json` next to the platform-owned copy. The Dockerfile and scaffold paths now pass the
  same blocking check as a Compose file — a `FROM` that is neither digest- nor version-pinned is
  refused (`unpinned_image`, waivable) — and the console gained the request dialog and matches an
  exception by product key rather than by a text fragment.
- **A platform restore restores** (`FR-1.35`, `FR-1.36`, `AC-30`, `AC-52`, `NFR-3.8`, `NFR-3.9`,
  `ADR-BE-27`) — the `platform-restore` pipeline now proves the recovery set before the first write
  (required artefacts present, every stored object matching its recorded digest), restores the identity
  provider's database and realm first and restarts it, fails the run when the provider never answers,
  restores the platform database, edge routes and catalogue fallback, and verifies the restored audit
  chain against the exported anchor. The control-plane database restore needs an owner credential
  (`SEAMNEX_PLATFORM_RESTORE_DB_URL`, restore-only) because the application role holds no DDL rights;
  without it the phase records `pnpm restore:platform-db` as an outstanding operator step and the run
  cannot end `complete`. The restore reinstates the running job's rows and the log/audit partitions
  the dump replaced, and settles the jobs the dump left active. The administrative login no longer
  completes the run: it records the login, reopens the gate and queues
  `platform-restore-products`, which restores each instance from its newest backup — volume archives,
  **engine dumps**, and the stored render set materialised on this host — at the run's configured
  concurrency, then fails unless every deployment is running and the identity provider answers. An
  ordinary instance restore now applies its engine dump too. `scripts/restore-platform-db.mjs`
  (`pnpm restore:platform-db`) is the clean-host path for operators who will not grant the platform an
  owner credential.
- **The product tier's job kind, and the settlement it needed** (`FR-1.36`, `ADR-BE-27`) — migration
  `0033` widens `deployment_job_kind_check` with `platform-restore-products` and `JOB_KINDS` gains it,
  without which the tier insert was refused on a real database and the run sat in `products` with
  nothing running. A tier that still cannot be queued settles the run `failed` with the queue's
  reason instead of leaving a `running` platform run that blocks every later restore. A failed product
  capture now settles its own `backup` row (audit `instance.backup.failed`), the Recovery register is
  platform-only, and volume archives use one compression both ways (`tar -czf`/`tar -xzf`) because the
  helper's busybox tar has no `--zstd`.
- **Product data volumes are recorded, measured and captured** (`FR-1.9`, `FR-1.12`, `AC-13`) — a
  deployment now registers the volumes Compose created, under the name the daemon gave them, with the
  catalog's mount path and per-volume quota, and drops the rows whose volume no longer exists. The
  status sampler measures each volume (`used_mb`, `sampled_at`), so the instance screen shows real
  usage with a near-quota and over-quota state, and the first sample that crosses a quota writes an
  `instance.volume.quota_exceeded` audit record. The limit is soft, as `DA-2` allows: the deploy is
  refused before anything is created when the declared quotas add up to more disk than the instance
  reserves, and the preview states the same shortfall. A backup of an instance whose applied
  definition declares volumes but none is registered fails with the reconfigure remediation instead
  of reporting a database-only set as complete.
- **Licence review workflow** (`ADR-BE-25`) — the auditor (R2) records obligations, restriction
  flags and the upstream LICENSE reference through `PUT /licenses/:instanceId/review`; the register
  shows the reviewer, date and evidence on every cleared row.
- **A platform recovery set that holds what it names** (`ADR-BE-26`) — a platform backup now captures
  and uploads the platform database, the identity provider's **database** and realm export, the edge
  route configuration, the audit anchors with the chain head, and a catalogue fallback copy, each with
  its byte count and a SHA-256 digest in a typed manifest. The secret-store root key and the operator's
  edge TLS material are recorded as references with their location (`SEAMNEX_ROOT_KEY_ESCROW_REF`,
  `SEAMNEX_EDGE_CONFIG_REF`), never bundled. A capture refuses before writing anything when
  `SEAMNEX_KEYCLOAK_DB_URL` or a required directory is missing, `.pgpass`/plaintext files do not
  outlive the upload, a failed set leaves no scratch copy, and a zero-byte artefact is refused rather
  than advertised. The escrow reference names the root key's non-secret id. Two settings make the
  capture work where the API runs in a container: `SEAMNEX_PLATFORM_DB_URL` is the platform database
  as the host-network dump helper reaches it, and `SEAMNEX_DOCKER_PATH_MAP` is the host spelling of a
  bind source (`containerPath=hostPath` pairs). Both default to empty, which is correct wherever the
  API's address and mount paths are already the host's.

### Changed

- **Verification records the facts the screens now quote** (`FR-2.10`, `FR-2.14`, `FR-2.15`, `AC-41`,
  `AC-50`) — the verification request carried a subset of the facts FR-2.14 names, and an empty one
  still restarted the review clock, which is how a catalogue assumption came to read as a verified
  one. `PATCH /catalog/:key/integration-metadata` now accepts the authentication path and guarantee
  class actually measured, the API base URL, the operation inventory, the event modes, SLO support,
  credential granularity and the session maximum, and refuses a request that changes nothing. The fact
  is written into `integration_metadata` — every fact column it has, not the two the old statement
  carried — and `verified_facts` accumulates what was checked until the next review, so an omitted
  field means "unchanged" and never "cleared". The audit row records the before/after value per field,
  and `verifiedAt`/`nextReviewAt`/`stale` move only because a fact arrived. The entry screen groups the
  facts it verifies (authentication, API surface, events, credentials) with the current value and its
  provenance, the registry prefers the verified `apiBaseUrl`, `authMethod`, `guaranteeClass`,
  `operationInventory`, `eventModes` and `sloSupported` while labelling the document's value a
  catalogue assumption, and an entry whose API cannot issue scoped credentials is reported as
  write-workflow-ineligible with the granularity that made it so.
- **"Verified" now means the objects are there** — verification listed the manifest and called that
  a check; it now requires every named dump and volume archive to exist in the target and every
  captured volume to carry a digest, and refuses with `BACKUP_UNUSABLE` naming what is missing. A
  restore re-creates a missing volume under the instance label before unpacking into it, and an
  instance backup's `includes` is computed from what was captured rather than asserted up front.
- **Recovery contents are read from the set, not asserted** — the "What the backup contains" panel is
  generated from the newest finished platform backup's manifest; an artefact shows `in` only when its
  object was stored, `ref` with the recorded location otherwise, and the panel states that no set has
  been captured when none has. A legacy manifest produces no claims, and the register's item count
  reflects stored artefacts.
- **Hosted-service gate** — an unreviewed licence now refuses
  `PUT /licenses/:instanceId/hosted-service` (409, audited) instead of being treated as permissive
  when the licence table already knows the term. The refusal sentence is shared by the API and the
  mock platform. Migration `0031` resets partial sign-offs and makes reviewer, date and reference
  all-or-nothing.
- **Volume facts where the decision is made** — the catalog entry lists each declared volume with its
  quota and the total against the disk reservation, the deploy wizard repeats the total beside the
  confirmation, and the instance panel's empty state says a backup is refused until the volumes are
  registered instead of describing a database-only one.

### Fixed

- **An upgrade applies the version the operator confirmed** (`FR-1.7`, `AC-06`) — the handler passed
  the confirmed version into `renderSetId`, so the job was handed a rollback selector and never knew
  what had been approved: the audit trail could not name it. The read model compounded it by deriving
  both versions from payload keys no producer writes, so the instance showed a version from the image
  tag and "no update" for ever, even where the catalogue pinned a newer one. The version now travels as
  `targetVersion` from the dialog through `LifecycleInput` into the job payload; the lifecycle call
  refuses a target that is already running or no longer matches the catalogue, the resolve step
  re-asserts it against the pin and refuses `STATE_CONFLICT` when the pin moved, and apply writes the
  version it applied into `payload.currentVersion`.
  `instance.upgrade.requested`, `.succeeded` and `.failed` name the version, the instance afterwards
  reports what is running beside any newer catalogue pin, and the delta the dialog shows comes from
  the entry's `upstream` rather than from a key nothing writes. The mock platform refuses an upgrade
  that carries no confirmed version, answers with both versions when the pin moved, and applies the
  pin it accepted instead of leaving the instance on the version it was on.
- **A profile is bound by the ceiling that caps it** (`FR-1.26`, `AC-51`) — the renderer tested the
  override ceiling on the instance branch and not on the profile branch, so a variable the declaration
  marks as not overridable was populated from `env_profile_value` in silence: the ceiling was enforced
  against the operator and not against the platform. A profile value over a `none` ceiling is now a
  `ceiling` field error that names the profile to fix, the resolved value falls back to the catalogue
  default instead of the value nobody was allowed to set, and an instance value for a `profile only`
  variable is still refused by the branch that always checked it.
- **Break-glass approver eligibility is enforced by the API, not only the console** (`FR-4.11`,
  `AC-47`, `NFR-4.4`) — an approver whose `breakglass.approve` grant is scoped (the R2 auditor) may
  approve a **read-only** elevation only, and a domain owner may approve an elevation only when one of
  their grants covers the domain or instance it targets. Both rules are decided on the row the
  decision transaction already locks, so the pending `access_mode` cannot be escalated between the
  check and the `UPDATE`. A refusal answers `403 APPROVAL_MODE_FORBIDDEN` or `403
APPROVAL_SCOPE_FORBIDDEN`, leaves the elevation `requested`, writes no `breakglass.approve` record
  and writes an `access.denied` row instead; a rejection is never gated, so an auditor can still
  decline a read-write request. The rule itself moved into `@seamnex/domain`
  (`break-glass-approval.ts`), which is what the console button and the mock platform now read: they
  had the only copy of it, which is why a caller that skipped the screen could have a read-write
  elevation approved and audited as legitimate.
- **Workflow write-target authority is enforced by the API, not only the mock** (`FR-5.9`, `AC-26`,
  `NFR-4.4`) — a definition may now be created, imported, edited, activated, disabled, duplicated,
  run, replayed, renamed or deleted only if the caller holds, for **every** product it writes to, R1
  (with an active read-write break-glass session on that instance), R3 over that product's domain, or
  R4 when its instance is the **only** write target. A refusal answers `403
WORKFLOW_WRITE_NOT_PERMITTED` naming the target and the missing authority, and writes an
  `access.denied` row; an authorisation that leans on an elevation records the elevation on the
  change's own audit row. `/workflows*` no longer refuses every scoped grant outright: the PDP
  resolves a workflow (or a run) to the instances it writes to, the list is filtered by the caller's
  scope, and a definition that writes nowhere stays visible to its author. A duplicate now leaves a
  `workflow.duplicated` record, and an edit keeps `workflow.write_targets` in step with the version.
  Which instance a write target means is decided once, in `@seamnex/domain`
  (`selectEgressInstance`), so authorisation, compilation and read scoping cannot rank two
  deployments of one product differently.
- **A domain owner can compose again** (`FR-5.2`, `FR-5.9`, `C-11`) — the workflow pickers were built
  from `GET /instances`, the fleet view guarded by `instance.view_logs`, which a domain owner (R3) and
  a product administrator (R4) are refused: both roles opened "New workflow", found two empty selects
  and could not create the workflow FR-5.9 grants them. They now read the integration registry
  (`registry.view`, full for both), which is where the builder's eligibility verdict already came
  from. An auditor (R2) is also no longer offered "New workflow"/"Import", which only ever answered
  `403`.
- **The dev seed reconciles a grant whose scope moved** (`FR-5.9`) — the domain owner is granted a
  catalog domain (`CRM & Sales Pipeline`) rather than the cluster that groups D1-D4, which resolved to
  no product at all. Re-seeding now removes the superseded row for the same subject and role instead
  of leaving a grant that matches no catalog entry beside the corrected one.
- **A failed job keeps the fix, not only the diagnosis** — the worker wrote the stage's message and
  dropped an `AppError`'s remediation, so the console showed "the database is not reachable" without
  the setting that makes it reachable. The remediation now travels into the failed step, the job log
  and the job's error detail.
- **Mock catalog quotas fit their shape** — the sample entry declared 40 GB of volumes on a 20 GB
  disk reservation, a configuration the platform now refuses; the fixture totals 19 GB, matching the
  seeded catalog.

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
