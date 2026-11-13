import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CredentialScope,
  ValidationIssue,
  Workflow,
  WorkflowExport,
  WorkflowNode,
  WorkflowRun,
  WorkflowState,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { withTransaction } from '@seamnex/db';
import { PG_POOL } from '../../database/database.module';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { AppError } from '../../common/problem/app-error';
import { isUuid } from '../../common/http/uuid';
import { assertIfMatch, etagFor } from '../../common/http/etag';
import { N8nClient } from './n8n.client';
import type { WorkflowListFilter, WorkflowListResult, WorkflowService } from './workflow.contract';
import {
  formatIrHash,
  manualTrigger,
  mappingsFor,
  normaliseDescription,
  ownerName,
} from './workflow.representation';

/** The page size the OpenAPI description promises; a larger `limit` is refused, not clamped. */
export const WORKFLOW_LIST_MAX_LIMIT = 200;

/** Used by the row mappers, which are plain functions and have no injected logger. */
const MODULE_LOG = new Logger('m13.workflow');

type Row = {
  id: string;
  name: string;
  description: string | null;
  owner_idp_id: string;
  owner_username: string | null;
  owner_display_name: string | null;
  state: string;
  version: number | null;
  ir_hash: string | null;
  ir: WorkflowIr | null;
  /** The recorded validation pass (migration 0022); `null` means none has run. */
  validated_at: Date | null;
  validation_issues: unknown;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
  last_run_state: string | null;
  total_count: string | number | null;
};

type WorkflowIr = {
  trigger?: Workflow['trigger'];
  nodes?: WorkflowNode[];
  edges?: Workflow['edges'];
};

type TargetRow = { workflow_id: string; entry_key: string; product: string | null };
type ScopeRow = {
  workflow_id: string;
  id: string;
  instance_id: string;
  entry_key: string;
  operations: string[];
  mode: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};
type RunRow = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  version: number | null;
  trigger: string;
  state: string;
  started_at: Date;
  finished_at: Date | null;
  idempotency_key: string | null;
  replay_of: string | null;
  error: unknown;
};
type RunNodeRow = {
  run_id: string;
  node_id: string;
  label: string | null;
  state: string;
  attempt: number;
  duration_ms: number | null;
  error: unknown;
};

/**
 * Deliverable 2.9 — the read surface plus rename and delete. Authoring is Phase 4E.
 *
 * Two rules hold the representation together, and both were broken by the previous version:
 *
 *  - **Nothing is invented.** `description`, `owner.name`, `writeTargets`, `credentialScopes` and
 *    `validation` are read from where the platform stores them, and an absent value stays absent
 *    (`null`) instead of being replaced with a plausible-looking string. A synthesised value cannot
 *    be told apart from a real one by the screen, and the fabricated `''` description made the
 *    create path answer `500` on every later list read.
 *  - **A malformed id is a client error, not a server error.** A non-UUID path segment would reach
 *    PostgreSQL as `22P02` and surface as `INTERNAL_ERROR`; it is refused here as `422` with the
 *    offending field, and a well-formed id that addresses no row is `404`.
 */

