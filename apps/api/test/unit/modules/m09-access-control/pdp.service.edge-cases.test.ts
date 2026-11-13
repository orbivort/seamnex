import { describe, expect, it, vi } from 'vitest';
import type { PlatformRole } from '@seamnex/domain';
import type { RequestContext } from '../../../../src/common/identity/request-context';
import { fakeDb } from '../../../support/fakes';
import { PdpService } from '../../../../src/modules/m09-access-control/pdp.service';

/**
 * The scope resolver's refusals. Every case here is a grant that *looks* usable and must not be:
 * a scope type the platform does not define, a scope rule that keeps the decision platform-wide, a
 * role the capability matrix has never heard of, and a domain that cannot be resolved. All of them
 * deny, because the PDP fails closed and a denial is checked by the evidence it leaves behind.
 */
type Grant = {
  role: string;
  scopeType: string;
  scopeId: string | null;
  expiresAt: string | null;
};

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: 'req-1',
    processRole: 'api',
    subject: { idpId: 'uuid-1', username: 'alice' },
    role: 'R3',
    actorType: 'user',
    sessionId: 'sess-1',
    instanceId: null,
    scopes: [],
    mfaSatisfied: true,
    mfaMethod: 'totp',
    mfaAsserted: true,
    sessionExpiresAt: null,
    sessionIdleExpiresAt: null,
    csrfToken: 'csrf',
    groups: [],
    ...overrides,
  };
}

function setup(
  options: {
    grants?: Grant[];
    routes?: Parameters<typeof fakeDb>[0];
    grantsError?: Error | string;
  } = {},
) {
  const db = fakeDb(options.routes ?? []);
  const redis = { get: vi.fn(async () => null), set: vi.fn(async () => 'OK') };
  const audit = { denied: vi.fn(async () => undefined) };
  const access = {
    grantsFor: vi.fn(async () => {
      if (options.grantsError !== undefined) throw options.grantsError;
      return options.grants ?? [];
    }),
  };
  const service = new PdpService(
    db.pool,
    redis as never,
    audit as never,
    access as never,
    { activeVersion: 7 } as never,
  );
  return { db, redis, audit, access, service };
}

const INSTANCE = { type: 'instance', id: 'inst-1' } as never;

describe('scope resolution refuses what it cannot place', () => {
  it('denies a grant whose scope type the platform does not define', async () => {
    // A row written by a hand-edited migration must not fall through to "allowed"; the reader is
    // the last place that can notice the value is not one of the three it knows.
    const { audit, service } = setup({
      grants: [{ role: 'R3', scopeType: 'team', scopeId: 'inst-1', expiresAt: null }],
      routes: [['FROM instance i JOIN catalog_entry', [{ domain: 'core' }]]],
    });

    const decision = await service.decide({
      context: context({ role: 'R3' }),
      policyKey: 'instance.configure',
      resource: INSTANCE,
    });

    expect(decision).toEqual({
      allowed: false,
      policyVersion: 7,
      reason: 'the scoped grant does not cover this resource',
    });
    expect(audit.denied).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'instance',
        targetId: 'inst-1',
        detail: expect.objectContaining({ policyVersion: 7 }),
      }),
    );
  });

  it('skips a grant for a role the capability matrix does not define', async () => {
    const { service } = setup({
      grants: [{ role: 'R7', scopeType: 'platform', scopeId: null, expiresAt: null }],
    });

    // An unknown role grants nothing at all — it is skipped, not treated as a wildcard.
    await expect(
      service.decide({
        // Deliberately outside `PlatformRole`: an unknown role is the case under test.
        context: context({ role: 'R7' as unknown as PlatformRole }),
        policyKey: 'instance.deploy',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'no role grants the capability' });
  });

  it('refuses a domain grant with no scope id even when the domain matches nothing', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'domain', scopeId: null, expiresAt: null }],
      routes: [['FROM instance i JOIN catalog_entry', [{ domain: 'core' }]]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'instance.configure',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('never queries for the domain of a resource that names no id', async () => {
    const { db, service } = setup({
      grants: [{ role: 'R3', scopeType: 'domain', scopeId: 'core', expiresAt: null }],
    });

    const decision = await service.decide({
      context: context({ role: 'R3' }),
      policyKey: 'audit.view',
      resource: { type: 'instance', id: '' } as never,
    });

    expect(decision.allowed).toBe(false);
    // An empty id cannot address a row, so resolving a domain for it would be a wasted query.
    expect(db.calls).toEqual([]);
  });

  it('treats a domain lookup that finds no row as unresolved', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'domain', scopeId: 'core', expiresAt: null }],
      routes: [['FROM instance i JOIN catalog_entry', []]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'audit.view',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('treats a catalog entry with no domain as unresolved', async () => {
    const { db, service } = setup({
      grants: [{ role: 'R3', scopeType: 'domain', scopeId: 'core', expiresAt: null }],
      routes: [['FROM catalog_entry WHERE key', []]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'audit.view',
        resource: { type: 'catalog', id: 'D01-01' } as never,
      }),
    ).resolves.toMatchObject({ allowed: false });
    expect(db.calls[0]?.sql).toContain('FROM catalog_entry WHERE key');
  });

  it('refuses a domain grant against a resource that has no owning domain at all', async () => {
    // A workflow run is not inside a catalog domain, so there is nothing for a domain grant to
    // match — and no query is issued to look for one.
    const { db, service } = setup({
      grants: [{ role: 'R3', scopeType: 'domain', scopeId: 'core', expiresAt: null }],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'audit.view',
        resource: { type: 'workflow', id: 'wf-1' } as never,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'the scoped grant does not cover this resource',
    });
    expect(db.calls).toEqual([]);
  });
});

describe('grant and cache failures', () => {
  it('denies and reports by string when the binding read throws a non-Error', async () => {
    const { service } = setup({ grantsError: 'role_binding down' });

    await expect(
      service.decide({ context: context(), policyKey: 'catalog.browse', resource: INSTANCE }),
    ).resolves.toMatchObject({ allowed: false, reason: 'no role grants the capability' });
  });
});
