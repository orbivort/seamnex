/**
 * Mask by default (exit criterion 7).
 *
 * Two independent mechanisms, because one of them will be forgotten:
 *   1. key-based masking here, applied to every object that leaves the process in a log line, an
 *      error payload or a job log;
 *   2. pino's own `redact` paths on the transport, for the fields a logger formats itself.
 *
 * A canary test asserts that a known secret value never appears in captured output.
 */

export const MASK = '********';

const SENSITIVE_KEY =
  /(secret|password|passwd|token|credential|authorization|cookie|csrf|session[-_]?id|api[-_]?key|private[-_]?key|hmac)/i;

/** Values that look like a bearer token or a long opaque credential are masked even under an innocent key. */
const SENSITIVE_VALUE =
  /^(bearer\s+\S+|basic\s+\S+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)$/i;

/**
 * Free text is a second leak path: a job log line such as `client_secret=abc` has no key to match,
 * so the assignment is redacted in place.
 *
 * Two shapes, because one colon rule masked prose: a key is followed by a value when it assigns one
 * (`KEY=value` anywhere) or when it opens a line (an env file, a YAML or JSON dump). Matching any
 * `…PASSWORD:` turned a diagnostic into nonsense — Compose's "required variable
 * ORANGEHRM_DATABASE_ROOT_PASSWORD is missing a value" reached the job log as
 * "MARIADB_ROOT_PASSWORD: ******** variable …", which reads as though a credential had been
 * printed there and hides the word the operator needs.
 */
const CREDENTIAL_KEY_SOURCE = String.raw`[\w.-]*(?:secret|password|passwd|token|credential|authorization|api[-_]?key|private[-_]?key|hmac)[\w.-]*`;
const VALUE_SOURCE = String.raw`(?:"[^"]*"|'[^']*'|[^\s,;&]+)`;
const LINE_ASSIGNMENT = new RegExp(
  `(^[ \\t]*${CREDENTIAL_KEY_SOURCE}[ \\t]*:[ \\t]*)${VALUE_SOURCE}`,
  'gim',
);
const KEY_ASSIGNMENT = new RegExp(`(${CREDENTIAL_KEY_SOURCE}\\s*=\\s*)${VALUE_SOURCE}`, 'gi');

export function maskText(value: string): string {
  return value.replace(LINE_ASSIGNMENT, `$1${MASK}`).replace(KEY_ASSIGNMENT, `$1${MASK}`);
}

export function maskValue(value: string): string {
  return SENSITIVE_VALUE.test(value) ? MASK : maskText(value);
}

/**
 * Depth-limited deep mask. A cyclic structure returns a placeholder instead of recursing, because
 * a logger must never be the reason a request dies.
 */
export function maskDeep<T>(input: T, depth = 0, seen = new WeakSet<object>()): T {
  if (depth > 8) return '[depth-limit]' as unknown as T;
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') return maskValue(input) as unknown as T;
  if (typeof input === 'number' || typeof input === 'boolean' || typeof input === 'bigint')
    return input;

  if (Array.isArray(input)) {
    return input.map((item) => maskDeep(item, depth + 1, seen)) as unknown as T;
  }

  if (input instanceof Date) return input;
  if (Buffer.isBuffer(input)) return MASK as unknown as T;

  if (typeof input === 'object') {
    if (seen.has(input)) return '[circular]' as unknown as T;
    seen.add(input);

    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY.test(key) ? MASK : maskDeep(value, depth + 1, seen);
    }
    return output as unknown as T;
  }

  return input;
}

/**
 * Removes one known value from free text.
 *
 * The key-based masks above cannot help with a product's own error page: a password-policy `422`
 * re-describes the submitted form input under no key at all. A caller that holds the credential
 * scrubs against it explicitly, which is the only check that does not rest on the product's
 * behaviour (ADR-BE-22 §Credentials, "exposure").
 */
export function redactValue(value: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return value;
  return value.split(secret).join(MASK);
}

/** True when a rendered line still contains the canary. Used by the leak test. */
export function containsCanary(line: string, canary: string): boolean {
  return canary.length > 0 && line.includes(canary);
}
