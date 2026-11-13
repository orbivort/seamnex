import { describe, expect, it } from 'vitest';
import type { WorkflowNode } from '@seamnex/domain';
import { mappingFieldIssues } from '../../../../src/modules/m13-workflow/authoring.service';

/**
 * The rule from the ADR, pinned: an unknown target is an **error** only where the product published
 * a schema, and a missing schema is a **warning**. Getting this backwards either lets a run fail at
 * the product or makes every imported workflow unactivatable the moment a product is offline.
 */
const INSTANCE = '1a2b3c4d-0000-4000-8000-000000000001';
const NODE = 'e4b0c8f6-1111-4a2b-8c3d-000000000002';

const WRITE_NODE = {
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
} as WorkflowNode;

function irWith(to: string) {
  return {
    trigger: {},
    nodes: [WRITE_NODE],
    edges: [
      {
        id: 'e1',
        source: 'n-trigger',
        target: NODE,
        mappings: [{ from: 'lead.email', to, transform: null }],
      },
    ],
  } as never;
}

const TARGETS = [{ node: WRITE_NODE, instanceId: INSTANCE, operation: 'contacts.write' }];
const KEY = `${INSTANCE}|contacts.write`;

describe('mappingFieldIssues', () => {
  it('accepts a target the product publishes', () => {
    const issues = mappingFieldIssues(
      irWith('emailAddress'),
      TARGETS,
      new Map([[KEY, { status: 'available', fields: [{ name: 'emailAddress' }] }]]),
    );

    expect(issues).toEqual([]);
  });

  it('reports an unknown target as an error and names an accepted one', () => {
    const issues = mappingFieldIssues(
      irWith('contact.emailAddress'),
      TARGETS,
      new Map([
        [KEY, { status: 'available', fields: [{ name: 'emailAddress' }, { name: 'lastName' }] }],
      ]),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'UNKNOWN_TARGET_FIELD',
      severity: 'error',
      nodeId: NODE,
    });
    expect(issues[0]?.message).toContain('contact.emailAddress');
    expect(issues[0]?.remediation).toContain('emailAddress');
  });

  it('warns instead of erroring when no snapshot exists', () => {
    const issues = mappingFieldIssues(irWith('emailAddress'), TARGETS, new Map());

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'FIELD_SCHEMA_UNAVAILABLE', severity: 'warning' });
  });

  it('warns when the product cannot describe itself', () => {
    const issues = mappingFieldIssues(
      irWith('emailAddress'),
      TARGETS,
      new Map([[KEY, { status: 'unsupported', fields: [] }]]),
    );

    expect(issues[0]).toMatchObject({ code: 'FIELD_SCHEMA_UNAVAILABLE', severity: 'warning' });
  });

  it('says nothing about a node that maps nothing', () => {
    const issues = mappingFieldIssues(
      {
        trigger: {},
        nodes: [WRITE_NODE],
        edges: [{ id: 'e1', source: 'a', target: NODE, mappings: [] }],
      } as never,
      TARGETS,
      new Map(),
    );

    expect(issues).toEqual([]);
  });
});
