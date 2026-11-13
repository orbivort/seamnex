<!--
  Thanks for the pull request. Fill this in; a template left as boilerplate tells a reviewer nothing.
  Read CONTRIBUTING.md before you request review — it lists the gates and the review process.
  Never include secrets, tokens, customer data or personal data in this description.
-->

## Description

<!-- What changes, and why. Two or three sentences is usually enough. Explain the constraint or the
     defect that motivated it; the diff already shows what the code does. -->

## Linked issues

<!-- Use a closing keyword so the issue closes on merge: Closes #123
     Use "Refs #123" for a related issue that must stay open. Write "None" if there is no issue. -->

Closes #

## Type of change

<!-- Tick the one that dominates. A pull request that is several of these usually wants splitting. -->

- [ ] Bug fix (non-breaking change that corrects a defect)
- [ ] Feature (non-breaking change that adds a capability)
- [ ] Refactor (behaviour-preserving restructuring)
- [ ] Performance improvement (state the measurement below)
- [ ] Documentation only
- [ ] Test only
- [ ] Build, CI or release automation
- [ ] Dependency update
- [ ] Deployment asset or configuration
- [ ] **Breaking change** (the migration path is required below)

## Scope

<!-- Which areas does this touch? Delete what does not apply. -->

- [ ] `apps/portal` · [ ] `apps/console` · [ ] `apps/api`
- [ ] `packages/domain` · [ ] `packages/db` · [ ] `packages/api-client`
- [ ] `packages/mocks` · [ ] `packages/ui` · [ ] `packages/shell`
- [ ] `packages/utils` · [ ] `packages/config`
- [ ] `docker/` · [ ] `platform/` · [ ] `scripts/` · [ ] `docs/`
- [ ] `.github/` (CI or release)

## How has this been tested?

### Automated

<!-- Tick what you ran and paste the result or the failing output. CI runs the same gates, so a
     claim here is checked, not taken on trust. -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm stylelint`
- [ ] `pnpm format:check`
- [ ] `pnpm build` (or `pnpm build:demo` for a demo-only change)
- [ ] `pnpm test:integration` (required for `packages/db` and `apps/api` data paths)
- [ ] `pnpm check:bundle` (required if first-load size changed)
- [ ] `pnpm check:migrations` (required if a migration changed)
- [ ] `pnpm check:route-policy` (required if a route was added or changed)

### Manual verification

<!-- The steps a test cannot cover: a role switch, a degraded scenario, a real container start.
     "Tested locally" is not a verification. -->

| Step | Expected | Observed |
| ---- | -------- | -------- |
|      |          |          |

## Screenshots or evidence

<!-- Required for a visual change: before and after, at desktop width and at 390 px. Note the
     keyboard focus order if interaction changed. Delete this section if it does not apply. -->

## Contract, schema and configuration impact

<!-- Delete the lines that do not apply; write "None" if the answer is none of them. -->

- **API contract:** no change / operations changed: `<operation ids>` — `docs/openapi.json` regenerated
- **Database schema:** no change / migration `NNNN_name` with its `.down.sql`
- **Capability matrix or PDP:** unchanged / described here
- **Environment variables:** unchanged / added to `.env.example` and `turbo.json` cache inputs
- **Mock fixtures or scenarios:** unchanged / updated to match the contract
- **Architecture decision:** no ADR needed / `ADR-BE-NN` added

## Risk and rollback

<!-- Required for anything touching authentication, the PDP, secrets, migrations, backups/restore or
     release automation. What fails if this is wrong, and how is it reverted? -->

- **Risk:**
- **Rollback:**

## Breaking change and migration path

<!-- Delete if this is not a breaking change. State what an existing self-hosted deployment must do,
     and whether the change is safe to apply before or after the code is upgraded. -->

## Checklist

- [ ] The change is focused on one concern, and the branch is rebased on `main`.
- [ ] Commits follow Conventional Commits, and the pull request title is a valid squash-merge subject.
- [ ] The new behaviour has a test that fails without this change — or this description explains why a test is impossible and what manual evidence replaces it.
- [ ] Documentation is updated where behaviour changed (`README.md`, `docs/`, `.env.example`, the ADRs).
- [ ] No secret, token, credential or personal data appears in the diff, fixtures, logs or screenshots.
- [ ] No debugging output, commented-out code or stray `console.log` is left behind.
- [ ] UI changes keep the accessibility contract: labelled inputs, visible focus, no colour-only status, usable at 390 px.
- [ ] No deep import crosses a module boundary, and no package is consumed outside its public entry point.
- [ ] A new dependency is pinned through the workspace `catalog:` (no `^` range, no hand-edited manifest).
- [ ] I have read `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.
- [ ] I am willing to address review feedback and follow-up defects this change introduces.

## Reviewer notes

<!-- Where should a reviewer look first? What are you unsure about? What did you deliberately leave
     out, and is there a follow-up issue for it? -->
