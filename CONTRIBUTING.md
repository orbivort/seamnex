# Contributing to Seamnex

**Applies to:** the whole repository · **Owner:** platform maintainers · **Last reviewed:** 2026-11-13

Contributions are welcome, with one limit: external code is not accepted yet
(§ [Licensing](#licensing)). This document covers what CI and review enforce: how to propose work, the
branch and commit conventions, what a pull request must contain, the standards the build cannot check,
and how a change merges. Everything from _Set up and run_ onward describes the workflow a maintainer
follows; it is public so that review is auditable. Setup and day-to-day commands live in
[`README.md`](README.md).

If something here is wrong or stale, that is a documentation defect — open an issue and a maintainer
fixes it.

## Contents

- [Before you start](#before-you-start)
- [Licensing](#licensing)
- [Set up and run](#set-up-and-run)
- [Quality gates](#quality-gates)
- [Reporting a bug](#reporting-a-bug)
- [Proposing a feature](#proposing-a-feature)
- [Branches and commits](#branches-and-commits)
- [Pull requests](#pull-requests)
- [Coding standards](#coding-standards)
- [Review and merge](#review-and-merge)
- [Releases](#releases)
- [Questions](#questions)

## Before you start

| Topic                  | Where                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Code of conduct        | [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — applies to issues, pull requests, reviews and every project space.                |
| Security reports       | [`SECURITY.md`](SECURITY.md) — **never** a public issue. A vulnerability reported in public exposes every self-hosted install. |
| Licence                | [`LICENSE`](LICENSE) — GPL-3.0-only, and pinning is deliberate: the GPL-3.0 §14 "or later" option is not granted.              |
| Third-party components | [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) — read before adding a dependency.                                          |

**Open an issue before code is written.** With outside code closed, the useful contribution today is an
issue: a defect with reproduction steps, a specification, or a change scoped before anyone builds it.
Scope agreed in an issue is cheaper than a pull request that licensing rules out, and a maintainer takes
it from there. A typo, a broken link or a stale paragraph is worth an issue too — this file calls that a
documentation defect, and it is fixed the same way.

## Licensing

Seamnex is distributed under `GPL-3.0-only` — version 3 only, not "or any later version": the GPL-3.0
§14 option to relicense under a later version is deliberately withheld. Every dependency inherits its own
terms, so read [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) before touching a `package.json`.

**No inbound grant.** External code contributions are not accepted at present. There is no CLA and none
is planned, so a patch from outside the project cannot be merged, however good the change is — the
useful contribution is an issue (§ [Before you start](#before-you-start)). Copyright stays with Orbivort,
which is what makes the outbound grant above accurate.

## Set up and run

Prerequisites, installation and the full command list are in [`README.md`](README.md). The short
version:

```powershell
corepack enable pnpm
pnpm install          # required before any test, dev server or build
pnpm mocks:init       # generates the MSW worker; not committed, required on a clean clone
pnpm dev:web          # both SPAs against the mock API: the fastest inner loop
```

- **One env file.** The repository-root `.env`, written from [`.env.example`](.env.example) on first
  `pnpm dev`. An `.env` inside an app is never read.
- **Mock or live.** `VITE_API_MODE=mock` (the default) runs the deterministic MSW platform in the
  browser; `live` drives the same screens against `apps/api`. Both are first-class — a change that
  works in only one mode is incomplete.
- **Ports.** Portal `:5173`, console `:5174`, API `:8080`. If a native PostgreSQL already holds
  `5432`, move the container with `SEAMNEX_PG_HOST_PORT` and keep `DATABASE_URL` in step.
- **Cross-platform.** Scripts are plain Node and run on Linux, macOS and Windows in CI; bash-only
  syntax is a defect.

### Where code goes

```text
apps/       portal (end users) · console (operators) · api (control plane)
packages/   domain (contract, state machines) · db (SQL) · mocks · api-client · shell · ui · utils · config
docker/     development stack, Keycloak realm, Traefik and observability configs
scripts/    cross-platform Node scripts
docs/       OpenAPI document
```

Imports flow one way: `domain` → `mocks` / `api-client` → `apps`, with `utils`, `ui` and `shell`
shared beneath them. The rules are lint-enforced from `packages/config/module-boundaries.json`, and
every package is consumed through its public entry point.

## Quality gates

Run the gates your change can affect before you ask for review. CI runs the same commands, so a red
local run is a red pull request.

| Command                 | Checks                                                              |
| ----------------------- | ------------------------------------------------------------------- |
| `pnpm typecheck`        | `tsc --noEmit` for every package and app                            |
| `pnpm lint`             | ESLint flat config, including module boundaries and `scripts/`      |
| `pnpm stylelint`        | Stylelint on every CSS file                                         |
| `pnpm format:check`     | Prettier; fix with `pnpm format`, never by hand                     |
| `pnpm test`             | Vitest: unit, jsdom app, API and database suites                    |
| `pnpm build`            | Typecheck, then production builds; fails if mock code ships         |
| `pnpm test:integration` | `@seamnex/db` then `@seamnex/api` against real PostgreSQL and Redis |

Gates for specific changes:

| Command                   | Run when                                        |
| ------------------------- | ----------------------------------------------- |
| `pnpm check:migrations`   | a migration was added or renumbered             |
| `pnpm check:route-policy` | a route was added or changed                    |
| `pnpm check:bundle`       | first-load size changed                         |
| `pnpm check:version`      | manifests or the release identity changed       |
| `pnpm check:license`      | any licence declaration or distributed artefact |
| `pnpm check:images`       | a container image tag changed (needs network)   |
| `pnpm check:s3`           | backup or S3 code changed                       |

Notes:

- Integration suites **skip** with a message when PostgreSQL or Redis is unreachable. A skip is not a
  pass: run `pnpm dev:stack` first if you changed `packages/db` or an API repository.
- While iterating, scope a turbo task: `pnpm exec turbo run lint --filter @seamnex/console`. Run the
  full command once before opening the pull request.
- The OpenAPI document is generated, never edited by hand. Regenerate and commit
  `docs/openapi.json` with the contract change:

  ```powershell
  $env:UPDATE_OPENAPI='1'; pnpm --filter @seamnex/domain test      # PowerShell
  ```

  ```bash
  UPDATE_OPENAPI=1 pnpm --filter @seamnex/domain test              # bash
  ```

## Reporting a bug

Use the **Bug report** form (`.github/ISSUE_TEMPLATE/bug_report.yml`) and fill in every required
field. A report a maintainer can reproduce contains:

- the affected component and the commit (`git rev-parse --short HEAD`) or release tag;
- the API mode, `mock` or `live` — the two platforms do not share fixtures;
- the shortest reliable reproduction, including URL parameters that change behaviour (`?role=`,
  `?scenario=`), the identity used and any prerequisite state;
- expected and actual behaviour, stated separately;
- evidence — logs, screenshot or HTTP transcript, with secrets and personal data redacted;
- impact: who is blocked and how badly. This sets priority.

Rules:

- **Never report a vulnerability publicly.** Follow [`SECURITY.md`](SECURITY.md).
- **Never paste production data**, customer records, tokens or live credentials. Reproduce with test
  identities against a disposable instance.
- One defect per issue. Search open and closed issues first; if you find a duplicate, add your
  reproduction there instead.
- Reports without a reproduction are labelled `needs-info` and closed after 30 days of silence.

## Proposing a feature

Use the **Feature request** form (`.github/ISSUE_TEMPLATE/feature_request.yml`), state the problem
before the solution. Acceptance criteria must be
testable: "the instance header shows drift" is; "better UX" is not.

Anything that changes the wire contract, the database schema, the authorisation matrix or a deployment
default needs an issue and a design note before implementation, and usually an ADR.

Proposals are assessed on requirement fit, architecture fit, testability and maintenance cost. A
declined proposal states the reason.

## Branches and commits

Work on a branch, never directly on `main`:

```text
<type>/<short-kebab-slug>
<type>/<issue-number>-<short-kebab-slug>     # when an issue exists
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/). The type drives release
notes, and the subject survives into `main` because pull requests are squash-merged.

| Type       | Use for                                         |
| ---------- | ----------------------------------------------- |
| `feat`     | A user-visible capability                       |
| `fix`      | A defect fix                                    |
| `docs`     | Documentation, ADRs, runbooks                   |
| `refactor` | Restructuring with no behaviour change          |
| `perf`     | A performance improvement, with its measurement |
| `test`     | Tests only, no production change                |
| `build`    | Build system, bundling, packaging, container    |
| `ci`       | Workflows, release automation, CI configuration |
| `chore`    | Housekeeping and dependency bumps               |
| `style`    | Formatting only, no code change                 |
| `revert`   | Reverting a commit; name the hash in the body   |

Branches reuse the same vocabulary: `feat/console-drift-badge`, `fix/142-instance-busy-409`,
`docs/contributing-scope`. Lowercase letters, digits and hyphens only; no personal names; one concern
per branch; rebase on `main` rather than merging it in. Delete the branch after merge.

```text
<type>(<scope>): <subject>

<body>

<footer>
```

**Scope** is the area, not the file: a workspace name (`portal`, `console`, `api`, `domain`, `db`,
`mocks`, `api-client`, `shell`, `ui`, `utils`, `config`) or an area (`docker`, `scripts`, `docs`,
`deps`, `release`). Omit it only for a genuinely repository-wide change.

- **Subject** — imperative mood ("add", not "added"), lowercase after the colon, no trailing full
  stop, 72 characters or fewer. Describe the effect, not the activity:
  `fix(api): reject an empty Idempotency-Key`, not `fix(api): changes to the request pipeline`.
- **Body** — why it changed and what was wrong before; the diff already shows what. Wrap at 72
  columns and separate it from the subject with a blank line. Name a trade-off you rejected or a
  follow-up you deliberately left out.
- **Footer** — `Closes #142` or `Refs #143`; `Refs: ADR-BE-18` when a decision is recorded.

A breaking change is marked twice — `!` and a footer that states the migration path:

```text
feat(domain)!: require a policy key on every mounted route

BREAKING CHANGE: a route without a policy key now fails at boot instead of
at first request. Add the key in packages/domain/src/contract.ts.
```

```text
feat(console): add drift badge to the instance header
fix(api): return 409 instance_busy instead of 500 on a second job
chore(deps): bump typescript to 6.0.3
```

History carries a few legacy types (`doc:`, `config:`). Use the table for new commits; do not rewrite
history to normalise old ones.

## Pull requests

Maintainers only, while § [Licensing](#licensing) keeps outside code closed. The template
(`.github/pull_request_template.md`) is the checklist — fill it in rather than replacing it with free
text.

**Before you open it:** rebase on `main`; confirm `pnpm install --frozen-lockfile` is clean; run the
gates your change can affect plus `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm format:check`;
regenerate `docs/openapi.json` if the contract changed; remove debugging output, commented-out code and
anything under `temp/`.

**Open it as a draft** while the direction is still open. Design feedback before the code is finished
is cheaper than a rewrite.

**The description carries** what changed and why (two or three sentences, linked with
`Closes #<number>`), the exact commands you ran plus the manual path for what a test cannot cover,
before/after evidence at desktop and 390 px for visual changes, risk and rollback for anything touching
auth, the PDP, secrets, migrations, backups or release automation, and the follow-ups you excluded.

**Size.** Aim for a change a reviewer can hold in their head — roughly 400 lines. Land a larger change
as a sequence that stays green (migration, repository, endpoint, screen); a mechanical change
(formatting, a rename) is its own pull request.

**While in review**, push follow-up commits — the merge squashes anyway. Do not force-push a branch
under active review unless you have said so in the conversation.

## Coding standards

The build enforces most of this. What it cannot enforce is judgement, so that part is written down.

### TypeScript

- Strict mode everywhere: no `as any`, no widened config, no `@ts-expect-error` without a note saying
  what will remove it.
- Parse untrusted input at the boundary (a Zod schema); do not assert it in the middle.
- Model states as unions and state machines, not contradicting booleans. Instance, break-glass and
  workflow transitions already live in `packages/domain`; extend them there.
- No dependency without a reason. Shared versions live in the workspace `catalog:`; add with
  `pnpm --filter <pkg> add <name>` and never hand-write a range into a manifest.

### React and the SPAs

- Function components and hooks only. Use the data layer: TanStack Query hooks from
  `@seamnex/api-client`, one query key factory, no ad-hoc `fetch` in a component.
- Every screen state renders: loading, empty, error, forbidden, success. A screen that silently renders
  nothing on failure is a defect — the transport normalises failures into a `ProblemDetail` so they can
  be rendered.
- Do not copy server state into `useState`; invalidate through the query key.
- Test what the user sees. A new screen brings at least one integration test against its own MSW
  server that asserts the rendered outcome, failure path included.
- Routes stay lazy-loaded and are registered in `packages/domain/src/routes.ts` with their requirement
  references.

### API (`apps/api`, NestJS on Fastify)

- Declare operations in `packages/domain/src/contract.ts`; never add a bare Fastify route.
- Authorisation is decided by the PDP. Every mounted route carries a policy key, and
  `pnpm check:route-policy` fails otherwise.
- State-changing writes go through `withAuditedMutation`: the audit row is appended in the same
  transaction, and a failing append refuses the change — fail closed, never best-effort.
- Failures are `application/problem+json` with `type`, `title`, `status`, `detail`, `code` and
  `fieldErrors`. Long operations return `202` with a job id rather than holding the request open.
- Never log a secret, token, password, session cookie or personal-data field. Repositories own SQL; a
  module does not query another module's table.

### Database and migrations

- Plain SQL pairs: `NNNN_name.up.sql` and `NNNN_name.down.sql`. A missing down file or a numbering gap
  fails `pnpm check:migrations`.
- Never edit an applied migration; add a new one.
- Invariants belong in the database — constraint, trigger, partial unique index — and are proven by a
  write that must fail in `packages/db/test/integration/invariants.test.ts`. An invariant enforced only
  in application code is not an invariant.

### Contract, mocks and scripts

- `packages/domain/src/contract.ts` is the single source; `docs/openapi.json` is generated from it and
  committed with it. A wire change is a review event — say which operations changed shape and why.
- A `ui` operation keeps a hook consumer; a test fails when the last one disappears. Declare
  `conditional` only where concurrency applies and `204` only for an operation with no body.
- Mocks are deterministic: no `Math.random()`, no `Date.now()` inside a fixture. Timestamps are offsets
  from the single load-time clock, which keeps screenshots and assertions stable. A contract change
  lands in the mock handlers in the same pull request; a new scenario is reset-clean.
- Scripts are cross-platform Node, fail loudly with a non-zero exit code, and write local artefacts to
  `temp/`.

### Styling and accessibility

- Tailwind tokens and the primitives in `packages/ui` come first; a one-off colour, spacing value or
  font size is a design-system defect.
- Accessibility is part of the contract: labelled inputs with `aria-describedby`/`aria-errormessage`,
  visible 2 px focus rings, 24×24 minimum targets, status by icon and text rather than colour alone,
  `aria-live` for job progress, `prefers-reduced-motion` respected. Tables use `aria-current`.
- The portal stays usable at 390 px, and the console rail becomes a focus-trapped sheet below 1024 px.
  Check both when you touch layout.

### Documentation

- A behaviour change updates the document that describes it — README, ADRs, runbooks and
  `.env.example` all count as code.
- An architectural decision gets an ADR in the existing format.
- Write for the next reader, who has the repository but not the conversation; prefer a number to an
  adjective.

## Review and merge

- **Automated gates first.** CI runs the quality gates, the Ubuntu/Windows/macOS matrix, the schema and
  audit suites, contract parity, and the image build with a Trivy scan. A red required job gets
  direction feedback, not a merge review.
- **Contribution policy before quality.** A pull request from someone other than the project owner is
  closed with a pointer to § [Licensing](#licensing). It is not reviewed, and it is not merged around
  the policy, however good the change is.
- **Approvals.** One for an ordinary change; two when it touches authentication, the PDP, secrets or
  cryptography, migrations, the audit chain, backup and restore, or the release workflow.
- **First response target: 5 business days.** A polite ping in the conversation is appropriate after
  that. Review is best-effort work; silence is not a rejection.
- **Answer with commits and explanations.** Do not rewrite a reviewed branch. A reasoned objection is a
  legitimate outcome — state the constraint that drives it, and resolve a thread only when the change
  or the explanation has landed.
- **Squash-and-merge.** The pull request title becomes the commit subject, so it must be a valid
  Conventional Commit. The branch is deleted after merge.
- **Stale pull requests** with no activity for 60 days are closed with a note; rebasing or reopening is
  welcome.

**Definition of done:** a test that fails without the change (or a stated reason plus manual evidence);
every gate green; documentation, `.env.example`, the contract and the ADRs updated where required; no
secret or personal data in the diff, fixtures or logs; revertable in one commit.

## Releases

Maintainers cut releases from tags. Contributors do not bump versions, edit `CHANGELOG.md` or tag
anything — a merged, gated pull request is the contribution. The release body is the `## [X.Y.Z]`
section of `CHANGELOG.md`, published as written; only when there is no such section — the first
release, or a tag cut before the bump merged — are notes generated from the commits since the
previous tag.

The tag is the version, and the repository keeps one copy of it: every manifest, the
`CONTRACT_DOCUMENT_VERSION` constant and therefore the committed `docs/openapi.json` carry the last
released version — `0.0.0` before the first release — and `pnpm check:version` fails when the copies
disagree. That copy is written in one place, never by hand:

- **Bump** — run the `version-bump` workflow from `main` with the version. It opens a `release/vX.Y.Z`
  pull request that moves every manifest, the contract constant and the regenerated
  `docs/openapi.json`, and turns `## [Unreleased]` in `CHANGELOG.md` into `## [X.Y.Z] - <date>`,
  leaving a fresh `## [Unreleased]` above it and moving the link definitions to `vX.Y.Z`. The
  version must sort above the one the manifests already carry. `node scripts/bump-version.mjs X.Y.Z`
  is the same edit locally.
- **Merge** — one approval and green gates. `ci.yml` is dispatched on the release branch for you,
  because a pull request opened with `GITHUB_TOKEN` does not start one. The number the repository
  states about itself is then that version, and a release refuses an identity its manifests
  disagree with.
- **Release** — `release-dispatch.yml`, or a pushed `vX.Y.Z` tag. That path re-runs CI, tags the merge
  commit and publishes the artefacts. `release-dispatch.yml` takes the version as an input, and
  `pnpm check:version` refuses it unless the bumped tree carries that number in every manifest, in
  `docs/openapi.json` and in the `## [X.Y.Z]` heading of `CHANGELOG.md`.

"Breaking" is a property of a self-hosted deployment, not of the diff:

| Change   | Bump                        | Examples                                                                                                                   |
| -------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Breaking | MAJOR (MINOR while `0.y.z`) | operation removed or reshaped; a new required variable; a secret or AAD format change; a migration whose `down` loses data |
| Feature  | MINOR                       | new operation, screen, role, deploy target or capability — backward compatible                                             |
| Fix      | PATCH                       | defect, refactor, dependency bump, documentation, performance, accessibility                                               |

A published tag is never moved, deleted or reused; a defective release is followed by `vX.Y.(Z+1)`.
Pre-releases are `vX.Y.Z-rc.N` and are published as pre-releases. Before `1.0.0` a MINOR may break;
`v1.0.0` declares `/api/v1` and the operator-facing configuration stable.

## Questions

- **A question about using the platform** — open an issue with the question label.
- **A question about contributing** — ask in the issue or pull request where the work is happening.
  Asking is cheaper than guessing, and the answer usually improves this document.
- **A security concern** — [`SECURITY.md`](SECURITY.md), privately.
- **A conduct concern** — [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), privately.

If this document and the build disagree, the build is right — and that is a documentation bug worth
reporting.
