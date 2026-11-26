import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_OPERATIONS,
  ANY_OF_POLICY_KEYS,
  COLLECTION_PATHS,
  POLICY_KEYS,
  RESERVED_POLICY_KEYS,
  SERVICE_SCOPES,
  collectionScopeArrays,
  isCollectionPath,
  isReservedPolicyKey,
  isServiceScope,
  resourceForRequest,
  scopeRuleFor,
} from '../../src/policy';

/**
 * One matrix, two consumers: the contract resolves every operation through `POLICY_KEYS` at module
 * load, so these cases are about the table's own consistency — a route with no key, or a key with
 * no scope rule, is a build failure rather than a runtime 403.
 */
describe('policy keys', () => {
  it('reserves exactly the session and delivery keys', () => {
    expect(RESERVED_POLICY_KEYS).toEqual(['auth.sign_in', 'auth.session.read', 'trigger.delivery']);
    expect(isReservedPolicyKey('auth.sign_in')).toBe(true);
    expect(isReservedPolicyKey('auth.session.read')).toBe(true);
    expect(isReservedPolicyKey('trigger.delivery')).toBe(true);
    expect(isReservedPolicyKey('portal.launch')).toBe(false);
  });

  it('declares the anonymous surface explicitly', () => {
    expect(ANONYMOUS_OPERATIONS).toContain('POST /auth/session');
    expect(ANONYMOUS_OPERATIONS).toContain('GET /auth/session');
    expect(ANONYMOUS_OPERATIONS).toContain('POST /trigger/:token');
    // Session establishment is not a capability any role matrix could grant.
    expect(POLICY_KEYS['POST /auth/session']).toBe('auth.sign_in');
    expect(POLICY_KEYS['GET /auth/session']).toBe('auth.session.read');
    // A delivery is authenticated by the endpoint's HMAC, which no role holds.
    expect(POLICY_KEYS['POST /trigger/:token']).toBe('trigger.delivery');
  });

  it('binds the launcher surface to the launch capability, not to the entitlement inventory', () => {
    // §5.2: R6 reaches "launch entitled products" (one product) and not "view own entitlements".
    expect(POLICY_KEYS['GET /me/launcher']).toBe('portal.launch');
    expect(POLICY_KEYS['GET /portal/products/:slug']).toBe('portal.launch');
    expect(POLICY_KEYS['GET /me/entitlements']).toBe('portal.view_entitlements');
  });

  it('never names an any-of operation that the single-key table does not know', () => {
    for (const key of Object.keys(ANY_OF_POLICY_KEYS)) {
      expect(POLICY_KEYS[key], key).toBeDefined();
      expect((ANY_OF_POLICY_KEYS[key] ?? []).length, key).toBeGreaterThan(1);
    }
  });
});

describe('scopeRuleFor', () => {
  it('resolves both reserved keys against the caller', () => {
    expect(scopeRuleFor('auth.session.read')).toBe('self');
    expect(scopeRuleFor('auth.sign_in')).toBe('self');
  });

  it('uses the declared scope for a mapped capability', () => {
    expect(scopeRuleFor('instance.env')).toBe('instance');
    expect(scopeRuleFor('audit.view')).toBe('domain');
    expect(scopeRuleFor('breakglass.approve')).toBe('self');
    expect(scopeRuleFor('workflow.approve')).toBe('request');
  });

  it('falls back to the platform for a capability with no narrower rule', () => {
    expect(scopeRuleFor('portal.view_entitlements')).toBe('platform');
  });
});

describe('service scopes', () => {
  it('grants machine clients exactly the listed keys', () => {
    expect(SERVICE_SCOPES['registry.read']).toEqual(['registry.view']);
    expect(SERVICE_SCOPES['audit.read']).toEqual(['audit.view', 'audit.verify', 'audit.export']);
  });

  it('treats an unknown scope as not a scope, so the PDP can deny it', () => {
    expect(isServiceScope('registry.read')).toBe(true);
    expect(isServiceScope('audit.read')).toBe(true);
    expect(isServiceScope('admin.everything')).toBe(false);
    // `hasOwn` rather than `in`: a prototype key must not read as a scope.
    expect(isServiceScope('toString')).toBe(false);
    expect(isServiceScope('__proto__')).toBe(false);
  });
});

