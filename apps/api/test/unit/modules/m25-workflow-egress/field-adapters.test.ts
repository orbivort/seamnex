import { describe, expect, it } from 'vitest';
import { objectAt } from '../../../../src/modules/m25-workflow-egress/field-adapters/adapter';
import { espoFields } from '../../../../src/modules/m25-workflow-egress/field-adapters/espo-fields';
import { openProjectFields } from '../../../../src/modules/m25-workflow-egress/field-adapters/openproject-fields';
import { orangeHrmFields } from '../../../../src/modules/m25-workflow-egress/field-adapters/orangehrm-fields';
import {
  adapterFor,
  FIELD_ADAPTERS,
} from '../../../../src/modules/m25-workflow-egress/field-adapters';

/**
 * FR-5.5 — one product, one translation of its own metadata.
 *
 * Each adapter answers three questions the service depends on: does this product describe this
 * operation at all, where is the schema, and which of its fields are actually writable. A guess here
 * becomes a mapping that validates and fails on the product's first run, so every "unreadable"
 * shape has to come back empty rather than invented.
 */
describe('objectAt', () => {
  it('reads a nested object and refuses every other shape', () => {
    const body = { _embedded: { schema: { subject: { type: 'String' } } } };

    expect(objectAt(body, '_embedded', 'schema')).toEqual({ subject: { type: 'String' } });
    expect(objectAt(body, '_embedded', 'missing')).toBeNull();
    expect(objectAt({ list: [1, 2] }, 'list')).toBeNull();
    expect(objectAt(null, 'anything')).toBeNull();
    expect(objectAt('text')).toBeNull();
    expect(objectAt({ value: null }, 'value')).toBeNull();
  });
});

describe('EspoCRM field adapter', () => {
  const METADATA = {
    entityDefs: {
      Contact: {
        fields: {
          lastName: { type: 'varchar', required: true, label: 'Last Name' },
          account: { type: 'link', notStorable: true },
          createdAt: { type: 'datetime' },
          weird: { type: 'somethingNew' },
          untyped: { label: 'No type' },
          broken: 'not-an-object',
          unlabelled: { type: 'bool', label: '' },
        },
      },
    },
  };

  it('names only the fields a collection can be written with', () => {
    const fields = espoFields.extract(METADATA, 'contacts.write');

    expect(fields).toEqual([
      { name: 'createdAt', label: null, type: 'date', required: false },
      { name: 'lastName', label: 'Last Name', type: 'string', required: true },
      { name: 'unlabelled', label: null, type: 'boolean', required: false },
      { name: 'untyped', label: 'No type', type: 'unknown', required: false },
      { name: 'weird', label: null, type: 'unknown', required: false },
    ]);
  });

  it('supports only the collections it knows an entity for', () => {
    expect(espoFields.supports('contacts.write')).toBe(true);
    expect(espoFields.supports('opportunities.read')).toBe(true);
    expect(espoFields.supports('users.write')).toBe(false);
    expect(espoFields.supports('notes.read')).toBe(false);
  });

  it('answers nothing when the operation names no collection', () => {
    expect(espoFields.extract(METADATA, 'users.write')).toEqual([]);
  });

  it('answers nothing when the metadata does not carry the entity', () => {
    expect(espoFields.extract({}, 'contacts.write')).toEqual([]);
    expect(espoFields.extract({ entityDefs: { Contact: {} } }, 'contacts.write')).toEqual([]);
    expect(espoFields.extract(null, 'contacts.write')).toEqual([]);
  });

  it('declares the request it needs to read the schema', () => {
    expect(espoFields).toMatchObject({
      entryKey: 'D01-01',
      method: 'GET',
      path: '/api/v1/Metadata',
    });
    expect(espoFields.unsupportedDetail).toContain('does not name a collection');
  });
});

describe('OpenProject field adapter', () => {
  const FORM = {
    _embedded: {
      schema: {
        _links: { href: '/api/v3' },
        subject: { type: 'String', name: 'Subject', required: true },
        startDate: { type: 'Date' },
        budget: { type: 'Float' },
        unknownType: { type: 'somethingNew' },
        notAnObject: 'ignored',
      },
    },
  };

  it('reads the writable attributes of a work package form', () => {
    expect(openProjectFields.extract(FORM, 'work_packages.write')).toEqual([
      { name: 'budget', label: null, type: 'number', required: false },
      { name: 'startDate', label: null, type: 'date', required: false },
      { name: 'subject', label: 'Subject', type: 'string', required: true },
      { name: 'unknownType', label: null, type: 'unknown', required: false },
    ]);
  });

  it('supports work packages only', () => {
    expect(openProjectFields.supports('work_packages.write')).toBe(true);
    expect(openProjectFields.supports('projects.read')).toBe(false);
  });

  it('answers nothing for a payload whose schema moved', () => {
    expect(
      openProjectFields.extract({ _embedded: { elements: [] } }, 'work_packages.write'),
    ).toEqual([]);
    expect(openProjectFields.extract(null, 'work_packages.write')).toEqual([]);
  });

  it('declares the request it needs to read the form', () => {
    expect(openProjectFields).toMatchObject({
      entryKey: 'D09-01',
      method: 'GET',
      path: '/api/v3/work_packages/form',
    });
    expect(openProjectFields.unsupportedDetail).toContain('not a work package');
  });
});

describe('OrangeHRM field adapter', () => {
  it('declares the absence of a schema instead of guessing field names', () => {
    expect(orangeHrmFields.supports('employees.write')).toBe(false);
    expect(orangeHrmFields.extract({ anything: true }, 'employees.write')).toEqual([]);
    expect(orangeHrmFields.unsupportedDetail).toContain('publishes no schema');
  });
});

describe('adapterFor', () => {
  it('answers the adapter of a composed product and nothing for the rest', () => {
    expect(adapterFor('D01-01')).toBe(espoFields);
    expect(adapterFor('D07-01')).toBe(orangeHrmFields);
    expect(adapterFor('D09-01')).toBe(openProjectFields);
    expect(adapterFor('D02-01')).toBeNull();
  });

  it('exposes the table frozen so a caller cannot register an adapter at runtime', () => {
    expect(Object.isFrozen(FIELD_ADAPTERS)).toBe(true);
  });
});