@Injectable()
export class PostgresWorkflowService implements WorkflowService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(N8nClient) private readonly n8n: N8nClient,
  ) {}

  async list(filter: WorkflowListFilter): Promise<WorkflowListResult> {
    const limit = pageLimit(filter.limit);
    const offset = pageOffset(filter.offset);
    const params = [filter.state ?? null, likePattern(filter.q), limit, offset];

    const rows = await this.pool.query<Row>(LIST_SQL, params);
    if (rows.rows.length === 0) return { items: [], total: 0 };

    const ids = rows.rows.map((row) => row.id);
    const related = await this.related(ids);
    return {
      items: rows.rows.map((row) => toWorkflow(row, related)),
      total: Number(rows.rows[0]?.total_count ?? rows.rows.length),
    };
  }

  async get(id: string): Promise<Workflow> {
    const workflowId = workflowIdOrThrow(id);
    const rows = await this.pool.query<Row>(`${LIST_SQL_BY_ID}`, [workflowId]);
    const row = rows.rows[0];
    if (row === undefined) throw notFound(id);
    const related = await this.related([row.id]);
    return toWorkflow(row, related);
  }

  async rename(
    id: string,
    patch: { name?: string; description?: string | null },
    expectedEtag: string | undefined,
    actorId: string,
  ): Promise<{ workflow: Workflow; etag: string }> {
    const workflowId = workflowIdOrThrow(id);
    // An empty string is not a description. `null` is how a caller clears the field, which a
    // `COALESCE` cannot express: it would silently keep the previous text.
    if (
      patch.description !== undefined &&
      patch.description !== null &&
      patch.description.trim().length === 0
    ) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'A description cannot be empty. Send null to clear it.',
        fieldErrors: [
          {
            field: 'description',
            code: 'min_length',
            message: 'Use at least one character, or null.',
          },
        ],
        remediation: 'Clear the field to remove the description, or write one.',
      });
    }

    const rows = await this.pool.query<Row>(LIST_SQL_BY_ID, [workflowId]);
    const row = rows.rows[0];
    if (row === undefined) throw notFound(id);
    const etag = etagFor([row.updated_at, row.version]);
    assertIfMatch({
      header: expectedEtag,
      etag,
      required: false,
      detail: 'The workflow changed since it was read.',
    });

    const replacesDescription = Object.hasOwn(patch, 'description');
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      await tx.query(
        `UPDATE workflow
            SET name = COALESCE($2, name),
                description = CASE WHEN $4 THEN $3 ELSE description END,
                updated_at = now()
          WHERE id = $1`,
        [workflowId, patch.name ?? null, patch.description ?? null, replacesDescription],
      );
      await this.audit.append(
        {
          action: 'workflow.renamed',
          actorType: 'user',
          actorId,
          targetType: 'workflow',
          targetId: workflowId,
          outcome: 'success',
          detail: { ...patch },
        },
        tx,
      );
    });

    const refreshed = await this.pool.query<Row>(LIST_SQL_BY_ID, [workflowId]);
    const next = refreshed.rows[0];
    if (next === undefined) throw notFound(id);
    return {
      workflow: toWorkflow(next, await this.related([next.id])),
      etag: etagFor([next.updated_at, next.version]),
    };
  }

  /**
   * Removes the definition, and the n8n workflow it was compiled to.
   *
   * Two rules the screen already stated and the code did not: an active definition cannot be deleted
   * (its schedule would keep running with nothing left to point at), and the n8n side is released.
   * The n8n call is best-effort and its outcome is recorded: a platform record must not survive a
   * failed delete because the adapter is down, but the audit row must not claim a clean removal either.
   */
  async remove(id: string, actorId: string): Promise<void> {
    const workflowId = workflowIdOrThrow(id);
    const current = await this.pool.query<{
      state: string;
      compiled_n8n_id: string | null;
    }>(
      `SELECT w.state, v.compiled_n8n_id
         FROM workflow w LEFT JOIN workflow_version v ON v.id = w.current_version_id
        WHERE w.id = $1`,
      [workflowId],
    );
    const row = current.rows[0];
    if (row === undefined) throw notFound(id);
    if (row.state === 'active') {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: `Workflow ${id} is active; disable it before deleting.`,
        remediation: 'Disable the workflow, then delete it.',
      });
    }

    const release = await this.n8n
      .remove(workflowId, row.compiled_n8n_id)
      .then((removed) => ({ removed }))
      .catch((error: unknown) => ({
        failed: error instanceof Error ? error.message : String(error),
      }));

    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const deleted = await tx.query(`DELETE FROM workflow WHERE id = $1`, [workflowId]);
      if (deleted.rowCount === 0) throw notFound(id);
      await this.audit.append(
        {
          action: 'workflow.deleted',
          actorType: 'user',
          actorId,
          targetType: 'workflow',
          targetId: workflowId,
          outcome: 'success',
          detail:
            'failed' in release
              ? { n8nRemoved: false, n8nRemovalFailed: release.failed }
              : { n8nRemoved: release.removed },
        },
        tx,
      );
    });
  }

  /**
   * Run history for one workflow.
   *
   * An unknown workflow is `404`: the previous version answered `200 []`, which is indistinguishable
   * from "this workflow has never run" and told the run history screen that a deleted definition
   * was simply idle. Two queries serve the whole page (runs, then their nodes) instead of the
   * `1 + 2N` the previous per-run loop issued.
   */
  async runs(workflowId: string): Promise<WorkflowRun[]> {
    const id = workflowIdOrThrow(workflowId);
    const exists = await this.pool.query(`SELECT 1 FROM workflow WHERE id = $1`, [id]);
    if (exists.rowCount === 0) throw notFound(workflowId);

    const runs = await this.pool.query<RunRow>(RUNS_SQL, [id]);
    if (runs.rows.length === 0) return [];

    const nodes = await this.pool.query<RunNodeRow>(RUN_NODES_SQL, [id]);
    const byRun = new Map<string, RunNodeRow[]>();
    for (const node of nodes.rows) {
      const bucket = byRun.get(node.run_id) ?? [];
      bucket.push(node);
      byRun.set(node.run_id, bucket);
    }
    return runs.rows.map((row) => toRun(row, byRun.get(row.id) ?? []));
  }

  async run(runId: string): Promise<WorkflowRun> {
    if (!isUuid(runId)) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'A run id is not a UUID.',
        fieldErrors: [
          { field: 'runId', code: 'invalid_uuid', message: 'Use the id from the run history.' },
        ],
        remediation: 'Open the workflow and choose a run from its history.',
      });
    }
    const runs = await this.pool.query<RunRow>(RUN_SQL, [runId]);
    const row = runs.rows[0];
    if (row === undefined) throw notFound(runId);
    const nodes = await this.pool.query<RunNodeRow>(RUN_NODES_BY_RUN_SQL, [runId]);
    return toRun(row, nodes.rows);
  }

  /**
   * Portable export. `apiVersion` is the value the import path accepts (`seamnex.workflow/v1`) — the
   * previous `seamnex/v1` could never be re-imported, so export→import failed with
   * `IMPORT_VERSION_UNSUPPORTED` on the platform's own document.
   */
  async export(id: string): Promise<WorkflowExport> {
    const workflow = await this.get(id);
    return {
      apiVersion: 'seamnex.workflow/v1',
      exportedAt: new Date().toISOString(),
      irHash: workflow.irHash,
      workflow,
    };
  }

  /** Write targets and credential scopes for a page of definitions: two queries, never one per row. */
  private async related(ids: readonly string[]): Promise<Related> {
    const targets = await this.pool.query<TargetRow>(WRITE_TARGETS_SQL, [ids]);
    const scopes = await this.pool.query<ScopeRow>(CREDENTIAL_SCOPES_SQL, [ids]);

    const byWorkflowTargets = new Map<string, Workflow['writeTargets']>();
    for (const row of targets.rows) {
      const bucket = byWorkflowTargets.get(row.workflow_id) ?? [];
      bucket.push({
        entryKey: row.entry_key,
        product: row.product ?? row.entry_key,
        mode: 'write',
      });
      byWorkflowTargets.set(row.workflow_id, bucket);
    }

    const byWorkflowScopes = new Map<string, CredentialScope[]>();
    for (const row of scopes.rows) {
      const bucket = byWorkflowScopes.get(row.workflow_id) ?? [];
      bucket.push({
        id: row.id,
        instanceId: row.instance_id,
        product: row.entry_key,
        operations: row.operations,
        mode: row.mode as CredentialScope['mode'],
        issuedAt: row.issued_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
        brokered: true,
      });
      byWorkflowScopes.set(row.workflow_id, bucket);
    }

    return { targets: byWorkflowTargets, scopes: byWorkflowScopes };
  }
}

