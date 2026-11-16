import { describe, expect, it } from 'vitest';
import type { FieldMapping, WorkflowNode } from '@seamnex/domain';
import { mappingSemanticsIssues } from '../../../../src/modules/m13-workflow/authoring.service';

/**
 * FR-5.5 — before this rule existed, `transform`, `required`, `onMissing` and `defaultValue` were
 * stored and never read: the mapping compiled to a bare dereference, activation succeeded, and the
 * product received the unconverted value. The platform owns the transform catalogue, so a name it
 * cannot apply is knowledge it has and the author got wrong — an error, not a warning.
 */
const NODE = 'e4b0c8f6-1111-4a2b-8c3d-000000000002';

function node(patch: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: NODE,
    kind: 'action',
    label: 'Create contact',
    product: 'EspoCRM',
    entryKey: 'D01-01',
    operation: 'contacts.write',
    mode: 'write',
    x: 0,
    y: 0,
    summary: '',
    mappings: [],
    ...patch,
  } as WorkflowNode;
}

function irWith(mappings: FieldMapping[], withNode: WorkflowNode = node()) {
  return {
    trigger: {},
    nodes: [withNode],
    edges: [{ id: 'e1', source: 'n-trigger', target: withNode.id, mappings }],
  } as never;
}

const mapping = (patch: Partial<FieldMapping> = {}): FieldMapping => ({
  from: 'lead.email',
  to: 'emailAddress',
  transform: null,
  ...patch,
});

describe('mappingSemanticsIssues', () => {
  it('accepts a mapping that declares nothing', () => {
    expect(mappingSemanticsIssues(irWith([mapping()]))).toEqual([]);
  });

  it('accepts a conversion the catalogue publishes', () => {
    expect(mappingSemanticsIssues(irWith([mapping({ transform: 'lower' })]))).toEqual([]);
    expect(
      mappingSemanticsIssues(irWith([mapping({ transform: 'date_iso', onMissing: 'skip' })])),
    ).toEqual([]);
  });

  it('refuses a conversion the platform cannot apply, and names the ones it can', () => {
    const issues = mappingSemanticsIssues(
      irWith([mapping({ to: 'budget', transform: 'currency → EUR' })]),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'UNKNOWN_TRANSFORM',
      severity: 'error',
      nodeId: NODE,
    });
    expect(issues[0]?.message).toContain('currency → EUR');
    expect(issues[0]?.remediation).toContain('trim');
    expect(issues[0]?.remediation).toContain('date_iso');
  });

  it('refuses a default policy that has no default to substitute', () => {
    const issues = mappingSemanticsIssues(
      irWith([mapping({ onMissing: 'default', defaultValue: null })]),
    );

    expect(issues[0]).toMatchObject({ code: 'MISSING_DEFAULT_VALUE', severity: 'error' });
  });

  it('refuses a default the declared conversion cannot hold', () => {
    const issues = mappingSemanticsIssues(
      irWith([mapping({ transform: 'number', onMissing: 'default', defaultValue: 'about 40' })]),
    );

    expect(issues[0]).toMatchObject({ code: 'INVALID_DEFAULT_VALUE', severity: 'error' });
    expect(issues[0]?.message).toContain('about 40');
  });

  it('judges one mapping at a time, so a bad row cannot hide its neighbour', () => {
    const issues = mappingSemanticsIssues(
      irWith([
        mapping({ to: 'emailAddress', transform: 'nonsense' }),
        mapping({ to: 'phone', transform: 'number', onMissing: 'default', defaultValue: 'x' }),
      ]),
    );

    expect(issues.map((entry) => entry.code)).toEqual([
      'UNKNOWN_TRANSFORM',
      'INVALID_DEFAULT_VALUE',
    ]);
  });

  /** A read node sends no body, so its mappings are notes the compiler never reads. */
  it('ignores the mappings of a read node', () => {
    const readNode = node({ mode: 'read', operation: 'contacts.read' });

    expect(
      mappingSemanticsIssues(irWith([mapping({ transform: 'currency → EUR' })], readNode)),
    ).toEqual([]);
  });

  /** `required` implies `fail`; there is no policy to validate, so the row is accepted as written. */
  it('says nothing about a required field with no explicit policy', () => {
    expect(mappingSemanticsIssues(irWith([mapping({ required: true })]))).toEqual([]);
  });
});
