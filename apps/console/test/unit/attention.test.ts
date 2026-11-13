import { describe, expect, it } from 'vitest';
import type { Instance, PostureSummary } from '@seamnex/domain';
import { buildAttention } from '../../src/features/overview/attention';

function instance(overrides: Partial<Instance>): Instance {
  return {
    id: 'inst-1',
    slug: 'inst-1',
    entryKey: 'D01-01',
    product: 'EspoCRM',
    state: 'ready',
    desiredState: 'running',
    ready: true,
    stateReason: null,
    ...overrides,
  } as Instance;
}

function posture(overrides: Partial<PostureSummary> = {}): PostureSummary {
  return {
    generatedAt: '2026-11-01T09:00:00.000Z',
    sso: { native: 0, forwardAuth: 0, signInRequired: 0, totalEntries: 0 },
    missingHealthChecks: [],
    unverifiedRestores: [],
    expiringCertificates: [],
    staleMetadata: [],
    instancesWithoutHealthCheck: 0,
    totalInstances: 0,
    coveragePercent: 100,
    ...overrides,
  } as PostureSummary;
}

/**
 * The attention queue is the console's opinion about what needs an operator. It has to be
 * severity-ordered, honest about *why* something is listed, and it must not invent an item from a
 * missing posture document.
 */
describe('attention queue', () => {
  it('reports an unreadable posture as an empty posture, not as an all-clear', () => {
    expect(buildAttention([], undefined)).toEqual([]);
    expect(buildAttention([instance({ state: 'ready' })], undefined)).toEqual([]);
  });

  it('lists a degraded instance first, with the reason it is degraded', () => {
    const items = buildAttention(
      [
        instance({
          id: 'inst-people',
          entryKey: 'D07-01',
          product: 'OrangeHRM',
          state: 'degraded',
          ready: false,
          stateReason: 'Readiness probe returned HTTP 503.',
        }),
      ],
      posture(),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'degraded-inst-people',
      tone: 'danger',
      title: 'D07-01 OrangeHRM is degraded',
      detail: 'Readiness probe returned HTTP 503.',
      href: '/instances/inst-people',
      cta: 'Inspect containers',
    });
  });

  it('falls back to a generic detail when the platform recorded no reason', () => {
    const [item] = buildAttention(
      [instance({ id: 'inst-x', state: 'degraded', stateReason: null })],
      posture(),
    );
    expect(item?.detail).toBe('Containers run but the application is not ready.');
  });

  it('lists an intentional stop as information, not as a failure', () => {
    const [item] = buildAttention(
      [
        instance({
          id: 'inst-shop',
          state: 'stopped',
          desiredState: 'stopped',
          stateReason: null,
        }),
      ],
      posture(),
    );
    expect(item).toMatchObject({ tone: 'info', id: 'stopped-inst-shop' });
    expect(item?.detail).toBe('The route is unpublished and the data is retained.');
  });

  it('ignores a stopped instance that was meant to be running', () => {
    expect(
      buildAttention(
        [instance({ state: 'stopped', desiredState: 'running', stateReason: 'crashed' })],
        posture(),
      ),
    ).toEqual([]);
  });

  it('keeps the reason recorded for an intentional stop', () => {
    const [item] = buildAttention(
      [
        instance({
          state: 'stopped',
          desiredState: 'stopped',
          stateReason: 'Scheduled wind-down for the merger.',
        }),
      ],
      posture(),
    );
    expect(item?.detail).toBe('Scheduled wind-down for the merger.');
  });

  it('reports a missing restore drill and an overdue one differently', () => {
    const items = buildAttention(
      [],
      posture({
        unverifiedRestores: [
          { instanceId: 'inst-a', product: 'EspoCRM', lastVerifiedAt: null },
          {
            instanceId: 'inst-b',
            product: 'Nextcloud Hub',
            lastVerifiedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );

    expect(items[0]).toMatchObject({ id: 'restore-inst-a', tone: 'caution' });
    expect(items[0]?.title).toBe('EspoCRM has no verified restore');
    expect(items[0]?.detail).toMatch(/no restore drill has passed/i);
    expect(items[1]?.title).toBe('Nextcloud Hub restore evidence is overdue');
    expect(items[1]?.detail).toMatch(/^Last passed /);
    expect(items[1]?.href).toBe('/governance/recovery');
  });

  it('reports stale integration metadata with the overdue count', () => {
    const [item] = buildAttention(
      [],
      posture({
        staleMetadata: [
          {
            entryKey: 'D04-01',
            product: 'Zammad',
            verifiedAt: '2026-06-01T00:00:00.000Z',
            daysOverdue: 12,
          },
        ],
      }),
    );
    expect(item).toMatchObject({
      id: 'stale-D04-01',
      tone: 'caution',
      title: 'D04-01 Zammad integration metadata is stale',
      href: '/catalog/D04-01',
      cta: 'Verify metadata',
    });
    expect(item?.detail).toMatch(/review is 12 days overdue/);
  });

  it('only lists certificates inside the 30-day renewal window', () => {
    const items = buildAttention(
      [],
      posture({
        expiringCertificates: [
          { host: 'a.seamnex.local', expiresAt: '2026-11-20T00:00:00.000Z', daysLeft: 14 },
          { host: 'b.seamnex.local', expiresAt: '2027-06-01T00:00:00.000Z', daysLeft: 31 },
          { host: 'c.seamnex.local', expiresAt: '2026-11-06T00:00:00.000Z', daysLeft: 30 },
        ],
      }),
    );
    expect(items.map((item) => item.id)).toEqual(['cert-a.seamnex.local', 'cert-c.seamnex.local']);
    expect(items[0]?.title).toBe('Certificate for a.seamnex.local expires in 14 days');
  });

  it('orders by severity, keeping insertion order within a tone', () => {
    const items = buildAttention(
      [
        instance({ id: 'inst-stop', state: 'stopped', desiredState: 'stopped' }),
        instance({ id: 'inst-bad', state: 'degraded' }),
      ],
      posture({
        staleMetadata: [
          {
            entryKey: 'D01-01',
            product: 'EspoCRM',
            verifiedAt: '2026-01-01T00:00:00.000Z',
            daysOverdue: 3,
          },
        ],
        unverifiedRestores: [{ instanceId: 'inst-r', product: 'Registry', lastVerifiedAt: null }],
      }),
    );

    expect(items.map((item) => item.tone)).toEqual(['danger', 'caution', 'caution', 'info']);
    expect(items[0]?.id).toBe('degraded-inst-bad');
    expect(items[3]?.id).toBe('stopped-inst-stop');
  });

  it('does not mutate the instance list it was given', () => {
    const instances = [instance({ id: 'inst-bad', state: 'degraded' })];
    const snapshot = [...instances];
    buildAttention(instances, posture());
    expect(instances).toEqual(snapshot);
  });
});
