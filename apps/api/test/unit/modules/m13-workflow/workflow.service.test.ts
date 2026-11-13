import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowSchema, type Workflow } from '@seamnex/domain';
import { AppError } from '../../../../src/common/problem/app-error';
import { toProblem } from '../../../../src/common/problem/to-problem';
import { PostgresWorkflowService } from '../../../../src/modules/m13-workflow/workflow.service';

/**
 * `withTransaction` is transparent for these tests: the fake pool is passed as the transaction
 * handle, so the statements a write issues are observable in the same list as the reads.
 */
const h = vi.hoisted(() => ({ withTransaction: vi.fn() }));
vi.mock('@seamnex/db', () => ({ withTransaction: h.withTransaction }));

/**
 * The read surface of module M13, exercised without a database.
 *
 * The fake pool answers by statement shape, so these tests pin the parts the endpoint got wrong and
 * a schema change cannot silently undo:
 *
 *  - the representation is honest (`description` null, owner name from the mirror, write targets
 *    from the column, `validation` from the persisted state);
 *  - the response satisfies `WorkflowSchema` — the failure that took the whole screen down was a
 *    row that parsed out of PostgreSQL and then failed its own contract;
 *  - a malformed id is a `422`, a well-formed one that addresses nothing is `404`, and an unknown
 *    workflow's run history is `404` rather than `[]`;
 *  - the query count does not grow with the number of rows.
 */

type Query = { sql: string; params: unknown[] };

class FakePool {
  readonly queries: Query[] = [];

  constructor(
    private readonly answers: (
      sql: string,
      params: unknown[],
    ) => { rows: unknown[]; rowCount: number },
  ) {}

  query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push({ sql, params });
    return Promise.resolve(this.answers(sql, params));
  }

  get sql(): string[] {
    return this.queries.map((query) => query.sql.replace(/\s+/g, ' ').trim());
  }
}

const WORKFLOW_ID = '6a7088ab-6955-47b2-88a2-797ae750f1a0';
const OWNER_ID = '871a8c71-f44d-44bc-b388-253b182fa76a';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKFLOW_ID,
    name: 'Invoice export to finance',
    description: 'Nightly export.',
    owner_idp_id: OWNER_ID,
    owner_username: 'dev-admin',
    owner_display_name: 'Dev Admin',
    state: 'draft',
    version: 3,
    ir_hash: '91d0be32184a266392a8fab1d69a30854cfeabaeac441e4428e07022825465ad',
    ir: {
      trigger: {
        type: 'schedule',
        label: 'Weekday schedule',
        config: '0 3 * * 1-5',
        timezone: 'Europe/Berlin',
      },
      nodes: [],
      edges: [],
    },
    // The recorded pass (migration 0022). A row with `validated_at: null` has never been checked —
    // that case is not "valid" and is the one the list used to get wrong.
    validated_at: new Date('2026-02-01T00:00:00.000Z'),
    validation_issues: [],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    last_run_at: null,
    last_run_state: null,
    total_count: '1',
    ...overrides,
  };
}

function serviceWith(pool: FakePool): PostgresWorkflowService {
  // The service uses only `query` for the read surface; the audit service is never reached here.
  return new PostgresWorkflowService(
    pool as unknown as Pool,
    {
      lockChain: () => Promise.resolve(),
      append: () => Promise.resolve(),
    } as never,
    { remove: () => Promise.resolve(false) } as never,
  );
}

