import { mappingExpression, mappingPath } from './mapping-expression';
import type { FieldMapping } from './schemas/workflow';

/**
 * FR-5.5 — the conversions a mapping may name, and how each becomes an expression.
 *
 * `FieldMappingSchema.transform` is a free string on the wire ("the shape is contractual so the
 * backend can implement it without a further schema change"), so the platform has to decide what it
 * *means*. A prose value ("currency → EUR") cannot be compiled by any backend, and the compiler used
 * to drop the field entirely: the mapping activated, ran, and sent the unconverted value. The
 * catalogue is therefore closed and named here, exactly as ADR-BE-24 §2 closed the target-field
 * question — strict where the platform owns the knowledge, silent where it does not.
 *
 * `output` is what the conversion produces, and it is not documentation: a `defaultValue` is stored
 * as text, so the compiler needs to know whether to emit `12`, `"12"` or `true` when the field is
 * missing, and validation needs to refuse a default a numeric conversion would turn into `NaN`.
 */
export const MAPPING_TRANSFORMS = [
  { name: 'text', label: 'Text', output: 'text' },
  { name: 'trim', label: 'Trim whitespace', output: 'text' },
  { name: 'lower', label: 'Lowercase', output: 'text' },
  { name: 'upper', label: 'Uppercase', output: 'text' },
  { name: 'number', label: 'Number', output: 'number' },
  { name: 'integer', label: 'Whole number', output: 'integer' },
  { name: 'boolean', label: 'Yes / no', output: 'boolean' },
  { name: 'date_iso', label: 'Date (ISO 8601, YYYY-MM-DD)', output: 'date' },
  { name: 'datetime_iso', label: 'Date and time (ISO 8601, UTC)', output: 'datetime' },
  { name: 'currency_minor_to_major', label: 'Currency: cents → units', output: 'number' },
  { name: 'currency_major_to_minor', label: 'Currency: units → cents', output: 'integer' },
  { name: 'kg_to_lb', label: 'Mass: kg → lb', output: 'number' },
  { name: 'lb_to_kg', label: 'Mass: lb → kg', output: 'number' },
  { name: 'cm_to_in', label: 'Length: cm → in', output: 'number' },
  { name: 'in_to_cm', label: 'Length: in → cm', output: 'number' },
  { name: 'c_to_f', label: 'Temperature: °C → °F', output: 'number' },
  { name: 'f_to_c', label: 'Temperature: °F → °C', output: 'number' },
] as const;

export type MappingTransform = (typeof MAPPING_TRANSFORMS)[number];
export type TransformOutput = MappingTransform['output'];

/**
 * What happens to a mapping when the source item has no such field.
 *
 * `keep` is the buttoned-down default and the reason this is not a new required field: an existing
 * definition that declares neither `required` nor `onMissing` compiles byte-identically to before, so
 * activating an unchanged workflow cannot change what it sends. Declaring `required: true` implies
 * `fail` — a field the author marked required that is silently dropped is the defect FR-5.5 names.
 */
export type MissingPolicy = 'keep' | 'fail' | 'skip' | 'default';

/** The canonical name of a transform, or `null` when the mapping declares none. */
export function normaliseTransform(transform: string | null | undefined): string | null {
  if (transform === null || transform === undefined) return null;
  const name = transform.trim().toLowerCase();
  return name.length === 0 ? null : name;
}

export function isMappingTransform(name: string | null | undefined): boolean {
  const normalised = normaliseTransform(name);
  return normalised !== null && APPLY[normalised] !== undefined;
}

/** The value a transform produces; `null` for an unknown name, which validation refuses first. */
export function transformOutput(name: string | null | undefined): TransformOutput | null {
  const normalised = normaliseTransform(name);
  if (normalised === null) return null;
  return MAPPING_TRANSFORMS.find((transform) => transform.name === normalised)?.output ?? null;
}

/** The names an error message offers, in catalogue order. */
export function transformNames(): readonly string[] {
  return MAPPING_TRANSFORMS.map((transform) => transform.name);
}

export function missingPolicy(
  mapping: Pick<FieldMapping, 'required' | 'onMissing'>,
): MissingPolicy {
  if (mapping.onMissing !== undefined && mapping.onMissing !== null) return mapping.onMissing;
  return mapping.required === true ? 'fail' : 'keep';
}

/**
 * Why a `defaultValue` cannot be used, or `null` when it can.
 *
 * Validation calls this so the refusal is one sentence in one place: `defaultValue` is text on the
 * wire, and `Number("approx. 40")` evaluates to `NaN`, which n8n then serialises as `null` — a
 * default the author wrote, a value the product never receives, and nothing in between that says so.
 */
