import { MASK } from '../logging/masking';

/**
 * FR-5.5 — the rules that make a stored sample safe to show an author.
 *
 * The sample exists to name fields, not to preserve a record: an author needs `data[0].lastName` to
 * exist in the item, not the surname itself. Everything here is therefore lossy on purpose —
 * credential-shaped keys are replaced wholesale, addresses and phone numbers are masked in place,
 * strings are cut at 120 characters and the whole document at 4 KiB. `truncated` records that the
 * stored item is not the payload, so the console never implies completeness.
 */
const BLOCKED_KEY =
  /(pass(wd|word)?|secret|token|api[-_]?key|private[-_]?key|authorization|cookie|session|credential|csrf)/i;

/*
 * Both patterns are deliberately shallow (no nested repetition), which keeps them linear on hostile
 * input: this runs on every item of every run, and a backtracking pattern here would be a denial of
 * service dressed as privacy.
 */
const EMAIL_CANDIDATE = /[^\s"'<>]+@[^\s"'<>]+/g;
const PHONE_PATTERN = /\+?\d[\d ().-]{5,20}\d/g;

const MAX_STRING = 120;
const MAX_DEPTH = 6;
const MAX_KEYS = 50;
const MAX_ARRAY = 20;
const MAX_BYTES = 4_096;

export type RedactedSample = {
  /** `null` when nothing could be stored; the caller persists `null`, never a partial guess. */
  readonly item: unknown | null;
  /** Something was dropped: depth, key count, array length, string length or the byte ceiling. */
  readonly truncated: boolean;
};

/** Mask e-mail and phone shapes; a string that is one of them becomes the mask, not a redacted copy. */
export function maskPersonalData(value: string): string {
  return value
    .replace(EMAIL_CANDIDATE, (candidate) => (isEmail(candidate) ? MASK : candidate))
    .replace(PHONE_PATTERN, (candidate) => (isPhone(candidate) ? MASK : candidate));
}

/**
 * A candidate is a phone number only if it carries enough digits and is not a bare ISO date.
 *
 * The phone shape also matches `2026-11-12`, and masking that hid the value of every timestamp field
 * in the sample — the one screen whose purpose is showing an author what the item looks like. A date
 * identifies nobody, so it stays readable. Only a candidate that is *entirely* a date is exempt: the
 * pattern cannot reach past the date in `2026-11-12T08:41:00Z`, and a date followed by a real phone
 * number is still too long to match, so it is masked as a whole.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isPhone(candidate: string): boolean {
  const trimmed = candidate.trim();
  const digits = trimmed.replace(/\D/g, '').length;
  if (digits < 7) return false;
  return !ISO_DATE.test(trimmed);
}

/**
 * A candidate is an address only if it has one `@`, a non-empty local part and a dotted domain of
 * plausible label lengths. The rejection matters: `user@localhost` and `@scope` appear in real
 * payloads and masking them would destroy the field's usefulness without protecting anyone.
 */
function isEmail(candidate: string): boolean {
  const at = candidate.indexOf('@');
  if (at <= 0 || at !== candidate.lastIndexOf('@')) return false;
  const local = candidate.slice(0, at);
  const domain = candidate.slice(at + 1);
  if (local.length > 64 || domain.length > 253) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  return labels.every(
    (label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9-]+$/.test(label),
  );
}

/**
 * Redact one item. Never throws: a sample that cannot be processed is dropped with a `null`, because
 * a mirror pass must not fail over an authoring convenience.
 */
export function redactSample(input: unknown): RedactedSample {
  try {
    const state: WalkState = { truncated: false };
    const result = walk(input, 0, state);
    const serialised = JSON.stringify(result);
    if (serialised !== undefined && serialised.length > MAX_BYTES) {
      return { item: shrink(result), truncated: true };
    }
    // Anything a cap dropped is a truncation, not only the byte ceiling: an array cut at 20 or a
    // string cut at 120 characters is just as much "this is not the whole item".
    return { item: result, truncated: state.truncated };
  } catch {
    return { item: null, truncated: false };
  }
}

type WalkState = { truncated: boolean };

function walk(value: unknown, depth: number, state: WalkState): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const masked = maskPersonalData(value);
    if (masked.length > MAX_STRING) {
      state.truncated = true;
      return `${masked.slice(0, MAX_STRING)}…`;
    }
    return masked;
  }
  if (typeof value !== 'object') return null;

  if (depth >= MAX_DEPTH) {
    state.truncated = true;
    return '[depth-limit]';
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) state.truncated = true;
    return value.slice(0, MAX_ARRAY).map((entry) => walk(entry, depth + 1, state));
  }

  const source = value as Record<string, unknown>;
  const entries = Object.entries(source);
  if (entries.length > MAX_KEYS) state.truncated = true;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, MAX_KEYS)) {
    if (BLOCKED_KEY.test(key)) {
      output[key] = MASK;
      continue;
    }
    output[key] = walk(entry, depth + 1, state);
  }
  return output;
}

/**
 * Bring the serialised item under the byte ceiling by dropping the outermost entries, which is the
 * only cut that keeps the remaining document valid JSON. Field names survive longer than values
 * because the mapper reads the paths, not the contents.
 */
function shrink(value: unknown): unknown {
  let candidate = value;
  while (JSON.stringify(candidate).length > MAX_BYTES) {
    const next = dropOne(candidate);
    if (next === null) return null;
    candidate = next;
  }
  return candidate;
}

function dropOne(value: unknown): unknown | null {
  if (Array.isArray(value)) {
    return value.length === 0 ? null : value.slice(0, -1);
  }
  if (typeof value !== 'object' || value === null) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.slice(0, -1));
}
