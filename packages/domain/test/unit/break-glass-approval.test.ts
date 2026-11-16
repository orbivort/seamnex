import { describe, expect, it } from 'vitest';
import {
  breakGlassApprovalRefusal,
  mayApproveAccessMode,
  type ApprovalGrant,
  type BreakGlassApprovalFacts,
} from '../../src/break-glass-approval';
import type { AccessMode, PlatformRole } from '../../src/enums';

/**
 * FR-4.11 / AC-47 / NFR-4.4 — an approver's eligibility follows the request it would approve.
 *
 * Each case is one sentence of the requirement. The two negative cases are the ones the compliance
 * review asked for (ISSUE-05): an auditor approving a read-write elevation, and a domain owner
 * approving another domain's elevation.
 */

const CRM = 'CRM & Sales Pipeline';
const DOCUMENTS = 'Document & Content Management';
const CRM_INSTANCE = 'inst-crm';

const PLATFORM: ApprovalGrant = { role: 'R2', scopeType: 'platform', scopeId: null };
const R3_CRM: ApprovalGrant = { role: 'R3', scopeType: 'domain', scopeId: CRM };
const R3_DOCUMENTS: ApprovalGrant = { role: 'R3', scopeType: 'domain', scopeId: DOCUMENTS };
const R3_INSTANCE: ApprovalGrant = { role: 'R3', scopeType: 'instance', scopeId: CRM_INSTANCE };
const R3_PLATFORM: ApprovalGrant = { role: 'R3', scopeType: 'platform', scopeId: null };
const R1: ApprovalGrant = { role: 'R1', scopeType: 'platform', scopeId: null };

function verdict(
  grants: readonly ApprovalGrant[],
  accessMode: AccessMode,
  target: BreakGlassApprovalFacts['target'] = { instanceId: CRM_INSTANCE, domain: CRM },
  role: PlatformRole = grants[0]?.role ?? 'R5',
) {
  return breakGlassApprovalRefusal({ role, accessMode, grants, target });
}

describe('mayApproveAccessMode', () => {
  it.each<[PlatformRole, AccessMode, boolean]>([
    ['R1', 'read_only', false],
    ['R2', 'read_only', true],
    ['R2', 'read_write', false],
    ['R3', 'read_only', true],
    ['R3', 'read_write', true],
    ['R4', 'read_only', false],
    ['R5', 'read_write', false],
    ['R6', 'read_only', false],
  ])('%s approving a %s elevation is %s', (role, mode, expected) => {
    expect(mayApproveAccessMode(role, mode)).toBe(expected);
  });
});

describe('breakGlassApprovalRefusal mode rule', () => {
  it('lets an auditor approve a read-only elevation', () => {
    expect(verdict([PLATFORM], 'read_only')).toBeNull();
  });

  it('refuses an auditor approving a read-write elevation', () => {
    expect(verdict([PLATFORM], 'read_write')).toMatchObject({
      code: 'APPROVAL_MODE_FORBIDDEN',
      detail:
        'R2 may approve read-only elevations only, and this request asks for read-write access.',
      remediation: expect.stringContaining('Ask the owner of the affected domain'),
    });
  });

  it('lets a domain owner approve either mode inside their own domain', () => {
    expect(verdict([R3_CRM], 'read_only')).toBeNull();
    expect(verdict([R3_CRM], 'read_write')).toBeNull();
  });

  it('lets a platform-scoped domain owner approve another domain', () => {
    expect(
      verdict([R3_PLATFORM], 'read_write', { instanceId: 'inst-docs', domain: DOCUMENTS }),
    ).toBeNull();
  });

  it('lets an instance-scoped owner approve the instance the elevation names', () => {
    expect(verdict([R3_INSTANCE], 'read_write')).toBeNull();
  });
});

describe('breakGlassApprovalRefusal scope rule', () => {
  it('refuses a domain owner approving another domain', () => {
    expect(verdict([R3_DOCUMENTS], 'read_write')).toMatchObject({
      code: 'APPROVAL_SCOPE_FORBIDDEN',
      detail: `The elevation targets ${CRM}, which is outside the domains you own.`,
      remediation: expect.stringContaining('Ask an approver who owns that domain'),
    });
  });

  it('refuses an instance-scoped owner approving a different instance', () => {
    expect(
      verdict([R3_INSTANCE], 'read_only', { instanceId: 'inst-docs', domain: CRM }),
    ).toMatchObject({ code: 'APPROVAL_SCOPE_FORBIDDEN' });
  });

  it('fails closed when the target domain cannot be resolved', () => {
    expect(verdict([R3_CRM], 'read_only', { instanceId: null, domain: null })).toMatchObject({
      code: 'APPROVAL_SCOPE_FORBIDDEN',
      detail: expect.stringContaining('the affected product'),
    });
  });

  it('refuses an auditor whose binding is limited to another domain', () => {
    expect(
      verdict([{ ...PLATFORM, scopeType: 'domain', scopeId: DOCUMENTS }], 'read_only'),
    ).toMatchObject({ code: 'APPROVAL_SCOPE_FORBIDDEN' });
  });

  it('reports the mode before the scope when both would refuse', () => {
    expect(
      verdict([{ ...PLATFORM, scopeType: 'domain', scopeId: DOCUMENTS }], 'read_write'),
    ).toMatchObject({ code: 'APPROVAL_MODE_FORBIDDEN' });
  });
});

describe('breakGlassApprovalRefusal answers only for approvers', () => {
  it('stays silent for a role that does not hold the capability', () => {
    // The route policy refuses R1 first; a second refusal here would tell the requester to ask a
    // domain owner for a capability they will never hold.
    expect(verdict([R1], 'read_write')).toBeNull();
  });

  it('stays silent when the grant set is empty', () => {
    expect(verdict([], 'read_write')).toBeNull();
  });

  it('accepts one covering grant among several', () => {
    expect(verdict([R3_DOCUMENTS, R3_CRM], 'read_write')).toBeNull();
  });
});
