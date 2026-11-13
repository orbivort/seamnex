import { checkEnvValue } from '@seamnex/domain';
import type { EnvPlanValue, FieldError } from '@seamnex/domain';
import { CATALOG_BY_KEY } from './catalog';
import { at } from './context';
import { ENV_PROFILES, envSchemaFor } from './env-schema';

/** Variables whose change needs the instance recreated rather than restarted (FR-1.28). */
const RECREATE_VARS = new Set(['SMTP_HOST', 'DB_PASSWORD', 'NEXTCLOUD_TRUSTED_DOMAINS', 'WP_HOME']);

const CONDITIONAL_RULE = /required when ([A-Z0-9_]+) is set/i;

export type EnvResolution = {
  entryKey: string;
  profileKey: string;
  values: EnvPlanValue[];
  fieldErrors: FieldError[];
  requiresRecreate: boolean;
  resolvedAt: string;
};

function blanks(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

function typeError(type: string, value: string, options?: string[]): string | null {
  if (type === 'integer' && !/^-?\d+$/.test(value)) return 'Must be a whole number.';
  if (type === 'url' && !/^https?:\/\/\S+$/i.test(value)) return 'Must be an http(s) URL.';
  if (type === 'boolean' && value !== 'true' && value !== 'false') return 'Must be true or false.';
  if (type === 'enum' && options && options.length > 0 && !options.includes(value)) {
    return `Must be one of: ${options.join(', ')}.`;
  }
  return null;
}

/**
 * FR-1.26 precedence: catalog default → environment profile → instance override → secret store.
 * The override ceiling is enforced here, so the wizard, provisioning and `PUT /instances/:id/env`
 * cannot disagree.
 */
export function resolveEnv(
  entryKey: string,
  profileKey: string,
  overrides: Record<string, string> = {},
): EnvResolution {
  const entry = CATALOG_BY_KEY[entryKey];
  const vars = entry ? envSchemaFor(entry) : [];
  const profile = ENV_PROFILES.find((item) => item.key === profileKey);
  const profileValueFor = (name: string) => profile?.values.find((item) => item.varName === name);

  const fieldErrors: FieldError[] = [];
  const present = new Map<string, boolean>();

  const values: EnvPlanValue[] = vars.map((variable) => {
    const profileValue = profileValueFor(variable.name);
    const override = overrides[variable.name];
    const locked = variable.overrideCeiling === 'none';
    const profileOnly = variable.overrideCeiling === 'profile_only';
    let source: EnvPlanValue['source'] = 'default';
    let value: string | null = variable.defaultValue;
    let masked = false;
    let error: string | null = null;

    if (!blanks(override)) {
      if (locked) {
        error = `${variable.name} is locked by the catalog; neither a profile nor an instance may set it.`;
        fieldErrors.push({ field: variable.name, code: 'CEILING_LOCKED', message: error });
      } else if (profileOnly) {
        error = `${variable.name} is capped at profile-only; change it in the environment profile instead.`;
        fieldErrors.push({ field: variable.name, code: 'PROFILE_ONLY', message: error });
      } else {
        source = 'instance';
        value = override ?? null;
      }
    }

    // Kept before the masking below: a rule judges the value the operator supplied, and a secret is
    // validated exactly like any other value without its text ever reaching the plan or an error.
    const candidate = value;

    if (!error) {
      if (variable.secret) {
        source = 'secret';
        masked = true;
        value = '••••••••';
      } else if (
        source !== 'instance' &&
        (profileValue?.secretRef || !blanks(profileValue?.value))
      ) {
        if (profileValue?.secretRef) {
          source = 'secret';
          masked = true;
          value = '••••••••';
        } else {
          source = 'profile';
          value = profileValue?.value ?? null;
        }
      }
    }

    const isPresent = variable.secret
      ? Boolean(profileValue?.secretRef) || !blanks(override) || !blanks(variable.defaultValue)
      : !blanks(value);
    present.set(variable.name, isPresent);

    if (!error && variable.required && !variable.secret && blanks(value)) {
      error = `${variable.name} is required.`;
      fieldErrors.push({ field: variable.name, code: 'REQUIRED', message: error });
    }

    if (!error && !variable.secret && !blanks(value) && value !== null) {
      const invalid = typeError(variable.type, value, variable.options);
      if (invalid) {
        error = `${variable.name}: ${invalid}`;
        fieldErrors.push({ field: variable.name, code: 'TYPE', message: error });
      }
    }

    // The declaration's enforceable half, evaluated by the same function the API uses, so the mock
    // and the live API cannot disagree about a value one of them refuses.
    if (!error && !blanks(candidate) && candidate !== null) {
      const violation = checkEnvValue(variable, candidate);
      if (violation !== null) {
        error = `${variable.name}: ${violation.message}`;
        fieldErrors.push({ field: variable.name, code: violation.code, message: error });
      }
    }

    return {
      ...variable,
      value,
      source,
      masked,
      error,
      requiresRecreate: RECREATE_VARS.has(variable.name),
    };
  });

  // Conditional rules ("required when X is set") need the resolved presence of the other variable.
  for (const variable of vars) {
    const match = variable.conditional?.match(CONDITIONAL_RULE);
    if (!match?.[1]) continue;
    const trigger = match[1];
    const triggerSet = present.get(trigger) ?? false;
    const target = values.find((item) => item.name === variable.name);
    if (!target || target.error) continue;
    if (triggerSet && !(present.get(variable.name) ?? false)) {
      const message = `${variable.name} is required when ${trigger} is set.`;
      target.error = message;
      fieldErrors.push({ field: variable.name, code: 'CONDITIONAL_REQUIRED', message });
    }
  }

  return {
    entryKey,
    profileKey,
    values,
    fieldErrors,
    requiresRecreate: values.some((item) => item.requiresRecreate && item.source !== 'default'),
    resolvedAt: at(0),
  };
}

export { RECREATE_VARS };