type Related = {
  readonly targets: ReadonlyMap<string, Workflow['writeTargets']>;
  readonly scopes: ReadonlyMap<string, CredentialScope[]>;
};

/**
 * One round trip per page for the definitions themselves.
 *
 * The previous query ran the same "last run" subquery twice per row (`SubPlan 1`/`SubPlan 2` in its
 * plan) and left the caller to fill in write targets and scopes from memory. The last run is a
 * single `LATERAL` now, `count(*) OVER ()` returns the size of the match set for `x-total-count`,
 * and `owner.name` comes from the identity mirror rather than being echoed back as the opaque id.
 */
const LIST_SELECT = `
  SELECT w.id, w.name, w.description, w.owner_idp_id, w.state,
         u.username AS owner_username, u.display_name AS owner_display_name,
         v.version, v.ir_hash, v.ir, v.validated_at, v.validation_issues,
         w.created_at, w.updated_at,
         lr.started_at AS last_run_at, lr.state AS last_run_state,
         count(*) OVER () AS total_count
    FROM workflow w
    LEFT JOIN workflow_version v ON v.id = w.current_version_id
    LEFT JOIN idp_user u ON u.idp_id = w.owner_idp_id
    LEFT JOIN LATERAL (
      SELECT r.started_at, r.state
        FROM workflow_run r
       WHERE r.workflow_id = w.id
       ORDER BY r.started_at DESC
       LIMIT 1
    ) lr ON TRUE`;

const LIST_SQL = `
${LIST_SELECT}
   WHERE ($1::text IS NULL OR w.state = $1)
     AND ($2::text IS NULL OR w.name ILIKE $2 ESCAPE '\\' OR COALESCE(w.description, '') ILIKE $2 ESCAPE '\\')
   ORDER BY w.updated_at DESC, w.id DESC
   LIMIT $3 OFFSET $4`;

const LIST_SQL_BY_ID = `${LIST_SELECT} WHERE w.id = $1`;