describe('resourceForRequest', () => {
  it('reads the resource id from any of the parameter names the route table uses', () => {
    expect(resourceForRequest('/instances/:id', { id: 'inst-crm' })).toEqual({
      type: 'instance',
      id: 'inst-crm',
    });
    expect(
      resourceForRequest('/portal/launch-targets/:instanceId', { instanceId: 'inst-crm' }),
    ).toEqual({ type: 'instance', id: 'inst-crm' });
    expect(resourceForRequest('/catalog/:key', { key: 'D01-01' })).toEqual({
      type: 'catalog',
      id: 'D01-01',
    });
    expect(resourceForRequest('/registry/instances/:slug', { slug: 'crm' })).toEqual({
      type: 'platform',
      id: 'crm',
    });
    expect(resourceForRequest('/workflow-runs/:runId', { runId: 'run-1' })).toEqual({
      type: 'workflow',
      id: 'run-1',
    });
    expect(resourceForRequest('/audit-events/:seq/proof', { seq: '42' })).toEqual({
      type: 'platform',
      id: '42',
    });
  });

  it('classifies the path when the parameter name is generic', () => {
    expect(resourceForRequest('/instances', {})).toEqual({ type: 'collection', id: '' });
    expect(resourceForRequest('/backups/verify', { id: 'b-1' })).toEqual({
      type: 'instance',
      id: 'b-1',
    });
    expect(resourceForRequest('/jobs/retry', { id: 'j-1' })).toEqual({
      type: 'instance',
      id: 'j-1',
    });
    expect(resourceForRequest('/admin/users/disable', { id: 'usr-1' })).toEqual({
      type: 'user',
      id: 'usr-1',
    });
    expect(resourceForRequest('/workflows/nodes', { id: 'wf-1' })).toEqual({
      type: 'workflow',
      id: 'wf-1',
    });
    expect(resourceForRequest('/me/entitlements', {})).toEqual({ type: 'self', id: '' });
    // A deep link is the caller's own tile, not a platform resource: `platform` scope would refuse
    // every scoped grant, which is exactly what the guest holds.
    expect(resourceForRequest('/portal/products/:slug', { slug: 'espocrm-dev' })).toEqual({
      type: 'self',
      id: '',
    });
    expect(resourceForRequest('/break-glass-sessions', { id: 'bg-1' })).toEqual({
      type: 'request',
      id: 'bg-1',
    });
    expect(resourceForRequest('/admin/access-requests', { id: 'ar-1' })).toEqual({
      type: 'request',
      id: 'ar-1',
    });
  });

  it('falls back to a platform-scoped resource for anything else', () => {
    expect(resourceForRequest('/settings', {})).toEqual({ type: 'platform', id: '' });
  });
});

/**
 * ADR-BE-44: a collection has no id, so scope resolution has nothing to join against. The type is
 * what tells the PDP to answer from the grant instead of from the resource.
 */
describe('collection reads', () => {
  it('names exactly the unaddressed reads that are scope-filtered', () => {
    expect([...COLLECTION_PATHS].sort()).toEqual([
      '/capacity',
      '/capacity/forecast',
      '/instances',
      '/jobs',
    ]);
    expect(isCollectionPath('/instances')).toBe(true);
    expect(isCollectionPath('/jobs')).toBe(true);
  });

  it('keeps an addressed read out of the collection set', () => {
    // A prefix match would turn `/instances/:id` into a list read and drop its row check.
    expect(isCollectionPath('/instances/:id')).toBe(false);
    expect(resourceForRequest('/instances/:id', { id: 'inst-1' })).toEqual({
      type: 'instance',
      id: 'inst-1',
    });
    expect(resourceForRequest('/jobs/:id', { id: 'job-1' })).toEqual({
      type: 'instance',
      id: 'job-1',
    });
  });

  it('classifies every declared collection path the same way', () => {
    for (const path of COLLECTION_PATHS) {
      expect(resourceForRequest(path, {}), path).toEqual({ type: 'collection', id: '' });
    }
  });
});

/**
 * ADR-BE-44: the scope is bound as SQL parameters, so a platform grant must say "unrestricted"
 * rather than asking for an empty filter — an empty `IN ()` reads as "nothing", not "everything".
 */
describe('collectionScopeArrays', () => {
  it('binds a platform grant as unrestricted and asks for no rows', () => {
    expect(collectionScopeArrays({ kind: 'platform' })).toEqual({
      unrestricted: true,
      domains: [],
      instanceIds: [],
    });
  });

  it('binds a scoped grant as filtered to exactly its domains and instances', () => {
    expect(
      collectionScopeArrays({
        kind: 'scoped',
        domains: ['crm', 'billing'],
        instanceIds: ['inst-1', 'inst-2'],
      }),
    ).toEqual({
      unrestricted: false,
      domains: ['crm', 'billing'],
      instanceIds: ['inst-1', 'inst-2'],
    });
  });

  it('keeps an empty scoped grant filtered, so it matches no rows', () => {
    const arrays = collectionScopeArrays({ kind: 'scoped', domains: [], instanceIds: [] });

    expect(arrays.unrestricted).toBe(false);
    expect(arrays.domains).toEqual([]);
    expect(arrays.instanceIds).toEqual([]);
  });

  it('passes the scope arrays through without copying them', () => {
    const domains = ['crm'];
    const instanceIds = ['inst-1'];

    const arrays = collectionScopeArrays({ kind: 'scoped', domains, instanceIds });

    expect(arrays.domains).toBe(domains);
    expect(arrays.instanceIds).toBe(instanceIds);
  });
});
