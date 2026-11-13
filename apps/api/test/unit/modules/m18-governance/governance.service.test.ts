import { describe, expect, it, vi } from 'vitest';
import { PostgresGovernanceService } from '../../../../src/modules/m18-governance/governance.service';
import { fakeDb, type QueryCall, type Row } from '../../../support/fakes';

/**
 * M18 read surface plus the one row it writes (the hosted-service gate). The register and the gate
 * are the same query twice, so the mapping is asserted on both: a licence id absent from the review
 * record falls back to the licence table, and a licence in neither refuses the toggle rather than
 * assuming the permissive answer.
 */

const INSTANCE_ID = '018f0000-0000-4000-8000-000000000002';

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  const audit = {
    lockChain: vi.fn(async (_tx?: unknown) => undefined),
    append: vi.fn(async (_input: unknown, _tx?: unknown) => ({ seq: '1', hash: 'hash' })),
  };
  const service = new PostgresGovernanceService(db.pool, audit as never);
  return { db, audit, service };
}

function callFor(calls: readonly QueryCall[], matcher: string): QueryCall | undefined {
  return calls.find((call) => call.sql.includes(matcher));
}

function paramsFor(calls: readonly QueryCall[], matcher: string): readonly unknown[] {
  return callFor(calls, matcher)?.params ?? [];
}

const LICENSE_QUERY = 'LEFT JOIN license_record l';

describe('licenses', () => {
  it('takes a review that exists as authoritative, restrictions and all', async () => {
    const { service } = setup([
      [
        LICENSE_QUERY,
        [
          {
            instance_id: INSTANCE_ID,
            entry_key: 'D01-01',
            product: 'Mail',
            license_id: 'Commercial-2026',
            obligations: ['State modifications when redistributing'],
            recorded: true,
            resale_restricted: true,
            hosted_service_restricted: false,
            hosted_service_enabled: true,
            reviewed_by: 'auditor-1',
            reviewed_at: new Date('2026-02-01T00:00:00.000Z'),
          },
        ],
      ],
    ]);

    const [record] = await service.licenses();

    expect(record).toEqual({
      instanceId: INSTANCE_ID,
      entryKey: 'D01-01',
      product: 'Mail',
      licenseId: 'Commercial-2026',
      obligations: ['State modifications when redistributing'],
      resaleRestricted: true,
      hostedServiceRestricted: false,
      reviewedBy: 'auditor-1',
      reviewedAt: '2026-02-01T00:00:00.000Z',
      status: 'cleared',
      hostedService: true,
    });
  });

  it('states the licence terms for a deployment nobody has reviewed yet', async () => {
    const { service } = setup([
      [
        LICENSE_QUERY,
        [
          {
            instance_id: INSTANCE_ID,
            entry_key: 'D02-01',
            product: 'Docs',
            license_id: 'AGPL-3.0',
            obligations: [],
            recorded: false,
            resale_restricted: false,
            hosted_service_restricted: false,
            hosted_service_enabled: false,
            reviewed_by: null,
            reviewed_at: null,
          },
        ],
      ],
    ]);

    const [record] = await service.licenses();

    expect(record).toMatchObject({
      licenseId: 'AGPL-3.0',
      resaleRestricted: false,
      hostedServiceRestricted: false,
      reviewedBy: null,
      reviewedAt: null,
      status: 'review_required',
      hostedService: false,
    });
    expect(record?.obligations).toContain(
      'Offer the complete corresponding source to every user who interacts over a network',
    );
  });

  it('states the restriction flags of a fair-code licence before a review exists', async () => {
    const { service } = setup([
      [
        LICENSE_QUERY,
        [
          {
            instance_id: INSTANCE_ID,
            entry_key: 'D03-01',
            product: 'Flow',
            license_id: 'Sustainable Use (fair-code)',
            obligations: null,
            recorded: false,
            resale_restricted: false,
            hosted_service_restricted: false,
            hosted_service_enabled: false,
            reviewed_by: null,
            reviewed_at: null,
          },
        ],
      ],
    ]);

    const [record] = await service.licenses();

    expect(record).toMatchObject({
      resaleRestricted: true,
      hostedServiceRestricted: true,
    });
    expect(record?.obligations).toEqual([
      'Internal business use only',
      'No resale or hosted-service provision',
      'Preserve licence notices',
    ]);
  });

  it('leaves an unrecognised licence with no obligations rather than inventing terms', async () => {
    const { service } = setup([
      [
        LICENSE_QUERY,
        [
          {
            instance_id: INSTANCE_ID,
            entry_key: 'D04-01',
            product: 'Vendor',
            license_id: 'Proprietary-X',
            obligations: [],
            recorded: false,
            resale_restricted: false,
            hosted_service_restricted: false,
            hosted_service_enabled: false,
            reviewed_by: null,
            reviewed_at: new Date('2026-03-01T00:00:00.000Z'),
          },
        ],
      ],
    ]);

    const [record] = await service.licenses();

    expect(record).toMatchObject({
      obligations: [],
      resaleRestricted: false,
      hostedServiceRestricted: false,
      status: 'cleared',
    });
  });
});

