import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../../../src/common/identity/request-context';
import { fakeDb } from '../../../support/fakes';
import { MFA_REASON, PdpService } from '../../../../src/modules/m09-access-control/pdp.service';

/**
 * The policy decision point. Evaluation order is the property under test: authenticated actor,
 * then the role matrix, then the scope, then the decision. Two asymmetries are deliberate and
 * asserted: allow decisions are cached for the policy window while denials never are (every refusal
 * must leave an `access.denied` row), and a step-up refusal is decided from the session — before the
 * cache, so a cached allow cannot outlive the assurance it was made under.
 */
type Grant = {
  role: string;
  scopeType: 'platform' | 'domain' | 'instance';
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
    grants?: Grant[] | (() => Promise<Grant[]>);
    redis?: Record<string, string>;
    routes?: Parameters<typeof fakeDb>[0];
    grantsError?: Error;
  } = {},
) {
  const db = fakeDb(options.routes ?? []);
  const store = new Map(Object.entries(options.redis ?? {}));
  const redis = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  };
  const audit = { denied: vi.fn(async () => undefined) };
  const access = {
    grantsFor: vi.fn(async () => {
      if (options.grantsError !== undefined) throw options.grantsError;
      if (typeof options.grants === 'function') return options.grants();
      return (
        options.grants ?? [{ role: 'R3', scopeType: 'platform', scopeId: null, expiresAt: null }]
      );
    }),
  };
  const compiler = { activeVersion: 3 };
  const service = new PdpService(
    db.pool,
    redis as never,
    audit as never,
    access as never,
    compiler as never,
  );
  return { db, store, redis, audit, access, service };
}

const INSTANCE = { type: 'instance', id: 'inst-1' } as never;

describe('reserved keys', () => {
  it('answers the session-read question about the caller’s own session', async () => {
    const { service } = setup();

    await expect(
      service.decide({ context: context(), policyKey: 'auth.session.read', resource: INSTANCE }),
    ).resolves.toEqual({ allowed: true, policyVersion: 3, reason: 'own session' });
  });

  it('refuses a reserved key for an anonymous caller and audits it', async () => {
    const { audit, service } = setup();

    const decision = await service.decide({
      context: context({ actorType: 'anonymous', role: 'R5' }),
      policyKey: 'auth.session.read',
      resource: INSTANCE,
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: 'reserved key is not a role capability',
    });
    expect(audit.denied).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'system',
        detail: expect.objectContaining({ policyKey: 'auth.session.read' }),
      }),
    );
  });

  it('never treats the sign-in key as a capability', async () => {
    const { service } = setup();

    await expect(
      service.decide({ context: context(), policyKey: 'auth.sign_in', resource: INSTANCE }),
    ).resolves.toMatchObject({ allowed: false });
  });
});

describe('machine clients', () => {
  it('allows a capability the client holds as a scope', async () => {
    const { service } = setup();

    await expect(
      service.decide({
        context: context({ actorType: 'service', scopes: ['registry.view'] }),
        policyKey: 'registry.view',
        resource: INSTANCE,
      }),
    ).resolves.toEqual({ allowed: true, policyVersion: 3, reason: 'machine scope' });
  });

  it('refuses a capability the client does not hold', async () => {
    const { audit, service } = setup();

    const decision = await service.decide({
      context: context({ actorType: 'service', scopes: [] }),
      policyKey: 'registry.view',
      resource: INSTANCE,
    });

    expect(decision.reason).toBe('machine scope does not include the capability');
    expect(audit.denied).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'service' }));
  });
});