/** Routes by statement shape: one answer per query the service issues. */
function poolFor(options: {
  rows?: unknown[];
  targets?: unknown[];
  scopes?: unknown[];
  runs?: unknown[];
  nodes?: unknown[];
  workflowExists?: boolean;
  runRows?: unknown[];
}): FakePool {
  return new FakePool((sql) => {
    if (sql.includes('count(*) OVER')) {
      return { rows: options.rows ?? [], rowCount: (options.rows ?? []).length };
    }
    if (sql.includes('unnest(w.write_targets)')) {
      return { rows: options.targets ?? [], rowCount: (options.targets ?? []).length };
    }
    if (sql.includes('FROM credential_scope')) {
      return { rows: options.scopes ?? [], rowCount: (options.scopes ?? []).length };
    }
    if (sql.includes('SELECT 1 FROM workflow WHERE id')) {
      const exists = options.workflowExists ?? true;
      return { rows: exists ? [{ '?column?': 1 }] : [], rowCount: exists ? 1 : 0 };
    }
    if (sql.includes('FROM workflow_run_node')) {
      return { rows: options.nodes ?? [], rowCount: (options.nodes ?? []).length };
    }
    if (sql.includes('FROM workflow_run r')) {
      const runs = options.runs ?? options.runRows ?? [];
      return { rows: runs, rowCount: runs.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('GET /workflows', () => {
  it('reports what the platform stores and satisfies the response contract', async () => {
    const pool = poolFor({
      rows: [
        row({
          state: 'active',
          last_run_at: new Date('2026-02-02T10:00:00.000Z'),
          last_run_state: 'succeeded',
        }),
      ],
      targets: [{ workflow_id: WORKFLOW_ID, entry_key: 'D01-01', product: 'EspoCRM' }],
      scopes: [
        {
          workflow_id: WORKFLOW_ID,
          id: 'c1',
          instance_id: 'i1',
          entry_key: 'D01-01',
          operations: ['contact.write'],
          mode: 'write',
          issued_at: new Date('2026-01-05T00:00:00.000Z'),
          expires_at: new Date('2026-04-05T00:00:00.000Z'),
          revoked_at: null,
        },
      ],
    });

    const result = await serviceWith(pool).list({});
    const workflow = result.items[0] as Workflow;

    expect(result.total).toBe(1);
    // The contract is the point: a body that parses here cannot 500 the screen later.
    expect(() => WorkflowSchema.parse(workflow)).not.toThrow();
    expect(workflow.owner).toEqual({ id: OWNER_ID, name: 'Dev Admin' });
    expect(workflow.writeTargets).toEqual([
      { entryKey: 'D01-01', product: 'EspoCRM', mode: 'write' },
    ]);
    expect(workflow.credentialScopes).toHaveLength(1);
    expect(workflow.irHash).toBe(
      'sha256:91d0be32184a266392a8fab1d69a30854cfeabaeac441e4428e07022825465ad',
    );
    expect(workflow.validation).toEqual({
      valid: true,
      checkedAt: '2026-02-01T00:00:00.000Z',
      issues: [],
    });
    expect(workflow.enabled).toBe(true);
    expect(workflow.lastRunAt).toBe('2026-02-02T10:00:00.000Z');
    expect(workflow.lastRunState).toBe('succeeded');
  });

  it('keeps an absent description absent instead of inventing one', async () => {
    const pool = poolFor({ rows: [row({ description: null })] });
    const workflow = (await serviceWith(pool).list({})).items[0] as Workflow;
    expect(workflow.description).toBeNull();
    expect(() => WorkflowSchema.parse(workflow)).not.toThrow();
  });

  it('normalises a legacy empty-string description to null', async () => {
    const pool = poolFor({ rows: [row({ description: '   ' })] });
    const workflow = (await serviceWith(pool).list({})).items[0] as Workflow;
    expect(workflow.description).toBeNull();
    expect(() => WorkflowSchema.parse(workflow)).not.toThrow();
  });

  it('reports an unvalidated draft as not valid and an owner without a mirror row by its id', async () => {
    const pool = poolFor({
      rows: [
        row({
          state: 'draft',
          validated_at: null,
          validation_issues: [],
          owner_display_name: null,
          owner_username: null,
        }),
      ],
    });
    const workflow = (await serviceWith(pool).list({})).items[0] as Workflow;
    expect(workflow.validation.valid).toBe(false);
    expect(workflow.validation.checkedAt).toBeNull();
    expect(workflow.owner.name).toBe(OWNER_ID);
  });

  /**
   * The regression that made the console offer Activate on a definition the API then refused.
   *
   * `POST /workflows/import` lands a workflow in `disabled` without any validation pass, and the
   * projection used to read `valid` off the state — so the row said "valid", the button was enabled,
   * and `POST /workflows/:id/activate` answered `422 VALIDATION_FAILED`.
   */
  it('does not call an imported, never-checked workflow valid just because it is disabled', async () => {
    const pool = poolFor({
      rows: [row({ state: 'disabled', validated_at: null, validation_issues: [] })],
    });
    const workflow = (await serviceWith(pool).list({})).items[0] as Workflow;

    expect(workflow.state).toBe('disabled');
    expect(workflow.validation).toEqual({ valid: false, checkedAt: null, issues: [] });
    expect(() => WorkflowSchema.parse(workflow)).not.toThrow();
  });

  it('reports the recorded pass, with its issues and the timestamp of the check', async () => {
    const issues = [
      {
        id: 'd4b1a2f8-6f2e-4a37-9f3f-4f6c0b7d5a11',
        nodeId: '3b7f2f0e-9f0f-4b58-8d8b-0f6c2f5d1a22',
        severity: 'error' as const,
        code: 'CREDENTIAL_MISSING',
        message: 'Node "Create sales order" writes but has no live write credential.',
        remediation: 'Request a write credential scope.',
      },
    ];
    const pool = poolFor({ rows: [row({ state: 'active', validation_issues: issues })] });
    const workflow = (await serviceWith(pool).list({})).items[0] as Workflow;

    // An error-severity issue blocks activation even while the row is active, so a workflow that
    // lost its scope is visible before the next run rather than after it.
    expect(workflow.validation.valid).toBe(false);
    expect(workflow.validation.checkedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(workflow.validation.issues).toEqual(issues);
    expect(() => WorkflowSchema.parse(workflow)).not.toThrow();
  });

  it('treats a non-array issue column as no recorded issues instead of failing the page', async () => {
    const pool = poolFor({ rows: [row({ validation_issues: { broken: true } })] });
    const workflow = (await serviceWith(pool).list({})).items[0] as Workflow;

    expect(workflow.validation.issues).toEqual([]);
    expect(() => WorkflowSchema.parse(workflow)).not.toThrow();
  });

  it('passes the declared filters to SQL and escapes the LIKE metacharacters', async () => {
    const pool = poolFor({ rows: [] });
    await serviceWith(pool).list({ state: 'active', q: '50%_off', limit: 20, offset: 40 });
    const [listQuery] = pool.queries;
    expect(listQuery?.params).toEqual(['active', '%50\\%\\_off%', 20, 40]);
    expect(listQuery?.sql).toContain("ESCAPE '\\'");
  });

  it('returns the whole match set size, not the page size', async () => {
    const pool = poolFor({ rows: [row({ total_count: '340' })] });
    const result = await serviceWith(pool).list({ limit: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(340);
  });

  it('issues a fixed number of queries regardless of row count', async () => {
    const pool = poolFor({ rows: [row(), row({ id: 'b' }), row({ id: 'c' })] });
    await serviceWith(pool).list({});
    expect(pool.queries).toHaveLength(3);
  });

  it('does not query for related records when the page is empty', async () => {
    const pool = poolFor({ rows: [] });
    const result = await serviceWith(pool).list({});
    expect(result).toEqual({ items: [], total: 0 });
    expect(pool.queries).toHaveLength(1);
  });

  it.each([0, 201, 1.5])('refuses limit %s with a field error', async (limit) => {
    const pool = poolFor({ rows: [] });
    await expect(serviceWith(pool).list({ limit })).rejects.toBeInstanceOf(AppError);
    expect(pool.queries).toHaveLength(0);

    await serviceWith(pool)
      .list({ limit })
      .catch((error: AppError) => {
        expect(error.code).toBe('VALIDATION_FAILED');
        expect(error.status).toBe(422);
        expect(error.fieldErrors).toEqual([
          expect.objectContaining({ field: 'limit', code: 'out_of_range' }),
        ]);
      });
  });

  it('refuses a negative offset', async () => {
    await expect(serviceWith(poolFor({ rows: [] })).list({ offset: -1 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
  });
});

describe('GET /workflows/:id', () => {
  it('answers 422 for an id that is not a UUID, without consulting the database', async () => {
    const pool = poolFor({});
    await expect(serviceWith(pool).get('bogus-id')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
    expect(pool.queries).toHaveLength(0);
  });

  it('answers 404 for a well-formed id that addresses no row', async () => {
    const error = await serviceWith(poolFor({ rows: [] }))
      .get('00000000-0000-4000-8000-000000000000')
      .catch((thrown: unknown) => thrown);
    // The status is the catalogue's, not the thrower's: assert the problem document the client sees.
    expect(error).toBeInstanceOf(AppError);
    expect(toProblem(error)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('GET /workflows/:id/runs', () => {
  it('answers 404 instead of an empty list when the workflow does not exist', async () => {
    const pool = poolFor({ workflowExists: false });
    const error = await serviceWith(pool)
      .runs(WORKFLOW_ID)
      .catch((thrown: unknown) => thrown);
    expect(toProblem(error)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    // The existence check is the only query: no run history is read for a missing definition.
    expect(pool.queries).toHaveLength(1);
  });

  it('groups node outcomes by run and labels them from the IR', async () => {
    const pool = poolFor({
      runs: [
        {
          id: 'run-1',
          workflow_id: WORKFLOW_ID,
          workflow_name: 'Invoice export to finance',
          version: 3,
          trigger: 'manual',
          state: 'failed',
          started_at: new Date('2026-02-02T10:00:00.000Z'),
          finished_at: new Date('2026-02-02T10:00:04.000Z'),
          idempotency_key: 'manual:1',
          replay_of: null,
          error: { message: 'HTTP 502 from the target' },
        },
      ],
      nodes: [
        {
          run_id: 'run-1',
          node_id: 'node-action',
          label: 'Create invoice',
          state: 'failed',
          attempt: 1,
          duration_ms: null,
          error: { message: 'timeout' },
        },
      ],
    });

    const [run] = await serviceWith(pool).runs(WORKFLOW_ID);

    expect(run?.nodes[0]).toMatchObject({
      nodeId: 'node-action',
      label: 'Create invoice',
      durationMs: 0,
      error: 'timeout',
    });
    expect(run?.error).toBe('HTTP 502 from the target');
    expect(run?.recordsProcessed).toBe(0);
    // exists + runs + nodes: no per-run query.
    expect(pool.queries).toHaveLength(3);
  });
});

describe('GET /workflow-runs/:runId', () => {
  it('answers 422 for a malformed run id', async () => {
    await expect(serviceWith(poolFor({})).run('nope')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
    });
  });

  it('reports the run-level error as null, never the string "none"', async () => {
    const pool = poolFor({
      runRows: [
        {
          id: 'run-2',
          workflow_id: WORKFLOW_ID,
          workflow_name: 'Invoice export to finance',
          version: 1,
          trigger: 'manual',
          state: 'running',
          started_at: new Date(Date.now() - 5_000),
          finished_at: null,
          idempotency_key: null,
          replay_of: null,
          error: null,
        },
      ],
    });

    const run = await serviceWith(pool).run('11111111-1111-4111-8111-111111111111');
    expect(run.error).toBeNull();
    expect(run.idempotencyKey).toBe('run-2');
    expect(run.durationMs).toBeGreaterThan(0);
  });
});

describe('GET /workflows/:id/export', () => {
  it('writes the apiVersion the import path accepts', async () => {
    const pool = poolFor({ rows: [row()] });
    const document = await serviceWith(pool).export(WORKFLOW_ID);
    expect(document.apiVersion).toBe('seamnex.workflow/v1');
    expect(document.irHash).toBe(
      'sha256:91d0be32184a266392a8fab1d69a30854cfeabaeac441e4428e07022825465ad',
    );
    expect(() => WorkflowSchema.parse(document.workflow)).not.toThrow();
  });
});

type Answer = { rows: unknown[]; rowCount: number };

function writer(handler: (sql: string, params: unknown[]) => Answer) {
  const pool = new FakePool(handler);
  const audit = {
    lockChain: vi.fn(() => Promise.resolve()),
    append: vi.fn(() => Promise.resolve({ seq: '1', hash: 'h' })),
  };
  h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
    fn(pool),
  );
  const n8n = { remove: vi.fn(async () => true) };
  return {
    pool,
    audit,
    n8n,
    service: new PostgresWorkflowService(pool as unknown as Pool, audit as never, n8n as never),
  };
}

/**
 * The single-row read, distinguished from the list query: both join the version, only this one
 * addresses a row. Matched on fragments because the statements are multi-line template literals.
 */
const isById = (sql: string): boolean =>
  sql.includes('FROM workflow w') &&
  sql.includes('LEFT JOIN workflow_version v') &&
  sql.includes('WHERE w.id = $1');

describe('PATCH /workflows/:id', () => {
  beforeEach(() => {
    h.withTransaction.mockReset();
  });

  it('refuses a description that is present but blank, before reading anything', async () => {
    const { pool, service } = writer(() => ({ rows: [], rowCount: 0 }));

    await expect(
      service.rename(WORKFLOW_ID, { description: '   ' }, undefined, 'actor'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [expect.objectContaining({ field: 'description' })],
    });
    // `null` is how a caller clears the field; an empty string is not a description.
    expect(pool.queries).toHaveLength(0);
  });

  it('refuses an id that is not a UUID', async () => {
    const { pool, service } = writer(() => ({ rows: [], rowCount: 0 }));

    await expect(
      service.rename('not-a-uuid', { name: 'x' }, undefined, 'actor'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(pool.queries).toHaveLength(0);
  });

  it('answers 404 for a well-formed id that addresses no row', async () => {
    const { service } = writer(() => ({ rows: [], rowCount: 0 }));

    await expect(
      service.rename(WORKFLOW_ID, { name: 'x' }, undefined, 'actor'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a stale If-Match', async () => {
    const { service } = writer(() => ({ rows: [row()], rowCount: 1 }));

    await expect(
      service.rename(WORKFLOW_ID, { name: 'x' }, '"stale-validator"', 'actor'),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('renames in one transaction, audits it and answers with the refreshed row', async () => {
    let reads = 0;
    const { pool, audit, service } = writer((sql) => {
      if (isById(sql)) {
        reads += 1;
        return { rows: [row({ name: reads === 1 ? 'Before' : 'After' })], rowCount: 1 };
      }
      if (sql.includes('UPDATE workflow')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const result = await service.rename(WORKFLOW_ID, { name: 'After' }, undefined, 'actor');

    expect(result.workflow.name).toBe('After');
    expect(audit.lockChain).toHaveBeenCalledOnce();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.renamed',
        actorId: 'actor',
        targetId: WORKFLOW_ID,
        detail: { name: 'After' },
      }),
      expect.anything(),
    );
    const update = pool.queries.find((query) => query.sql.includes('UPDATE workflow'));
    // The third parameter is the description and the fourth says whether to touch it at all.
    expect(update?.params).toEqual([WORKFLOW_ID, 'After', null, false]);
  });

  it('clears a description when the caller sends null', async () => {
    const { pool, service } = writer((sql) => {
      if (isById(sql)) return { rows: [row()], rowCount: 1 };
      if (sql.includes('UPDATE workflow')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await service.rename(WORKFLOW_ID, { description: null }, undefined, 'actor');

    const update = pool.queries.find((query) => query.sql.includes('UPDATE workflow'));
    // A COALESCE cannot express "clear": the CASE plus this flag is what makes null mean null.
    expect(update?.params).toEqual([WORKFLOW_ID, null, null, true]);
  });

  it('reports a row that vanished between the read and the refresh', async () => {
    let reads = 0;
    const { service } = writer((sql) => {
      if (isById(sql)) {
        reads += 1;
        return reads === 1 ? { rows: [row()], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(
      service.rename(WORKFLOW_ID, { name: 'After' }, undefined, 'actor'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('DELETE /workflows/:id', () => {
  it('releases the compiled workflow, then deletes and audits in one transaction', async () => {
    const { audit, n8n, service } = writer((sql) => {
      if (sql.includes('SELECT w.state, v.compiled_n8n_id'))
        return { rows: [{ state: 'disabled', compiled_n8n_id: 'wf-1' }], rowCount: 1 };
      if (sql.includes('DELETE FROM workflow')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await expect(service.remove(WORKFLOW_ID, 'actor')).resolves.toBeUndefined();
    expect(n8n.remove).toHaveBeenCalledWith(WORKFLOW_ID, 'wf-1');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.deleted',
        actorId: 'actor',
        targetId: WORKFLOW_ID,
        detail: { n8nRemoved: true },
      }),
      expect.anything(),
    );
  });

  it('refuses to delete an active workflow, so its schedule cannot outlive it', async () => {
    const { audit, n8n, service } = writer(() => ({
      rows: [{ state: 'active', compiled_n8n_id: 'wf-1' }],
      rowCount: 1,
    }));

    await expect(service.remove(WORKFLOW_ID, 'actor')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
    });
    expect(n8n.remove).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('deletes anyway when n8n cannot be reached, and records that it could not', async () => {
    const { audit, n8n, service } = writer((sql) => {
      if (sql.includes('SELECT w.state, v.compiled_n8n_id'))
        return { rows: [{ state: 'disabled', compiled_n8n_id: 'wf-1' }], rowCount: 1 };
      if (sql.includes('DELETE FROM workflow')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    n8n.remove.mockRejectedValueOnce(new Error('n8n unreachable'));

    await expect(service.remove(WORKFLOW_ID, 'actor')).resolves.toBeUndefined();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { n8nRemoved: false, n8nRemovalFailed: 'n8n unreachable' },
      }),
      expect.anything(),
    );
  });

  it('records that there was nothing to release when n8n never had the definition', async () => {
    const { audit, n8n, service } = writer((sql) => {
      if (sql.includes('SELECT w.state, v.compiled_n8n_id'))
        return { rows: [{ state: 'draft', compiled_n8n_id: null }], rowCount: 1 };
      if (sql.includes('DELETE FROM workflow')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    n8n.remove.mockResolvedValueOnce(false);

    await service.remove(WORKFLOW_ID, 'actor');

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { n8nRemoved: false } }),
      expect.anything(),
    );
  });

  it('answers 404 and writes no audit row when nothing was deleted', async () => {
    const { audit, service } = writer(() => ({ rows: [], rowCount: 0 }));

    await expect(service.remove(WORKFLOW_ID, 'actor')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses an id that is not a UUID', async () => {
    const { pool, service } = writer(() => ({ rows: [], rowCount: 0 }));

    await expect(service.remove('nope', 'actor')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(pool.queries).toHaveLength(0);
  });
});

describe('list paging', () => {
  it.each([0, -1, 201, 12.5])('refuses limit %s', async (limit) => {
    const { pool, service } = writer(() => ({ rows: [], rowCount: 0 }));

    await expect(service.list({ limit })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [expect.objectContaining({ field: 'limit' })],
    });
    expect(pool.queries).toHaveLength(0);
  });

  it('passes the maximum page size through', async () => {
    const { pool, service } = writer(() => ({ rows: [], rowCount: 0 }));

    await service.list({ limit: 200 });

    expect(pool.queries[0]?.params).toEqual([null, null, 200, 0]);
  });

  it('defaults the offset and escapes LIKE metacharacters in the search term', async () => {
    const { pool, service } = writer(() => ({ rows: [], rowCount: 0 }));

    await service.list({ q: ' a_b%c\\d ' });

    // `_`, `%` and `\` are escaped so a search for them matches the characters, not the pattern.
    expect(pool.queries[0]?.params).toEqual([null, '%a\\_b\\%c\\\\d%', null, 0]);
  });

  it('treats a blank search as no search', async () => {
    const { pool, service } = writer(() => ({ rows: [], rowCount: 0 }));

    await service.list({ q: '   ' });

    expect(pool.queries[0]?.params[1]).toBeNull();
  });
});

describe('rows the platform cannot fully represent', () => {
  it('reports an unversioned row as version 1 with no IR hash and a manual trigger', async () => {
    const { service } = writer((sql) => {
      if (isById(sql)) {
        return {
          rows: [row({ version: null, ir_hash: null, ir: null, state: 'draft' })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const workflow = await service.get(WORKFLOW_ID);

    expect(workflow.version).toBe(1);
    // The contract always carries the algorithm, so "no hash" is spelled `sha256:none`.
    expect(workflow.irHash).toBe('sha256:none');
    expect(workflow.trigger.type).toBe('manual');
    expect(workflow.nodes).toEqual([]);
    expect(workflow.edges).toEqual([]);
    expect(workflow.writeTargets).toEqual([]);
    expect(workflow.credentialScopes).toEqual([]);
    expect(workflow.enabled).toBe(false);
  });

  it('counts the first page when the window function is absent from the row', async () => {
    const { service } = writer((sql) => {
      if (sql.includes('count(*) OVER ()')) {
        return { rows: [row({ total_count: null }), row({ id: 'other-id' })], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });

    // The id query is answered first; the list uses the same rows for both queries.
    await expect(service.list({})).resolves.toMatchObject({ total: 2 });
  });

  it('answers no runs for a workflow that exists but has never run', async () => {
    const { service } = writer((sql) => {
      if (sql.includes('SELECT 1 FROM workflow')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    await expect(service.runs(WORKFLOW_ID)).resolves.toEqual([]);
  });

  it('describes a node without a label by its id, and a run without a key by its id', async () => {
    const { service } = writer((sql) => {
      if (sql.includes('FROM workflow_run_node rn')) {
        return {
          rows: [
            {
              run_id: 'run-9',
              node_id: '9f1c4a2e-0000-4000-8000-000000000001',
              label: null,
              state: 'failed',
              attempt: 2,
              duration_ms: null,
              error: { message: '' },
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM workflow_run r')) {
        return {
          rows: [
            {
              id: 'run-9',
              workflow_id: WORKFLOW_ID,
              workflow_name: 'Invoice export',
              version: null,
              trigger: 'manual',
              state: 'failed',
              started_at: new Date('2026-02-01T00:00:00Z'),
              finished_at: new Date('2026-02-01T00:00:02Z'),
              idempotency_key: null,
              replay_of: null,
              error: { message: 'the product answered 500' },
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM workflow_run_node rn')) {
        return {
          rows: [
            {
              run_id: 'run-9',
              node_id: '9f1c4a2e-0000-4000-8000-000000000001',
              label: null,
              state: 'failed',
              attempt: 2,
              duration_ms: null,
              error: { message: '' },
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const run = await service.run('11111111-1111-4111-8111-111111111111');

    expect(run.idempotencyKey).toBe('run-9');
    expect(run.version).toBe(1);
    expect(run.error).toBe('the product answered 500');
    expect(run.nodes[0]).toMatchObject({
      nodeId: '9f1c4a2e-0000-4000-8000-000000000001',
      label: '9f1c4a2e-0000-4000-8000-000000000001',
      attempt: 2,
      durationMs: 0,
      records: 0,
      // An empty message is not a message.
      error: null,
    });
  });
});