export function defaultValueProblem(mapping: FieldMapping): string | null {
  if (missingPolicy(mapping) !== 'default') return null;
  const value = mapping.defaultValue;
  if (value === null || value === undefined || value.trim().length === 0) {
    return `Mapping "${mapping.to}" substitutes a default when the value is missing, but no default is set.`;
  }
  const output = transformOutput(mapping.transform);
  if (output === null) return null;
  if (output === 'number' || output === 'integer') {
    const numeric = Number.isFinite(Number(value));
    if (output === 'number') {
      return numeric
        ? null
        : `Mapping "${mapping.to}" converts to a number, but its default "${value}" is not numeric.`;
    }
    return /^-?\d+$/.test(value.trim())
      ? null
      : `Mapping "${mapping.to}" converts to a whole number, but its default "${value}" is not one.`;
  }
  if (output === 'boolean') {
    return /^(true|false|yes|no|1|0)$/i.test(value.trim())
      ? null
      : `Mapping "${mapping.to}" converts to yes/no, but its default "${value}" is neither.`;
  }
  return null;
}

/**
 * FR-5.5 — the `=<expression>` one body parameter compiles to.
 *
 * A mapping that declares no conversion and no policy returns exactly what the compiler emitted
 * before this existed (`={{ $json.path }}`), so a definition that never opted in must not be
 * re-pointed by a version bump.
 *
 * Otherwise the result is one ternary, because a body parameter's value has to stay a single
 * expression: n8n resolves `{{ … }}` per value and encodes the object itself, while a JSON string
 * body with an interpolated expression sends the literal text (see `compile`). The missing test is
 * `(value ?? '') === ''`, which covers the three shapes a product answers with for "not provided" —
 * absent, `null`, and an empty string — in one comparison, and leaves `0` and `false` alone.
 */
export function mappedValueExpression(mapping: FieldMapping): string {
  const policy = missingPolicy(mapping);
  const transform = normaliseTransform(mapping.transform);
  // An unknown name is validation's business (`UNKNOWN_TRANSFORM`); here it degrades to the path.
  const known = transform === null ? null : (APPLY[transform] ?? null);

  if (known === null && policy === 'keep') return `=${mappingExpression(mapping.from)}`;

  const path = mappingPath(mapping.from);
  const present = known === null ? path : known(path);
  const missing = missingValue(mapping, policy, path);
  return `={{ (${path} ?? '') === '' ? ${missing} : ${present} }}`;
}

/**
 * What the missing branch evaluates to.
 *
 * `fail` is a throw rather than a sentinel: FR-5.5 asks for explicit handling, and a required value
 * that reaches the product as `undefined` is handled by the product, after a record may already have
 * been half-written. n8n reports a thrown expression as an expression error on the node, which is
 * the failed run the operator can inspect and replay (FR-5.7).
 */
function missingValue(mapping: FieldMapping, policy: MissingPolicy, path: string): string {
  if (policy === 'fail') {
    return `(() => { throw new Error(${JSON.stringify(`Missing required value for "${mapping.to}" (${mapping.from})`)}); })()`;
  }
  if (policy === 'skip') return 'undefined';
  if (policy === 'default') return defaultLiteral(mapping);
  return path;
}

/**
 * A default is text on the wire and is **not** converted: it stands in for the value the product
 * receives, so the author writes it in the target's units and validation (`defaultValueProblem`)
 * refuses one the conversion's type cannot hold. Emitting it typed is the only translation needed.
 */
function defaultLiteral(mapping: FieldMapping): string {
  const value = mapping.defaultValue ?? '';
  const output = transformOutput(mapping.transform);
  if (output === 'number' || output === 'integer') return String(Number(value));
  if (output === 'boolean') return /^(true|yes|1)$/i.test(value.trim()) ? 'true' : 'false';
  return JSON.stringify(value);
}

/**
 * One applier per catalogue entry, each wrapping the dereferenced path.
 *
 * `DateTime` is Luxon, which n8n exposes to expressions; `fromISO` is the only parser that accepts
 * both a date and a date-time, which is what "normalise the date this product sends" has to survive.
 */
const APPLY: Record<string, (value: string) => string> = {
  text: (value) => `String(${value})`,
  trim: (value) => `String(${value}).trim()`,
  lower: (value) => `String(${value}).toLowerCase()`,
  upper: (value) => `String(${value}).toUpperCase()`,
  number: (value) => `Number(${value})`,
  integer: (value) => `Math.trunc(Number(${value}))`,
  boolean: (value) =>
    `!['false', '0', 'no', 'off', ''].includes(String(${value}).trim().toLowerCase())`,
  date_iso: (value) => `DateTime.fromISO(String(${value}), { zone: 'utc' }).toISODate()`,
  datetime_iso: (value) => `DateTime.fromISO(String(${value}), { zone: 'utc' }).toISO()`,
  currency_minor_to_major: (value) => `Math.round(Number(${value})) / 100`,
  currency_major_to_minor: (value) => `Math.round(Number(${value}) * 100)`,
  kg_to_lb: (value) => `Number(${value}) * 2.2046226218`,
  lb_to_kg: (value) => `Number(${value}) / 2.2046226218`,
  cm_to_in: (value) => `Number(${value}) / 2.54`,
  in_to_cm: (value) => `Number(${value}) * 2.54`,
  c_to_f: (value) => `(Number(${value}) * 9) / 5 + 32`,
  f_to_c: (value) => `((Number(${value}) - 32) * 5) / 9`,
};
