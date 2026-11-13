export type SampleFieldType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

export type SampleField = {
  /** A path relative to the item, e.g. `lastName` or `data[0].email`. */
  readonly path: string;
  /** A short preview, never the whole value: the list exists to choose a path. */
  readonly value: string;
  readonly type: SampleFieldType;
};

export type ParsedSample =
  | { readonly ok: true; readonly fields: readonly SampleField[]; readonly truncated: boolean }
  | { readonly ok: false; readonly error: string };

const MAX_FIELDS = 200;
const MAX_DEPTH = 6;
const MAX_PREVIEW = 72;

/**
 * Turn a pasted item into the list of paths a mapping can use.
 *
 * The mapping's `from` is evaluated as `{{ $json.<path> }}` against the item the node receives, so
 * the paths here are relative to that item — not to the n8n item wrapper. Three shapes are accepted
 * because all three are what a person actually pastes:
 *   - the item itself: `{ "lastName": "Chen" }`
 *   - n8n's items array: `[{ "json": { … } }]`
 *   - one n8n item: `{ "json": { … } }`
 */
export function parseSample(text: string): ParsedSample {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, error: 'Paste an item to read its fields.' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error: 'That is not valid JSON. Paste the item exactly as the run shows it.',
    };
  }

  const root = unwrap(parsed);
  if (root === null) {
    return { ok: false, error: 'The sample has no object to read fields from.' };
  }

  const fields: SampleField[] = [];
  const state = { truncated: false };
  walk(root, '', 0, fields, state);
  if (fields.length === 0) {
    return { ok: false, error: 'The sample has no leaf fields to map.' };
  }
  return { ok: true, fields, truncated: state.truncated };
}

/** Best-guess target field for a source path: the leaf name, unchanged. */
export function targetGuessFor(path: string): string {
  const leaf = /(?:^|\.)([^.[\]]+)$|\[(\d+)\]$/.exec(path);
  if (leaf?.[1] !== undefined) return leaf[1];
  // `data[0]` has no name to offer; the author names the field.
  return '';
}

function unwrap(value: unknown): Record<string, unknown> | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (!isRecord(first)) return null;
  const json = first['json'];
  if (isRecord(json)) return json;
  return first;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(
  value: unknown,
  base: string,
  depth: number,
  out: SampleField[],
  state: { truncated: boolean },
): void {
  if (out.length >= MAX_FIELDS) {
    state.truncated = true;
    return;
  }
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push({ path: `${base}[0]`, value: '[]', type: 'array' });
      return;
    }
    // The first element only: every mapping `from` path has the same shape, and indexing 40 rows
    // would bury the field list the author is actually choosing from.
    walk(value[0], `${base}[0]`, depth + 1, out, state);
    if (value.length > 1) state.truncated = true;
    return;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      out.push({ path: base, value: '{}', type: 'object' });
      return;
    }
    for (const [key, entry] of entries) {
      if (out.length >= MAX_FIELDS) {
        state.truncated = true;
        return;
      }
      walk(entry, `${base}${segment(key, base.length === 0)}`, depth + 1, out, state);
    }
    return;
  }

  out.push({ path: base.length === 0 ? '$' : base, value: preview(value), type: typeOf(value) });
}

function segment(key: string, root: boolean): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return root ? key : `.${key}`;
  return `["${key.replace(/"/g, '\\"')}"]`;
}

function typeOf(value: unknown): SampleFieldType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'object';
  }
}

function preview(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ') : String(value);
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}…` : text;
}
