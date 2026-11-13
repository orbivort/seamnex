import { z } from 'zod';

/**
 * The machine-checkable half of an environment declaration.
 *
 * `constraint` is prose for the operator and nothing ever parsed it. That is how a 12-character
 * `MB_ENCRYPTION_SECRET_KEY` reached a container whose declaration asked for 64 hexadecimal
 * characters: the declaration was correct, the platform agreed with it in a sentence, and the
 * deployment then spent its whole 20-minute `verify` window waiting for a JVM that had already
 * aborted on `MB_ENCRYPTION_SECRET_KEY must be at least 16 characters`.
 *
 * `rule` is the same statement in a shape the loader, the resolver and the wizard can enforce:
 *
 *   - `minLength` / `maxLength` — characters, counted the way the product counts them;
 *   - `pattern` — a JavaScript regular-expression source, tested with `RegExp.test`;
 *   - `patternDescription` — what the pattern means in words, for the message beside the field;
 *   - `disallow` — values refused outright, compared case-insensitively;
 *   - `notNumeric` — refuses a value that parses as a number.
 *
 * `notNumeric` is not a strength rule, it is a *transport* rule. Products that build their own
 * configuration from environment variables routinely infer the type from the shape of the value, so
 * a digits-only client secret is stored as a float and the product then authenticates with a
 * different string than the one that was registered. `pattern` cannot express this without also
 * fixing an alphabet, and a refused value needs a message that names the mechanism rather than
 * "does not match the declared format".
 *
 * It is optional so every declaration written before it existed still parses, and it is enforced
 * wherever a value resolves (preview, deploy, `PUT /instances/:id/env`), so the preview and the
 * 422 cannot disagree.
 */
export const EnvVarRuleSchema = z.object({
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().min(1).optional(),
  /** What `pattern` means in words; the message falls back to `constraint` and then to the pattern. */
  patternDescription: z.string().min(1).optional(),
  disallow: z.array(z.string().min(1)).optional(),
  /** Refuse values a type-inferring consumer would read as a number, including `1e12` and `-0.5`. */
  notNumeric: z.boolean().optional(),
});

export type EnvVarRule = z.infer<typeof EnvVarRuleSchema>;

/** The codes a field error carries, so a screen can group them instead of matching on prose. */
export type EnvRuleCode =
  'min_length' | 'max_length' | 'pattern' | 'disallowed_value' | 'numeric_value';

export type EnvRuleViolation = { code: EnvRuleCode; message: string };

/** What the checker needs from a declaration; `EnvSchemaVar` satisfies it structurally. */
export type EnvRuleTarget = {
  readonly name: string;
  readonly type: string;
  readonly rule?: EnvVarRule | undefined;
  readonly constraint?: string | null;
};

// A malformed pattern is an authoring error the loader reports (`EnvSchemaFileSchema`); the checker
// must not throw on it, and compiling once per distinct pattern keeps a 30-variable plan cheap.
const patterns = new Map<string, RegExp | null>();

// The characters a decimal literal can be written with, then `Number()` for the shape. Two cheap
// steps rather than one clever expression: a single regex for "integer or decimal or exponent" is
// ambiguous enough to trip `security/detect-unsafe-regex`, and the character class also keeps hex
// (`0x…`) out — PHP's `is_numeric` refuses it, so refusing it here matches the consumer.
const NUMERIC_CHARS = /^[0-9eE+\-.]+$/;

/** True when a type-inferring consumer would read this value as a number rather than as text. */
function readsAsNumber(value: string): boolean {
  const trimmed = value.trim();
  return NUMERIC_CHARS.test(trimmed) && Number.isFinite(Number(trimmed));
}

function patternFor(source: string): RegExp | null {
  const cached = patterns.get(source);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null;
  try {
    compiled = new RegExp(source);
  } catch {
    compiled = null;
  }
  patterns.set(source, compiled);
  return compiled;
}

