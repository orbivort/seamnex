import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  COMPOSE_RULES,
  evaluateCompose,
  parseCompose,
  stringifyCompose,
  type ComposeRule,
} from '../../../../src/common/compose/compose-policy';

/**
 * The compose policy is the boundary between a customer-authored file and the host kernel. Each
 * rule is asserted on its own and then on the interaction that matters: a waived rule still has to
 * appear in the evidence, and a file with one waived and one blocking violation is `blocked`.
 */
function document(services: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { services, ...extra };
}

const PINNED = 'registry.example.test/app@sha256:abc123';
const VERSIONED = 'registry.example.test/app:1.4.2';

describe('evaluateCompose: allowed files', () => {
  it('accepts a pinned image with no ports and returns the rule list unchanged', () => {
    const result = evaluateCompose(document({ app: { image: VERSIONED } }));

    expect(result.verdict).toBe('allowed');
    expect(result.violations).toEqual([]);
    expect(result.waived).toEqual([]);
    expect(result.patch).toEqual([]);
    expect(result.publishedPorts).toBe(0);
    expect(result.services).toEqual(['app']);
    expect(COMPOSE_RULES).toHaveLength(5);
  });

  it('accepts a service that builds instead of naming an image', () => {
    const result = evaluateCompose(document({ app: { build: { context: '.' } } }));
    expect(result.verdict).toBe('allowed');
  });

  it('treats a document without a usable services map as having none', () => {
    // A list or a scalar under `services` is nonsense, not a crash.
    const result = evaluateCompose({ services: ['app'] });
    expect(result.verdict).toBe('allowed');
    expect(result.services).toEqual([]);
  });

  it('skips a service whose definition is not a mapping', () => {
    const result = evaluateCompose(document({ app: 'nonsense' }));
    expect(result.verdict).toBe('allowed');
    expect(result.services).toEqual(['app']);
  });

  it('accepts an image pinned by an explicit version tag', () => {
    expect(evaluateCompose(document({ app: { image: 'nginx:1.27' } })).verdict).toBe('allowed');
    expect(evaluateCompose(document({ app: { image: PINNED } })).verdict).toBe('allowed');
  });
});

