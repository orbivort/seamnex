import type { FieldAdapter } from './adapter';
import { espoFields } from './espo-fields';
import { openProjectFields } from './openproject-fields';
import { orangeHrmFields } from './orangehrm-fields';

export type { FieldAdapter } from './adapter';

/**
 * The products whose schema this platform knows how to read. A product with no entry answers
 * `unsupported`, exactly like OrangeHRM: the mapper still works, the target field is just typed by
 * hand and the API does not claim to validate it.
 */
export const FIELD_ADAPTERS: Readonly<Record<string, FieldAdapter>> = Object.freeze({
  'D01-01': espoFields,
  'D07-01': orangeHrmFields,
  'D09-01': openProjectFields,
});

export function adapterFor(entryKey: string): FieldAdapter | null {
  return FIELD_ADAPTERS[entryKey] ?? null;
}
