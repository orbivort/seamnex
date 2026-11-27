import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AppError } from '../../../../src/common/problem/app-error';
import { runWithContext } from '../../../../src/common/identity/request-context';
import { PostgresWorkflowAuthority } from '../../../../src/modules/m13-workflow/workflow-authority.service';
import { fakeDb, failingDb, type Route } from '../../../support/fakes';

/**
 * FR-5.9 / AC-26 / NFR-4.4 — the API's write-target gate.
 *
 * The rule itself is a pure function with its own matrix; these cases pin the three facts this
 * service feeds it and the two answers it owes the caller: a refusal that names the product and the
 * missing authority (and is audited), and the elevation evidence an R1 write leaned on. They also
 * pin the two failure modes that matter — a grants query that fails must deny rather than fall back
 * to the session role, and an entry key with no usable deployment must not be read as a target.
 */

const INSTANCE_ID = '2f1d6a3e-4b5c-4d6e-8f70-1a2b3c4d5e6f';
const WORKFLOW_ID = '6a7088ab-6955-47b2-88a2-797ae750f1a0';
const SESSION_ID = '8f3c1e2d-1a2b-4c3d-9e4f-5a6b7c8d9e0f';

const ENTRY_TARGETS = 'unnest($1::text[]) AS t(entry_key)';
const INSTANCE_TARGETS = 'WHERE i.id = ANY($1::uuid[])';

type Grant = {
  role: string;
  scopeType: 'platform' | 'domain' | 'instance';
  scopeId: string | null;
  expiresAt: string | null;
};

function grant(role: string, scopeType: Grant['scopeType'], scopeId: string | null): Grant {
  return { role, scopeType, scopeId, expiresAt: null };
}

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    entry_key: 'D01-01',
    instance_id: INSTANCE_ID,
    domain: 'CRM & Sales Pipeline',
    product: 'EspoCRM',
    granularity: 'scoped',
    ...overrides,
  };
}

function setup(options: {
  grants?: Grant[];
  targets?: unknown[];
  instances?: unknown[];
  elevations?: { instanceId: string; sessionId: string }[];
  /** The role-binding read fails; the rest of the database is healthy. */
  grantsError?: Error;
  /** The target resolution fails. */
  dbError?: Error;
}) {
  const routes: Route[] = [];
  if (options.targets !== undefined) routes.push([ENTRY_TARGETS, options.targets]);
  if (options.instances !== undefined) routes.push([INSTANCE_TARGETS, options.instances]);
  const db = options.dbError === undefined ? fakeDb(routes) : failingDb(options.dbError);

  const access = {
    grantsFor: vi.fn(async () => {
      if (options.grantsError !== undefined) throw options.grantsError;
      return options.grants ?? [];
    }),
    roleFor: vi.fn(async () => 'R5'),
    settings: vi.fn(),
    putSettings: vi.fn(),
    compilePolicy: vi.fn(),
  };
  const governance = {
    activeWriteElevations: vi.fn(async () => options.elevations ?? []),
  };
  const audit = {
    lockChain: vi.fn(async () => undefined),
    append: vi.fn(async () => ({ seq: '1', hash: 'h' })),
    denied: vi.fn(async () => undefined),
  };

  const service = new PostgresWorkflowAuthority(
    db.pool as unknown as Pool,
    access as never,
    governance as never,
    audit as never,
  );
  return { db, access, governance, audit, service };
}

