import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_OPERATIONS,
  ANY_OF_POLICY_KEYS,
  POLICY_KEYS,
  RESERVED_POLICY_KEYS,
  SERVICE_SCOPES,
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
  it('reserves exactly the two session operations', () => {
    expect(RESERVED_POLICY_KEYS).toEqual(['auth.sign_in', 'auth.session.read']);
    expect(isReservedPolicyKey('auth.sign_in')).toBe(true);
    expect(isReservedPolicyKey('auth.session.read')).toBe(true);
    expect(isReservedPolicyKey('portal.launch')).toBe(false);
  });

  it('declares the anonymous surface explicitly', () => {
    expect(ANONYMOUS_OPERATIONS).toContain('POST /auth/session');
    expect(ANONYMOUS_OPERATIONS).toContain('GET /auth/session');
    // Session establishment is not a capability any role matrix could grant.
    expect(POLICY_KEYS['POST /auth/session']).toBe('auth.sign_in');
    expect(POLICY_KEYS['GET /auth/session']).toBe('auth.session.read');
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
    expect(resourceForRequest('/instances', {})).toEqual({ type: 'instance', id: '' });
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
    expect(resourceForRequest('/capacity', {})).toEqual({ type: 'platform', id: '' });
  });
});