describe('anonymous requests', () => {
  it('are refused on a protected operation', async () => {
    const { service } = setup();

    await expect(
      service.decide({
        context: context({ actorType: 'anonymous' }),
        policyKey: 'catalog.browse',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'anonymous request on a protected operation',
    });
  });
});

describe('step-up gate', () => {
  it('refuses a sensitive capability when the provider stated methods and none is a second factor', async () => {
    const { audit, redis, service } = setup();

    const decision = await service.decide({
      context: context({ role: 'R1', mfaSatisfied: false, mfaAsserted: true }),
      policyKey: 'settings.manage',
      resource: INSTANCE,
    });

    expect(decision).toEqual({ allowed: false, policyVersion: 3, reason: MFA_REASON });
    // Evaluated before the cache, and the refusal is audited.
    expect(redis.get).not.toHaveBeenCalled();
    expect(audit.denied).toHaveBeenCalledOnce();
  });

  it('does not refuse on absence of evidence', async () => {
    // `mfaAsserted: false` means the provider said nothing, not "no second factor".
    const { service } = setup({
      grants: [{ role: 'R1', scopeType: 'platform', scopeId: null, expiresAt: null }],
    });

    await expect(
      service.decide({
        context: context({ role: 'R1', mfaSatisfied: false, mfaAsserted: false }),
        policyKey: 'settings.manage',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('does not gate a capability that is not on the step-up list', async () => {
    const { service } = setup();

    await expect(
      service.decide({
        context: context({ role: 'R1', mfaSatisfied: false, mfaAsserted: true }),
        policyKey: 'catalog.browse',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });
});

describe('matrix and scope resolution', () => {
  it('returns a full grant without resolving a scope, and caches it', async () => {
    const { redis, store, service } = setup({
      grants: [{ role: 'R1', scopeType: 'platform', scopeId: null, expiresAt: null }],
    });

    const decision = await service.decide({
      context: context({ role: 'R1' }),
      policyKey: 'catalog.browse',
      resource: INSTANCE,
    });

    expect(decision).toEqual({
      allowed: true,
      policyVersion: 3,
      reason: 'R1 holds catalog.browse',
    });
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining('seamnex:pdp:3:uuid-1:catalog.browse'),
      'allow',
      'EX',
      60,
    );
    expect([...store.values()]).toEqual(['allow']);
  });

  it('honours a cached allow', async () => {
    const { service, access } = setup({
      redis: { 'seamnex:pdp:3:uuid-1:catalog.browse:instance:inst-1': 'allow' },
    });

    await expect(
      service.decide({ context: context(), policyKey: 'catalog.browse', resource: INSTANCE }),
    ).resolves.toEqual({ allowed: true, policyVersion: 3, reason: 'cached allow' });
    expect(access.grantsFor).not.toHaveBeenCalled();
  });

  it('treats a cache read failure as a miss', async () => {
    const { redis, service } = setup();
    redis.get.mockRejectedValue(new Error('redis down'));

    await expect(
      service.decide({ context: context(), policyKey: 'catalog.browse', resource: INSTANCE }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('allows a scoped capability whose rule is resolved against the actor', async () => {
    const { service } = setup({
      grants: [{ role: 'R5', scopeType: 'platform', scopeId: null, expiresAt: null }],
    });

    // `catalog.browse` is a `self` rule: a scoped grant covers the actor's own view.
    await expect(
      service.decide({
        context: context({ role: 'R5' }),
        policyKey: 'catalog.browse',
        resource: INSTANCE,
      }),
    ).resolves.toEqual({
      allowed: true,
      policyVersion: 3,
      reason: 'R5 holds catalog.browse within platform',
    });
  });

  it('refuses a scoped grant that does not cover the resource', async () => {
    const { db, audit, service } = setup({
      grants: [{ role: 'R3', scopeType: 'instance', scopeId: 'other', expiresAt: null }],
      routes: [['FROM instance i JOIN catalog_entry', [{ domain: 'core' }]]],
    });

    const decision = await service.decide({
      context: context({ role: 'R3' }),
      policyKey: 'instance.configure',
      resource: INSTANCE,
    });

    expect(decision).toEqual({
      allowed: false,
      policyVersion: 3,
      reason: 'the scoped grant does not cover this resource',
    });
    expect(db.calls).toHaveLength(1);
    expect(audit.denied).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'instance', targetId: 'inst-1' }),
    );
  });

  it('allows an instance-scoped grant that names the instance', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'instance', scopeId: 'inst-1', expiresAt: null }],
      routes: [['FROM instance i JOIN catalog_entry', [{ domain: 'core' }]]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'instance.configure',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ reason: 'R3 holds instance.configure within instance' });
  });

  it('refuses an instance-scoped grant when the session is bound to another instance (R6)', async () => {
    const { service } = setup({
      grants: [{ role: 'R6', scopeType: 'instance', scopeId: 'inst-1', expiresAt: null }],
      routes: [['FROM instance i JOIN catalog_entry', [{ domain: 'core' }]]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R6', instanceId: 'inst-2' }),
        policyKey: 'portal.launch',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('resolves a domain rule through the catalog domain of the instance', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'domain', scopeId: 'core', expiresAt: null }],
      routes: [['FROM instance i JOIN catalog_entry', [{ domain: 'core' }]]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'audit.view',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'R3 holds audit.view within domain' });
  });

  it('refuses a domain rule when the domain differs', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'domain', scopeId: 'other', expiresAt: null }],
      routes: [['FROM instance i JOIN catalog_entry', [{ domain: 'core' }]]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'audit.view',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('lets a platform-scoped grant cover any resource a scoped capability names', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'platform', scopeId: null, expiresAt: null }],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'audit.view',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({
      allowed: true,
      reason: 'R3 holds audit.view within platform',
    });
  });

  it('lets a domain rule be satisfied by an instance-scoped grant on that instance', async () => {
    // `audit.view` is a domain rule, but an operator bound to one instance still holds it there.
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'instance', scopeId: 'inst-1', expiresAt: null }],
      routes: [['FROM instance i JOIN catalog_entry', [{ domain: 'core' }]]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'audit.view',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('refuses a domain rule when the instance grant is for another instance', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'instance', scopeId: 'inst-9', expiresAt: null }],
      routes: [['FROM instance i JOIN catalog_entry', [{ domain: 'core' }]]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'audit.view',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('refuses a domain rule for a resource that is not an instance when only an instance grant exists', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'instance', scopeId: 'D01-01', expiresAt: null }],
      routes: [['FROM catalog_entry WHERE key', [{ domain: 'core' }]]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'audit.view',
        resource: { type: 'catalog', id: 'D01-01' } as never,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('satisfies an instance rule through a domain grant that owns the instance', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'domain', scopeId: 'core', expiresAt: null }],
      routes: [['FROM instance i JOIN catalog_entry', [{ domain: 'core' }]]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'instance.configure',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('refuses an instance rule when the domain grant owns a different domain', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'domain', scopeId: 'other', expiresAt: null }],
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

  it('still allows when the decision cannot be cached', async () => {
    const { redis, service } = setup();
    redis.set.mockRejectedValue(new Error('redis down'));

    await expect(
      service.decide({ context: context(), policyKey: 'catalog.browse', resource: INSTANCE }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('still allows when the cache rejects with a non-Error', async () => {
    const { redis, service } = setup();
    redis.set.mockRejectedValue('down');

    await expect(
      service.decide({ context: context(), policyKey: 'catalog.browse', resource: INSTANCE }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('refuses when no grant names a role with the capability', async () => {
    const { service } = setup({
      grants: [{ role: 'R5', scopeType: 'platform', scopeId: null, expiresAt: null }],
    });

    await expect(
      service.decide({
        context: context({ role: 'R5' }),
        policyKey: 'instance.deploy',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: false, reason: 'no role grants the capability' });
  });

  it('falls back to the session role when the subject has no binding row', async () => {
    const { service } = setup({ grants: [] });

    await expect(
      service.decide({
        context: context({ role: 'R1' }),
        policyKey: 'catalog.browse',
        resource: INSTANCE,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('denies when the live grant set cannot be read', async () => {
    const { service } = setup({ grantsError: new Error('role_binding down') });

    await expect(
      service.decide({ context: context(), policyKey: 'catalog.browse', resource: INSTANCE }),
    ).resolves.toMatchObject({ allowed: false, reason: 'no role grants the capability' });
  });
});

describe('domain resolution', () => {
  it('resolves a catalog resource through its entry domain', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'domain', scopeId: 'core', expiresAt: null }],
      routes: [['FROM catalog_entry WHERE key', [{ domain: 'core' }]]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'audit.view',
        resource: { type: 'catalog', id: 'D01-01' } as never,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('treats a failed lookup as unresolved rather than granting access', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'domain', scopeId: 'core', expiresAt: null }],
      routes: [['FROM catalog_entry WHERE key', () => Promise.reject(new Error('db down'))]],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'audit.view',
        resource: { type: 'catalog', id: 'D01-01' } as never,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('refuses an instance rule for a resource that is not an instance', async () => {
    const { service } = setup({
      grants: [{ role: 'R3', scopeType: 'instance', scopeId: 'inst-1', expiresAt: null }],
    });

    await expect(
      service.decide({
        context: context({ role: 'R3' }),
        policyKey: 'instance.configure',
        resource: { type: 'catalog', id: 'D01-01' } as never,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });
});

describe('refusal evidence', () => {
  it('records the capability as the target when the operation names no resource', async () => {
    const { audit, service } = setup();

    await service.decide({
      context: context(),
      policyKey: 'instance.deploy',
      resource: { type: 'platform', id: '' } as never,
    });

    expect(audit.denied).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'platform', targetId: 'instance.deploy' }),
    );
  });

  it('still refuses when the evidence cannot be written', async () => {
    const { audit, service } = setup();
    audit.denied.mockRejectedValue(new Error('audit down'));

    await expect(
      service.decide({ context: context(), policyKey: 'instance.deploy', resource: INSTANCE }),
    ).resolves.toMatchObject({ allowed: false, reason: 'no role grants the capability' });
  });

  it('records a non-Error audit failure without throwing', async () => {
    const { audit, service } = setup();
    audit.denied.mockRejectedValue('down');

    await expect(
      service.decide({ context: context(), policyKey: 'instance.deploy', resource: INSTANCE }),
    ).resolves.toMatchObject({ allowed: false });
  });
});

describe('decideAny', () => {
  it('allows on the first key that grants the capability', async () => {
    const { service } = setup();

    await expect(
      service.decideAny({
        context: context({ role: 'R3' }),
        policyKeys: ['instance.deploy', 'catalog.browse'],
        resource: INSTANCE,
        declaredKey: 'catalog.browse',
      }),
    ).resolves.toMatchObject({ allowed: true, reason: 'R3 holds catalog.browse' });
  });

  it('writes exactly one denial naming the declared key and the whole set', async () => {
    const { audit, service } = setup({
      grants: [{ role: 'R5', scopeType: 'platform', scopeId: null, expiresAt: null }],
    });

    const decision = await service.decideAny({
      context: context({ role: 'R5' }),
      policyKeys: ['instance.deploy', 'audit.verify'],
      resource: INSTANCE,
      declaredKey: 'audit.verify',
    });

    expect(decision).toEqual({
      allowed: false,
      policyVersion: 3,
      reason: 'no role grants any of: instance.deploy, audit.verify',
    });
    expect(audit.denied).toHaveBeenCalledOnce();
    expect(audit.denied).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'inst-1',
        detail: expect.objectContaining({ policyKey: 'audit.verify' }),
      }),
    );
  });

  it('treats a step-up refusal as decisive and records it against that key', async () => {
    const { audit, service } = setup();

    const decision = await service.decideAny({
      context: context({ role: 'R1', mfaSatisfied: false, mfaAsserted: true }),
      policyKeys: ['settings.manage', 'catalog.browse'],
      resource: INSTANCE,
      declaredKey: 'catalog.browse',
    });

    expect(decision).toEqual({ allowed: false, policyVersion: 3, reason: MFA_REASON });
    expect(audit.denied).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ policyKey: 'settings.manage' }),
      }),
    );
  });

  it('refuses an empty set against the active policy version', async () => {
    const { service } = setup();

    await expect(
      service.decideAny({
        context: context(),
        policyKeys: [],
        resource: INSTANCE,
        declaredKey: 'catalog.browse',
      }),
    ).resolves.toEqual({
      allowed: false,
      policyVersion: 3,
      reason: 'no role grants any of: ',
    });
  });
});
