import { describe, expect, it } from 'vitest';
import { PrivacyQueueService } from '../../../../src/modules/m18-governance/privacy-queue.service';
import { fakeDb, type Row } from '../../../support/fakes';

const DSAR_ID = '018f0000-0000-4000-8000-000000000010';

function dsarRow(overrides: Row = {}): Row {
  return {
    id: DSAR_ID,
    subject_ref: 'user@example.test',
    kind: 'export',
    state: 'in_progress',
    opened_by: 'sub-1',
    opened_at: new Date('2026-01-01T00:00:00.000Z'),
    closed_at: null,
    due_at: null,
    scopes: [
      {
        scopeType: 'platform',
        scopeId: 'idp_user',
        label: 'Identity-provider record',
        state: 'pending',
        detail: 'Profile.',
      },
    ],
    scope_progress: null,
    evidence: { steps: ['queued'] },
    ...overrides,
  };
}

function db(options: { requests?: Row[]; map?: Row[] } = {}) {
  return fakeDb([
    [/FROM dsar_request WHERE id = \$1/, options.requests ?? []],
    [/FROM dsar_request ORDER BY opened_at/, options.requests ?? []],
    [/FROM personal_data_map/, options.map ?? []],
  ]);
}

describe('PrivacyQueueService.queue', () => {
  it('reads the queue and the data map in one round trip each', async () => {
    const fake = db({ requests: [dsarRow()] });
    const queue = await new PrivacyQueueService(fake.pool).queue();

    expect(Number.isNaN(Date.parse(queue.generatedAt))).toBe(false);
    expect(queue.requests).toHaveLength(1);
    expect(queue.requests[0]).toMatchObject({
      id: DSAR_ID,
      subjectRef: 'user@example.test',
      kind: 'export',
      state: 'running',
      openedAt: '2026-01-01T00:00:00.000Z',
      evidence: ['queued'],
    });
  });

  it('renders a request with no scopes snapshot against the current map', async () => {
    const fake = db({
      requests: [dsarRow({ scopes: null, scope_progress: null })],
      map: [
        {
          scope_type: 'product',
          scope_id: 'mail',
          export_procedure: 'Dump the mailbox.',
          delete_procedure: 'Delete the mailbox.',
        },
      ],
    });

    const queue = await new PrivacyQueueService(fake.pool).queue();

    expect(queue.requests[0]?.scopes.length).toBeGreaterThan(1);
    expect(queue.requests[0]?.scopes.some((scope) => scope.scopeId === 'idp_user')).toBe(true);
  });

  it('returns an empty queue rather than failing when no request is open', async () => {
    const queue = await new PrivacyQueueService(db().pool).queue();
    expect(queue.requests).toEqual([]);
  });
});

describe('PrivacyQueueService.byId', () => {
  it('returns the request the write path just changed', async () => {
    const fake = db({ requests: [dsarRow()] });
    const request = await new PrivacyQueueService(fake.pool).byId(DSAR_ID);

    expect(request.id).toBe(DSAR_ID);
    expect(fake.calls[0]?.params).toEqual([DSAR_ID]);
  });

  it('refuses an id that is not a uuid before querying', async () => {
    const fake = db();
    await expect(new PrivacyQueueService(fake.pool).byId('nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(fake.calls).toEqual([]);
  });

  it('refuses a uuid with no row', async () => {
    await expect(new PrivacyQueueService(db().pool).byId(DSAR_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      remediation: expect.stringContaining('Refresh the queue'),
    });
  });
});

describe('PrivacyQueueService.catalogue', () => {
  it('returns the scope list a new request snapshots', async () => {
    const fake = db({ map: [] });
    const scopes = await new PrivacyQueueService(fake.pool).catalogue('delete');

    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((scope) => scope.scopeType.length > 0)).toBe(true);
  });
});
