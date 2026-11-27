import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Route } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { PreflightService } from '../../../../src/modules/m05-executor/preflight.service';

/**
 * NFR-4.16 — the pre-flight refuses an image outside the allow-list.
 *
 * The blocker matters even though `DockerEngineClient` also refuses at pull time: the pre-flight is
 * what the operator sees *before* an instance row and a job exist, so the refusal has to name the
 * namespace and the remedy rather than produce a job that fails four steps later.
 */
const ENTRY = {
  key: 'D01-01',
  packaging: 'compose',
  payload: {
    imageRef: 'docker.io/bitnami/espocrm:9.2.1',
    repoUrl: 'https://git.example.test/espocrm.git',
    resources: { cpu: 1, memoryMb: 2_048, diskMb: 2_048 },
  },
};

const DEFAULTS: readonly Route[] = [
  ['SELECT key, packaging, payload FROM catalog_entry', [ENTRY]],
  ['SELECT repo_url FROM catalog_entry', [{ repo_url: '' }]],
  ['SELECT entry_key, state, domain_route', []],
  ['scaffold_artefact', [{ present: false }]],
];

function setup(allowed: readonly string[]) {
  const db = fakeDb(DEFAULTS);
  const renderer = {
    plan: vi.fn(async () => ({
      entryKey: 'D01-01',
      profileKey: 'default',
      values: [],
      fieldErrors: [],
      requiresRecreate: false,
      resolvedAt: new Date().toISOString(),
    })),
    unresolvedSecrets: vi.fn(async () => []),
  };
  const capacity = {
    admit: vi.fn(async () => ({
      admissible: true,
      headline: 'fits on this host',
      detail: '12 vCPU free',
      shortfall: { cpuMilli: 0, memoryMb: 0, diskMb: 0 },
      limits: { cpuMilli: 8_000, memoryMb: 16_384, diskMb: 200_000 },
      used: { cpuMilli: 2_000, memoryMb: 4_096, diskMb: 20_000 },
      source: 'measured',
    })),
  };
  const sources = {
    previewPolicy: vi.fn(async () => ({
      verdict: 'allowed',
      violations: [],
      evaluatedAt: '2026-02-01T10:00:00.000Z',
      source: 'local_evaluation',
      reason: null,
    })),
  };
  const config = { SEAMNEX_INGRESS_DOMAIN: 'seamnex.local' } as unknown as AppConfig;
  const trusted = { entries: vi.fn(async () => allowed) };

  return new PreflightService(
    db.pool,
    config,
    renderer as never,
    capacity as never,
    sources as never,
    trusted as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the trusted-registry blocker', () => {
  it('refuses an image whose namespace is not on the allow-list, naming the namespace and the fix', async () => {
    const service = setup(['docker.io/library', 'ghcr.io/seamnex']);

    const result = await service.run({ entryKey: 'D01-01', slug: 'crm' } as never);

    const blocker = result.blockers.find((item) => item.code === 'image_untrusted_registry');
    expect(blocker).toBeDefined();
    expect(blocker?.blocking).toBe(true);
    expect(blocker?.message).toContain('docker.io/bitnami');
    // The remedy is the allow-list, not an exception: NFR-4.16 has no waivable form.
    expect(blocker?.message).toContain('allow-list');
    expect(result.admissible).toBe(false);
  });

  it('admits the same image once its namespace is trusted', async () => {
    const service = setup(['docker.io/bitnami']);

    const result = await service.run({ entryKey: 'D01-01', slug: 'crm' } as never);

    expect(result.blockers.filter((item) => item.code === 'image_untrusted_registry')).toEqual([]);
    expect(result.admissible).toBe(true);
  });
});
