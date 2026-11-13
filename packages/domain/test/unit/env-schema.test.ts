import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkEnvValue, ruleFingerprint, ruleIssues } from '../../src/env-rules';
import { EnvSchemaFileSchema } from '../../src/schemas/catalog';

/**
 * The loader validates `catalog/env/<KEY>.json` with this schema before anything is written, so
 * these cases are the authoring rules — they belong to the contract, not to a screen or a database.
 */

// ADR-BE-20: the shipped baseline moved to the composed key (`D01-01`, domain 01 / product 01)
// before the API could read it; the schema now accepts both grammars, so this asserts the file the
// build actually ships rather than a legacy spelling nothing writes any more.
const shipped = fileURLToPath(
  new URL('../../../../platform/catalog/env/D01-01.json', import.meta.url),
);

function file(variables: readonly unknown[], entryKey = 'D09-01') {
  return { format: 'env-schema/v1', entryKey, variables };
}

function variable(overrides: Record<string, unknown> = {}) {
  return {
    name: 'SOME_VAR',
    purpose: 'What the variable is for.',
    type: 'string',
    required: false,
    defaultValue: null,
    constraint: null,
    conditional: null,
    secret: false,
    overrideCeiling: 'profile_and_instance',
    ...overrides,
  };
}

function issuesOf(candidate: unknown): string[] {
  const parsed = EnvSchemaFileSchema.safeParse(candidate);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('env-schema file', () => {
  it('accepts the declaration this build ships for D01-01', () => {
    const parsed = EnvSchemaFileSchema.safeParse(JSON.parse(readFileSync(shipped, 'utf8')));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.entryKey).toBe('D01-01');
    // 30 since the OIDC block (`…_OIDC_*`) landed in the shipped baseline: the console renders
    // those fields, and a schema that omits them shows an empty identity section. The count is
    // exact on purpose — a variable added without a fixture update is the drift this guards.
    expect(parsed.data.variables.length).toBe(30);
    expect(new Set(parsed.data.variables.map((entry) => entry.name)).size).toBe(30);
    // The variable the served schema used to lose: an enum without options renders an empty select.
    // Values are the method names EspoCRM 10.0.11 registers (`Espo`, `ApiKey`, `Hmac`, `Oidc`).
    const method = parsed.data.variables.find(
      (entry) => entry.name === 'ESPOCRM_CONFIG_AUTHENTICATION_METHOD',
    );
    expect(method?.options).toEqual(['Espo', 'ApiKey', 'Hmac', 'Oidc']);
  });

  it('refuses a secret that carries a default value', () => {
    const issues = issuesOf(
      file([
        variable({ name: 'DB_PASSWORD', type: 'secret', secret: true, defaultValue: 'hunter2' }),
      ]),
    );
    expect(issues.join('\n')).toMatch(/may not carry a default value/);
  });

  it('refuses a flag that disagrees with the type', () => {
    const issues = issuesOf(file([variable({ name: 'API_TOKEN', type: 'secret', secret: false })]));
    expect(issues.join('\n')).toMatch(/`secret` must be true exactly when/);
  });

  it('refuses an enum without options, and a default outside them', () => {
    expect(
      issuesOf(file([variable({ name: 'METHOD', type: 'enum', defaultValue: 'Oidc' })])).join('\n'),
    ).toMatch(/must list its options/);
    expect(
      issuesOf(
        file([variable({ name: 'METHOD', type: 'enum', defaultValue: 'Sms', options: ['Oidc'] })]),
      ).join('\n'),
    ).toMatch(/not one of the declared options/);
  });

  it('refuses a required variable that only "none" may set and nothing supplies', () => {
    const issues = issuesOf(
      file([variable({ name: 'SITE_URL', required: true, overrideCeiling: 'none' })]),
    );
    expect(issues.join('\n')).toMatch(/capped at "none" and no default/);
  });

  it('accepts a locked variable whose default supplies it', () => {
    expect(
      issuesOf(
        file([
          variable({
            name: 'DB_HOST',
            required: true,
            defaultValue: 'espocrm-db',
            overrideCeiling: 'none',
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it('refuses duplicate names and lower-case names', () => {
    expect(issuesOf(file([variable(), variable()])).join('\n')).toMatch(/Duplicate declaration/);
    expect(issuesOf(file([variable({ name: 'site_url' })])).join('\n')).toMatch(
      /upper-case letters/,
    );
  });

  it('carries the author’s condition instead of a boolean the API translates', () => {
    const conditional = variable({
      conditional: 'Required when ESPOCRM_CONFIG_AUTHENTICATION_METHOD is Oidc.',
    });
    expect(issuesOf(file([conditional]))).toEqual([]);
    expect(conditional.conditional).not.toBe(false);
  });

  it('refuses an unknown format version', () => {
    expect(
      issuesOf({ format: 'env-schema/v2', entryKey: 'D09-01', variables: [] }).join('\n'),
    ).toMatch(/Invalid input/);
  });
});

describe('environment rules', () => {
  const hex = {
    minLength: 16,
    pattern: '^[0-9a-fA-F]{64}$',
    patternDescription: '64 hexadecimal characters',
  };

  it('carries the enforceable half of a constraint through the file', () => {
    const parsed = EnvSchemaFileSchema.safeParse(
      file([
        variable({ name: 'MB_ENCRYPTION_SECRET_KEY', type: 'secret', secret: true, rule: hex }),
      ]),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.variables[0]?.rule).toEqual(hex);
  });

  it('accepts a declaration without a rule, so existing files keep loading', () => {
    expect(issuesOf(file([variable()]))).toEqual([]);
  });

  it('refuses an inverted length range and an uncompilable pattern', () => {
    expect(
      issuesOf(file([variable({ rule: { minLength: 64, maxLength: 8 } })])).join('\n'),
    ).toMatch(/exceeds/);
    expect(issuesOf(file([variable({ rule: { pattern: '^[a-z' } })])).join('\n')).toMatch(
      /not a valid regular expression/,
    );
  });

  it('refuses a rule on a type that is already bounded by its type', () => {
    expect(
      issuesOf(file([variable({ type: 'boolean', rule: { minLength: 2 } })])).join('\n'),
    ).toMatch(/constrained by its type/);
    expect(
      issuesOf(file([variable({ type: 'enum', options: ['a'], rule: { minLength: 2 } })])).join(
        '\n',
      ),
    ).toMatch(/constrained by its type/);
  });

  it('refuses a default that breaks its own rule', () => {
    expect(
      issuesOf(file([variable({ defaultValue: 'short', rule: { minLength: 16 } })])).join('\n'),
    ).toMatch(/declared default breaks its own rule/);
  });
});

describe('checkEnvValue', () => {
  const hex = {
    minLength: 16,
    pattern: '^[0-9a-fA-F]{64}$',
    patternDescription: '64 hexadecimal characters (openssl rand -hex 32)',
  };
  const target = { name: 'MB_ENCRYPTION_SECRET_KEY', type: 'secret', rule: hex, constraint: null };

  it('names the length it got, so the operator can count', () => {
    const violation = checkEnvValue(target, '123456789012');
    expect(violation?.code).toBe('min_length');
    expect(violation?.message).toBe('At least 16 characters are required; this value has 12.');
  });

  it('refuses a long but wrongly shaped value with the declared format', () => {
    const violation = checkEnvValue(target, 'z'.repeat(64));
    expect(violation?.code).toBe('pattern');
    expect(violation?.message).toBe(
      'Does not match the declared format: 64 hexadecimal characters (openssl rand -hex 32).',
    );
  });

  it('accepts a value that satisfies the rule, and says nothing about an absent one', () => {
    expect(checkEnvValue(target, 'a'.repeat(64))).toBeNull();
    expect(checkEnvValue(target, null)).toBeNull();
    expect(checkEnvValue(target, '')).toBeNull();
  });

  it('reports one violation, the one the operator has to fix first', () => {
    // D11's real rule: `metabase` is an eight-character word, so a value that is merely banned also
    // breaks the length rule — and "at least 24 characters" is the message that leads anywhere.
    const password = {
      name: 'MB_DB_PASS',
      type: 'secret',
      rule: { minLength: 24, disallow: ['metabase', 'postgres'] },
    };
    expect(checkEnvValue(password, 'Metabase')?.code).toBe('min_length');
  });

  it('refuses a disallowed value without echoing it back', () => {
    const banned = { name: 'BOOTSTRAP_TOKEN', type: 'secret', rule: { disallow: ['changeme'] } };
    const violation = checkEnvValue(banned, 'ChangeMe');
    expect(violation?.code).toBe('disallowed_value');
    expect(violation?.message).not.toContain('ChangeMe');
    expect(violation?.message).toContain('changeme');
  });

  it('refuses a value a type-inferring product would read as a number', () => {
    // The incident behind `notNumeric`: a 24-digit client secret satisfied the old "at least 16
    // characters" rule, and EspoCRM's entrypoint stored it as `1.2345678901212345E+23`, so every
    // login failed at the token exchange with `invalid_client_credentials`.
    const secret = {
      name: 'ESPOCRM_CONFIG_OIDC_CLIENT_SECRET',
      type: 'secret',
      rule: {
        minLength: 24,
        pattern: '^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9._~-]+$',
        notNumeric: true,
      },
    };
    const digits = checkEnvValue(secret, '123456789012345678901234');
    expect(digits?.code).toBe('numeric_value');
    expect(digits?.message).toContain('number');
    // Exponent notation and surrounding whitespace coerce just as readily, and `pattern` alone
    // cannot see either. Both stay long enough for the length rule, so the numeric cause is the one
    // reported rather than a length complaint that leads nowhere.
    expect(checkEnvValue(secret, '  1.2345678901212345E+23  ')?.code).toBe('numeric_value');
    expect(checkEnvValue(secret, '000000000000000000000001')?.code).toBe('numeric_value');
    expect(checkEnvValue(secret, '0123456789abcdef0123456789abcdef')).toBeNull();
    expect(checkEnvValue(secret, 'seamnex-local-0123456789abcdef')).toBeNull();
  });

  it('treats `notNumeric` as part of the rule, so adding it is a declaration change', () => {
    expect(ruleFingerprint({ notNumeric: true })).not.toBe(ruleFingerprint({}));
    expect(ruleFingerprint({ notNumeric: false })).not.toBe(ruleFingerprint({}));
  });

  it('refuses a declared default that is a number', () => {
    expect(
      ruleIssues({
        name: 'CLIENT_SECRET',
        type: 'secret',
        defaultValue: '123456789012345678901234',
        rule: { notNumeric: true },
      }).join('\n'),
    ).toMatch(/reads as a number/);
  });

  it('does not throw on a pattern the loader would have refused', () => {
    expect(
      checkEnvValue({ name: 'X', type: 'string', rule: { pattern: '^[a-z' } }, 'abc'),
    ).toBeNull();
  });

  it('compares rules by content, not by JSON key order', () => {
    expect(ruleFingerprint({ minLength: 1, disallow: ['b', 'a'] })).toBe(
      ruleFingerprint({ disallow: ['a', 'b'], minLength: 1 }),
    );
    expect(ruleFingerprint(undefined)).toBe('');
    expect(ruleFingerprint(null)).toBe('');
  });

  it('enforces a maximum length as well as a minimum', () => {
    const bounded = { name: 'NAME', type: 'string', rule: { maxLength: 4 } };
    expect(checkEnvValue(bounded, 'abcde')?.code).toBe('max_length');
    expect(checkEnvValue(bounded, 'abcd')).toBeNull();
  });

  it('says nothing when the declaration carries no rule at all', () => {
    const plain = { name: 'PLAIN', type: 'string' };
    expect(checkEnvValue(plain, 'anything')).toBeNull();
  });

  it('describes a pattern with its raw expression when the author gave no description', () => {
    const digits = { name: 'PORT', type: 'string', rule: { pattern: '^\\d+$' } };
    expect(checkEnvValue(digits, 'eighty')).toEqual({
      code: 'pattern',
      message: 'Does not match the declared format: /^\\d+$/.',
    });
  });

  it('uses the human constraint when the author supplied one', () => {
    const host = {
      name: 'DB_HOST',
      type: 'string',
      constraint: 'A hostname reachable from the product network',
      rule: { pattern: '^[a-z.]+$' },
    };
    expect(checkEnvValue(host, 'DB_HOST')?.message).toContain(
      'A hostname reachable from the product network',
    );
  });
});

describe('ruleIssues', () => {
  it('accepts a variable with no rule', () => {
    expect(ruleIssues({ name: 'PLAIN', type: 'string' })).toEqual([]);
  });

  it('reports every authoring problem at once', () => {
    const issues = ruleIssues({
      name: 'BAD',
      type: 'boolean',
      rule: { minLength: 8, maxLength: 2, pattern: '^[a-z' },
      defaultValue: 'x',
    });

    expect(issues.some((issue) => issue.includes('exceeds'))).toBe(true);
    expect(issues.some((issue) => issue.includes('not a valid regular expression'))).toBe(true);
    expect(issues.some((issue) => issue.includes('constrained by its type'))).toBe(true);
    expect(issues.some((issue) => issue.includes('declared default breaks its own rule'))).toBe(
      true,
    );
  });

  it('does not police a null default, which means "not supplied"', () => {
    expect(
      ruleIssues({ name: 'OPTIONAL', type: 'string', rule: { minLength: 4 }, defaultValue: null }),
    ).toEqual([]);
  });
});
