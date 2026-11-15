import { describe, expect, it } from 'vitest';
import {
  canAuthorWorkflows,
  workflowWriteAuthority,
  type WorkflowGrant,
  type WorkflowWriteTarget,
} from '../../src/workflow-authority';

/**
 * FR-5.9 / AC-26 / NFR-4.4 — authority follows the write targets.
 *
 * Each case is a sentence from the requirement, and the negative cases are the ones the compliance
 * review asked for: a cross-domain target refused for R3, a second target refused for R4, and an R1
 * with no elevation refused whatever else they hold.
 */

const CRM: WorkflowWriteTarget = {
  instanceId: 'inst-crm',
  entryKey: 'D01-01',
  domain: 'CRM & Sales Pipeline',
  product: 'EspoCRM',
};
const DOCS: WorkflowWriteTarget = {
  instanceId: 'inst-docs',
  entryKey: 'D08-01',
  domain: 'Document & Content Management',
  product: 'Paperless-ngx',
};
const NO_DOMAIN: WorkflowWriteTarget = {
  instanceId: 'inst-unknown',
  entryKey: 'D99-99',
  domain: null,
  product: null,
};

const R1: WorkflowGrant = { role: 'R1', scopeType: 'platform', scopeId: null };
const R3_CUSTOMERS: WorkflowGrant = {
  role: 'R3',
  scopeType: 'domain',
  scopeId: 'CRM & Sales Pipeline',
};
const R3_DOCUMENTS: WorkflowGrant = {
  role: 'R3',
  scopeType: 'domain',
  scopeId: 'Document & Content Management',
};
const R4_CRM: WorkflowGrant = { role: 'R4', scopeType: 'instance', scopeId: 'inst-crm' };
const R5: WorkflowGrant = { role: 'R5', scopeType: 'platform', scopeId: null };

function verdict(
  grants: readonly WorkflowGrant[],
  targets: readonly WorkflowWriteTarget[],
  elevations: Record<string, string> = {},
) {
  return workflowWriteAuthority({
    grants,
    targets,
    elevations: new Map(Object.entries(elevations)),
  });
}

describe('R3 — domain owner', () => {
  it('may write to a product in a domain they own', () => {
    expect(verdict([R3_CUSTOMERS], [CRM])).toEqual({ allowed: true, refusals: [], elevations: [] });
  });

  it('is refused when any write target is outside their domains', () => {
    const result = verdict([R3_CUSTOMERS], [CRM, DOCS]);

    expect(result.allowed).toBe(false);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toMatchObject({
      instanceId: 'inst-docs',
      entryKey: 'D08-01',
      missing: 'domain',
    });
    expect(result.refusals[0]?.detail).toContain('Paperless-ngx (D08-01)');
    expect(result.refusals[0]?.remediation).toContain('Remove that write target');
  });

  it('is allowed across domains they own, one grant per domain', () => {
    expect(verdict([R3_CUSTOMERS, R3_DOCUMENTS], [CRM, DOCS]).allowed).toBe(true);
  });

  it('is refused for a product the catalogue gives no domain, rather than assumed to own it', () => {
    const result = verdict([R3_CUSTOMERS], [NO_DOMAIN]);

    expect(result.allowed).toBe(false);
    expect(result.refusals[0]?.missing).toBe('domain');
  });

  it('does not need an elevation even when one exists', () => {
    const result = verdict([R3_CUSTOMERS], [CRM], { 'inst-crm': 'bg-1' });

    expect(result.allowed).toBe(true);
    // Standing authority was used; recording an elevation as used would misstate the evidence.
    expect(result.elevations).toEqual([]);
  });
});

