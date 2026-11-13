import { describe, expect, it } from 'vitest';
import { PrivacyRequestSchema } from '@seamnex/domain';
import {
  dsarCatalogue,
  toPrivacyRequest,
  type DsarRow,
  type PersonalDataMapRow,
} from '../../../../src/modules/m18-governance/dsar-scopes';

const HOUR = 3_600_000;

function row(overrides: Partial<DsarRow> = {}): DsarRow {
  return {
    id: 'fc2e71c2-521d-45bd-ac51-7eda2d289f26',
    subject_ref: '710a6b633fbdec1056edc31d1123f3e85fa80f01ebbe2b5805c3cb08d0e0fc2f',
    kind: 'export',
    state: 'open',
    opened_by: '871a8c71-f44d-44bc-b388-253b182fa76a',
    opened_at: new Date('2026-11-02T10:00:00.000Z'),
    closed_at: null,
    due_at: new Date('2026-12-02T10:00:00.000Z'),
    scopes: [],
    scope_progress: [],
    evidence: {},
    ...overrides,
  };
}

const MAP: PersonalDataMapRow[] = [
  {
    scope_type: 'platform',
    scope_id: 'audit_event',
    export_procedure: 'export_audit_by_subject_ref()',
    delete_procedure: 'redact_audit_lines()',
  },
  {
    scope_type: 'catalog_entry',
    scope_id: 'inst-helpdesk',
    export_procedure: 'zammad export --subject',
    delete_procedure: 'zammad erase --subject',
  },
];

/**
 * 4F.4: platform-tier scopes are always in a request. An empty `personal_data_map` used to mean
 * "no scopes", so a click on Advance completed a request with nothing in it.
 */
describe('DSAR scope catalogue', () => {
  it('keeps the platform tier when the personal-data map is empty', () => {
    const scopes = dsarCatalogue([], 'export');
    expect(scopes.map((scope) => scope.scopeId)).toEqual([
      'idp_user',
      'entitlements',
      'audit_event',
      'job_log',
      'notification',
    ]);
    expect(scopes.every((scope) => scope.scopeType === 'platform')).toBe(true);
    expect(scopes.every((scope) => scope.state === 'pending')).toBe(true);
  });

  it('lets the map refine a platform procedure without removing the scope', () => {
    const scopes = dsarCatalogue(MAP, 'export');
    const audit = scopes.find((scope) => scope.scopeId === 'audit_event');
    expect(audit?.detail).toBe('export_audit_by_subject_ref()');
    expect(scopes.filter((scope) => scope.scopeType === 'platform')).toHaveLength(5);
  });

  it('describes the erasure procedure for a delete request', () => {
    const scopes = dsarCatalogue(MAP, 'delete');
    expect(scopes.find((scope) => scope.scopeId === 'audit_event')?.detail).toBe(
      'redact_audit_lines()',
    );
    expect(scopes.find((scope) => scope.scopeId === 'inst-helpdesk')).toMatchObject({
      scopeType: 'product',
      detail: 'zammad erase --subject',
    });
  });
});

describe('scopes the map declares beyond the platform tier', () => {
  it('adds a platform scope the tier does not name, so a new data store is not silently dropped', () => {
    const scopes = dsarCatalogue(
      [
        {
          scope_type: 'platform',
          scope_id: 'custom_platform',
          export_procedure: 'export_custom()',
          delete_procedure: 'erase_custom()',
        },
      ],
      'export',
    );

    expect(scopes.find((scope) => scope.scopeId === 'custom_platform')).toMatchObject({
      scopeType: 'platform',
      label: 'custom_platform',
      detail: 'export_custom()',
    });
    expect(scopes.filter((scope) => scope.scopeType === 'platform')).toHaveLength(6);
  });

  it('falls back to the export procedure when the erasure one is blank', () => {
    const scopes = dsarCatalogue(
      [
        {
          scope_type: 'platform',
          scope_id: 'custom_platform',
          export_procedure: 'export_custom()',
          delete_procedure: '   ',
        },
        {
          scope_type: 'catalog_entry',
          scope_id: 'inst-blank',
          export_procedure: 'export_product()',
          delete_procedure: '',
        },
      ],
      'delete',
    );

    // A blank procedure is not an instruction: the documented export path is the best evidence.
    expect(scopes.find((scope) => scope.scopeId === 'custom_platform')?.detail).toBe(
      'export_custom()',
    );
    expect(scopes.find((scope) => scope.scopeId === 'inst-blank')?.detail).toBe('export_product()');
  });
});

