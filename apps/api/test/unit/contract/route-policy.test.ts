import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_OPERATIONS,
  API_OPERATIONS,
  CAPABILITIES,
  POLICY_KEYS,
  RESERVED_POLICY_KEYS,
  isReservedPolicyKey,
  operationKey,
} from '@seamnex/domain';

const capabilities = new Set<string>(CAPABILITIES);

describe('route policy (ADR-BE-05, deliverable 3.4)', () => {
  it('gives every operation a policy key', () => {
    for (const operation of API_OPERATIONS) {
      expect(operation.policyKey, operationKey(operation)).toBeTruthy();
    }
  });

  it('names only declared capabilities or the two reserved session keys', () => {
    const invalid = API_OPERATIONS.filter(
      (operation) =>
        !isReservedPolicyKey(operation.policyKey) && !capabilities.has(operation.policyKey),
    ).map((operation) => `${operationKey(operation)} → ${operation.policyKey}`);
    expect(invalid).toEqual([]);
  });

  it('pins the anonymous allowlist to the two session operations', () => {
    const anonymous = API_OPERATIONS.filter((operation) => operation.anonymous === true).map(
      operationKey,
    );
    expect(anonymous.sort()).toEqual([...ANONYMOUS_OPERATIONS].sort());
  });

  it('has no policy entry for an operation that does not exist', () => {
    const declared = new Set(API_OPERATIONS.map(operationKey));
    const orphans = Object.keys(POLICY_KEYS).filter((key) => !declared.has(key));
    expect(orphans).toEqual([]);
  });

  it('uses reserved keys only where the session surface declares them', () => {
    const reserved = RESERVED_POLICY_KEYS as readonly string[];
    const users = API_OPERATIONS.filter((operation) => reserved.includes(operation.policyKey)).map(
      operationKey,
    );
    expect(users.sort()).toEqual([
      'GET /auth/session',
      'GET /me',
      'POST /auth/session',
      'POST /me/logout',
    ]);
  });

  /**
   * The any-of set exists so the elevation register can be read by the requester and both
   * approvers, who share no single capability, and so one dynamic action segment can serve
   * `approve` (a second party) and `revoke` (a platform administrator). Both were previously
   * gated on `breakglass.approve`: the approver could not read the queue they were meant to work,
   * and the only role allowed to revoke was refused.
   */
  it('ties an any-of set to real capabilities and to the operation it belongs to', () => {
    const anyOf = API_OPERATIONS.filter((operation) => operation.policyAnyOf !== undefined);

    expect(anyOf.map(operationKey).sort()).toEqual([
      'GET /break-glass-sessions',
      'POST /break-glass-sessions/:id/:action',
    ]);

    for (const operation of anyOf) {
      const keys = operation.policyAnyOf ?? [];
      expect(keys.length, operationKey(operation)).toBeGreaterThan(1);
      // The declared key stays in the set, so refusals and the OpenAPI document describe the route.
      expect(keys).toContain(operation.policyKey);
      for (const key of keys) {
        expect(capabilities.has(key), `${operationKey(operation)} → ${key}`).toBe(true);
      }
    }
  });

  it('admits both deciding roles and the revoking role to the elevation action route', () => {
    const operation = API_OPERATIONS.find(
      (candidate) => operationKey(candidate) === 'POST /break-glass-sessions/:id/:action',
    );
    expect(operation?.policyAnyOf).toEqual(['breakglass.approve', 'breakglass.revoke']);
  });

  it('declares the sign-in rate limit in the contract', () => {
    const signIn = API_OPERATIONS.find(
      (operation) => operationKey(operation) === 'POST /auth/session',
    );
    expect(signIn?.rateLimit).toEqual({ bucket: 'auth', limit: 10, windowSeconds: 300 });
  });
});
