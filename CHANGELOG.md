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