describe('R4 — product administrator', () => {
  it('may write when their instance is the only write target', () => {
    expect(verdict([R4_CRM], [CRM])).toEqual({ allowed: true, refusals: [], elevations: [] });
  });

  it('is refused as soon as a second write target appears', () => {
    const result = verdict([R4_CRM], [CRM, DOCS]);

    expect(result.allowed).toBe(false);
    // The instance they administer is refused for the rule; the other for the instance itself —
    // two different fixes, so they are two different kinds.
    expect(result.refusals.map((refusal) => refusal.missing)).toEqual(['sole-target', 'instance']);
    expect(result.refusals[0]?.detail).toContain('writes to 2');
  });

  it('is refused for an instance they do not administer', () => {
    const result = verdict([R4_CRM], [DOCS]);

    expect(result.allowed).toBe(false);
    expect(result.refusals[0]).toMatchObject({ instanceId: 'inst-docs', missing: 'instance' });
    expect(result.refusals[0]?.detail).toContain('You do not administer Paperless-ngx (D08-01)');
  });
});

describe('R1 — break-glass only', () => {
  it('is refused without an elevation, naming the target', () => {
    const result = verdict([R1], [CRM]);

    expect(result.allowed).toBe(false);
    expect(result.refusals[0]).toMatchObject({ instanceId: 'inst-crm', missing: 'elevation' });
    expect(result.refusals[0]?.detail).toContain('break-glass');
    expect(result.refusals[0]?.remediation).toContain('read-write break-glass session');
  });

  it('is allowed with an active read-write elevation on every target, and reports it', () => {
    const result = verdict([R1], [CRM, DOCS], { 'inst-crm': 'bg-1', 'inst-docs': 'bg-2' });

    expect(result.allowed).toBe(true);
    expect(result.elevations).toEqual([
      { instanceId: 'inst-crm', elevationId: 'bg-1' },
      { instanceId: 'inst-docs', elevationId: 'bg-2' },
    ]);
  });

  it('is refused when only one of two targets is elevated', () => {
    const result = verdict([R1], [CRM, DOCS], { 'inst-crm': 'bg-1' });

    expect(result.allowed).toBe(false);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.instanceId).toBe('inst-docs');
    // The elevation that was used is still evidence; the refusal is about the other target.
    expect(result.elevations).toEqual([{ instanceId: 'inst-crm', elevationId: 'bg-1' }]);
  });

  it('prefers standing domain authority over an elevation when they hold both', () => {
    const result = verdict([R1, R3_CUSTOMERS], [CRM], { 'inst-crm': 'bg-1' });

    expect(result.allowed).toBe(true);
    expect(result.elevations).toEqual([]);
  });
});

describe('no write authority at all', () => {
  it('is refused for a role that may not author workflows', () => {
    const result = verdict([R5], [CRM]);

    expect(result.allowed).toBe(false);
    expect(result.refusals[0]?.missing).toBe('role');
  });

  it('is refused for an empty grant set', () => {
    expect(verdict([], [CRM]).allowed).toBe(false);
  });
});

describe('definitions that write nowhere', () => {
  it('are not gated here: read-only targets require entitlement only', () => {
    expect(verdict([], [])).toEqual({ allowed: true, refusals: [], elevations: [] });
  });

  it('report no elevation even when the actor holds one', () => {
    expect(verdict([R1], [], { 'inst-crm': 'bg-1' }).elevations).toEqual([]);
  });
});

describe('duplicate targets', () => {
  it('are counted once, because one product is one write target', () => {
    const result = verdict([R4_CRM], [CRM, { ...CRM }]);

    expect(result.allowed).toBe(true);
  });

  it('do not inflate the count that decides R4 authority', () => {
    const result = verdict([R4_CRM], [CRM, { ...CRM }, DOCS]);

    expect(result.refusals[0]?.detail).toContain('writes to 2');
  });
});

describe('canAuthorWorkflows', () => {
  it('admits the three writing roles and nothing else', () => {
    expect(canAuthorWorkflows([R1])).toBe(true);
    expect(canAuthorWorkflows([R3_CUSTOMERS])).toBe(true);
    expect(canAuthorWorkflows([R4_CRM])).toBe(true);
    expect(canAuthorWorkflows([R5])).toBe(false);
    expect(canAuthorWorkflows([])).toBe(false);
  });
});
