import type { EnvProfile, EnvSchemaVar } from '@seamnex/domain';

export type ProfileValue = EnvProfile['values'][number];
export type Ceiling = EnvSchemaVar['overrideCeiling'];

/** One entry's opinion about a variable, as far as the declarative schema is concerned. */
export type Declaration = { entryKey: string; ceiling: Ceiling; secret: boolean };
export type Declarations = ReadonlyMap<string, readonly Declaration[]>;

/**
 * FR-1.26 / AC-51 — who declares each variable and which ceiling applies.
 *
 * The schema is per entry, so the union across entries is the only honest answer to "may a profile
 * set this?". `schemas` and `keys` are parallel: a schema the API refused stays `undefined` and the
 * variable is then reported as undeclared *for that entry*, not as absent everywhere.
 */
export function declarationsOf(
  keys: readonly string[],
  schemas: readonly (readonly EnvSchemaVar[] | undefined)[],
): Declarations {
  const map = new Map<string, Declaration[]>();
  keys.forEach((entryKey, index) => {
    for (const variable of schemas[index] ?? []) {
      const list = map.get(variable.name) ?? [];
      list.push({ entryKey, ceiling: variable.overrideCeiling, secret: variable.secret });
      map.set(variable.name, list);
    }
  });
  return map;
}

/** The strictest ceiling wins: a variable every entry locks is not a profile variable. */
export function ceilingOf(declarations: readonly Declaration[] | undefined): Ceiling | null {
  if (declarations === undefined || declarations.length === 0) return null;
  if (declarations.every((item) => item.ceiling === 'none')) return 'none';
  if (declarations.every((item) => item.ceiling === 'profile_only')) return 'profile_only';
  return 'profile_and_instance';
}

export function ceilingTone(ceiling: Ceiling): 'neutral' | 'caution' | 'accent' {
  return ceiling === 'none' ? 'neutral' : ceiling === 'profile_only' ? 'caution' : 'accent';
}