describe('evaluateCompose: blocking rules', () => {
  it('refuses host networking', () => {
    const result = evaluateCompose(document({ app: { image: VERSIONED, network_mode: 'host' } }));
    expect(result.verdict).toBe('blocked');
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'network_mode_host', service: 'app' }),
    ]);
  });

  it('refuses privileged mode', () => {
    const result = evaluateCompose(document({ app: { image: VERSIONED, privileged: true } }));
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'privileged', service: 'app' }),
    ]);
  });

  it('refuses every form of host-path bind mount', () => {
    const result = evaluateCompose(
      document({
        absolute: { image: VERSIONED, volumes: ['/var/run/docker.sock:/var/run/docker.sock'] },
        relative: { image: VERSIONED, volumes: ['./data:/data'] },
        home: { image: VERSIONED, volumes: ['~/secrets:/secrets'] },
        longForm: { image: VERSIONED, volumes: [{ type: 'bind', source: './x', target: '/x' }] },
        shortSource: { image: VERSIONED, volumes: [{ source: '/tmp', target: '/t' }] },
      }),
    );

    expect(result.verdict).toBe('blocked');
    expect(result.violations.filter((item) => item.rule === 'host_path_mount')).toHaveLength(5);
    expect(result.violations[0]?.detail).toContain('/var/run/docker.sock');
  });

  it('allows a named volume and a non-bind long-form mount', () => {
    const result = evaluateCompose(
      document({
        app: {
          image: VERSIONED,
          volumes: ['data:/data', { type: 'volume', source: 'data', target: '/data' }, 42],
        },
      }),
    );
    expect(result.verdict).toBe('allowed');
  });

  it('describes a bind mount that names no source', () => {
    const result = evaluateCompose(
      document({ app: { image: VERSIONED, volumes: [{ type: 'bind', target: '/data' }] } }),
    );
    expect(result.violations[0]?.detail).toContain('unknown source');
  });

  it('ignores an expose entry that is neither a string nor a number', () => {
    const result = evaluateCompose(
      document({ app: { image: VERSIONED, expose: [true], ports: ['8080:80'] } }),
    );
    const service = result.document.services as Record<string, Record<string, unknown>>;
    expect(service.app?.expose).toEqual(['80']);
  });

  it('refuses a service joined to an external network', () => {
    const result = evaluateCompose(
      document(
        { app: { image: VERSIONED, networks: ['shared'] } },
        { networks: { shared: { external: true } } },
      ),
    );

    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'external_network', service: 'app' }),
    ]);
    expect(result.violations[0]?.detail).toContain('shared');
  });

  it('refuses an external network declared but not attached to any service', () => {
    // A definition someone may extend later is intent, not debris.
    const result = evaluateCompose(
      document({ app: { image: VERSIONED } }, { networks: { shared: { external: true } } }),
    );

    expect(result.verdict).toBe('blocked');
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'external_network', service: null }),
    ]);
  });

  it('ignores a long-form network reference and an internal top-level network', () => {
    const result = evaluateCompose(
      document(
        { app: { image: VERSIONED, networks: [{ name: 'shared' }] } },
        { networks: { shared: { external: false } } },
      ),
    );
    expect(result.verdict).toBe('allowed');
  });

  it('refuses an image tag that is missing or latest', () => {
    const result = evaluateCompose(
      document({ implicit: { image: 'nginx' }, latest: { image: 'nginx:latest' } }),
    );
    expect(result.violations.map((item) => item.service)).toEqual(['implicit', 'latest']);
    expect(result.violations[0]?.detail).toContain('not digest- or version-pinned');
  });

  it('reads the tag after the registry port, not the port itself', () => {
    // `registry:5000/app` has a colon but no tag; treating the port as the tag would allow it.
    expect(evaluateCompose(document({ app: { image: 'registry:5000/app' } })).verdict).toBe(
      'blocked',
    );
    expect(evaluateCompose(document({ app: { image: 'registry:5000/app:2.1' } })).verdict).toBe(
      'allowed',
    );
  });

  it('refuses a service that declares neither image nor build', () => {
    const result = evaluateCompose(document({ app: { command: ['true'] } }));
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'unpinned_image', service: 'app' }),
    ]);
    expect(result.violations[0]?.detail).toContain('neither an image nor a build context');
  });
});

describe('evaluateCompose: port normalisation', () => {
  it('rewrites every published form into a container port and counts them', () => {
    const result = evaluateCompose(
      document({
        app: {
          image: VERSIONED,
          ports: ['8080:80', '127.0.0.1:8443:443', '3000', '53/udp', 9000],
          expose: ['7000', 7001],
        },
      }),
    );

    const service = result.document.services as Record<string, Record<string, unknown>>;
    expect(service.app?.ports).toBeUndefined();
    expect(service.app?.expose).toEqual(
      ['3000', '443', '53/udp', '7000', '7001', '80', '9000'].sort(),
    );
    expect(result.publishedPorts).toBe(5);
    expect(result.patch).toEqual([
      {
        path: 'services.app.ports',
        from: ['8080:80', '127.0.0.1:8443:443', '3000', '53/udp', 9000],
        to: null,
      },
      { path: 'services.app.expose', from: ['7000', 7001], to: expect.any(Array) },
    ]);
  });

  it('accepts the long form with a numeric or string target', () => {
    const numeric = evaluateCompose(
      document({ app: { image: VERSIONED, ports: [{ target: 8080, published: 80 }] } }),
    );
    const textual = evaluateCompose(
      document({ app: { image: VERSIONED, ports: [{ target: '9090' }] } }),
    );

    expect(
      (numeric.document.services as never as Record<string, { expose: string[] }>).app?.expose,
    ).toEqual(['8080']);
    expect(
      (textual.document.services as never as Record<string, { expose: string[] }>).app?.expose,
    ).toEqual(['9090']);
  });

  it('drops a port entry it cannot read, without counting it', () => {
    const result = evaluateCompose(
      document({ app: { image: VERSIONED, ports: [{}, null, '', ':'] } }),
    );
    expect(result.publishedPorts).toBe(0);
    // The rewrite is still recorded: the array left the platform copy either way.
    expect(result.patch).toHaveLength(2);
  });

  it('refuses an image that is not even a string', () => {
    const result = evaluateCompose(document({ app: { image: 42 } }));
    expect(result.violations).toEqual([
      expect.objectContaining({ rule: 'unpinned_image', service: 'app' }),
    ]);
  });

  it('does not touch expose when the service publishes nothing', () => {
    const result = evaluateCompose(document({ app: { image: VERSIONED, expose: ['80'] } }));
    expect(result.patch).toEqual([]);
  });

  it('drops container_name even when no port is published', () => {
    // A conditional write-back here silently kept the removed key in the document.
    const result = evaluateCompose(
      document({ app: { image: VERSIONED, container_name: 'fixed' } }),
    );

    const service = result.document.services as Record<string, Record<string, unknown>>;
    expect(service.app?.container_name).toBeUndefined();
    expect(result.patch).toEqual([
      { path: 'services.app.container_name', from: 'fixed', to: null },
    ]);
  });
});