const WRITE_TARGETS_SQL = `
  SELECT w.id AS workflow_id, t.entry_key, c.payload->>'product' AS product
    FROM workflow w
    CROSS JOIN LATERAL unnest(w.write_targets) AS t(entry_key)
    LEFT JOIN catalog_entry c ON c.key = t.entry_key
   WHERE w.id = ANY($1::uuid[])
   ORDER BY t.entry_key`;

const CREDENTIAL_SCOPES_SQL = `
  SELECT s.workflow_id, s.id, s.instance_id, i.entry_key, s.operations, s.mode,
         s.issued_at, s.expires_at, s.revoked_at
    FROM credential_scope s
    JOIN instance i ON i.id = s.instance_id
   WHERE s.workflow_id = ANY($1::uuid[])
   ORDER BY s.issued_at`;

const RUN_SELECT = `
  SELECT r.id, r.workflow_id, w.name AS workflow_name, v.version, r.trigger, r.state,
         r.started_at, r.finished_at, r.idempotency_key, r.replay_of, r.error
    FROM workflow_run r
    JOIN workflow w ON w.id = r.workflow_id
    LEFT JOIN workflow_version v ON v.id = r.version_id`;

const RUNS_SQL = `${RUN_SELECT} WHERE r.workflow_id = $1 ORDER BY r.started_at DESC, r.id DESC`;

const RUN_SQL = `${RUN_SELECT} WHERE r.id = $1`;

/**
 * Node outcomes with the label the IR gave them. The node id is a UUID; `node_id.replace(/-/g, ' ')`
 * — the previous label — rendered "9f1c 4a2e …" in the run inspector.
 */
const RUN_NODE_SELECT = `
  SELECT rn.run_id, rn.node_id, n.value->>'label' AS label, rn.state, rn.attempt,
         rn.duration_ms, rn.error
    FROM workflow_run_node rn
    JOIN workflow_run r ON r.id = rn.run_id
    LEFT JOIN workflow_version v ON v.id = r.version_id
    LEFT JOIN LATERAL (
      SELECT value
        FROM jsonb_array_elements(COALESCE(v.ir->'nodes', '[]'::jsonb)) AS value
       WHERE value->>'id' = rn.node_id
       LIMIT 1
    ) n ON TRUE`;

const RUN_NODES_SQL = `${RUN_NODE_SELECT} WHERE r.workflow_id = $1 ORDER BY rn.run_id, rn.node_id, rn.attempt`;

const RUN_NODES_BY_RUN_SQL = `${RUN_NODE_SELECT} WHERE r.id = $1 ORDER BY rn.node_id, rn.attempt`;

