import type { ApiOperation, FieldError } from '@seamnex/domain';
import { AppError } from '../problem/app-error';

/**
 * Deliverable 2.1: the request surface is the contract, not the handler.
 *
 * - Unknown query keys are rejected, because the client's transport only sends declared ones;
 * - a `prefix: true` declaration accepts `<name>.` keys and nothing else (`env.MAIL_HOST`);
 * - `values` is a closed set, and `type` is coerced before a handler sees it;
 * - a body is parsed with the operation's own zod schema, so the schema and the validator can
 *   never drift.
 *
 * Every failure lands in `fieldErrors[]` and is answered as `VALIDATION_FAILED`.
 */
export type ValidatedInput = {
  /** Declared scalar query values, coerced to their declared type. */
  readonly query: Readonly<Record<string, string>>;
  /** The `prefix` family, keyed by the suffix: `env.MAIL_HOST` → `MAIL_HOST`. */
  readonly families: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Parsed body (zod output), or `undefined` when the operation declares no request schema — an
   * operation without a schema accepts no body at all, so a handler can never read an unvalidated
   * value through this field.
   */
  readonly body: unknown;
};

export type RawRequestInput = {
  readonly query: Record<string, unknown>;
  readonly body: unknown;
};

export function validateRequest(operation: ApiOperation, input: RawRequestInput): ValidatedInput {
  const errors: FieldError[] = [];
  const query: Record<string, string> = {};
  const families: Record<string, Record<string, string>> = {};

  const declared = new Map((operation.query ?? []).map((parameter) => [parameter.name, parameter]));
  const prefixes = [...declared.values()].filter((parameter) => parameter.prefix === true);

  for (const [key, rawValue] of Object.entries(input.query)) {
    const value = singleValue(rawValue);
    if (value === undefined) continue;

    const parameter = declared.get(key);
    if (parameter !== undefined && parameter.prefix !== true) {
      const coerced = coerce(parameter.name, parameter.type, value, parameter.values, errors);
      if (coerced !== undefined) query[key] = coerced;
      continue;
    }

    const family = prefixes.find((candidate) => key.startsWith(`${candidate.name}.`));
    if (family !== undefined) {
      const suffix = key.slice(family.name.length + 1);
      if (suffix.length === 0) {
        errors.push({
          field: key,
          code: 'invalid_key',
          message: `"${key}" needs a name after the "${family.name}." prefix.`,
        });
        continue;
      }
      (families[family.name] ??= {})[suffix] = value;
      continue;
    }

    errors.push({
      field: key,
      code: 'unrecognized_key',
      message: `"${key}" is not a declared query parameter of ${operation.method} ${operation.path}.`,
    });
  }

  for (const parameter of declared.values()) {
    if (
      parameter.required === true &&
      parameter.prefix !== true &&
      query[parameter.name] === undefined
    ) {
      errors.push({
        field: parameter.name,
        code: 'required',
        message: `"${parameter.name}" is required.`,
      });
    }
  }

  const body = parseBody(operation, input.body, errors);

  if (errors.length > 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'The request does not match the declared surface of this operation.',
      fieldErrors: errors,
    });
  }

  return { query, families, body };
}

function parseBody(operation: ApiOperation, body: unknown, errors: FieldError[]): unknown {
  if (operation.request === undefined) {
    /*
     * No schema means no body. Returning the raw value made a handler's `input.body as { … }` the
     * only validation an operation had: any JSON reached the service, and removing `request:` from
     * the contract changed nothing at runtime. Now it is a 422 that names the operation, and a
     * handler that needs a body has to declare the schema it parses.
     */
    if (hasBody(body)) {
      errors.push({
        field: 'body',
        code: 'unexpected_body',
        message: `${operation.method} ${operation.path} declares no request body.`,
      });
    }
    return undefined;
  }
  const parsed = operation.request.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    errors.push({
      field: issue.path.length === 0 ? 'body' : issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    });
  }
  return undefined;
}

function coerce(
  name: string,
  type: 'string' | 'integer' | 'boolean',
  value: string,
  values: readonly string[] | undefined,
  errors: FieldError[],
): string | undefined {
  if (values !== undefined && !values.includes(value)) {
    errors.push({
      field: name,
      code: 'invalid_enum_value',
      message: `"${name}" must be one of: ${values.join(', ')}.`,
    });
    return undefined;
  }
  if (type === 'integer') {
    if (!/^-?\d+$/.test(value)) {
      errors.push({ field: name, code: 'invalid_type', message: `"${name}" must be an integer.` });
      return undefined;
    }
    return String(Number.parseInt(value, 10));
  }
  if (type === 'boolean') {
    if (!['true', 'false', '1', '0'].includes(value)) {
      errors.push({
        field: name,
        code: 'invalid_type',
        message: `"${name}" must be true or false.`,
      });
      return undefined;
    }
    return value === 'true' || value === '1' ? 'true' : 'false';
  }
  return value;
}

function hasBody(body: unknown): boolean {
  if (body === undefined || body === null) return false;
  if (typeof body === 'object' && !Array.isArray(body)) {
    return Object.keys(body as Record<string, unknown>).length > 0;
  }
  return true;
}

function singleValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}
