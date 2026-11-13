import { z } from 'zod';

// The pattern is named rather than inlined so the suppression below stays attached to the literal:
// the formatter moves a chained `.regex(...)` call onto its own line, and a directive that describes
// the wrong line is both wrong at review time and invisible to `reportUnusedDisableDirectives`.
// eslint-disable-next-line security/detect-unsafe-regex -- every quantifier has a fixed bound (4, 2, 2, 2, 1-3); there is no nesting to backtrack into.
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** ISO-8601 UTC instant. The prototype always emits `...Z`. */
export const TimestampSchema = z
  .string()
  .regex(TIMESTAMP_PATTERN, 'Expected an ISO-8601 UTC timestamp');

export const IdSchema = z.string().min(1);

// eslint-disable-next-line security/detect-unsafe-regex -- the inner and outer quantifiers both consume the same single character class, so the worst case is linear in the input length.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const SlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(SLUG_PATTERN, 'Slug must be lower-case alphanumeric with dashes');

/**
 * The two key grammars of ADR-BE-20, as pattern fragments so that one definition feeds both the
 * schema and `isComposedEntryKey`.
 *
 * Legacy is `D<domain>`; composed is `D<dd>-<pp>` with both halves 01–99. They are **disjoint** —
 * the composed form always carries a hyphen, the legacy form never does — so a value cannot parse as
 * both and nothing downstream has to guess which one it received.
 */
const LEGACY_ENTRY_KEY_BODY = '[1-9]\\d{0,2}';
const COMPOSED_ENTRY_KEY_BODY = '(?:0[1-9]|[1-9]\\d)-(?:0[1-9]|[1-9]\\d)';

/**
 * Catalog entry key. Deliberately open-ended: NFR-1.3 and AC-01 require a fourteenth product to be
 * added by configuration alone, so the contract must not cap the domain count.
 *
 * Both grammars are accepted while ADR-BE-20's migration is in flight: legacy `D1`/`D14`, which every
 * stored row and published bookmark uses, and composed `D01-01`/`D13-02`, which adds the product
 * ordinal and is the key every `platform/` asset already uses. Phase 3 narrows this to the composed
 * form once no legacy row survives; until then the alternation is what keeps a half-renamed tree
 * loadable.
 *
 * A single `regex` rather than a `refine`, because the pattern is published: `docs/openapi.json`
 * carries it for every key-bearing field, and a predicate would validate identically while
 * serialising to a bare `{"type": "string"}` — quietly removing the grammar from the document
 * clients validate against.
 */
export const EntryKeySchema = z
  .string()
  .regex(
    new RegExp(`^D(?:${LEGACY_ENTRY_KEY_BODY}|${COMPOSED_ENTRY_KEY_BODY})$`),
    'Expected a catalog entry key such as D1, D14 or D01-01',
  );

/** Whether a value uses the composed grammar — the form the ADR's later phases converge on. */
export function isComposedEntryKey(value: string): boolean {
  return new RegExp(`^D${COMPOSED_ENTRY_KEY_BODY}$`).test(value);
}

/**
 * ADR-BE-20 phase 1: every key this platform has published, and the composed key that replaces it.
 *
 * Frozen because the set closes permanently in phase 3 — after the rename nothing new can become
 * legacy. It is permanent code rather than a migration scratchpad: bookmarks, audit payloads,
 * `registry_snapshot` rows and `instance_params` written under `D3` outlive any deprecation window.
 *
 * Exactly the thirteen rows of the ADR's mapping table, in order. The values are the product `01`
 * of each domain, so the mapping is a bijection and phase 2 is reversible.
 */
export const LEGACY_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  D1: 'D01-01',
  D2: 'D02-01',
  D3: 'D03-01',
  D4: 'D04-01',
  D5: 'D05-01',
  D6: 'D06-01',
  D7: 'D07-01',
  D8: 'D08-01',
  D9: 'D09-01',
  D10: 'D10-01',
  D11: 'D11-01',
  D12: 'D12-01',
  D13: 'D13-01',
});

/**
 * The canonical key for a value that may still be legacy; a composed key resolves to itself.
 *
 * This is what lets a caller compare *identities* without first asking which grammar it was handed —
 * the seed's "is this product already declared?" check and the eventual `/catalog/D3` read path both
 * need exactly this and nothing more.
 */
export function resolveKey(key: string): string {
  return LEGACY_KEY_ALIASES[key] ?? key;
}