const GATE_QUERY = 'WHERE i.id = $1 AND i.deleted_at IS NULL';

function gateRow(overrides: Row = {}): Row {
  return {
    entry_key: 'D01-01',
    product: 'Mail',
    license_id: 'AGPL-3.0',
    obligations: [],
    recorded: false,
    resale_restricted: false,
    hosted_service_restricted: false,
    hosted_service_enabled: false,
    reviewed_at: null,
    ...overrides,
  };
}

describe('setHostedService', () => {
  it('refuses an id that is not a uuid before querying', async () => {
    const { db, service } = setup();
    await expect(service.setHostedService('nope', true, 'admin-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No instance nope.',
      remediation: 'Refresh the licence register.',
    });
    expect(db.calls).toEqual([]);
  });

  it('refuses an instance that is gone', async () => {
    const { service } = setup([[GATE_QUERY, []]]);
    await expect(service.setHostedService(INSTANCE_ID, true, 'admin-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No instance ${INSTANCE_ID}.`,
    });
  });

  it('refuses to enable hosted-service mode for a licence with no recorded terms', async () => {
    const { db, audit, service } = setup([[GATE_QUERY, [gateRow({ license_id: null })]]]);

    await expect(service.setHostedService(INSTANCE_ID, true, 'admin-1')).rejects.toMatchObject({
      code: 'LICENCE_RESTRICTED',
      detail:
        'No licence terms are recorded for Mail (unreviewed), so hosted-service mode stays off.',
      remediation: expect.stringContaining('complete the licence review'),
    });
    expect(audit.append).toHaveBeenCalledWith({
      action: 'license.hosted_service.denied',
      actorType: 'user',
      actorId: 'admin-1',
      targetType: 'instance',
      targetId: INSTANCE_ID,
      outcome: 'denied',
      detail: {
        enabled: true,
        licenseId: 'unreviewed',
        recorded: false,
        reviewed: false,
        resaleRestricted: false,
        hostedServiceRestricted: false,
      },
    });
    expect(callFor(db.calls, 'INSERT INTO license_record')).toBeUndefined();
  });

  it('refuses a licence that does not permit offering the product to third parties', async () => {
    const { service } = setup([
      [GATE_QUERY, [gateRow({ license_id: 'Elastic License 2.0', product: 'Search' })]],
    ]);

    await expect(service.setHostedService(INSTANCE_ID, true, 'admin-1')).rejects.toMatchObject({
      code: 'LICENCE_RESTRICTED',
      detail:
        'Search is licensed under Elastic License 2.0, which does not permit resale or offering it as a hosted service.',
    });
  });

  it.each([
    ['a resale restriction', { recorded: true, resale_restricted: true }],
    ['a hosted-service restriction', { recorded: true, hosted_service_restricted: true }],
  ] as ReadonlyArray<readonly [string, Row]>)(
    'treats %s recorded by a review as blocking',
    async (_label, overrides) => {
      const { service } = setup([
        [
          GATE_QUERY,
          [
            gateRow({
              license_id: 'Commercial-2026',
              reviewed_at: new Date('2026-02-01'),
              ...overrides,
            }),
          ],
        ],
      ]);

      await expect(service.setHostedService(INSTANCE_ID, true, 'admin-1')).rejects.toMatchObject({
        code: 'LICENCE_RESTRICTED',
        detail:
          'Mail is licensed under Commercial-2026, which does not permit resale or offering it as a hosted service.',
      });
    },
  );

  it('records the first toggle as the register row, taking terms from the licence table', async () => {
    const { db, audit, service } = setup([
      [GATE_QUERY, [gateRow({ recorded: true, obligations: ['Keep the NOTICE file'] })]],
      ['INSERT INTO license_record', []],
    ]);

    const gate = await service.setHostedService(INSTANCE_ID, true, 'admin-1');

    const insert = paramsFor(db.calls, 'INSERT INTO license_record');
    expect(insert[0]).toBe(INSTANCE_ID);
    expect(insert[1]).toBe('AGPL-3.0');
    expect(JSON.parse(String(insert[2]))).toEqual(['Keep the NOTICE file']);
    expect(insert.slice(3)).toEqual([false, false, true]);
    expect(audit.append).toHaveBeenCalledWith(
      {
        action: 'license.hosted_service.updated',
        actorType: 'user',
        actorId: 'admin-1',
        targetType: 'instance',
        targetId: INSTANCE_ID,
        outcome: 'success',
        detail: { enabled: true, licenseId: 'AGPL-3.0', entryKey: 'D01-01', recorded: true },
      },
      db.client,
    );
    expect(gate).toMatchObject({
      instanceId: INSTANCE_ID,
      hostedService: true,
      restricted: false,
      reason: null,
    });
    expect(Number.isNaN(Date.parse(gate.evaluatedAt))).toBe(false);
  });

  it('creates an unreviewed row from the licence table when none exists yet', async () => {
    const { db, service } = setup([
      [GATE_QUERY, [gateRow()]],
      ['INSERT INTO license_record', []],
    ]);

    await service.setHostedService(INSTANCE_ID, true, 'admin-1');

    const insert = paramsFor(db.calls, 'INSERT INTO license_record');
    expect(JSON.parse(String(insert[2]))).toContain(
      'Offer the complete corresponding source to every user who interacts over a network',
    );
    expect(insert.slice(3)).toEqual([false, false, true]);
  });

  it('stores an empty obligation list for a reviewed licence nobody wrote terms for', async () => {
    const { db, service } = setup([
      [GATE_QUERY, [gateRow({ recorded: true, license_id: 'Vendor-2026', obligations: null })]],
      ['INSERT INTO license_record', []],
    ]);

    await service.setHostedService(INSTANCE_ID, true, 'admin-1');

    expect(paramsFor(db.calls, 'INSERT INTO license_record')[2]).toBe('[]');
  });

  it('turns hosted-service mode off without refusing, and keeps the stated reason', async () => {
    const { db, audit, service } = setup([
      [
        GATE_QUERY,
        [
          gateRow({
            license_id: 'BSL-1.1',
            recorded: true,
            hosted_service_enabled: true,
            resale_restricted: true,
            hosted_service_restricted: true,
          }),
        ],
      ],
      ['INSERT INTO license_record', []],
    ]);

    const gate = await service.setHostedService(INSTANCE_ID, false, 'admin-1');

    expect(paramsFor(db.calls, 'INSERT INTO license_record').slice(3)).toEqual([true, true, false]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'license.hosted_service.updated',
        detail: expect.objectContaining({ enabled: false }),
      }),
      db.client,
    );
    expect(gate).toMatchObject({
      hostedService: false,
      restricted: true,
      reason:
        'Mail is licensed under BSL-1.1, which does not permit resale or offering it as a hosted service.',
    });
  });

  it('writes nothing when the toggle already holds the requested value', async () => {
    const { db, audit, service } = setup([
      [GATE_QUERY, [gateRow({ recorded: true, hosted_service_enabled: true })]],
    ]);

    const gate = await service.setHostedService(INSTANCE_ID, true, 'admin-1');

    expect(db.calls).toHaveLength(1);
    expect(audit.append).not.toHaveBeenCalled();
    expect(gate).toMatchObject({ hostedService: true, restricted: false });
  });
});