describe('creating a workflow', () => {
  it('permits a domain owner writing into their own domain', async () => {
    const { service, audit, governance } = setup({
      grants: [grant('R3', 'domain', 'CRM & Sales Pipeline')],
      instances: [targetRow()],
    });

    await expect(
      service.assertPermitted({
        actorId: 'dev-owner',
        action: 'create',
        policyKey: 'workflow.author',
        instanceIds: [INSTANCE_ID],
      }),
    ).resolves.toEqual({ elevations: [] });
    // Standing authority never asks for an elevation, so the read is not even issued.
    expect(governance.activeWriteElevations).not.toHaveBeenCalled();
    expect(audit.denied).not.toHaveBeenCalled();
  });

  it('refuses a target outside the caller domains, naming the product and the missing authority', async () => {
    const { service, audit } = setup({
      grants: [grant('R3', 'domain', 'CRM & Sales Pipeline')],
      instances: [targetRow({ domain: 'Document & Content Management', product: 'Paperless-ngx' })],
    });

    const error = await service
      .assertPermitted({
        actorId: 'dev-owner',
        action: 'create',
        policyKey: 'workflow.author',
        instanceIds: [INSTANCE_ID],
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'WORKFLOW_WRITE_NOT_PERMITTED', status: 403 });
    // The design's requirement: which target, and which role is missing.
    expect((error as AppError).detail).toContain('Paperless-ngx (D01-01)');
    expect((error as AppError).detail).toContain('outside the domains you own');
    expect((error as AppError).fieldErrors).toEqual([
      expect.objectContaining({ field: 'writeTargets', code: 'domain' }),
    ]);
    // AC-38: a denial is audited, with the target and the reason a reader needs.
    expect(audit.denied).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'user',
        actorId: 'dev-owner',
        targetType: 'workflow',
        detail: expect.objectContaining({
          policyKey: 'workflow.author',
          action: 'create',
          refusals: [expect.objectContaining({ entryKey: 'D01-01', missing: 'domain' })],
        }),
      }),
    );
  });

  it('refuses an R1 with no elevation: inside a product, R1 authority is break-glass', async () => {
    const { service, audit, governance } = setup({
      grants: [grant('R1', 'platform', null)],
      instances: [targetRow()],
      elevations: [],
    });

    await expect(
      service.assertPermitted({
        actorId: 'dev-admin',
        action: 'create',
        policyKey: 'workflow.author',
        instanceIds: [INSTANCE_ID],
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_WRITE_NOT_PERMITTED', status: 403 });

    expect(governance.activeWriteElevations).toHaveBeenCalledWith('dev-admin', [INSTANCE_ID]);
    expect(audit.denied).toHaveBeenCalled();
  });

  it('permits an R1 with an active read-write elevation and returns it as evidence', async () => {
    const { service, audit } = setup({
      grants: [grant('R1', 'platform', null)],
      instances: [targetRow()],
      elevations: [{ instanceId: INSTANCE_ID, sessionId: SESSION_ID }],
    });

    await expect(
      service.assertPermitted({
        actorId: 'dev-admin',
        action: 'create',
        policyKey: 'workflow.author',
        instanceIds: [INSTANCE_ID],
      }),
    ).resolves.toEqual({ elevations: [{ instanceId: INSTANCE_ID, elevationId: SESSION_ID }] });
    expect(audit.denied).not.toHaveBeenCalled();
  });

  it('denies when the role bindings cannot be read, instead of falling back to the session role', async () => {
    const { service, audit } = setup({
      grants: [grant('R1', 'platform', null)],
      instances: [targetRow()],
      grantsError: new Error('role_binding unavailable'),
    });

    await expect(
      service.assertPermitted({
        // A session role of R1 is exactly the fallback this must not take.
        role: 'R1',
        actorId: 'dev-admin',
        action: 'create',
        policyKey: 'workflow.author',
        instanceIds: [INSTANCE_ID],
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_WRITE_NOT_PERMITTED' });
    expect(audit.denied).toHaveBeenCalled();
  });

  it('still refuses when the denial cannot be audited', async () => {
    const { service, audit } = setup({
      grants: [grant('R3', 'domain', 'CRM & Sales Pipeline')],
      instances: [targetRow({ domain: 'Document & Content Management' })],
    });
    audit.denied.mockRejectedValueOnce(new Error('audit chain unavailable'));

    // An audit outage must not become an allow: the refusal is still the answer.
    await expect(
      service.assertPermitted({
        actorId: 'dev-owner',
        action: 'create',
        policyKey: 'workflow.author',
        instanceIds: [INSTANCE_ID],
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_WRITE_NOT_PERMITTED', status: 403 });
  });

  it('records the request id on the denial when one is in flight', async () => {
    const { service, audit } = setup({
      grants: [grant('R3', 'domain', 'CRM & Sales Pipeline')],
      instances: [targetRow({ domain: 'Document & Content Management' })],
    });
    const context = {
      requestId: 'req-42',
      processRole: 'api' as const,
      subject: { idpId: 'dev-owner', username: 'dev-owner' },
      role: 'R3' as const,
    } as never;

    await runWithContext(context, async () => {
      await expect(
        service.assertPermitted({
          actorId: 'dev-owner',
          action: 'create',
          policyKey: 'workflow.author',
          instanceIds: [INSTANCE_ID],
        }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_WRITE_NOT_PERMITTED' });
    });

    expect(audit.denied).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-42' }));
  });

  it('refuses, and says so, when the write targets cannot be resolved', async () => {
    const { service, audit } = setup({
      grants: [grant('R1', 'platform', null)],
      dbError: new Error('targets unavailable'),
    });

    const error = await service
      .assertPermitted({
        actorId: 'dev-admin',
        action: 'create',
        policyKey: 'workflow.author',
        instanceIds: [INSTANCE_ID],
      })
      .catch((thrown: unknown) => thrown);

    // Not "writes nowhere, therefore permitted": the difference between an empty target set and an
    // unreadable one is the whole point of the check.
    expect(error).toMatchObject({ code: 'WORKFLOW_WRITE_NOT_PERMITTED', status: 403 });
    expect((error as AppError).detail).toContain('could not be resolved');
    expect(audit.denied).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          refusals: [expect.objectContaining({ missing: 'unresolved' })],
        }),
      }),
    );
  });

  it('does not gate a definition whose targets are not deployed here', async () => {
    const { service, audit } = setup({
      grants: [],
      targets: [
        { entry_key: 'D99-99', instance_id: null, domain: null, product: null, granularity: null },
      ],
    });

    await expect(
      service.assertPermitted({
        actorId: 'dev-owner',
        action: 'import',
        policyKey: 'workflow.author',
        entryKeys: ['D99-99'],
      }),
    ).resolves.toEqual({ elevations: [] });
    // Validation and activation report the undeployed product; authority is about instances.
    expect(audit.denied).not.toHaveBeenCalled();
  });
});

describe('editing a workflow', () => {
  it('counts a product once even when the definition names it twice', async () => {
    const { service } = setup({
      grants: [grant('R4', 'instance', INSTANCE_ID)],
      targets: [targetRow(), targetRow()],
    });

    await expect(
      service.assertPermitted({
        actorId: 'dev-product',
        action: 'edit',
        policyKey: 'workflow.author',
        workflowId: WORKFLOW_ID,
        entryKeys: ['D01-01', 'D01-01'],
      }),
    ).resolves.toEqual({ elevations: [] });
  });

  it('skips an entry key that is not deployed here', async () => {
    const { service } = setup({
      grants: [grant('R3', 'domain', 'CRM & Sales Pipeline')],
      targets: [
        { entry_key: 'D99-99', instance_id: null, domain: null, product: null, granularity: null },
      ],
    });

    await expect(
      service.assertPermitted({
        actorId: 'dev-owner',
        action: 'edit',
        policyKey: 'workflow.author',
        workflowId: WORKFLOW_ID,
        entryKeys: ['D99-99'],
      }),
    ).resolves.toEqual({ elevations: [] });
  });

  it('skips an entry key whose deployment cannot mint a write scope', async () => {
    const { service } = setup({
      grants: [grant('R4', 'instance', INSTANCE_ID)],
      targets: [targetRow({ granularity: 'account' })],
    });

    await expect(
      service.assertPermitted({
        actorId: 'dev-product',
        action: 'edit',
        policyKey: 'workflow.author',
        workflowId: WORKFLOW_ID,
        entryKeys: ['D01-01'],
      }),
    ).resolves.toEqual({ elevations: [] });
  });

  it('refuses a second write target for a product administrator', async () => {
    const { service } = setup({
      grants: [grant('R4', 'instance', INSTANCE_ID)],
      targets: [
        targetRow(),
        targetRow({
          entry_key: 'D08-01',
          instance_id: '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d',
          domain: 'Document & Content Management',
          product: 'Paperless-ngx',
        }),
      ],
    });

    await expect(
      service.assertPermitted({
        actorId: 'dev-product',
        action: 'edit',
        policyKey: 'workflow.author',
        workflowId: WORKFLOW_ID,
        entryKeys: ['D01-01', 'D08-01'],
      }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_WRITE_NOT_PERMITTED',
      detail: expect.stringContaining('exactly one instance'),
    });
  });

  it('checks the instance the egress plan will use, not merely a deployed one', async () => {
    const scoped = '1a1a1a1a-2222-4333-8444-555566667777';
    const { service } = setup({
      grants: [grant('R4', 'instance', INSTANCE_ID)],
      targets: [
        targetRow({ instance_id: '0b0b0b0b-1111-4222-8333-444455556666', granularity: 'none' }),
        targetRow({ instance_id: scoped, granularity: 'scoped' }),
      ],
    });

    // The scoped deployment is the one a run writes through, so the grant on the account-wide one
    // does not authorise it.
    await expect(
      service.assertPermitted({
        actorId: 'dev-product',
        action: 'run',
        policyKey: 'workflow.run',
        workflowId: WORKFLOW_ID,
        entryKeys: ['D01-01'],
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_WRITE_NOT_PERMITTED' });
  });
});

describe('listScope', () => {
  it('is unrestricted for a platform-scoped reading role', async () => {
    const { service } = setup({ grants: [grant('R2', 'platform', null)] });

    await expect(service.listScope('dev-auditor')).resolves.toEqual({ unrestricted: true });
  });

  it('names the domains and instances a scoped actor holds', async () => {
    const { service } = setup({
      grants: [
        grant('R3', 'domain', 'CRM & Sales Pipeline'),
        grant('R3', 'domain', 'Document & Content Management'),
        grant('R4', 'instance', INSTANCE_ID),
      ],
    });

    await expect(service.listScope('dev-owner')).resolves.toEqual({
      unrestricted: false,
      domains: ['CRM & Sales Pipeline', 'Document & Content Management'],
      instanceIds: [INSTANCE_ID],
    });
  });

  it('falls back to the session role when the subject has no binding, and to nothing otherwise', async () => {
    const { service } = setup({ grants: [] });

    await expect(service.listScope('dev-admin', 'R1')).resolves.toEqual({ unrestricted: true });
    await expect(service.listScope('nobody', 'R5')).resolves.toEqual({
      unrestricted: false,
      domains: [],
      instanceIds: [],
    });
  });

  it('denies everything when the bindings cannot be read', async () => {
    const { service } = setup({ grantsError: new Error('db down') });

    await expect(service.listScope('dev-owner', 'R3')).resolves.toEqual({
      unrestricted: false,
      domains: [],
      instanceIds: [],
    });
  });
});