describe('request states', () => {
  it.each(['rejected', 'expired'])('maps %s to a failed request', (state) => {
    // Both are failures of the request, not of the subject: the queue must not read them as open.
    const request = toPrivacyRequest(row({ state, scopes: dsarCatalogue([], 'export') }), []);

    expect(request.state).toBe('failed');
  });

  it('keeps an unknown state open rather than inventing a terminal one', () => {
    const request = toPrivacyRequest(
      row({ state: 'queued', scopes: dsarCatalogue([], 'export') }),
      [],
    );

    expect(request.state).toBe('open');
  });
});

describe('malformed snapshot entries', () => {
  it('keeps an entry whose state and detail cannot be rendered', () => {
    const request = toPrivacyRequest(
      row({
        scopes: [
          { scopeType: 'product', scopeId: 's1', label: 'Product one', state: 'bogus', detail: '' },
        ],
      }),
      [],
    );

    expect(request.scopes).toEqual([
      {
        scopeType: 'product',
        scopeId: 's1',
        label: 'Product one',
        state: 'pending',
        detail: 'Product one',
      },
    ]);
  });

  it('ignores progress entries without a usable scope id', () => {
    const request = toPrivacyRequest(
      row({
        scopes: dsarCatalogue([], 'export'),
        scope_progress: [
          null,
          'x',
          42,
          { state: 'complete' },
          { scopeId: 5, state: 'complete' },
          { scopeId: 'idp_user', state: 'bogus' },
          { scopeId: 'entitlements', state: 'complete', detail: '' },
        ],
      }),
      [],
    );

    const byId = new Map(request.scopes.map((scope) => [scope.scopeId, scope]));
    // A state that is not one of the four is rendered as pending, not as whatever was stored.
    expect(byId.get('idp_user')?.state).toBe('pending');
    // An empty detail keeps the catalogue's own description.
    expect(byId.get('entitlements')).toMatchObject({
      state: 'complete',
      detail: 'Effective grants with their scope labels.',
    });
  });
});

describe('privacy request projection', () => {
  it('satisfies the contract the client parses', () => {
    const request = toPrivacyRequest(row({ scopes: dsarCatalogue(MAP, 'export') }), MAP);
    expect(PrivacyRequestSchema.safeParse(request).success).toBe(true);
    expect(request.dueAt).toBe('2026-12-02T10:00:00.000Z');
    expect(request.scopes).toHaveLength(6);
  });

  it('shows the stored deadline instead of recomputing one', () => {
    const request = toPrivacyRequest(
      row({ due_at: new Date('2026-11-20T10:00:00.000Z'), scopes: dsarCatalogue([], 'export') }),
      [],
    );
    expect(Date.parse(request.dueAt)).toBe(Date.parse('2026-11-20T10:00:00.000Z'));
  });

  it('merges recorded progress over the snapshot', () => {
    const request = toPrivacyRequest(
      row({
        state: 'in_progress',
        scopes: dsarCatalogue([], 'export'),
        scope_progress: [
          { scopeId: 'idp_user', state: 'complete', detail: 'Profile and groups exported' },
        ],
      }),
      [],
    );
    expect(request.state).toBe('running');
    expect(request.scopes[0]).toMatchObject({
      scopeId: 'idp_user',
      state: 'complete',
      detail: 'Profile and groups exported',
    });
    expect(request.scopes[1]?.state).toBe('pending');
  });

  it('renders a request opened before snapshots existed against the current map', () => {
    const request = toPrivacyRequest(row({ scopes: [], scope_progress: [] }), MAP);
    expect(request.scopes.map((scope) => scope.scopeId)).toContain('inst-helpdesk');
  });

  it('reports an erased subject and a closed request', () => {
    const request = toPrivacyRequest(
      row({
        subject_ref: null,
        kind: 'delete',
        state: 'completed',
        closed_at: new Date('2026-11-02T11:00:00.000Z'),
        evidence: { steps: ['Every scope complete; outcome recorded'] },
        scopes: dsarCatalogue(MAP, 'delete'),
      }),
      MAP,
    );
    expect(request.subjectRef).toBe('erased');
    expect(request.state).toBe('complete');
    expect(request.evidence).toEqual(['Every scope complete; outcome recorded']);
    expect(request.closedAt).toBe(new Date('2026-11-02T11:00:00.000Z').toISOString());
  });

  it('survives a malformed jsonb snapshot', () => {
    const request = toPrivacyRequest(
      row({ scopes: [{ nonsense: true }, null, 'x'], scope_progress: { not: 'an array' } }),
      [],
    );
    expect(PrivacyRequestSchema.safeParse(request).success).toBe(true);
    expect(request.scopes).toHaveLength(5);
  });

  it('opens a fresh request with the platform tier still pending', () => {
    const request = toPrivacyRequest(
      row({ opened_at: new Date(Date.now() - 2 * HOUR), scopes: dsarCatalogue([], 'export') }),
      [],
    );
    expect(request.state).toBe('open');
    expect(request.scopes.every((scope) => scope.state === 'pending')).toBe(true);
  });
});
