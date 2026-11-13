import type { FieldDescriptor } from '@seamnex/domain';
import type { FieldAdapter } from './adapter';

/**
 * EspoCRM publishes its metadata at `GET /api/v1/Metadata`: `entityDefs.<Entity>.fields` is a map of
 * field name to `{ type, required, ... }`. The operation id names the collection (`contacts.write`),
 * so the entity is the singular, PascalCased collection.
 */
const ENTITY_BY_COLLECTION: Readonly<Record<string, string>> = Object.freeze({
  accounts: 'Account',
  contacts: 'Contact',
  leads: 'Lead',
  opportunities: 'Opportunity',
});

/** Espo's field types, folded into the platform's seven. */
const TYPE_MAP: Readonly<Record<string, FieldDescriptor['type']>> = Object.freeze({
  varchar: 'string',
  text: 'string',
  wysiwyg: 'string',
  email: 'string',
  phone: 'string',
  url: 'string',
  enum: 'string',
  multiEnum: 'string',
  id: 'string',
  int: 'number',
  float: 'number',
  currency: 'number',
  bool: 'boolean',
  date: 'date',
  datetime: 'date',
  link: 'object',
  linkParent: 'object',
  linkOne: 'object',
  address: 'object',
  personName: 'object',
  jsonObject: 'object',
  array: 'array',
  attachmentMultiple: 'array',
});

function entityFor(operation: string): string | null {
  const collection = operation.split('.')[0] ?? '';
  return ENTITY_BY_COLLECTION[collection] ?? null;
}

export const espoFields: FieldAdapter = {
  entryKey: 'D01-01',
  method: 'GET',
  path: '/api/v1/Metadata',
  supports: (operation) => entityFor(operation) !== null,
  unsupportedDetail: 'This EspoCRM operation does not name a collection whose fields can be read.',
  extract(body, operation) {
    const entity = entityFor(operation);
    if (entity === null) return [];
    const entityDefs = readObject(body, 'entityDefs');
    const definition = entityDefs === null ? null : readObject(entityDefs, entity);
    const fields = definition === null ? null : readObject(definition, 'fields');
    if (fields === null) return [];
    const result: FieldDescriptor[] = [];
    for (const [name, raw] of Object.entries(fields)) {
      const descriptor = readObject(raw, '');
      if (descriptor === null) continue;
      // Espo marks relationships as "not storable" when the field is a computed/link helper; those
      // are not part of the request body.
      if (descriptor['notStorable'] === true) continue;
      const declared = typeof descriptor['type'] === 'string' ? descriptor['type'] : '';
      result.push({
        name,
        label:
          typeof descriptor['label'] === 'string' && descriptor['label'].length > 0
            ? descriptor['label']
            : null,
        type: TYPE_MAP[declared] ?? 'unknown',
        required: descriptor['required'] === true,
      });
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  },
};

/**
 * Read a nested object without asserting a shape. `''` means "the value itself must be an object",
 * which keeps the calls above readable.
 */
function readObject(value: unknown, key: string): Record<string, unknown> | null {
  const target = key === '' ? value : (value as Record<string, unknown> | null)?.[key];
  if (typeof target !== 'object' || target === null || Array.isArray(target)) return null;
  return target as Record<string, unknown>;
}
