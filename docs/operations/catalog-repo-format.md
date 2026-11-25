# Catalog repository format

The platform serves a catalogue it does not own. The one it serves is a directory of JSON files on the
host, loaded by `POST /catalog/reload` and by `pnpm catalog:project`, and projected into
`catalog_entry` and `env_schema_var`. This page is the on-disk contract: what the loader reads, what it
refuses, and how it labels a revision.

Nothing in this repository is an instance of that format: the platform ships no documents, so the only
checkout this page describes is one fetched with `pnpm catalog:sync`, cloned by hand, or produced by an
operator. [`orbivort/seamnex-catalog`](https://github.com/orbivort/seamnex-catalog) is the reference
instance (ADR-BE-42).

## Where the loader looks

`SEAMNEX_CATALOG_REPO_PATH` names the repository root. A relative value is resolved against the
repository root, not against the working directory, so `./temp/catalog-repo` in the root `.env` means
the checkout's own `temp/`. The seed and the API resolve it identically; they never look at two
directories.

The loader reads exactly two paths under that root:

| Path                     | Holds                                 | Schema                |
| ------------------------ | ------------------------------------- | --------------------- |
| `catalog/<KEY>.json`     | one catalog entry per file            | `CatalogEntrySchema`  |
| `catalog/env/<KEY>.json` | one environment declaration per entry | `EnvSchemaFileSchema` |

`env/` is a subdirectory, never a sibling: every `*.json` directly under `catalog/` is read as an
entry, so `catalog/D01-01.env.json` would be reported as an invalid entry forever.

If `catalog/` is absent the tree is "no catalogue": the revision is `absent` and nothing is
reconciled. That is a legitimate state, not an error.

## Rules a file must satisfy

- **One document per identity.** `key` is the identity, so two files declaring the same key is a
  silent replacement rather than an addition. The loader resolves duplicates last-filename-wins,
  which is why the seed refuses to create one.
- **A composed key is its filename.** For a key in the `D01-01` grammar, the filename stem must equal
  the declared `key`; otherwise the artefact is refused by name and by declared key.
- **A declaration names its entry.** `entryKey` must equal the filename stem. The projector refuses a
  mismatch at apply time.
- **The served schema decides.** A file is parsed with the same schema the API publishes, so a
  document the console could not render is not accepted into the projection.
- **A refused file is not a deleted one.** Anything that fails to parse is reported in `invalid[]`
  and its identity is protected from removal. A typo reads as a typo, not as "the operator deleted
  the product".

## Revision labels

The revision recorded beside a projection is one of two kinds, and the platform does not invent a
third:

| Condition            | Label                                                           |
| -------------------- | --------------------------------------------------------------- |
| `<root>/.git` exists | `git rev-parse HEAD`                                            |
| no `.git`            | `content-<16 hex>`, a SHA-256 over the entries and declarations |
| `catalog/` absent    | `absent`                                                        |

The content hash covers both artefact kinds, so an environment-only edit still produces a new
revision, and a warm reload that finds no change writes nothing.

`pnpm db:seed` records a per-file `content-<16 hex>` instead, because it projects one document rather
than the tree it belongs to. The first reload therefore reports those entries as `updated` — that is
the truth: they were seeded from a file, not read from a revision. A checkout fetched by
`catalog:sync` does have a `.git`, so the same rows move to the commit on the first reload.

## Reconciliation

A reload projects what the tree declares and deletes the rows whose keys the tree no longer declares.
This is why a row is never seeded without a file behind it: the next reload would read that absence as
a deletion. A declaration whose entry document is missing cannot be projected, and is reported as
refused rather than applied.

## Where the catalogue comes from

The catalogue is deployable product content, and it lives in its own repository (ADR-BE-42):
`https://github.com/orbivort/seamnex-catalog`. The platform repository holds none of it — no entry
documents, no declarations, no upstream trees — so a clone of the platform has no catalogue to serve. A
virgin stack has an empty catalogue until one is acquired.

Acquisition is a server operation, because the request that swaps a tree is also the request that
records `catalog_commit` and reconciles the projection:

| Path                                                            | Use                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /catalog/sync`                                            | fetch a tag, swap it into the working tree, reload in one go                                |
| Catalog → "Sync from source"                                    | the same request, with the ref pre-filled and the receipt shown                             |
| `pnpm catalog:sync --ref <tag>`                                 | the same request from a script, given `SEAMNEX_API_TOKEN`                                   |
| `git clone --depth 1 --branch <tag> <mirror> temp/catalog-repo` | air-gapped hosts, then `pnpm db:seed` (documents) and `pnpm catalog:project` (declarations) |

The source URL is deployment configuration (`SEAMNEX_CATALOG_SOURCE_URL`), never a request field: a
signed-in operator choosing a ref cannot make the platform reach a host of their choosing. Empty is a
supported setting — the console action is disabled and explains what to run instead.

`pnpm db:seed` projects whatever the checkout declares, and writes nothing. It skips with exit 0 when
there is no checkout, naming `catalog:sync`; it fails when a checkout exists but yields no parseable
document, because projecting nothing is indistinguishable from a database nobody seeded.

`pnpm check:catalog` reads the same checkout (`SEAMNEX_CATALOG_REPO_PATH`), derives the key set from
the documents, and asserts the two halves pair up: every document has a declaration and every
declaration has a document, each document declares its own key and pins its image, and the coverage
the tag proves is reported against S-2's native floor. A missing checkout fails the gate rather than
passing vacuously.

### When the working tree is gone

The projection and the tree are two halves of one state, and they live in different places: the rows
are in PostgreSQL's volume, the documents are under `SEAMNEX_CATALOG_REPO_PATH` (by default
`./temp/catalog-repo`). Deleting `temp/`, moving the checkout or restoring a database onto another host
can therefore keep one half and lose the other. Both repair steps refuse by design — `pnpm db:seed`
projects only into an empty `catalog_entry`, and `pnpm catalog:project` stops rather than report
"nothing to project".

The repair is to put the checkout back at the tag the projection came from:

| Condition                         | Outcome                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `<root>/catalog` exists           | nothing to repair; the tree is the authority               |
| `catalog_entry` is empty          | `pnpm db:seed` projects the checkout                       |
| the checkout is gone              | `pnpm catalog:sync --ref <tag>` (or restore a `git clone`) |
| the tag is unknown or unreachable | refused, naming the code; nothing is written               |

The last row is the important one: rows from a tree this repository cannot reproduce are restored from
the catalogue repository or a backup, never reconstructed by guesswork. `pnpm catalog:restore` used to
do that from vendored files; it now prints this table and exits non-zero.
