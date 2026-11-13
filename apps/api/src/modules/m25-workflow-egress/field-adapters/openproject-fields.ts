import type { FieldDescriptor } from '@seamnex/domain';
import { objectAt, type FieldAdapter } from './adapter';

/**
 * OpenProject describes a work package through the HAL form payload, where `_embedded.schema`
 * carries one entry per writable attribute. The shape has moved between minor versions, so the
 * extractor accepts only the name-keyed map it was written against; any other shape — an element
 * array, a renamed embedding — yields nothing, which the service reports as `unsupported` rather
 * than inventing fields from a payload it cannot read.
 *
 * The path must be confirmed against the running instance (D09-01); a version that answers `404`
 * degrades to manual entry, which is the documented behaviour for any product without a schema.
 */
const FORM_PATH = '/api/v3/work_packages/form';

const TYPE_MAP: Readonly<Record<string, FieldDescriptor['type']>> = Object.freeze({
  string: 'string',
  text: 'string',
  integer: 'number',
  float: 'number',
  date: 'date',
  datetime: 'date',
  boolean: 'boolean',
  link: 'object',
  array: 'array',
});

function typeOf(raw: Record<string, unknown>): FieldDescriptor['type'] {
  const declared = typeof raw['type'] === 'string' ? raw['type'].toLowerCase() : '';
  return TYPE_MAP[declared] ?? 'unknown';
}

export const openProjectFields: FieldAdapter = {
  entryKey: 'D09-01',
  method: 'GET',
  path: FORM_PATH,
  supports: (operation) => operation.startsWith('work_packages.'),
  unsupportedDetail:
    'This OpenProject operation is not a work package, so its schema cannot be read from the form endpoint.',
  extract(body) {
    const schema = objectAt(body, '_embedded', 'schema');
    if (schema === null) return [];
    const result: FieldDescriptor[] = [];
    for (const [name, raw] of Object.entries(schema)) {
      // HAL bookkeeping keys are not attributes: a mapping to `_links` would be refused by the
      // product on the first run.
      if (name.startsWith('_')) continue;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
      const descriptor = raw as Record<string, unknown>;
      result.push({
        name,
        label: typeof descriptor['name'] === 'string' ? descriptor['name'] : null,
        type: typeOf(descriptor),
        required: descriptor['required'] === true,
      });
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  },
};