describe('evaluateCompose: waivers', () => {
  it('downgrades a waived rule to unsafe_approved, keeping the evidence', () => {
    const waived = new Set<ComposeRule>(['privileged']);
    const result = evaluateCompose(
      document({ app: { image: VERSIONED, privileged: true } }),
      waived,
    );

    expect(result.verdict).toBe('unsafe_approved');
    expect(result.waived).toEqual(['privileged']);
    expect(result.violations).toHaveLength(1);
  });

  it('lists a waived rule once even when several services break it', () => {
    const waived = new Set<ComposeRule>(['privileged']);
    const result = evaluateCompose(
      document({
        a: { image: VERSIONED, privileged: true },
        b: { image: VERSIONED, privileged: true },
      }),
      waived,
    );

    expect(result.waived).toEqual(['privileged']);
  });

  it('stays blocked when a rule that was not waived is also present', () => {
    const waived = new Set<ComposeRule>(['privileged']);
    const result = evaluateCompose(
      document({ app: { image: VERSIONED, privileged: true, network_mode: 'host' } }),
      waived,
    );

    expect(result.verdict).toBe('blocked');
    expect(result.waived).toEqual(['privileged']);
  });
});

describe('parseCompose', () => {
  it('parses a single-document compose file', () => {
    const parsed = parseCompose('services:\n  app:\n    image: nginx:1.27\n');
    expect(parsed).toEqual({ services: { app: { image: 'nginx:1.27' } } });
  });

  it('refuses a multi-document file rather than silently taking the first', () => {
    expect(() =>
      parseCompose('services:\n  a:\n    image: x:1\n---\nservices:\n  b:\n    image: y:1\n'),
    ).toThrow(/exactly one document \(found 2\)/);
  });

  it('refuses invalid YAML with the parser message', () => {
    expect(() => parseCompose('services:\n  app:\n   image: [unclosed\n')).toThrow(
      /compose YAML is invalid/,
    );
  });

  it('refuses a document that is not a mapping', () => {
    expect(() => parseCompose('- one\n- two\n')).toThrow(/mapping at the top level/);
  });

  it('refuses a mapping with no services key', () => {
    expect(() => parseCompose('version: "3"\n')).toThrow(/must declare `services`/);
  });

  it('refuses services that are not a mapping', () => {
    expect(() => parseCompose('services:\n  - app\n')).toThrow(/must declare `services`/);
  });
});

describe('stringifyCompose', () => {
  it('serialises the platform-owned copy without folding long lines', () => {
    const text = stringifyCompose({
      services: { app: { image: VERSIONED, expose: ['80'], command: 'echo ' + 'x'.repeat(200) } },
    });

    expect(parseYaml(text)).toEqual({
      services: { app: { image: VERSIONED, expose: ['80'], command: 'echo ' + 'x'.repeat(200) } },
    });
    expect(text.split('\n').length).toBeLessThan(10);
  });
});