/** True when `value` would be refused by the declaration; `null` when it satisfies it. */
export function checkEnvValue(
  target: EnvRuleTarget,
  value: string | null | undefined,
): EnvRuleViolation | null {
  // An absent value is `required`'s business, not the rule's: reporting "too short" for a variable
  // the operator never filled would put two errors on one field and hide the actionable one.
  if (value === null || value === undefined || value === '') return null;
  const rule = target.rule;
  if (rule === undefined) return null;

  const length = value.length;
  if (rule.minLength !== undefined && length < rule.minLength) {
    return {
      code: 'min_length',
      message: `At least ${rule.minLength} characters are required; this value has ${length}.`,
    };
  }
  if (rule.maxLength !== undefined && length > rule.maxLength) {
    return {
      code: 'max_length',
      message: `At most ${rule.maxLength} characters are allowed; this value has ${length}.`,
    };
  }
  // Before `pattern`, so a digits-only secret hears the mechanism instead of a format complaint that
  // reads like a typo. The message names what goes wrong downstream, because "include a letter"
  // alone would look like an arbitrary style rule.
  if (rule.notNumeric === true && readsAsNumber(value)) {
    return {
      code: 'numeric_value',
      message:
        'This value is not accepted here: it reads as a number, and a product that infers the type of an environment value then receives a number instead of the text entered. Include at least one letter.',
    };
  }
  if (rule.pattern !== undefined) {
    const pattern = patternFor(rule.pattern);
    // An uncompilable pattern is refused at load time; at resolution time it cannot reject a value.
    if (pattern !== null && !pattern.test(value)) {
      const described = rule.patternDescription ?? target.constraint ?? `/${rule.pattern}/`;
      return { code: 'pattern', message: `Does not match the declared format: ${described}.` };
    }
  }
  if (
    rule.disallow !== undefined &&
    rule.disallow.some((entry) => entry.toLowerCase() === value.toLowerCase())
  ) {
    return {
      code: 'disallowed_value',
      message: `This value is not accepted here; it may not be ${rule.disallow.map((entry) => `"${entry}"`).join(', ')}.`,
    };
  }
  return null;
}

/**
 * Authoring checks for one declaration: everything that is wrong with the *rule itself* rather than
 * with a value, reported while the file is loaded so a typo cannot become a runtime surprise.
 */
export function ruleIssues(
  variable: EnvRuleTarget & { readonly defaultValue?: string | null },
): string[] {
  const rule = variable.rule;
  if (rule === undefined) return [];
  const issues: string[] = [];

  if (
    rule.minLength !== undefined &&
    rule.maxLength !== undefined &&
    rule.minLength > rule.maxLength
  ) {
    issues.push(
      `\`rule.minLength\` (${rule.minLength}) exceeds \`rule.maxLength\` (${rule.maxLength}).`,
    );
  }
  if (rule.pattern !== undefined && patternFor(rule.pattern) === null) {
    issues.push('`rule.pattern` is not a valid regular expression.');
  }
  if (variable.type === 'boolean' || variable.type === 'enum') {
    // A boolean or an enum is already bounded by its type and options; a length rule there is a
    // copy-paste, and enforcing it would refuse a correct value for a reason the author never meant.
    issues.push(
      `a \`${variable.type}\` variable is constrained by its type and options, not by \`rule\`.`,
    );
  }
  if (variable.defaultValue !== undefined && variable.defaultValue !== null) {
    const violation = checkEnvValue(variable, variable.defaultValue);
    if (violation !== null)
      issues.push(`its declared default breaks its own rule: ${violation.message}`);
  }
  return issues;
}

/** The rule as a comparable tuple, so the projection compares rules instead of JSON key order. */
export function ruleFingerprint(rule: EnvVarRule | undefined | null): string {
  if (rule === undefined || rule === null) return '';
  return JSON.stringify([
    rule.minLength ?? null,
    rule.maxLength ?? null,
    rule.pattern ?? null,
    rule.patternDescription ?? null,
    [...(rule.disallow ?? [])].sort(),
    rule.notNumeric ?? null,
  ]);
}