const PATCH_QUERY = 'LEFT JOIN patch_record p';

function patchRow(overrides: Row = {}): Row {
  return {
    instance_id: INSTANCE_ID,
    entry_key: 'D01-01',
    product: 'Mail',
    current_version: '1.0.0',
    latest_version: '1.2.0',
    last_upgrade_at: new Date('2026-05-01T00:00:00.000Z'),
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    oldest_unapplied_security_days: 45,
    checked_at: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('patches', () => {
  it('calls an instance more than a month behind on a security update critical', async () => {
    const { service } = setup([[PATCH_QUERY, [patchRow()]]]);

    const [record] = await service.patches();

    expect(record).toEqual({
      instanceId: INSTANCE_ID,
      entryKey: 'D01-01',
      product: 'Mail',
      currentVersion: '1.0.0',
      latestVersion: '1.2.0',
      lastUpgradeAt: '2026-05-01T00:00:00.000Z',
      oldestUnappliedSecurityDays: 45,
      severity: 'critical',
      checkedAt: '2026-06-01T00:00:00.000Z',
    });
  });

  it('reports an up-to-date instance as informational, with no age to state', async () => {
    const { service } = setup([
      [
        PATCH_QUERY,
        [
          patchRow({
            current_version: '2.0.0',
            latest_version: null,
            oldest_unapplied_security_days: null,
          }),
        ],
      ],
    ]);

    const [record] = await service.patches();

    expect(record).toMatchObject({
      currentVersion: '2.0.0',
      latestVersion: '2.0.0',
      severity: 'info',
      oldestUnappliedSecurityDays: null,
    });
  });

  it('warns about a recent security update and falls back for an unchecked instance', async () => {
    const { service } = setup([
      [
        PATCH_QUERY,
        [
          patchRow({
            current_version: null,
            latest_version: '1.0.0',
            last_upgrade_at: null,
            oldest_unapplied_security_days: 10,
          }),
        ],
      ],
    ]);

    const [record] = await service.patches();

    expect(record).toMatchObject({
      currentVersion: 'unknown',
      severity: 'warning',
      lastUpgradeAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('warns, rather than claims nothing is pending, when no check has produced an age', async () => {
    const { service } = setup([
      [PATCH_QUERY, [patchRow({ oldest_unapplied_security_days: null })]],
    ]);

    const [record] = await service.patches();

    expect(record).toMatchObject({ severity: 'warning', oldestUnappliedSecurityDays: null });
  });

  it('falls back to the check time when the row carries no install date', async () => {
    const { service } = setup([
      [PATCH_QUERY, [patchRow({ last_upgrade_at: null, created_at: null })]],
    ]);

    const [record] = await service.patches();

    expect(record?.lastUpgradeAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

const INSTANCES_QUERY = 'LEFT JOIN instance_status s';
const RESTORES_QUERY = 'FROM restore_drill';
const STALE_QUERY = 'FROM integration_metadata';
/** ADR-BE-22: deployments whose product credential the platform holds. */
const MANAGED_QUERY = 'FROM product_account';

function postureDb(options: {
  instances?: Row[];
  restores?: Row[];
  stale?: Row[];
  managed?: string;
}): Parameters<typeof fakeDb>[0] {
  return [
    [INSTANCES_QUERY, options.instances ?? []],
    [RESTORES_QUERY, options.restores ?? []],
    [STALE_QUERY, options.stale ?? []],
    [MANAGED_QUERY, [{ count: options.managed ?? '0' }]],
  ];
}

const DAY = 86_400_000;

describe('posture', () => {
  it('counts per deployment and separates a stale drill from a missing one', async () => {
    const performedAt = new Date(Date.now() - 200 * DAY);
    const { service } = setup(
      postureDb({
        instances: [
          { id: 'A', product: 'Mail', entry_key: 'D01-01', guarantee_class: 'native', ready: true },
          {
            id: 'B',
            product: 'Mail',
            entry_key: 'D01-01',
            guarantee_class: 'fa_header',
            ready: null,
          },
          {
            id: 'C',
            product: 'Docs',
            entry_key: 'D02-01',
            guarantee_class: 'fa_delegated',
            ready: false,
          },
          { id: 'D', product: 'Flow', entry_key: 'D03-01', guarantee_class: null, ready: null },
        ],
        restores: [
          { instance_id: 'A', performed_at: new Date(Date.now() - 5 * DAY) },
          { instance_id: 'B', performed_at: performedAt },
          { instance_id: null, performed_at: new Date() },
        ],
        stale: [
          {
            entry_key: 'D01-01',
            product: 'Mail',
            verified_at: new Date('2026-01-01T00:00:00.000Z'),
            next_review_at: new Date(Date.now() - 3.5 * DAY),
          },
          {
            entry_key: 'D02-01',
            product: 'Docs',
            verified_at: new Date('2026-01-01T00:00:00.000Z'),
            next_review_at: new Date(Date.now() - 3_600_000),
          },
        ],
      }),
    );

    const summary = await service.posture();

    expect(summary.sso).toEqual({
      native: 1,
      forwardAuth: 2,
      signInRequired: 1,
      totalEntries: 3,
      platformManagedCredentials: 0,
    });
    expect(summary.totalInstances).toBe(4);
    expect(summary.coveragePercent).toBe(25);
    expect(summary.instancesWithoutHealthCheck).toBe(2);
    expect(summary.missingHealthChecks).toEqual([
      { instanceId: 'B', product: 'Mail' },
      { instanceId: 'D', product: 'Flow' },
    ]);
    expect(summary.unverifiedRestores).toEqual([
      { instanceId: 'B', product: 'Mail', lastVerifiedAt: performedAt.toISOString() },
      { instanceId: 'C', product: 'Docs', lastVerifiedAt: null },
      { instanceId: 'D', product: 'Flow', lastVerifiedAt: null },
    ]);
    expect(summary.staleMetadata).toEqual([
      {
        entryKey: 'D01-01',
        product: 'Mail',
        verifiedAt: '2026-01-01T00:00:00.000Z',
        daysOverdue: 3,
      },
      {
        entryKey: 'D02-01',
        product: 'Docs',
        verifiedAt: '2026-01-01T00:00:00.000Z',
        daysOverdue: 1,
      },
    ]);
    expect(summary.expiringCertificates).toEqual([]);
    expect(Number.isNaN(Date.parse(summary.generatedAt))).toBe(false);
  });

  it('reports zero coverage for an empty fleet instead of dividing by zero', async () => {
    const { service } = setup(postureDb({}));

    const summary = await service.posture();

    expect(summary).toMatchObject({
      totalInstances: 0,
      coveragePercent: 0,
      instancesWithoutHealthCheck: 0,
      unverifiedRestores: [],
      staleMetadata: [],
      sso: {
        native: 0,
        forwardAuth: 0,
        signInRequired: 0,
        totalEntries: 0,
        platformManagedCredentials: 0,
      },
    });
  });

  it('counts the deployments whose credential the platform holds, inside sign-in-required', async () => {
    const { service } = setup(
      postureDb({
        instances: [
          {
            id: 'A',
            product: 'OpenProject',
            entry_key: 'D09-01',
            guarantee_class: 'fa_gate',
            ready: true,
          },
        ],
        managed: '1',
      }),
    );

    const summary = await service.posture();

    // A relayed password is not single sign-on: the deployment stays in `signInRequired`, and the
    // count is what lets the screen say "platform-managed credential" instead of "outside".
    expect(summary.sso).toMatchObject({
      signInRequired: 1,
      native: 0,
      platformManagedCredentials: 1,
    });
  });
});

function bgRow(overrides: Row = {}): Row {
  return {
    id: 'bg-1',
    requester: 'sub-1',
    instance_id: INSTANCE_ID,
    product: 'Mail',
    access_mode: 'read_write',
    justification: 'Investigating the failing nightly job',
    approver: 'sub-2',
    approver_name: 'Alex Approver',
    self_approved: false,
    state: 'active',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    granted_at: new Date('2026-01-01T00:05:00.000Z'),
    expires_at: new Date('2029-01-01T01:05:00.000Z'),
    revoked_at: null,
    created_accounts: [],
    retention_reason: null,
    ...overrides,
  };
}

describe('breakGlass', () => {
  it('maps a live grant, resolving both parties to directory names', async () => {
    const { db, service } = setup([
      [
        'FROM break_glass_session b',
        [bgRow({ requester_name: 'Rita Requester', created_accounts: [{}] })],
      ],
    ]);

    const [session] = await service.breakGlass();

    expect(session).toEqual({
      id: 'bg-1',
      requester: { id: 'sub-1', name: 'Rita Requester' },
      instanceId: INSTANCE_ID,
      product: 'Mail',
      domainOwner: 'Platform',
      accessMode: 'read_write',
      justification: 'Investigating the failing nightly job',
      approver: 'Alex Approver',
      selfApproved: false,
      state: 'active',
      requestedAt: '2026-01-01T00:00:00.000Z',
      grantedAt: '2026-01-01T00:05:00.000Z',
      expiresAt: '2029-01-01T01:05:00.000Z',
      revokedAt: null,
      createdAccounts: 1,
      retentionReason: null,
    });
    expect(paramsFor(db.calls, 'FROM break_glass_session b')).toEqual([]);
  });

  it('never reports a grant as live once the clock has passed its window', async () => {
    const { service } = setup([
      [
        'FROM break_glass_session b',
        [bgRow({ requester_name: 'Rita Requester', expires_at: new Date(Date.now() - 60_000) })],
      ],
    ]);

    const [session] = await service.breakGlass();

    expect(session?.state).toBe('expired');
  });

  it('falls back to the identifier for an elevation with no instance and no product', async () => {
    const { service } = setup([
      [
        'FROM break_glass_session b',
        [
          bgRow({
            requester_name: 'Rita Requester',
            instance_id: null,
            product: null,
            approver_name: null,
            created_accounts: null,
            granted_at: null,
            expires_at: null,
            revoked_at: new Date('2026-01-02T00:00:00.000Z'),
            state: 'revoked',
            retention_reason: 'accounts revoked on expiry',
          }),
        ],
      ],
    ]);

    const [session] = await service.breakGlass();

    expect(session).toMatchObject({
      instanceId: 'bg-1',
      product: 'Platform',
      approver: null,
      createdAccounts: 0,
      grantedAt: null,
      expiresAt: null,
      revokedAt: '2026-01-02T00:00:00.000Z',
      state: 'revoked',
      retentionReason: 'accounts revoked on expiry',
    });
  });
});

const WINDOW_QUERY = 'FROM maintenance_window m';

describe('maintenance', () => {
  it('renders every window through the one mapper the write path shares', async () => {
    const { db, service } = setup([
      [
        WINDOW_QUERY,
        [
          {
            id: 'mw-1',
            scope: 'Core Operations',
            instance_id: INSTANCE_ID,
            product: 'Mail',
            starts_at: new Date(Date.now() - 60_000),
            ends_at: new Date(Date.now() + 60_000),
            created_by: 'sub-1',
            created_by_label: 'Rita Requester',
            cancelled_at: null,
          },
          {
            id: 'mw-2',
            scope: 'Platform upgrade',
            instance_id: null,
            product: null,
            starts_at: new Date(Date.now() - 7_200_000),
            ends_at: new Date(Date.now() - 3_600_000),
            created_by: 'sub-2',
            created_by_label: null,
            cancelled_at: null,
          },
        ],
      ],
    ]);

    const windows = await service.maintenance();

    expect(windows.map((window) => [window.id, window.scopeLabel, window.state])).toEqual([
      ['mw-1', 'Mail', 'active'],
      ['mw-2', 'Platform upgrade', 'completed'],
    ]);
    expect(windows[1]?.createdBy).toBe('sub-2');
    expect(String(callFor(db.calls, WINDOW_QUERY)?.sql)).toContain('ORDER BY m.starts_at DESC');
  });
});

const EXCEPTIONS_QUERY = 'FROM policy_exception pe';

function exceptionRow(overrides: Row = {}): Row {
  return {
    id: 'pe-1',
    rule: 'no-hosted-service',
    scope: 'D01-01',
    justification: 'Needs hosted service until the licence lands',
    approver: 'sub-requester',
    state: 'pending',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    expires_at: new Date('2026-02-01T00:00:00.000Z'),
    patch_diff: { requestedBy: 'sub-requester', diff: '--- a\n+++ b' },
    requester_name: null,
    approver_name: null,
    ...overrides,
  };
}

describe('policyExceptions', () => {
  it.each([
    ['pending', 'requested'],
    ['requested', 'requested'],
    ['approved', 'approved'],
    ['rejected', 'rejected'],
    ['expired', 'expired'],
    ['withdrawn', 'expired'],
  ] as ReadonlyArray<readonly [string, string]>)(
    'names a "%s" row %s on the wire',
    async (column, wire) => {
      const { service } = setup([[EXCEPTIONS_QUERY, [exceptionRow({ state: column })]]]);

      const [exception] = await service.policyExceptions();

      expect(exception?.state).toBe(wire);
    },
  );

  it('leaves an undecided row without an approver, reading the requester out of the diff', async () => {
    const { service } = setup([[EXCEPTIONS_QUERY, [exceptionRow()]]]);

    const [exception] = await service.policyExceptions();

    expect(exception).toEqual({
      id: 'pe-1',
      rule: 'no-hosted-service',
      scope: 'D01-01',
      justification: 'Needs hosted service until the licence lands',
      requester: 'sub-requester',
      approver: null,
      state: 'requested',
      requestedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-02-01T00:00:00.000Z',
      patchDiff: '--- a\n+++ b',
    });
  });

  it('names both parties once a decision exists, or falls back to the column', async () => {
    const { service } = setup([
      [
        EXCEPTIONS_QUERY,
        [
          exceptionRow({
            id: 'pe-2',
            state: 'approved',
            approver: 'sub-approver',
            requester_name: 'Rita Requester',
            approver_name: 'Alex Approver',
          }),
          exceptionRow({
            id: 'pe-3',
            state: 'rejected',
            approver: 'sub-approver',
            requester_name: 'Rita Requester',
            approver_name: null,
            patch_diff: 'plain text diff',
          }),
        ],
      ],
    ]);

    const [named, unresolved] = await service.policyExceptions();

    expect(named).toMatchObject({ requester: 'Rita Requester', approver: 'Alex Approver' });
    expect(unresolved).toMatchObject({
      requester: 'Rita Requester',
      approver: 'sub-approver',
      patchDiff: 'plain text diff',
    });
  });
});

const DSAR_QUERY = 'FROM dsar_request ORDER BY opened_at DESC';

function dsarRow(overrides: Row = {}): Row {
  return {
    id: 'dsar-1',
    subject_ref: 'a'.repeat(64),
    kind: 'export',
    state: 'in_progress',
    opened_by: 'sub-1',
    opened_at: new Date('2026-01-01T00:00:00.000Z'),
    closed_at: null,
    evidence: { notes: ['queued'] },
    ...overrides,
  };
}

describe('dsar', () => {
  it.each([
    ['in_progress', 'running'],
    ['completed', 'complete'],
    ['rejected', 'failed'],
    ['expired', 'failed'],
    ['open', 'open'],
    ['something-else', 'open'],
  ] as ReadonlyArray<readonly [string, string]>)(
    'names a "%s" request %s on the wire',
    async (column, wire) => {
      const { service } = setup([[DSAR_QUERY, [dsarRow({ state: column })]]]);

      const [request] = await service.dsar();

      expect(request?.state).toBe(wire);
    },
  );

  it('reports an erased subject as erased and keeps the evidence steps', async () => {
    const { db, service } = setup([
      [
        DSAR_QUERY,
        [
          dsarRow({
            subject_ref: null,
            state: 'completed',
            closed_at: new Date('2026-01-09T00:00:00.000Z'),
          }),
        ],
      ],
    ]);

    const [request] = await service.dsar();

    expect(request).toEqual({
      id: 'dsar-1',
      subjectRef: 'erased',
      kind: 'export',
      state: 'complete',
      openedBy: 'sub-1',
      openedAt: '2026-01-01T00:00:00.000Z',
      closedAt: '2026-01-09T00:00:00.000Z',
      evidence: ['queued'],
    });
    expect(paramsFor(db.calls, DSAR_QUERY)).toEqual([]);
  });

  it('reports no evidence steps for a request that recorded none', async () => {
    const { service } = setup([[DSAR_QUERY, [dsarRow({ evidence: {} })]]]);

    const [request] = await service.dsar();

    expect(request).toMatchObject({ evidence: [], closedAt: null });
  });
});
