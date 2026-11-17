# Catalog repository format

The platform serves a catalogue it does not own. The one it serves is a directory of JSON files on the
host, loaded by `POST /catalog/reload` and by `pnpm catalog:project`, and projected into
`catalog_entry` and `env_schema_var`. This page is the on-disk contract: what the loader reads, what it
refuses, and how it labels a revision.

The default set that ships with the repository is an instance of the same format, not a second one —
see [the default set](#the-default-set) at the end.

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

`pnpm db:seed` records a per-file `content-<16 hex>` instead, because it projects a file it just wrote
rather than a tree under version control. The first reload therefore reports those entries as
`updated` — that is the truth: they were seeded, not read from a revision.

## Reconciliation

A reload projects what the tree declares and deletes the rows whose keys the tree no longer declares.
This is why a row is never seeded without a file behind it: the next reload would read that absence as
a deletion. A declaration whose entry document is missing cannot be projected, and is reported as
refused rather than applied.

## The default set

A virgin stack has no catalogue. `pnpm db:seed` materialises a checked-in default set into the working
tree — `catalog/<KEY>.json` and `catalog/env/<KEY>.json` — and then projects it, but only into a
`catalog_entry` that is empty. An operator's catalogue is never topped up, merged into or replaced.

The default set lives beside the shipped catalogue artefacts, not inside them:

| Path                                  | Holds                                                    |
| ------------------------------------- | -------------------------------------------------------- |
| `platform/default-catalog/<KEY>.json` | the entry documents the seed copies                      |
| `platform/catalog/env/<KEY>.json`     | the declarations the seed copies, one owner per artefact |

`platform/default-catalog/` is deliberately **not** `platform/catalog/`. The latter is shaped like a
catalog root (`env/` inside it), so entry documents at its root would turn it into a loadable
repository holding only the default set — and a reload against it would delete every other entry.
A sibling directory is read by nothing.

`pnpm check:catalog` asserts the two halves pair up: every key in `DEFAULT_PRODUCT_KEYS` has a
document and a declaration, every document and declaration belongs to a key, each document parses as
the served schema and pins its image, and the coverage the set proves is reported against S-2's native
floor.
