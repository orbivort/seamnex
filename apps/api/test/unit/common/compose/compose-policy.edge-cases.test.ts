import { describe, expect, it } from 'vitest';
import { evaluateCompose, type ComposeRule } from '../../../../src/common/compose/compose-policy';

/**
 * The main suite pins each rule on its own. These pin the two ways a rule is *not* triggered, which
 * is where a policy file leaks: a service attached to a network that is merely declared (not
 * external), a reference to a network that is not declared at all, and a long-form mount whose
 * source is not a path at all.
 */
const VERSIONED = 'registry.example.test/app:1.4.2';

function document(services: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { services, ...extra };
}

describe('external network detection on an attached service', () => {
  it('allows a service joined to a declared internal network and to one declared nowhere', () => {
    // `external: false` is an internal network, and a reference the file never declares creates a
    // project-scoped network — neither reaches outside the instance.
    const result = evaluateCompose(
      document(
        { app: { image: VERSIONED, networks: ['internal', 'project-scoped'] } },
        { networks: { internal: { external: false } } },
      ),
    );

    expect(result.verdict).toBe('allowed');
    expect(result.violations).toEqual([]);
  });

  it('still blocks the external one when two services join different networks', () => {
    const result = evaluateCompose(
      document(
        {
          app: { image: VERSIONED, networks: ['internal'] },
          worker: { image: VERSIONED, networks: ['shared'] },
        },
        { networks: { internal: { driver: 'bridge' }, shared: { external: true } } },
      ),
    );

    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'external_network', service: 'worker' }),
    ]);
    expect(result.violations[0]?.detail).toContain('shared');
  });

  it('keeps the declared networks in the platform-owned copy', () => {
    const result = evaluateCompose(
      document({ app: { image: VERSIONED } }, { networks: { internal: { external: false } } }),
    );
    expect(result.document.networks).toEqual({ internal: { external: false } });
  });

  it('reports a waived external network without unblocking an unrelated rule', () => {
    const waived = new Set<ComposeRule>(['external_network']);
    const result = evaluateCompose(
      document(
        { app: { image: VERSIONED, privileged: true, networks: ['shared'] } },
        { networks: { shared: { external: true } } },
      ),
      waived,
    );

    expect(result.waived).toEqual(['external_network']);
    expect(result.verdict).toBe('blocked');
  });
});

describe('host-path detection on a long-form mount', () => {
  it('does not read a non-string source as a host path', () => {
    // A mount whose `source` is a number or absent names a volume the engine creates, so it stays
    // inside the platform's volume namespace.
    const result = evaluateCompose(
      document({
        app: {
          image: VERSIONED,
          volumes: [
            { type: 'volume', source: 42, target: '/data' },
            { type: 'tmpfs', target: '/tmp' },
          ],
        },
      }),
    );

    expect(result.verdict).toBe('allowed');
    expect(result.violations).toEqual([]);
  });

  it('still refuses a bind mount that only names a relative source', () => {
    const result = evaluateCompose(
      document({ app: { image: VERSIONED, volumes: [{ type: 'bind', source: './x' }] } }),
    );

    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'host_path_mount', service: 'app' }),
    ]);
    expect(result.violations[0]?.detail).toContain('./x');
  });
});