function toWorkflow(row: Row, related: Related): Workflow {
  const ir = row.ir ?? {};
  const state = row.state as WorkflowState;
  if (row.version === null || row.ir_hash === null) {
    // Only a hand-edited or half-provisioned row reaches this: create/import always write a version.
    // The list must not fail for the other rows, so the defect is logged and reported as absent.
    MODULE_LOG.warn(`workflow ${row.id} has no current version; reported as unversioned`);
  }

  return {
    id: row.id,
    name: row.name,
    // A legacy `''` (stored by the create path before this change) is "no description", not a
    // description that happens to be empty; the read path normalises it instead of failing the schema.
    description: normaliseDescription(row.description),
    owner: {
      id: row.owner_idp_id,
      name: ownerName(row.owner_display_name, row.owner_username, row.owner_idp_id),
    },
    state,
    // `version` is non-null for every representable row; the fallback keeps one corrupt row from
    // failing the whole page (the contract requires a positive integer).
    version: row.version ?? 1,
    irHash: formatIrHash(row.ir_hash),
    // A workflow with no trigger in its IR cannot run on its own, so "manual" is the safe reading;
    // it is logged like a missing version rather than silently replaced by a schedule.
    trigger: ir.trigger ?? missingTrigger(row.id),
    writeTargets: related.targets.get(row.id) ?? [],
    // The mappings a node sends, not only the ones filed on the node record: `setMappings` files a
    // non-source node's fields on its inbound edge (see `mappingsFor`).
    nodes: (ir.nodes ?? []).map((node) => ({ ...node, mappings: mappingsFor(ir, node) })),
    edges: ir.edges ?? [],
    credentialScopes: related.scopes.get(row.id) ?? [],
    /**
     * The pass `POST /workflows/:id/validate` recorded on this version (migration 0022).
     *
     * This used to be inferred from the state (`valid = state !== 'draft' && state !== 'failed'`),
     * which was wrong twice over: an imported `disabled` workflow has never been checked but reported
     * `valid: true` — the screen enabled Activate and the POST answered `422` — and the issues the
     * validator did produce were dropped, so `activation blocked` had nothing to list. Reading the
     * recorded pass costs no extra query (it is a column of the version row already joined here).
     */
    validation: validationOfRow(row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastRunState: (row.last_run_state as Workflow['lastRunState']) ?? null,
    enabled: state === 'active',
  };
}

/**
 * The persisted pass, in the shape `WorkflowSchema.validation` declares.
 *
 * `validated_at IS NULL` is neither valid nor invalid — nobody has checked this version — so it
 * reports `valid: false` with `checkedAt: null`, which the console renders as `not validated` and
 * never as `valid`. A column that is not an array is treated as "no recorded issues" rather than
 * allowed to fail the response schema for the whole page.
 */
function validationOfRow(row: Row): Workflow['validation'] {
  if (row.validated_at === null || row.validated_at === undefined) {
    return { valid: false, checkedAt: null, issues: [] };
  }
  const issues = Array.isArray(row.validation_issues)
    ? (row.validation_issues as ValidationIssue[])
    : [];
  return {
    valid: issues.every((entry) => entry.severity !== 'error'),
    checkedAt: row.validated_at.toISOString(),
    issues,
  };
}

function toRun(row: RunRow, nodes: readonly RunNodeRow[]): WorkflowRun {
  // An unfinished run has no duration; the elapsed time is what is true, and 0 (the previous answer)
  // reads as "finished instantly".
  const end = row.finished_at ?? new Date();
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    version: row.version ?? 1,
    trigger: row.trigger as WorkflowRun['trigger'],
    state: row.state as WorkflowRun['state'],
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    durationMs: Math.max(0, end.getTime() - row.started_at.getTime()),
    // `workflow_run` allows a null key (an internal trigger); the contract requires one, and the run
    // id is the only identifier the platform then has.
    idempotencyKey: row.idempotency_key ?? row.id,
    replayOf: row.replay_of,
    // `workflow_run` has no record counter yet; 0 is honest ("not measured"), unlike the previous
    // `nodes * 10`, which reported ten records per node the platform never counted.
    recordsProcessed: 0,
    nodes: nodes.map((node) => ({
      nodeId: node.node_id,
      label: node.label ?? node.node_id,
      state: node.state as WorkflowRun['nodes'][number]['state'],
      attempt: node.attempt,
      durationMs: node.duration_ms ?? 0,
      records: 0,
      error: messageOf(node.error),
    })),
    error: messageOf(row.error),
  };
}

/** `undefined` unless the column holds an object with a string `message`. */
function messageOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

function missingTrigger(workflowId: string): Workflow['trigger'] {
  MODULE_LOG.warn(`workflow ${workflowId} has no trigger in its IR; reported as manual`);
  return manualTrigger();
}

/** `%term%` with the LIKE metacharacters escaped, so a search for `_` matches an underscore. */
function likePattern(q: string | undefined): string | null {
  const term = q?.trim() ?? '';
  if (term.length === 0) return null;
  return `%${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function pageLimit(limit: number | undefined): number | null {
  if (limit === undefined) return null;
  if (!Number.isInteger(limit) || limit < 1 || limit > WORKFLOW_LIST_MAX_LIMIT) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: `limit must be between 1 and ${WORKFLOW_LIST_MAX_LIMIT}.`,
      fieldErrors: [
        { field: 'limit', code: 'out_of_range', message: `Use 1–${WORKFLOW_LIST_MAX_LIMIT}.` },
      ],
      remediation: 'Page through the list with limit and offset.',
    });
  }
  return limit;
}

function pageOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'offset must be zero or positive.',
      fieldErrors: [
        { field: 'offset', code: 'out_of_range', message: 'Use 0 or a larger integer.' },
      ],
      remediation: 'Page through the list with limit and offset.',
    });
  }
  return offset;
}

/**
 * A path parameter that is not a UUID cannot address a row, and passing it to PostgreSQL raises
 * `22P02` — a `500` for what is a client error. Refused before the query runs.
 */
function workflowIdOrThrow(id: string): string {
  if (isUuid(id)) return id;
  throw new AppError({
    code: 'VALIDATION_FAILED',
    status: 422,
    detail: 'A workflow id is not a UUID.',
    fieldErrors: [
      { field: 'id', code: 'invalid_uuid', message: 'Use the id from the workflow list.' },
    ],
    remediation: 'Open the workflow from the list, or refresh it and retry.',
  });
}

function notFound(id: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No workflow ${id}.`,
    remediation: 'Refresh the workflow list.',
  });
}