/** A catalog key reduced to the three parts that decide its position in a list. */
type ComparableEntryKey = {
  /** The letter before the ordinal, upper-cased: case is spelling, never meaning. */
  prefix: string;
  /** Domain ordinal — the `01` of `D01-02`. */
  group: number;
  /** Product ordinal — the `02` of `D01-02`. The legacy form has none and orders as product `01`. */
  item: number;
};

// The two grammars `EntryKeySchema` accepts, with the parts ordering cares about captured. The
// pattern fragments above stay the only definition of what a key looks like; this only reads them.
const COMPARABLE_ENTRY_KEY = new RegExp(
  `^([A-Za-z])(?:(${LEGACY_ENTRY_KEY_BODY})|(${COMPOSED_ENTRY_KEY_BODY}))$`,
);

function parseComparableEntryKey(key: string): ComparableEntryKey | null {
  const match = COMPARABLE_ENTRY_KEY.exec(key);
  if (match === null) return null;
  const prefix = (match[1] ?? '').toUpperCase();
  const legacyGroup = match[2];
  if (legacyGroup !== undefined) return { prefix, group: Number(legacyGroup), item: 1 };
  const composed = match[3] ?? '';
  const separator = composed.indexOf('-');
  return {
    prefix,
    group: Number(composed.slice(0, separator)),
    item: Number(composed.slice(separator + 1)),
  };
}

/** Code-unit comparison: locale-free, so every machine sorts a list the same way. */
function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Orders catalog keys ascending: `D01-01`, `D01-02`, `D02-01`, `D09-01`, `D10-01`.
 *
 * Text order is not this order. `D10` sorts before `D9` as text, and the legacy spelling of an entry
 * (`D9`) shares no prefix with its composed spelling (`D09-01`) — a half-renamed tree would list as
 * two sequences. So the comparison is structural: prefix letter, then domain ordinal, then product
 * ordinal, each ordinal read as a number. A legacy key has no product ordinal, so it takes the cell
 * of the `01` it aliases — the same reading `LEGACY_KEY_ALIASES` publishes — and `D3` lands among the
 * `D03-…` keys instead of at the end of the list.
 *
 * Different prefixes order by letter, so a key of another namespace is placed by its letter rather
 * than rejected; the ordering does not assume `D` is the only prefix that will ever exist.
 *
 * Two keys that agree on all three parts are one entry in two spellings (`D1`, `D01-01`). The raw
 * text settles that tie: it keeps the comparison total and the sort stable, without claiming either
 * spelling is meaningfully "before" the other. A caller asking whether two keys are the same entry
 * compares `resolveKey`d values instead — this function orders spellings, not identities.
 *
 * A value the grammar does not describe is not a catalog entry and has no ordinal, so it sorts after
 * every key that does, and among its own kind by code unit. That keeps the catalog readable while
 * still showing the odd value, instead of inventing a position for it.
 *
 * Total and non-throwing by construction: it never returns `NaN`, so any list can be sorted with it.
 */
export function compareEntryKeys(left: string, right: string): number {
  const a = parseComparableEntryKey(left);
  const b = parseComparableEntryKey(right);
  if (a === null || b === null) {
    if (a !== null) return -1;
    if (b !== null) return 1;
    return byCodeUnit(left, right);
  }
  return (
    byCodeUnit(a.prefix, b.prefix) ||
    a.group - b.group ||
    a.item - b.item ||
    byCodeUnit(left, right)
  );
}

export const NamedRefSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  email: z.string().min(3).optional(),
});

export const FieldErrorSchema = z.object({
  field: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
});

/** RFC 9457 `application/problem+json` (design §8.1). */
export const ProblemDetailSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string().min(1),
  code: z.string().min(1),
  fieldErrors: z.array(FieldErrorSchema).default([]),
  remediation: z.string().min(1),
});

export const JobAcceptedSchema = z.object({
  jobId: IdSchema,
  links: z.object({ self: z.string(), logs: z.string() }),
});

export const PageMetaSchema = z.object({
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
});

/** Cursor page envelope. Every list that can grow must use it, not a bare array. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().nonnegative(),
  });
}

export type Page<T> = { items: T[]; nextCursor: string | null; total: number };

export type FieldError = z.infer<typeof FieldErrorSchema>;
export type ProblemDetail = z.infer<typeof ProblemDetailSchema>;
export type JobAccepted = z.infer<typeof JobAcceptedSchema>;
export type NamedRef = z.infer<typeof NamedRefSchema>;
