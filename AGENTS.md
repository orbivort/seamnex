# AGENTS.md

Instructions for AI coding assistants working in this repository. Applies to everything under the
workspace root. [`CONTRIBUTING.md`](CONTRIBUTING.md) remains the human-facing source of truth; where
the two disagree, `CONTRIBUTING.md` wins.

---

## Role

- Act as a senior engineer on this codebase, not a code generator. Read before writing.
- Own the change end to end: implement, verify, report what you ran and what you did not.
- Prefer the smallest correct change. No drive-by refactors, no speculative abstractions.
- Never invent repository facts. If you have not read it, do not assert it.

## Stack

| Area     | Reality                                                                        |
| -------- | ------------------------------------------------------------------------------ |
| Runtime  | Node.js 24 (`>= 24.15.0 < 25`), pnpm 11.21 via Corepack, Turbo workspace       |
| Language | TypeScript 6, strict mode; no build step for `scripts/*.mjs`                   |
| Apps     | `apps/api` (NestJS + Fastify), `apps/console`, `apps/portal` (React 19 + Vite) |
| Packages | `packages/{domain,db,ui,shell,api-client,mocks,utils,config}`                  |
| Data     | PostgreSQL 18 + plain SQL migrations in `packages/db`                          |
| Tests    | Vitest; MSW for HTTP mocks                                                     |

## Conventions

- Versions live only in the `catalog` in `pnpm-workspace.yaml`. Add dependencies with
  `pnpm add`; never hand-write a range into a `package.json`.
- Formatting is Prettier, lint is ESLint, CSS is Stylelint — all configured in `packages/config`.
  Do not override rules locally; fix the code.
- File names are kebab-case (`run-role.ts`); classes and types are PascalCase; imports are
  extensionless relative paths or workspace package names (`@seamnex/db`).
- Keep comments for the _why_. No commented-out code, no narration of type signatures.
- Docs are reviewed like code: short sections, sentence-case headings, tables over prose walls.
  Architectural decisions belong in an ADR, not in a pull-request comment.

## Workflow

1. **Locate** — search the repo before proposing. Check `docs/`, the matching ADR, and neighbouring
   files so the change fits existing patterns.
2. **Plan** — for anything beyond a typo or a one-line fix, state the plan and the files you will
   touch before editing.
3. **Edit** — targeted edits with the file tools. Re-read a file before replacing large regions.
4. **Verify** — run the narrowest relevant check, then widen. See gates below.
5. **Report** — what changed, what you ran, what failed, what still needs a human.

Ask a question only when blocked or when the action needs approval (dependency, contract, schema,
deletion). Otherwise choose the conservative option, state the assumption, and proceed.

## Quality gates

```powershell
pnpm typecheck          # turbo typecheck across the workspace
pnpm lint               # ESLint, --max-warnings=0
pnpm stylelint          # CSS
pnpm format:check       # Prettier
pnpm test               # unit tests inside each package
```

Conditional gates — run the one your change touches: `pnpm check:migrations`, `check:route-policy`,
`check:version`, `check:license`, `check:bundle`, `check:no-shim`, `check:test-tasks`.
Report a gate you skipped as skipped; never claim a run that did not happen.

## Boundaries

- **Ask first:** adding a dependency, changing an API contract or route policy, writing a schema
  migration, deleting files, touching CI, Docker or `platform/` assets, regenerating the committed
  artifact `docs/openapi.json`.
- **Never:** commit `.env*`, keys or tokens; print secret values; edit generated output by hand;
  commit the MSW worker (`*/public/mockServiceWorker.js` — untracked, written by `pnpm mocks:init`);
  weaken or skip a lint rule, test or gate to make a change pass; rewrite git history.
- **Never touch** `temp/` outside your own scratch subdirectory — it holds live runtime state
  (instances, backups, keys) that no rebuild reproduces. Scratch files go in `temp/agent/`.
- Cite requirement ids (`FR-*`, `NFR-*`, `AC-*`) when behaviour changes, and record a version bump
  where `CHANGELOG.md` expects one.
- Say "I don't know" and go read the code. A confident wrong answer costs more than a slow one.
