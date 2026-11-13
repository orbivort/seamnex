# Changelog

All notable changes to **Seamnex** — a self-hosted, open-source platform that gives a small business one
identity, one portal and one operator console for the products it runs — are recorded here.

Format: [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) · Versioning:
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) · Licence: [GPL-3.0-only](LICENSE). The
version is the git tag (`vX.Y.Z`). This `## [Unreleased]` heading becomes the released version in the
`version-bump` pull request, which moves the same number through every manifest and the link
definitions at the foot of this file.

[Repository](https://github.com/orbivort/seamnex) · [Issues](https://github.com/orbivort/seamnex/issues) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## [Unreleased]

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
