import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  isCredentialGranularity,
  isWorkflowEligible,
  mappingExpression,
  WORKFLOW_EXPORT_API_VERSION,
  workflowIneligibilityReason,
  writeIneligibilityReason,
} from '@seamnex/domain';
import type {
  CredentialGranularity,
  CredentialScope,
  FieldDescriptor,
  FieldMapping,
  NodeFields,
  NodeSample,
  ValidationIssue,
  Workflow,
  WorkflowExport,
  WorkflowImportRequest,
  WorkflowNode,
  WorkflowNodeCreateRequest,
  WorkflowNodePatchRequest,
  WorkflowRun,
  WorkflowTrigger,
  WorkflowTriggerUpdate,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { withTransaction } from '@seamnex/db';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError, isAppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import {
  CREDENTIAL_BROKER_SERVICE,
  type CredentialBrokerService,
} from '../m14-credential-broker/credential-broker.contract';
import { N8nClient } from './n8n.client';
import { FieldDiscoveryService } from './field-discovery.service';
import { snapshotKey } from './field-snapshot.repository';
import { WorkflowSampleService } from './sample.service';
import {
  formatIrHash,
  mappingsFor,
  normaliseDescription,
  ownerName,
} from './workflow.representation';

/** Matches the broker's own ceiling: an active version's credential lives 90 days. */
const NINETY_DAYS = 90 * 24 * 60 * 60;

type Ir = {
  trigger: WorkflowTrigger;
  nodes: WorkflowNode[];
  edges: { id: string; source: string; target: string; mappings: FieldMapping[] }[];
};

type WorkflowRow = {
  id: string;
  name: string;
  description: string | null;
  owner_idp_id: string;
  owner_username: string | null;
  owner_display_name: string | null;
  state: Workflow['state'];
  current_version_id: string | null;
  write_targets: string[];
  created_at: Date;
  updated_at: Date;
};

type VersionRow = {
  id: string;
  workflow_id: string;
  version: number;
  ir: Ir;
  ir_hash: string;
  compiled_n8n_id: string | null;
  /** n8n credential id per entry key, created by the activation that compiled this version. */
  n8n_credentials: Record<string, string>;
  /** `null` means no validation pass has run against this version — not "zero issues". */
  validated_at: Date | null;
  validation_issues: ValidationIssue[] | null;
};

/** The outcome of one pass, as it is persisted and as `POST /workflows/:id/validate` answers it. */
type ValidationPass = { issues: ValidationIssue[]; checkedAt: Date };

/**
 * A discovered operation, reduced to what the draft needs: the id the IR stores and the label the
 * canvas shows. `mode` decides which node may take it — a read op cannot bind a write node.
 */
type DiscoveredOperation = { id: string; label: string; mode: 'read' | 'write' };

/** One product a version touches, and the scope the two sides agree on at activation. */
type EgressProduct = {
  readonly entryKey: string;
  readonly instanceId: string;
  readonly operations: string[];
  readonly mode: 'read' | 'write';
};

/**
 * 4E.1/4E.2 - authoring and validation over the versioned IR.
 *
 * The IR lives in `workflow_version.ir`; every authoring edit writes a **new version** rather than
 * mutating the live one, so an active workflow cannot be changed underneath a running execution
 * (FR-5.1). `ir_hash` is the content address and its unique constraint is what makes a duplicate
 * edit cheap instead of noisy.
 */
@Injectable()
export class WorkflowAuthoringService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(N8nClient) private readonly n8n: N8nClient,
    @Inject(CREDENTIAL_BROKER_SERVICE) private readonly broker: CredentialBrokerService,
    /*
     * Both are optional so that a unit test can build the authoring service without a product or a
     * database behind the mapper. When absent, `fields()` refuses and validation simply skips the
     * unknown-target rule — it never reports an error it could not justify.
     */
    @Optional()
    @Inject(FieldDiscoveryService)
    private readonly discovery?: FieldDiscoveryService,
    @Optional()
    @Inject(WorkflowSampleService)
    private readonly samples?: WorkflowSampleService,
  ) {}

  async create(
    input: {
      name: string;
      description?: string;
      triggerType: WorkflowTrigger['type'];
      sourceInstanceId: string;
      targetInstanceId: string;
    },
    actorId: string,
  ): Promise<Workflow> {
    const source = await this.instanceLabel(input.sourceInstanceId);
    const target = await this.instanceLabel(input.targetInstanceId);
    /**
     * FR-5.3 / C-11, refused where the author can act on it.
     *
     * The draft's second node *is* a write, so a product whose credential granularity is not
     * `scoped` can never satisfy it: no write scope can be minted (the broker refuses) and none can
     * exist (invariant 4). Creating the draft anyway would let an author build a workflow that is
     * guaranteed to fail validation later, with an error that points at the credential rather than at
     * the choice that made it impossible.
     */
    const refusal = writeIneligibilityReason(target.granularity);
    if (refusal !== null) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `${target.product} cannot be a write target: ${refusal}`,
        fieldErrors: [{ field: 'targetInstanceId', code: 'write_ineligible', message: refusal }],
        remediation: 'Choose a write-eligible target, or make the node read-only.',
      });
    }
    /**
     * The same rule for the source, which this path used to accept unconditionally: a product with
     * no credential at all cannot be read either, so the draft's first node could never be executed.
     * The console filters the picker by `workflowEligible`; the API has to refuse it as well, because
     * the picker is not the only caller.
     */
    const readRefusal = workflowIneligibilityReason(source.granularity);
    if (readRefusal !== null) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `${source.product} cannot be a source: ${readRefusal}`,
        fieldErrors: [
          { field: 'sourceInstanceId', code: 'workflow_ineligible', message: readRefusal },
        ],
        remediation: 'Choose a product the platform can obtain a brokered credential for.',
      });
    }
    /**
     * FR-5.2: the draft is composed from **discovered** operations, so the first read operation of
     * the source and the first write operation of the target are bound here.
     *
     * Leaving `operation` null (which this path used to do) made every draft authored from the
     * console structurally invalid: the validator answered `UNBOUND_NODE` for both nodes, and the
     * only endpoint that can bind an operation (`PATCH /workflows/:id/nodes/:nodeId`) has no screen.
     * A draft that cannot be repaired from the UI is not a draft, it is a dead end.
     *
     * An instance whose registry entry exposes no operation of the required mode keeps `null`, so the
     * validator still reports `UNBOUND_NODE` with its remediation instead of the platform inventing a
     * binding that the registry never published.
     */
    const [sourceOperations, targetOperations] = await Promise.all([
      this.discoveredOperations(input.sourceInstanceId),
      this.discoveredOperations(input.targetInstanceId),
    ]);
    const ir: Ir = {
      trigger: triggerFor(input.triggerType),
      nodes: [
        node({
          instanceId: input.sourceInstanceId,
          kind: 'trigger',
          product: source.product,
          entryKey: source.entryKey,
          mode: 'read',
          operation: sourceOperations.find((operation) => operation.mode === 'read') ?? null,
        }),
        node({
          instanceId: input.targetInstanceId,
          kind: 'action',
          product: target.product,
          entryKey: target.entryKey,
          mode: 'write',
          operation: targetOperations.find((operation) => operation.mode === 'write') ?? null,
        }),
      ],
      edges: [],
    };
    ir.edges.push({
      id: randomUUID(),
      source: ir.nodes[0]?.id ?? '',
      target: ir.nodes[1]?.id ?? '',
      mappings: [],
    });

    const workflowId = await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const created = await tx.query<{ id: string }>(
        // `NULL`, never `''`: an empty string is not a description, and storing one made every later
        // read fail the `min(1)` rule of the shared schema (a `500` on the whole workflow list).
        `INSERT INTO workflow (name, description, owner_idp_id, state, write_targets)
         VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
        [input.name, emptyToNull(input.description), actorId, [target.entryKey]],
      );
      const id = created.rows[0]?.id;
      if (id === undefined) throw internal('The workflow row was not created.');
      await this.insertVersion(tx, id, ir, actorId);
      await this.audit.append(
        {
          action: 'workflow.created',
          actorType: 'user',
          actorId,
          targetType: 'workflow',
          targetId: id,
          outcome: 'success',
          detail: { name: input.name },
        },
        tx,
      );
      return id;
    });
    return this.load(workflowId);
  }

  async importDocument(request: WorkflowImportRequest, actorId: string): Promise<Workflow> {
    const document = request.document as WorkflowExport;
    /**
     * The document version is checked here, not only in the consuming screen: `export` writes
     * `seamnex.workflow/v1`, and an older/newer document must be refused with a field error rather than
     * imported on the assumption that its node shape still parses.
     */
    if (document.apiVersion !== WORKFLOW_EXPORT_API_VERSION) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `Expected apiVersion ${WORKFLOW_EXPORT_API_VERSION}, received ${String(document.apiVersion)}.`,
        fieldErrors: [
          {
            field: 'document.apiVersion',
            code: 'unsupported',
            message: `Only ${WORKFLOW_EXPORT_API_VERSION} is accepted.`,
          },
        ],
        remediation:
          'Re-export the workflow from a platform build that supports this document version.',
      });
    }
    const source = document.workflow;
    const ir: Ir = { trigger: source.trigger, nodes: source.nodes, edges: source.edges };
    const workflowId = await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const created = await tx.query<{ id: string }>(
        `INSERT INTO workflow (name, description, owner_idp_id, state, write_targets)
         VALUES ($1, $2, $3, 'disabled', $4) RETURNING id`,
        [
          `${source.name} (imported)`,
          emptyToNull(source.description),
          actorId,
          source.writeTargets.map((target) => target.entryKey),
        ],
      );
      const id = created.rows[0]?.id;
      if (id === undefined) throw internal('The imported workflow was not created.');
      await this.insertVersion(tx, id, ir, actorId);
      await this.audit.append(
        {
          action: 'workflow.imported',
          actorType: 'user',
          actorId,
          targetType: 'workflow',
          targetId: id,
          outcome: 'success',
          detail: { irHash: document.irHash },
        },
        tx,
      );
      return id;
    });
    return this.load(workflowId);
  }

  async addNode(
    workflowId: string,
    request: WorkflowNodeCreateRequest,
    actorId: string,
  ): Promise<Workflow> {
    return this.mutate(workflowId, actorId, 'workflow.node.added', (ir) => {
      const existing = ir.nodes.some((entry) => entry.id === request.node.id);
      if (existing) {
        throw new AppError({
          code: 'CONFLICT',
          status: 409,
          detail: `Node ${request.node.id} already exists.`,
        });
      }
      ir.nodes.push(request.node);
      if (request.connectFrom !== null && request.connectFrom !== undefined) {
        if (!ir.nodes.some((entry) => entry.id === request.connectFrom)) {
          throw new AppError({
            code: 'VALIDATION_FAILED',
            status: 422,
            detail: `Node ${request.connectFrom} does not exist.`,
          });
        }
        ir.edges.push({
          id: randomUUID(),
          source: request.connectFrom,
          target: request.node.id,
          mappings: [],
        });
      }
    });
  }

  async patchNode(
    workflowId: string,
    nodeId: string,
    patch: WorkflowNodePatchRequest,
    actorId: string,
  ): Promise<Workflow> {
    return this.mutate(workflowId, actorId, 'workflow.node.updated', (ir) => {
      const target = ir.nodes.find((entry) => entry.id === nodeId);
      if (target === undefined) throw nodeNotFound(nodeId);
      Object.assign(target, compact(patch));
    });
  }

  async removeNode(workflowId: string, nodeId: string, actorId: string): Promise<Workflow> {
    return this.mutate(workflowId, actorId, 'workflow.node.removed', (ir) => {
      const before = ir.nodes.length;
      ir.nodes = ir.nodes.filter((entry) => entry.id !== nodeId);
      if (ir.nodes.length === before) throw nodeNotFound(nodeId);
      // Edges that referenced the node cannot survive it: an edge to nothing is not a graph.
      ir.edges = ir.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
    });
  }

  async setMappings(
    workflowId: string,
    nodeId: string,
    mappings: FieldMapping[],
    actorId: string,
  ): Promise<Workflow> {
    return this.mutate(workflowId, actorId, 'workflow.mappings.updated', (ir) => {
      if (!ir.nodes.some((entry) => entry.id === nodeId)) throw nodeNotFound(nodeId);
      /*
       * A mapping describes what one node receives, so a node with an inbound edge files it there
       * — that is the edge `mappingsFor` reads. Only a source node, which has no inbound edge,
       * keeps them on itself. Falling back to the *outbound* edge made a source node's edit
       * overwrite the fields of the node downstream of it, silently, because both landed on the
       * same edge.
       */
      const inbound = ir.edges.find((entry) => entry.target === nodeId);
      if (inbound !== undefined) {
        inbound.mappings = mappings;
        return;
      }
      const nodeEntry = ir.nodes.find((entry) => entry.id === nodeId);
      if (nodeEntry !== undefined) nodeEntry.mappings = mappings;
    });
  }

  /**
   * FR-5.5 — the fields the node's operation accepts.
   *
   * The node does not carry an instance id, and it never needed one: the instance is resolved from
   * the entry key and the node's mode, exactly as the egress plan does at compile time. That keeps
   * the IR unchanged and means discovery answers for the product the run will actually call.
   */
  async fields(
    workflowId: string,
    nodeId: string,
    options: { refresh: boolean },
    actorId: string,
  ): Promise<NodeFields> {
    const version = await this.currentVersion(workflowId);
    const node = version.ir.nodes.find((entry) => entry.id === nodeId);
    if (node === undefined) throw nodeNotFound(nodeId);
    if (this.discovery === undefined) {
      throw internal('Field discovery is not configured in this process.');
    }
    if (node.operation === null || node.entryKey === null) {
      return {
        nodeId,
        entryKey: node.entryKey,
        operation: node.operation,
        status: 'unsupported',
        fields: [],
        fetchedAt: null,
        detail: 'Bind an operation to this node before its fields can be read.',
      };
    }

    /*
     * A node whose product is not deployed (or whose credential cannot be brokered) is the ordinary
     * state of an imported or legacy definition, and the mapper still has to open: manual entry is
     * the documented fallback. Throwing here answered `422` where the drawer expected a field list,
     * so the one screen built to explain the degradation was the screen that could not load.
     */
    let instanceId: string;
    try {
      instanceId = await this.egressInstance(node.entryKey, node.mode);
    } catch (error) {
      return {
        nodeId,
        entryKey: node.entryKey,
        operation: node.operation,
        status: 'unavailable',
        fields: [],
        fetchedAt: null,
        detail: isAppError(error)
          ? [error.detail, error.remediation].filter((part) => part !== undefined).join(' ')
          : errorMessage(error),
      };
    }
    /*
     * `snapshot` re-reads the product once the answer is older than the TTL, so an `available` row
     * that comes back from here was just produced or is still inside the window. That is why the
     * answer carries no "stale" verdict: the alternative — serving yesterday's list and marking it —
     * would make validation refuse a field the product added this morning.
     */
    const row = await this.discovery.snapshot(
      { instanceId, entryKey: node.entryKey, operation: node.operation },
      { refresh: options.refresh, actorId },
    );
    return {
      nodeId,
      entryKey: node.entryKey,
      operation: node.operation,
      status: row.status,
      fields: fieldsOf(row.fields),
      fetchedAt: row.fetched_at.toISOString(),
      detail: row.detail,
    };
  }

  /** FR-5.5 — the redacted item this node last received, resolved to its inbound source. */
  async sample(workflowId: string, nodeId: string, actorId: string): Promise<NodeSample> {
    if (this.samples === undefined) {
      throw internal('Run samples are not configured in this process.');
    }
    return this.samples.latest(workflowId, nodeId, actorId);
  }

  async setTrigger(
    workflowId: string,
    update: WorkflowTriggerUpdate,
    actorId: string,
  ): Promise<Workflow> {
    return this.mutate(workflowId, actorId, 'workflow.trigger.updated', (ir) => {
      ir.trigger = {
        type: update.type,
        label: triggerLabel(update.type),
        config: triggerConfig(update),
        timezone: update.timezone ?? null,
        ...(update.cron === undefined ? {} : { cron: update.cron }),
        ...(update.minimumIntervalMinutes === undefined
          ? {}
          : { minimumIntervalMinutes: update.minimumIntervalMinutes }),
      };
    });
  }

  /** `POST /workflows/:id/:action` - validate, activate, disable, duplicate or run now. */
  async action(
    workflowId: string,
    action: string,
    actorId: string,
    /** The caller's `Idempotency-Key`; a run started twice with one key executes once. */
    idempotencyKey?: string,
  ): Promise<
    | { kind: 'validation'; value: ReturnType<typeof validationResult> }
    | { kind: 'workflow'; value: Workflow }
    | { kind: 'run'; value: WorkflowRun }
  > {
    const workflow = await this.load(workflowId);
    const version = await this.currentVersion(workflowId);

    if (action === 'validate') {
      const pass = await this.validate(workflow, version);
      return { kind: 'validation', value: validationResult(pass) };
    }

    if (action === 'activate') {
      const { issues } = await this.validate(workflow, version);
      const blocking = issues.filter((issue) => issue.severity === 'error');
      if (blocking.length > 0) {
        /*
         * FR-5.6: activation is blocked with actionable node errors, never silently downgraded.
         * The issues travel with the refusal: a count alone would name nothing, and the operator
         * reading the response — not the screen — has to be able to act on it.
         */
        throw new AppError({
          code: 'VALIDATION_FAILED',
          status: 422,
          detail: `The workflow has ${blocking.length} blocking issue(s).`,
          fieldErrors: blocking.map((issue) => ({
            field: issue.nodeId ?? 'workflow',
            code: issue.code,
            message: issue.message,
          })),
          remediation: 'Fix the node issues reported by validate, then activate again.',
        });
      }
      /**
       * Design §10.4 puts the mint between compile and push, and that order matters in both
       * directions: a credential without an n8n workflow is an orphan row, an activated n8n
       * workflow without a credential is a live definition that fails on its first egress.
       *
       * The adapter is checked first for the same reason. A missing key is the one failure we can
       * see before writing anything, and the refusal tells the operator nothing changed.
       */
      this.n8n.assertReady();
      /**
       * Resolved first, for the reason readiness is checked first: a node whose product publishes no
       * callable endpoint cannot run, and finding that out after minting would leave a live
       * credential behind for a definition that never went live. Each node's address is the broker,
       * built from its entry key and operation — never a product host and never a URL the author
       * typed (FR-5.2).
       */
      const plan = await this.egressPlan(version.ir);
      const tokens = await this.mintEgress(workflow, plan.products, version.id);
      const credentials = await this.issueCredentials(workflow, version, plan.products, tokens);
      const document = compile(workflow, version.ir, plan.addresses, credentials);
      // The recorded id, when there is one, is what makes a re-activation an update rather than a
      // second n8n workflow; the name search only covers a definition that has never been pushed.
      const compiledId = await this.n8n.upsert(
        workflow.id,
        document,
        true,
        version.compiled_n8n_id,
      );
      /*
       * Two statements, one transaction. They used to be one parameterised string: `pool.query`
       * switches to the extended protocol whenever `values` is passed, and that protocol accepts
       * exactly one command per message — PostgreSQL rejected it with `42601`, so activation could
       * never succeed. Splitting them also lets the audit row join the same commit, which is what
       * keeps "compiled id recorded", "workflow active" and "it was recorded" from diverging.
       */
      await withTransaction(this.pool, async (tx) => {
        await this.audit.lockChain(tx);
        await tx.query(
          `UPDATE workflow_version SET compiled_n8n_id = $2, n8n_credentials = $3 WHERE id = $1`,
          [version.id, compiledId, JSON.stringify(Object.fromEntries(credentials))],
        );
        await tx.query(
          `UPDATE workflow SET state = 'active', updated_at = now(),
                  write_targets = $2 WHERE id = $1`,
          [workflowId, writeTargetsOf(version.ir)],
        );
        await this.audit.append(
          {
            action: 'workflow.activated',
            actorType: 'user',
            actorId,
            targetType: 'workflow',
            targetId: workflowId,
            outcome: 'success',
            detail: { version: version.version },
          },
          tx,
        );
      });
      /*
       * Rotation: n8n exposes create and delete but never a mutation of a credential's value, so the
       * old rows are removed only now — after the push and the commit that repointed the definition.
       * A failure here leaves an orphan in n8n's store, which is harmless; it must not be reported as
       * a failed activation, because the workflow is live and its credential is the new one.
       */
      const live = new Set(credentials.values());
      for (const credentialId of Object.values(version.n8n_credentials ?? {})) {
        if (live.has(credentialId)) continue;
        await this.n8n.removeCredential(credentialId).catch(() => undefined);
      }
      return { kind: 'workflow', value: await this.load(workflowId) };
    }

    if (action === 'disable') {
      /*
       * Ending a schedule is a safety action: it must not be refused because n8n is unreachable.
       * But the local state must not then be reported as the whole truth either — the failure is
       * captured and written into the audit row, so "disabled" here means "disabled locally, n8n
       * unreachable" rather than a claim an operator cannot check.
       */
      const deactivation = await this.n8n
        .deactivate(workflow.id, version.compiled_n8n_id)
        .then(() => undefined)
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
      await withTransaction(this.pool, async (tx) => {
        await this.audit.lockChain(tx);
        await tx.query(`UPDATE workflow SET state = 'disabled', updated_at = now() WHERE id = $1`, [
          workflowId,
        ]);
        await this.audit.append(
          {
            action: 'workflow.disabled',
            actorType: 'user',
            actorId,
            targetType: 'workflow',
            targetId: workflowId,
            outcome: deactivation === undefined ? 'success' : 'failure',
            detail:
              deactivation === undefined
                ? {}
                : { n8nDeactivationFailed: deactivation, localStateOnly: true },
          },
          tx,
        );
      });
      return { kind: 'workflow', value: await this.load(workflowId) };
    }

    if (action === 'duplicate') {
      const copy = await withTransaction(this.pool, async (tx) => {
        await this.audit.lockChain(tx);
        const created = await tx.query<{ id: string }>(
          `INSERT INTO workflow (name, description, owner_idp_id, state, write_targets)
           VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
          [`${workflow.name} (copy)`, workflow.description, actorId, writeTargetsOf(version.ir)],
        );
        const id = created.rows[0]?.id;
        if (id === undefined) throw internal('The copy was not created.');
        await this.insertVersion(tx, id, version.ir, actorId);
        return id;
      });
      return { kind: 'workflow', value: await this.load(copy) };
    }

    if (action === 'run') {
      if (workflow.state !== 'active' && workflow.state !== 'validated') {
        throw new AppError({
          code: 'STATE_CONFLICT',
          detail: `Workflow ${workflow.name} is ${workflow.state}; a run needs an active workflow.`,
          remediation: 'Activate the workflow, then run it.',
        });
      }
      /**
       * A run is an n8n execution, so both preconditions are checked **before** anything is
       * written. The previous version created the run unconditionally and answered `200` with
       * `state: "running"`, while nothing had been asked to execute: the run never finished, no
       * record moved between the products, and the one refusal that explained why — the missing
       * API key — was only ever reported by `activate`.
       */
      this.n8n.assertReady();
      if (version.compiled_n8n_id === null) {
        throw new AppError({
          code: 'STATE_CONFLICT',
          detail: `Workflow ${workflow.name} has no compiled n8n definition, so there is nothing to execute.`,
          remediation: 'Activate the workflow (which compiles and pushes it), then run it.',
        });
      }
      const run = await this.startRun(workflow, version, 'manual', actorId, null, idempotencyKey);
      return { kind: 'run', value: run };
    }

    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: `Unknown workflow action "${action}".`,
      remediation: 'Use validate, activate, disable, duplicate or run.',
    });
  }

  /** FR-5.7: replay keyed on (COALESCE(replay_of, run_id), node_id, operation) so a retry cannot duplicate. */
  async replay(runId: string, actorId: string): Promise<WorkflowRun> {
    const run = await this.runRow(runId);
    if (run.state !== 'failed') {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: `Run ${runId} is ${run.state}; only a failed run can be replayed.`,
        remediation: 'Replay exists to retry a failure, not to re-execute a success.',
      });
    }
    const workflow = await this.load(run.workflow_id);
    const version = await this.versionById(run.version_id);
    return this.startRun(workflow, version, run.trigger as WorkflowRun['trigger'], actorId, runId);
  }

  async decideApproval(
    token: string,
    decision: 'approve' | 'reject',
    actorId: string,
  ): Promise<{ runId: string; nodeId: string; state: WorkflowRun['state']; decidedAt: string }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = await this.pool.query<{
      id: string;
      run_id: string;
      node_id: string;
      state: string;
      expires_at: Date;
    }>(
      `SELECT id, run_id, node_id, state, expires_at FROM workflow_approval WHERE token_hash = $1`,
      [tokenHash],
    );
    const approval = row.rows[0];
    if (approval === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: 'The approval token is not recognised.',
        remediation: 'Use the link from the approval notification.',
      });
    }
    if (approval.state !== 'waiting_approval') {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: `This approval is already ${approval.state}.`,
        remediation: 'A token is single-use.',
      });
    }
    if (approval.expires_at.getTime() < Date.now()) {
      await this.pool.query(`UPDATE workflow_approval SET state = 'expired' WHERE id = $1`, [
        approval.id,
      ]);
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: 'The approval window has closed.',
        remediation: 'Ask the operator to re-run the workflow.',
      });
    }

    const nextState: WorkflowRun['state'] = decision === 'approve' ? 'running' : 'failed';
    const decidedAt = new Date().toISOString();
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      await tx.query(
        `UPDATE workflow_approval SET state = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
        [approval.id, decision === 'approve' ? 'approved' : 'rejected', actorId],
      );
      await tx.query(`UPDATE workflow_run_node SET state = $2 WHERE run_id = $1 AND node_id = $3`, [
        approval.run_id,
        decision === 'approve' ? 'succeeded' : 'failed',
        approval.node_id,
      ]);
      await tx.query(
        `UPDATE workflow_run SET state = $2, finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END WHERE id = $1`,
        [approval.run_id, nextState],
      );
      await this.audit.append(
        {
          action: `workflow.approval.${decision}`,
          actorType: 'user',
          actorId,
          targetType: 'workflow_run',
          targetId: approval.run_id,
          outcome: 'success',
          detail: { nodeId: approval.node_id },
        },
        tx,
      );
    });
    return { runId: approval.run_id, nodeId: approval.node_id, state: nextState, decidedAt };
  }

  // ---- validation ----------------------------------------------------------------------------

  /**
   * FR-5.6 rules, each reported per node with a remediation: reachability, unbound node, mapping
   * completeness and credential sufficiency. A warning is advice; an error blocks activation.
   *
   * The pass is **persisted on the version it checked** before it is returned. Without that, the
   * issues existed only in this response: `GET /workflows/:id` could not repeat them, so the
   * workspace had nothing to list under "activation blocked" and the list fell back to reading the
   * state (`disabled` ⇒ "valid"), which is how the screen came to offer Activate on a definition the
   * API then refused with `422`.
   */
  private async validate(workflow: Workflow, version: VersionRow): Promise<ValidationPass> {
    const issues: ValidationIssue[] = [];
    const ir = version.ir;
    const nodeIds = new Set(ir.nodes.map((entry) => entry.id));

    if (ir.nodes.length < 2) {
      issues.push(
        issue(
          null,
          'error',
          'NODE_COUNT',
          'A workflow needs at least a source and a target node.',
          'Add the missing node.',
        ),
      );
    }

    for (const entry of ir.nodes) {
      if (entry.operation === null || entry.operation === undefined) {
        issues.push(
          issue(
            entry.id,
            'error',
            'UNBOUND_NODE',
            `Node "${entry.label}" has no operation bound.`,
            'Choose an operation from the registry for this node.',
          ),
        );
      }
      if (mappingsFor(ir, entry).length === 0) {
        /*
         * A write node with no mappings compiles to `sendBody: false`, so the request reaches the
         * product with no body and is refused there — after activation succeeded. The warning has to
         * name that consequence, because the alternative is a definition that looks ready and fails
         * on its first run with the product's own validation error.
         */
        issues.push(
          issue(
            entry.id,
            'warning',
            'EMPTY_MAPPINGS',
            entry.mode === 'write'
              ? `Node "${entry.label}" maps no fields, so it posts an empty body to ${entry.entryKey ?? 'the product'}.`
              : `Node "${entry.label}" maps no fields.`,
            entry.mode === 'write'
              ? 'Map at least one field before running: a product that requires any field refuses the write, and the run fails after activation.'
              : 'Map at least one field, or confirm the product needs none.',
          ),
        );
      }
      for (const edge of ir.edges.filter((candidate) => candidate.target === entry.id)) {
        if (!nodeIds.has(edge.source)) {
          issues.push(
            issue(
              entry.id,
              'error',
              'DANGLING_EDGE',
              `Node "${entry.label}" has an edge from a deleted node.`,
              'Remove the edge or re-add the source node.',
            ),
          );
        }
      }
    }

    const reachable = reachableFrom(ir);
    for (const entry of ir.nodes) {
      if (!reachable.has(entry.id)) {
        issues.push(
          issue(
            entry.id,
            'error',
            'UNREACHABLE_NODE',
            `Node "${entry.label}" is not connected to the trigger path.`,
            'Connect it to a source node.',
          ),
        );
      }
    }

    /**
     * FR-5.9 / C-11: a write node needs a product that can issue an operation-scoped credential.
     *
     * This used to require a *row* in `credential_scope` that already existed. Only `activate`
     * mints one, so the check could never pass for a definition nobody had activated: every newly
     * authored workflow answered `CREDENTIAL_MISSING`, `Activate` stayed disabled, and activation
     * was unreachable by construction. The row is now minted by activation, and the verdict here is
     * eligibility — the same predicate the write-target picker, the broker and invariant 4 use.
     * Two causes are named separately, because they need different fixes.
     */
    for (const entry of ir.nodes.filter((candidate) => candidate.mode === 'write')) {
      const capability = await this.writeCapability(entry.entryKey);
      if (capability === 'scoped') continue;
      issues.push(
        issue(
          entry.id,
          'error',
          'CREDENTIAL_MISSING',
          capability === 'unresolved'
            ? `Node "${entry.label}" writes but no deployed product is bound to the node.`
            : `Node "${entry.label}" writes but ${entry.entryKey ?? 'its product'} cannot issue an operation-scoped credential.`,
          capability === 'unresolved'
            ? 'Bind the node to a catalog entry that publishes write operations.'
            : 'Use a read-only operation, or ask the platform administrator to record an operation-scoped credential for this product (C-11).',
        ),
      );
    }

    /**
     * FR-5.6 parity with activation: an operation the registry publishes without `path`/`method`
     * cannot be compiled, and `egressPlan` refuses it before a scope is minted. Reported only there,
     * the preflight said "activation is available" and the next click answered `422` for a fact
     * validation could have known — the operator had no way to trust either answer.
     */
    await this.checkCallableOperations(ir, issues);

    /**
     * FR-5.5: a mapping to a field the product does not publish is reported here, from the cached
     * snapshot only. No product call happens during validation — a schema read that timed out would
     * otherwise turn every validation into a slow, flaky operation.
     */
    await this.checkMappingFields(ir, issues);

    const checkedAt = new Date();
    const valid = issues.every((entry) => entry.severity !== 'error');
    await this.pool.query(
      `UPDATE workflow_version SET validated_at = $2, validation_issues = $3::jsonb WHERE id = $1`,
      [version.id, checkedAt, JSON.stringify(issues)],
    );
    // The state is a coarse projection of the same fact: `draft` becomes `validated` only on a clean
    // pass, and an active workflow is never demoted by a check (that is what `disable` is for).
    await this.pool.query(
      `UPDATE workflow SET state = CASE WHEN state = 'active' THEN state WHEN $2 THEN 'validated' ELSE state END, updated_at = now() WHERE id = $1`,
      [workflow.id, valid],
    );
    return { issues, checkedAt };
  }

  /**
   * Every operation a node asks for must have an address in the registry.
   *
   * `OperationSchema.path` and `.method` are optional on purpose: an inventory may describe an
   * operation before anyone measured its endpoint, and "discovered but not callable" is a stated
   * state rather than a guessed URL. `egressPlan` is therefore the authority that refuses such a
   * definition, and this pass asks the same question from the same rows so `validate` and `activate`
   * cannot answer differently about it.
   *
   * Nodes are grouped per entry key exactly as `egressPlan` groups them — one product resolves to one
   * instance, in `write` mode as soon as any of its nodes writes — so the two cannot disagree about
   * which instance's inventory they are reading.
   */
  private async checkCallableOperations(ir: Ir, issues: ValidationIssue[]): Promise<void> {
    const byEntry = new Map<string, { operations: string[]; mode: 'read' | 'write' }>();
    for (const entry of ir.nodes) {
      // An unbound node is `UNBOUND_NODE`; there is no operation to look up.
      if (entry.entryKey === null || entry.operation === null) continue;
      const current = byEntry.get(entry.entryKey) ?? { operations: [], mode: 'read' as const };
      if (!current.operations.includes(entry.operation)) current.operations.push(entry.operation);
      byEntry.set(entry.entryKey, {
        operations: current.operations,
        mode: current.mode === 'write' || entry.mode === 'write' ? 'write' : 'read',
      });
    }

    for (const [entryKey, product] of byEntry) {
      let published: Map<string, { path: string | null; method: string | null }>;
      try {
        published = await this.publishedOperations(
          await this.egressInstance(entryKey, product.mode),
        );
      } catch {
        /*
         * Resolving the instance is somebody else's error: `CREDENTIAL_MISSING` already names a write
         * product that cannot issue a scope, and a read product with nothing to broker is refused at
         * activation. Reporting the cause twice would bury the one the operator can act on.
         */
        continue;
      }
      for (const operation of product.operations) {
        const spec = published.get(operation);
        if (spec !== undefined && spec.path !== null && spec.method !== null) continue;
        for (const entry of ir.nodes.filter(
          (candidate) => candidate.entryKey === entryKey && candidate.operation === operation,
        )) {
          issues.push(
            issue(
              entry.id,
              'error',
              'OPERATION_NOT_CALLABLE',
              `Node "${entry.label}" cannot run: ${entryKey} "${operation}" declares no callable endpoint (path and method).`,
              'Record the endpoint in the catalog entry (integration.operationInventory), rebuild the registry, then validate again.',
            ),
          );
        }
      }
    }
  }

  /**
   * FR-5.5 — compare every mapping with the field list the product published.
   *
   * Two rules, one query:
   *  - a target the operation does not accept is an **error**, because the product would refuse the
   *    write on the first run and activation is the only place to catch it;
   *  - no usable snapshot is a **warning**, because a product that cannot describe itself (or is
   *    simply down) must not make an otherwise valid definition unactivatable. This is the scoping
   *    the ADR records: strictness applies to knowledge, never to its absence.
   */
  private async checkMappingFields(ir: Ir, issues: ValidationIssue[]): Promise<void> {
    if (this.discovery === undefined) return;
    const targets: { node: WorkflowNode; instanceId: string; operation: string }[] = [];
    for (const node of ir.nodes) {
      if (node.mode !== 'write') continue;
      if (node.entryKey === null || node.operation === null) continue;
      if (mappingsFor(ir, node).length === 0) continue;
      try {
        const instanceId = await this.egressInstance(node.entryKey, 'write');
        targets.push({ node, instanceId, operation: node.operation });
      } catch {
        // An undeployed product is already an error from the credential rule above; adding a second
        // one for the same cause would just make the issue list repeat itself.
        continue;
      }
    }
    if (targets.length === 0) return;

    const snapshots = await this.discovery.cached(
      targets.map((target) => ({ instanceId: target.instanceId, operation: target.operation })),
    );
    issues.push(...mappingFieldIssues(ir, targets, snapshots));
  }

  /**
   * Whether a write node's product can bound a write to an operation. `unresolved` and `ineligible`
   * are different answers: the first is a node bound to nothing deployed, the second a product whose
   * credential is account-wide or absent (C-11), and no retry of the same definition fixes either.
   */
  private async writeCapability(
    entryKey: string | null,
  ): Promise<'scoped' | 'ineligible' | 'unresolved'> {
    if (entryKey === null) return 'unresolved';
    const result = await this.pool.query<{ granularity: string | null }>(
      `SELECT seamnex_effective_granularity(i.id) AS granularity
         FROM instance i WHERE i.entry_key = $1`,
      [entryKey],
    );
    if (result.rows.length === 0) return 'unresolved';
    return result.rows.some((row) => row.granularity === 'scoped') ? 'scoped' : 'ineligible';
  }

  /**
   * The instance a node's product resolves to.
   *
   * The IR stores the entry key, not an instance id, and one entry can be deployed more than once.
   * The scoped instance wins and `id` breaks the tie, so two activations of the same definition
   * cannot mint against different tenants. A write needs `scoped` (C-11); a read needs any
   * credential the platform can broker, because a product with `none` has nothing to authenticate
   * with.
   */
  private async egressInstance(entryKey: string, mode: 'read' | 'write'): Promise<string> {
    const result = await this.pool.query<{ id: string; granularity: string | null }>(
      `SELECT i.id, seamnex_effective_granularity(i.id) AS granularity
         FROM instance i WHERE i.entry_key = $1 AND i.deleted_at IS NULL ORDER BY i.id`,
      [entryKey],
    );
    if (result.rows.length === 0) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `No deployed ${entryKey} instance to run this node against.`,
        remediation: 'Deploy the product, then activate again.',
      });
    }
    const usable = (granularity: string | null): boolean =>
      mode === 'write'
        ? granularity === 'scoped'
        : isWorkflowEligible(isCredentialGranularity(granularity) ? granularity : 'none');
    const chosen =
      result.rows.find((row) => row.granularity === 'scoped' && usable('scoped')) ??
      result.rows.find((row) => usable(row.granularity));
    if (chosen === undefined) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail:
          mode === 'write'
            ? `No deployed ${entryKey} instance can issue an operation-scoped credential.`
            : `No deployed ${entryKey} instance can issue a credential the platform can broker.`,
        // FR-2.14 — the workflow-mode remediation used to end with "(FR-2.14)". Remediation text
        // is rendered to operators, so the id stays here.
        remediation:
          mode === 'write'
            ? 'Deploy the product, or make the writing node read-only (C-11).'
            : 'Record a verified credential granularity for the product, or make the node read from a product that has one.',
      });
    }
    return chosen.id;
  }

  /**
   * Where every node sends its request, and which products the version touches.
   *
   * This is the compile-time half of AD-10: a node's address is the broker plus its operation, its
   * verb is the one the catalog declares, and an operation the catalog has no endpoint for is refused
   * here — before a scope is minted — rather than pushed and failed on first egress.
   */
  private async egressPlan(ir: Ir): Promise<{
    addresses: Map<string, EgressAddress>;
    products: EgressProduct[];
  }> {
    const byEntry = new Map<string, { operations: string[]; mode: 'read' | 'write' }>();
    for (const entry of ir.nodes) {
      if (entry.entryKey === null || entry.operation === null) {
        throw new AppError({
          code: 'VALIDATION_FAILED',
          status: 422,
          detail: `Node "${entry.label}" is not bound to a product operation.`,
          remediation: 'Pick a product and an operation on the canvas, then activate again.',
        });
      }
      const current = byEntry.get(entry.entryKey) ?? { operations: [], mode: 'read' as const };
      if (!current.operations.includes(entry.operation)) current.operations.push(entry.operation);
      byEntry.set(entry.entryKey, {
        operations: current.operations,
        mode: current.mode === 'write' || entry.mode === 'write' ? 'write' : 'read',
      });
    }

    const addresses = new Map<string, EgressAddress>();
    const products: EgressProduct[] = [];
    for (const [entryKey, product] of byEntry) {
      const instanceId = await this.egressInstance(entryKey, product.mode);
      const catalog = await this.publishedOperations(instanceId);
      for (const operation of product.operations) {
        const spec = catalog.get(operation);
        if (spec === undefined || spec.path === null || spec.method === null) {
          throw new AppError({
            code: 'VALIDATION_FAILED',
            status: 422,
            detail: `${entryKey} "${operation}" declares no callable endpoint (path and method).`,
            fieldErrors: [
              {
                field: 'nodes',
                code: 'OPERATION_NOT_CALLABLE',
                message: `${entryKey} "${operation}" has no path/method in the catalog inventory.`,
              },
            ],
            remediation:
              'Record the endpoint in the catalog entry (integration.operationInventory), rebuild the registry, then activate again.',
          });
        }
        for (const entry of ir.nodes.filter(
          (node) => node.entryKey === entryKey && node.operation === operation,
        )) {
          addresses.set(entry.id, {
            // `encodeURIComponent` because both segments are identifiers: an operation id with a dot
            // or a slash must not change the shape of the path the broker routes on.
            url: `${this.config.SEAMNEX_BROKER_URL.replace(/\/+$/, '')}/broker/${encodeURIComponent(entryKey)}/${encodeURIComponent(operation)}`,
            method: spec.method,
          });
        }
      }
      products.push({ entryKey, instanceId, ...product });
    }
    return { addresses, products };
  }

  /**
   * 4E.3 minting, one scope per product the version touches.
   *
   * A scope is a **set** of operations, so two nodes on the same product share one row and one token.
   * Re-activation of the same version reuses the row (the token n8n already carries); a row minted for
   * another version, or one whose mode or operations no longer match, is revoked — the broker only
   * honours a token whose `version_id` is the workflow's current version, so keeping a superseded row
   * alive would leave a credential that every egress refuses.
   */
  private async mintEgress(
    workflow: Workflow,
    products: readonly EgressProduct[],
    versionId: string,
  ): Promise<Map<string, string>> {
    const tokens = new Map<string, string>();
    for (const product of products) {
      const live = await this.liveScopes(workflow.id, product.entryKey);
      /*
       * Only a scope minted *for this version* survives. `verifyToken` accepts a token whose
       * `version_id` is null or equals `workflow.current_version_id`, so a token minted for the
       * previous version is already dead the moment the edit bumps the version — and reusing it was
       * what made every run after a mapping edit fail with `401 the broker token … belongs to a
       * version the workflow has moved past`, while the definition looked active and correct.
       */
      const keep = live.filter(
        (existing) =>
          // A null `version_id` is valid for every version — that is the broker's own reading, so it
          // must be this function's too.
          (existing.versionId === null || existing.versionId === versionId) &&
          existing.mode === product.mode &&
          sameOperations(existing.operations, product.operations),
      );
      for (const existing of live) {
        if (keep.some((kept) => kept.id === existing.id)) continue;
        await this.broker.revoke(existing.id);
      }
      const minted = await this.broker.mint({
        instanceId: product.instanceId,
        workflowId: workflow.id,
        operations: product.operations,
        mode: product.mode,
        ttlSeconds: NINETY_DAYS,
        // Version and product: a retried activation of the same version finds the same row, and a
        // new version mints its own rather than inheriting a bound that no longer holds.
        idempotencyKey: `${workflow.id}:${versionId}:${product.entryKey}:${product.mode}`,
      });
      tokens.set(product.entryKey, minted.token);
    }
    return tokens;
  }

  /**
   * The live scopes for one product, with the version that bounds each of them.
   *
   * `scopes()` answers the read model, which has no version field; retiring a superseded scope needs
   * one, so the caller gets it here rather than widening the API contract.
   */
  private async liveScopes(
    workflowId: string,
    entryKey: string,
  ): Promise<{ id: string; versionId: string | null; mode: string; operations: string[] }[]> {
    const result = await this.pool.query<{
      id: string;
      version_id: string | null;
      mode: string;
      operations: string[];
    }>(
      `SELECT s.id, s.version_id, s.mode, s.operations
         FROM credential_scope s JOIN instance i ON i.id = s.instance_id
        WHERE s.workflow_id = $1 AND i.entry_key = $2 AND s.revoked_at IS NULL`,
      [workflowId, entryKey],
    );
    return result.rows.map((row) => ({
      id: row.id,
      versionId: row.version_id ?? null,
      mode: row.mode,
      operations: row.operations,
    }));
  }

  /**
   * The n8n credential each product's nodes authenticate with.
   *
   * Created per activation because the token is the only value n8n needs and a stale one would fail
   * exactly like the missing one did. The previous ids are deleted after the push (see `activate`).
   */
  private async issueCredentials(
    workflow: Workflow,
    version: VersionRow,
    products: readonly EgressProduct[],
    tokens: ReadonlyMap<string, string>,
  ): Promise<Map<string, string>> {
    const credentials = new Map<string, string>();
    for (const product of products) {
      const token = tokens.get(product.entryKey);
      if (token === undefined) continue;
      const id = await this.n8n.createCredential(
        `seamnex ${product.entryKey} v${version.version} [${workflow.id}]`,
        token,
      );
      credentials.set(product.entryKey, id);
    }
    return credentials;
  }

  /** The operations one instance publishes, with the endpoint each of them is called at. */
  private async publishedOperations(
    instanceId: string,
  ): Promise<Map<string, { path: string | null; method: string | null }>> {
    const result = await this.pool.query<{ operations: unknown }>(
      `SELECT payload->'operations' AS operations FROM registry_snapshot WHERE instance_id = $1`,
      [instanceId],
    );
    const raw = result.rows[0]?.operations;
    const operations = new Map<string, { path: string | null; method: string | null }>();
    if (!Array.isArray(raw)) return operations;
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.id !== 'string') continue;
      operations.set(record.id, {
        path: typeof record.path === 'string' ? record.path : null,
        method: typeof record.method === 'string' ? record.method : null,
      });
    }
    return operations;
  }

  private async scopes(workflowId: string, entryKey: string | null): Promise<CredentialScope[]> {
    const result = await this.pool.query<{
      id: string;
      instance_id: string;
      entry_key: string;
      operations: string[];
      mode: string;
      issued_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT s.id, s.instance_id, i.entry_key, s.operations, s.mode, s.issued_at, s.expires_at,
              s.revoked_at
         FROM credential_scope s JOIN instance i ON i.id = s.instance_id
        WHERE s.workflow_id = $1 AND ($2::text IS NULL OR i.entry_key = $2)`,
      [workflowId, entryKey],
    );
    return result.rows.map((row) => ({
      id: row.id,
      instanceId: row.instance_id,
      // The entry key, not the filter: `load` asks for every scope with a null key, and the
      // contract requires a non-empty product on each one.
      product: row.entry_key,
      operations: row.operations,
      mode: row.mode as CredentialScope['mode'],
      issuedAt: row.issued_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null,
      brokered: true,
    }));
  }

  // ---- runs ----------------------------------------------------------------------------------

  /**
   * Creates the run and asks n8n to execute it.
   *
   * The key is the caller's `Idempotency-Key` when there is one: with a fresh random key per request
   * the unique index could never fire, so a double submit became two executions of a write
   * workflow. A replay keeps its own key so it is one execution per source run, however often it is
   * retried.
   */
  private async startRun(
    workflow: Workflow,
    version: VersionRow,
    trigger: WorkflowRun['trigger'],
    actorId: string,
    replayOf: string | null,
    idempotencyKey?: string,
  ): Promise<WorkflowRun> {
    const key = `${replayOf ?? idempotencyKey ?? randomUUID()}:${version.id}`;
    const created = await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const inserted = await tx.query<{ id: string }>(
        // `workflow_run_idempotency_unique` is a partial index, so the inference clause has to
        // repeat its predicate or Postgres answers 42P10 instead of de-duplicating a double submit.
        `INSERT INTO workflow_run (workflow_id, version_id, trigger, state, idempotency_key, replay_of)
         VALUES ($1, $2, $3, 'queued', $4, $5)
         ON CONFLICT (workflow_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [workflow.id, version.id, trigger, key, replayOf],
      );
      let id = inserted.rows[0]?.id;
      if (id === undefined) {
        const existing = await tx.query<{ id: string }>(
          `SELECT id FROM workflow_run WHERE workflow_id = $1 AND idempotency_key = $2`,
          [workflow.id, key],
        );
        id = existing.rows[0]?.id;
        if (id === undefined) throw internal('The run could not be created or found.');
        // The run this key already produced is the answer; executing it again would be the
        // duplicate the idempotency key exists to prevent.
        return { id, started: false };
      }
      for (const entry of version.ir.nodes) {
        await tx.query(
          `INSERT INTO workflow_run_node (run_id, node_id, state) VALUES ($1, $2, 'queued')
           ON CONFLICT (run_id, node_id, attempt) DO NOTHING`,
          [id, entry.id],
        );
      }
      await this.audit.append(
        {
          action: replayOf === null ? 'workflow.run.started' : 'workflow.run.replayed',
          actorType: 'user',
          actorId,
          targetType: 'workflow_run',
          targetId: id,
          outcome: 'success',
          detail: { trigger, version: version.version, replayOf },
        },
        tx,
      );
      return { id, started: true };
    });

    /**
     * A row is not an execution. A version that was never pushed has no definition for n8n to
     * run, so the run is recorded as failed with that reason instead of staying `running` for
     * ever — the failed-run queue and the replay flow both key off `failed`, and neither can act
     * on a run that is permanently in flight.
     */
    if (created.started) {
      if (version.compiled_n8n_id === null) {
        await this.failRun(
          created.id,
          'The workflow version has no compiled n8n definition; activate the workflow, then run it.',
        );
      } else {
        try {
          await this.n8n.trigger(version.compiled_n8n_id, workflow.id);
          // n8n accepted the execution: from here the run is genuinely in flight.
          await this.pool.query(`UPDATE workflow_run SET state = 'running' WHERE id = $1`, [
            created.id,
          ]);
        } catch (error) {
          await this.failRun(created.id, errorMessage(error));
        }
      }
    }
    return this.runById(created.id);
  }

  /** Terminal failure that keeps the evidence: the run row, the reason, and an audit entry. */
  private async failRun(runId: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_run SET state = 'failed', finished_at = now(), error = $2::jsonb WHERE id = $1`,
      [runId, JSON.stringify({ message })],
    );
    await this.audit
      .append({
        action: 'workflow.run.failed',
        actorType: 'system',
        actorId: 'platform',
        targetType: 'workflow_run',
        targetId: runId,
        outcome: 'failure',
        detail: { message },
      })
      .catch(() => undefined);
  }

  // ---- plumbing ------------------------------------------------------------------------------

  private async mutate(
    workflowId: string,
    actorId: string,
    action: string,
    change: (ir: Ir) => void,
  ): Promise<Workflow> {
    const current = await this.currentVersion(workflowId);
    const ir: Ir = JSON.parse(JSON.stringify(current.ir)) as Ir;
    change(ir);
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      await this.insertVersion(tx, workflowId, ir, actorId);
      await tx.query(
        `UPDATE workflow SET state = CASE WHEN state = 'active' THEN 'disabled' ELSE 'draft' END, updated_at = now() WHERE id = $1`,
        [workflowId],
      );
      await this.audit.append(
        {
          action,
          actorType: 'user',
          actorId,
          targetType: 'workflow',
          targetId: workflowId,
          outcome: 'success',
        },
        tx,
      );
    });
    return this.load(workflowId);
  }

  private async insertVersion(
    tx: { query: (text: string, values?: unknown[]) => Promise<{ rows: { id?: string }[] }> },
    workflowId: string,
    ir: Ir,
    actorId: string,
  ): Promise<void> {
    const latest = await tx.query(
      `SELECT COALESCE(max(version), 0) AS version FROM workflow_version WHERE workflow_id = $1`,
      [workflowId],
    );
    const next =
      Number((latest.rows[0] as { version?: string | number } | undefined)?.version ?? 0) + 1;
    const hash = contentHash(ir);
    const inserted = await tx.query(
      `INSERT INTO workflow_version (workflow_id, version, ir, ir_hash, created_by)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (workflow_id, ir_hash) DO NOTHING
       RETURNING id`,
      [workflowId, next, JSON.stringify(ir), hash, actorId],
    );
    const versionId =
      inserted.rows[0]?.id ??
      (
        await tx.query(`SELECT id FROM workflow_version WHERE workflow_id = $1 AND ir_hash = $2`, [
          workflowId,
          hash,
        ])
      ).rows[0]?.id;
    if (versionId !== undefined) {
      await tx.query(`UPDATE workflow SET current_version_id = $2 WHERE id = $1`, [
        workflowId,
        versionId,
      ]);
    }
  }

  private async currentVersion(workflowId: string): Promise<VersionRow> {
    const result = await this.pool.query<VersionRow>(
      `SELECT v.id, v.workflow_id, v.version, v.ir, v.ir_hash, v.compiled_n8n_id,
              v.n8n_credentials, v.validated_at, v.validation_issues
         FROM workflow w JOIN workflow_version v ON v.id = w.current_version_id
        WHERE w.id = $1`,
      [workflowId],
    );
    const row = result.rows[0];
    if (row === undefined) throw workflowNotFound(workflowId);
    return row;
  }

  private async versionById(versionId: string | null): Promise<VersionRow> {
    if (versionId === null) throw internal('The run has no version to replay.');
    const result = await this.pool.query<VersionRow>(
      `SELECT * FROM workflow_version WHERE id = $1`,
      [versionId],
    );
    const row = result.rows[0];
    if (row === undefined) throw internal(`No workflow version ${versionId}.`);
    return row;
  }

  private async runRow(runId: string): Promise<{
    id: string;
    workflow_id: string;
    version_id: string | null;
    state: string;
    trigger: string;
  }> {
    const result = await this.pool.query<{
      id: string;
      workflow_id: string;
      version_id: string | null;
      state: string;
      trigger: string;
    }>(`SELECT id, workflow_id, version_id, state, trigger FROM workflow_run WHERE id = $1`, [
      runId,
    ]);
    const row = result.rows[0];
    if (row === undefined)
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No workflow run ${runId}.`,
        remediation: 'Refresh the runs list.',
      });
    return row;
  }

  private async runById(runId: string): Promise<WorkflowRun> {
    const result = await this.pool.query<{
      id: string;
      workflow_id: string;
      workflow_name: string;
      version: number;
      trigger: WorkflowRun['trigger'];
      state: WorkflowRun['state'];
      started_at: Date;
      finished_at: Date | null;
      idempotency_key: string;
      replay_of: string | null;
      error: { message?: string } | null;
    }>(
      `SELECT r.id, r.workflow_id, w.name AS workflow_name, COALESCE(v.version, 1) AS version, r.trigger, r.state,
              r.started_at, r.finished_at, r.idempotency_key, r.replay_of, r.error
         FROM workflow_run r JOIN workflow w ON w.id = r.workflow_id
         LEFT JOIN workflow_version v ON v.id = r.version_id
        WHERE r.id = $1`,
      [runId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new AppError({ code: 'NOT_FOUND', detail: `No workflow run ${runId}.` });
    /**
     * The label the canvas shows, not the node id. `workflow.service` already reads it from the
     * version's IR; this path reported `9f1c 4a2e …`, so the run returned by `POST /run` and the
     * same run read from `GET /workflows/:id/runs` disagreed about what the nodes were called.
     */
    const nodes = await this.pool.query<{
      node_id: string;
      label: string | null;
      state: WorkflowRun['state'];
      attempt: number;
      duration_ms: number | null;
      error: { message?: string } | null;
    }>(
      `SELECT rn.node_id, n.value->>'label' AS label, rn.state, rn.attempt, rn.duration_ms, rn.error
         FROM workflow_run_node rn
         JOIN workflow_run r ON r.id = rn.run_id
         LEFT JOIN workflow_version v ON v.id = r.version_id
         LEFT JOIN LATERAL (
           SELECT value
             FROM jsonb_array_elements(COALESCE(v.ir->'nodes', '[]'::jsonb)) AS value
            WHERE value->>'id' = rn.node_id
            LIMIT 1
         ) n ON TRUE
        WHERE rn.run_id = $1
        ORDER BY rn.node_id, rn.attempt`,
      [runId],
    );
    // An unfinished run is measured to now, as the list read does: `0` reads as "finished instantly"
    // and was the answer for a run that had been going for an hour.
    const finished = row.finished_at ?? new Date();
    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      version: row.version,
      trigger: row.trigger,
      state: row.state,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      durationMs: Math.max(0, finished.getTime() - row.started_at.getTime()),
      idempotencyKey: row.idempotency_key ?? row.id,
      replayOf: row.replay_of,
      recordsProcessed: 0,
      nodes: nodes.rows.map((node) => ({
        nodeId: node.node_id,
        label: node.label ?? node.node_id,
        state: node.state,
        attempt: node.attempt,
        durationMs: node.duration_ms ?? 0,
        records: 0,
        error: node.error?.message ?? null,
      })),
      error: row.error?.message ?? null,
    };
  }

  async load(workflowId: string): Promise<Workflow> {
    const result = await this.pool.query<WorkflowRow>(
      `SELECT w.id, w.name, w.description, w.owner_idp_id, w.state, w.current_version_id,
              w.write_targets, w.created_at, w.updated_at,
              u.username AS owner_username, u.display_name AS owner_display_name
         FROM workflow w
         LEFT JOIN idp_user u ON u.idp_id = w.owner_idp_id
        WHERE w.id = $1`,
      [workflowId],
    );
    const row = result.rows[0];
    if (row === undefined) throw workflowNotFound(workflowId);
    const version = await this.currentVersion(workflowId);
    const scopes = await this.scopes(workflowId, null);
    const validation = validationOf(version);
    const lastRun = await this.pool.query<{ state: WorkflowRun['state']; started_at: Date }>(
      `SELECT state, started_at FROM workflow_run WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [workflowId],
    );
    const ir = version.ir;
    return {
      id: row.id,
      name: row.name,
      // Shared with the collection GET: an absent description stays absent instead of becoming `''`
      // or `"<name>."`, and the owner is a name rather than the opaque identity id.
      description: normaliseDescription(row.description),
      owner: {
        id: row.owner_idp_id,
        name: ownerName(row.owner_display_name, row.owner_username, row.owner_idp_id),
      },
      state: row.state,
      version: version.version,
      irHash: formatIrHash(version.ir_hash),
      trigger: ir.trigger,
      writeTargets: await this.writeTargets(row.write_targets),
      /*
       * The mappings the node actually sends, not the ones filed on the node record. `setMappings`
       * writes a non-source node's mappings to its inbound edge (that is what `mappingsFor` and
       * `compile` read), and the read model returned the raw node — so the canvas said "No field
       * mapping yet" for a node with two, and an author re-entering them would have overwritten
       * values they could not see.
       */
      nodes: ir.nodes.map((node) => ({ ...node, mappings: mappingsFor(ir, node) })),
      edges: ir.edges,
      credentialScopes: scopes,
      // The persisted pass, never a fresh check: a read must not write, and `checkedAt` has to mean
      // "when the pass ran" rather than "when this response was built".
      validation,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      lastRunAt: lastRun.rows[0]?.started_at.toISOString() ?? null,
      lastRunState: lastRun.rows[0]?.state ?? null,
      enabled: row.state === 'active',
    };
  }

  /** `workflow.write_targets` is the record; `product` comes from the catalog, not from the key. */
  private async writeTargets(entryKeys: readonly string[]): Promise<Workflow['writeTargets']> {
    if (entryKeys.length === 0) return [];
    const result = await this.pool.query<{ entry_key: string; product: string | null }>(
      `SELECT t.entry_key, c.payload->>'product' AS product
         FROM unnest($1::text[]) AS t(entry_key)
         LEFT JOIN catalog_entry c ON c.key = t.entry_key
        ORDER BY t.entry_key`,
      [entryKeys],
    );
    return result.rows.map((row) => ({
      entryKey: row.entry_key,
      product: row.product ?? row.entry_key,
      mode: 'write' as const,
    }));
  }

  /**
   * The operations a deployed product publishes, in registry order (declared read: `registry_snapshot`).
   *
   * The registry snapshot is the projection the console's palette already renders (FR-5.2), so a
   * draft binds exactly what an operator could have picked. Reading the projection directly keeps
   * this to one indexed row instead of pulling every entry through M12's contract; entries that do
   * not carry a usable id/label/mode are skipped rather than guessed at.
   */
  private async discoveredOperations(instanceId: string): Promise<DiscoveredOperation[]> {
    const result = await this.pool.query<{ operations: unknown }>(
      `SELECT payload->'operations' AS operations FROM registry_snapshot WHERE instance_id = $1`,
      [instanceId],
    );
    const raw = result.rows[0]?.operations;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry): DiscoveredOperation[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const candidate = entry as { id?: unknown; label?: unknown; mode?: unknown };
      if (typeof candidate.id !== 'string' || candidate.id.length === 0) return [];
      if (typeof candidate.label !== 'string' || candidate.label.length === 0) return [];
      if (candidate.mode !== 'read' && candidate.mode !== 'write') return [];
      return [{ id: candidate.id, label: candidate.label, mode: candidate.mode }];
    });
  }

  private async instanceLabel(
    instanceId: string,
  ): Promise<{ entryKey: string; product: string; granularity: CredentialGranularity }> {
    const result = await this.pool.query<{
      entry_key: string;
      product: string | null;
      granularity: string | null;
    }>(
      // The granularity comes from the database's resolver (migration 0017), so authoring, the broker
      // and invariant 4 answer "is this product write-eligible?" from one recorded fact.
      `SELECT i.entry_key, c.payload->>'product' AS product, seamnex_effective_granularity(i.id) AS granularity
         FROM instance i
         LEFT JOIN catalog_entry c ON c.key = i.entry_key
        WHERE i.id = $1`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No instance ${instanceId}.`,
        remediation: 'Pick a deployed product.',
      });
    }
    return {
      entryKey: row.entry_key,
      product: row.product ?? row.entry_key,
      granularity: isCredentialGranularity(row.granularity) ? row.granularity : 'none',
    };
  }
}

/**
 * The IR hash is the content address used to dedupe versions.
 *
 * `JSON.stringify(ir, Object.keys(ir).sort())` reads like key ordering but is a *replacer
 * allowlist*: it keeps only the names `trigger`, `nodes` and `edges`, at every depth, so the IR
 * serialised to `{"edges":[],"nodes":[{}],"trigger":{}}`. Two versions with the same number of
 * nodes and edges therefore hashed alike — a rename, a mapping set, a trigger change — and
 * `ON CONFLICT (workflow_id, ir_hash) DO NOTHING` discarded the edit while the request answered
 * `200` and the audit row said the change succeeded. Nothing authored through the workflow API
 * was ever persisted.
 */
export function contentHash(ir: Ir): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(ir)))
    .digest('hex');
}

/** Stable serialisation: keys sorted at every depth, array order preserved. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key])]),
  );
}

/**
 * Where one node sends its request: the broker, and the verb the catalog declares.
 *
 * A node's IR carries an entry key and an operation id, never an address and never a method
 * (FR-5.2: no URLs typed by the author), so these two values can only come from the platform's own
 * records — the registry projection and the operation inventory behind it.
 */
export type EgressAddress = {
  readonly url: string;
  readonly method: string;
};

/** IR → n8n workflow JSON. One httpRequest node per IR node, one webhook or schedule trigger. */
export function compile(
  workflow: Workflow,
  ir: Ir,
  addresses: ReadonlyMap<string, EgressAddress>,
  credentials: ReadonlyMap<string, string> = new Map(),
): Record<string, unknown> {
  const nodes = ir.nodes.map((entry) => {
    /**
     * A write node sends what its edge maps, and nothing when it maps nothing: `sendBody: true`
     * with no body posted an empty object, so the product either refused the record or created a
     * blank one. `from` stays an n8n expression — the value is read from the previous node's item,
     * never baked into the definition.
     */
    const body = mappingsFor(ir, entry);
    /**
     * One body parameter per mapping, each value a whole expression (`={{ … }}`).
     *
     * A JSON *string* in `jsonBody` did not work: n8n does not interpolate `{{ … }}` inside it, and
     * prefixing the string with `=` does not either, so the literal text was sent — EspoCRM created a
     * contact named `{{ $json.data[0].firstName }} {{ $json.data[0].lastName }}`. The key/value body
     * is the one place where n8n resolves an expression per value and encodes the object itself, so
     * quoting is its problem, not the definition's.
     */
    const bodyParameters = body.map((mapping) => ({
      name: mapping.to,
      // The path rule is shared with the console preview: a bracket path (`["first name"]`) must not
      // become `$json.["first name"]`, which n8n only rejects when it evaluates the expression.
      value: `=${mappingExpression(mapping.from)}`,
    }));
    const address = addresses.get(entry.id);
    if (address === undefined) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `Node "${entry.label}" has no address: its product publishes no callable endpoint for "${entry.operation ?? 'nothing'}".`,
        remediation:
          'Record the endpoint in the catalog entry (integration.operationInventory), rebuild the registry, then activate again.',
      });
    }
    const credentialId = entry.entryKey === null ? undefined : credentials.get(entry.entryKey);
    /*
     * The credential is a real id in n8n's store, created by activation just before this push. It
     * used to be the expression `{{ $json.credentialId }}`, which n8n cannot resolve: a credential
     * reference is read from the definition, never from the item, so every call failed before it
     * left the process.
     */
    const credentials_ =
      credentialId === undefined
        ? {}
        : {
            httpHeaderAuth: {
              id: credentialId,
              name: `seamnex ${entry.entryKey ?? 'product'} [${workflow.id}]`,
            },
          };
    return {
      name: entry.label,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [entry.x, entry.y],
      parameters: {
        method: address.method,
        url: address.url,
        /*
         * `credentials` alone is inert on an HTTP Request node: n8n only applies an attached
         * credential when the node is told which family to use. Without these two fields the request
         * went to the broker with no `Authorization` header at all, and every run failed with the
         * broker's `401 UNAUTHORIZED` — `durationMs: 0`, so the product was never called either.
         */
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        options: { timeout: 30_000 },
        sendBody: entry.mode === 'write' && bodyParameters.length > 0,
        ...(entry.mode === 'write' && bodyParameters.length > 0
          ? { specifyBody: 'keypair', bodyParameters: { parameters: bodyParameters } }
          : {}),
      },
      ...(credentialId === undefined ? {} : { credentials: credentials_ }),
    };
  });

  const triggerType =
    ir.trigger.type === 'schedule' ? 'n8n-nodes-base.scheduleTrigger' : 'n8n-nodes-base.webhook';
  const triggerNode = {
    name: 'Trigger',
    type: triggerType,
    typeVersion: triggerType.endsWith('webhook') ? 2 : 1.2,
    position: [-260, 0],
    parameters:
      ir.trigger.type === 'schedule'
        ? {
            rule: {
              interval: [{ field: 'cronExpression', expression: ir.trigger.cron ?? '0 2 * * *' }],
            },
          }
        : { path: workflow.id, httpMethod: 'POST' },
  };

  return {
    /*
     * The trailing `[<workflow id>]` is how this platform finds its own workflow again in n8n: the
     * name is the only field n8n returns on the list endpoint and preserves on update. Without it the
     * lookup could never match, so every activation created a duplicate and `deactivate` had nothing
     * to stop.
     */
    name: `${workflow.name} v${workflow.version} [${workflow.id}]`,
    nodes: [triggerNode, ...nodes],
    connections: connectionMap(ir),
    settings: { executionOrder: 'v1', timezone: ir.trigger.timezone ?? 'UTC' },
    staticData: { irHash: workflow.irHash },
  };
}

function connectionMap(ir: Ir): Record<string, unknown> {
  const connections: Record<string, { main: { node: string; type: string; index: number }[][] }> =
    {};
  for (const edge of ir.edges) {
    const source = ir.nodes.find((entry) => entry.id === edge.source);
    const target = ir.nodes.find((entry) => entry.id === edge.target);
    if (source === undefined || target === undefined) continue;
    const entry = (connections[source.label] ??= { main: [[]] });
    entry.main[0]?.push({ node: target.label, type: 'main', index: 0 });
  }

  /*
   * The trigger is never the source of an IR edge — it is not a node in the IR at all — so wiring
   * only the edges left it with no outgoing connection. n8n then starts at a node with nowhere to
   * go and reports the execution as *successful* having run nothing: the platform mirrored nothing,
   * the run stayed `running`, and no product was called while every surface said the workflow had
   * executed. Each root (a node no edge feeds) starts from the trigger.
   */
  const fed = new Set(ir.edges.map((edge) => edge.target));
  const roots = ir.nodes.filter((entry) => !fed.has(entry.id));
  if (roots.length > 0) {
    const trigger = (connections.Trigger ??= { main: [[]] });
    for (const root of roots) {
      trigger.main[0]?.push({ node: root.label, type: 'main', index: 0 });
    }
  }
  return connections;
}

function reachableFrom(ir: Ir): Set<string> {
  const reachable = new Set<string>();
  const queue = ir.nodes.slice(0, 1).map((entry) => entry.id);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || reachable.has(current)) continue;
    reachable.add(current);
    for (const edge of ir.edges.filter((candidate) => candidate.source === current)) {
      queue.push(edge.target);
    }
  }
  return reachable;
}

/** Same set of operations, whatever the order the nodes declared them in. */
function sameOperations(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((operation) => rightSet.has(operation));
}

function writeTargetsOf(ir: Ir): string[] {
  return [
    ...new Set(
      ir.nodes
        .filter((entry) => entry.mode === 'write' && entry.entryKey !== null)
        .map((entry) => entry.entryKey as string),
    ),
  ];
}

/**
 * The trigger a new draft starts with. `config` used to be the literal `'Manual trigger'` for every
 * type, so a `schedule` workflow read `{type: "schedule", cron: "0 2 * * *", config: "Manual trigger"}`
 * — three fields contradicting each other in one object.
 */
function triggerFor(type: WorkflowTrigger['type']): WorkflowTrigger {
  const cron = type === 'schedule' ? '0 2 * * *' : null;
  return {
    type,
    label: triggerLabel(type),
    config: triggerConfig({ type, ...(cron === null ? {} : { cron }) }),
    timezone: 'UTC',
    ...(cron === null ? {} : { cron }),
  };
}

function triggerLabel(type: WorkflowTrigger['type']): string {
  return type === 'schedule'
    ? 'Every day at 02:00 UTC'
    : type === 'webhook'
      ? 'On webhook delivery'
      : type === 'poll'
        ? 'On a poll interval'
        : 'Manual';
}

function triggerConfig(update: WorkflowTriggerUpdate): string {
  if (update.cron !== null && update.cron !== undefined) return `cron ${update.cron}`;
  if (update.minimumIntervalMinutes !== null && update.minimumIntervalMinutes !== undefined) {
    return `every ${update.minimumIntervalMinutes} minute(s)`;
  }
  return triggerLabel(update.type);
}

/**
 * One IR node. `kind` distinguishes the entry point (`trigger`) from what acts on its output, and
 * `product` is the product **name** the schema asks for — it used to hold the entry key, so the
 * canvas read `D2 · no operation` where it should read `D2 · Mautic`.
 *
 * Without a discovered operation the label falls back to `"<product> (read|write)"`, and the node is
 * reported by the validator as `UNBOUND_NODE` rather than being quietly bound to an invented id.
 */
function node(input: {
  instanceId: string;
  kind: 'trigger' | 'action';
  product: string;
  entryKey: string;
  mode: 'read' | 'write';
  operation: DiscoveredOperation | null;
}): WorkflowNode {
  const operation = input.operation;
  return {
    id: randomUUID(),
    kind: input.kind,
    label: operation === null ? `${input.product} (${input.mode})` : operation.label,
    product: input.product,
    entryKey: input.entryKey,
    operation: operation?.id ?? null,
    mode: input.mode,
    x: input.kind === 'trigger' ? 0 : 260,
    y: 0,
    summary:
      operation === null
        ? `${input.mode} ${input.entryKey} with no operation bound (instance ${input.instanceId})`
        : `${operation.label} — ${input.entryKey} ${input.product} (instance ${input.instanceId})`,
    mappings: [],
  };
}

/**
 * FR-5.5 — compare mappings with cached product schemas.
 *
 * Exported because the rule is the contract, not an implementation detail: "an unknown target is an
 * error only where the product actually published a schema" is the sentence the ADR defends, and a
 * test should be able to pin it without a database or an HTTP call.
 */
export function mappingFieldIssues(
  ir: Ir,
  targets: readonly { node: WorkflowNode; instanceId: string; operation: string }[],
  snapshots: ReadonlyMap<string, { status: string; fields: unknown }>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const target of targets) {
    const row = snapshots.get(snapshotKey(target.instanceId, target.operation));
    const mappings = mappingsFor(ir, target.node);
    // Nothing is sent for a node without mappings; `EMPTY_MAPPINGS` already speaks for it, and a
    // second warning about an unknown schema would be noise on every unmapped draft node.
    if (mappings.length === 0) continue;
    if (row === undefined || row.status !== 'available') {
      issues.push(
        issue(
          target.node.id,
          'warning',
          'FIELD_SCHEMA_UNAVAILABLE',
          `Node "${target.node.label}" maps fields, but ${target.node.entryKey ?? 'the product'} published no field list for "${target.operation}".`,
          'The target names are not checked against the product. Open the mapper to read the schema again, or confirm the field names in the product.',
        ),
      );
      continue;
    }
    const known = fieldsOf(row.fields);
    const accepted = new Set(known.map((field) => field.name));
    const unknown = mappings.filter((mapping) => !accepted.has(mapping.to));
    if (unknown.length === 0) continue;
    const example = known
      .slice(0, 6)
      .map((field) => field.name)
      .join(', ');
    issues.push(
      issue(
        target.node.id,
        'error',
        'UNKNOWN_TARGET_FIELD',
        `Node "${target.node.label}" maps to ${unknown
          .map((mapping) => `"${mapping.to}"`)
          .join(
            ', ',
          )}, which ${target.node.entryKey ?? 'the product'} "${target.operation}" does not accept.`,
        example.length === 0
          ? 'Choose a field the operation publishes, then validate again.'
          : `Use a field the operation publishes (${example}${known.length > 6 ? ', …' : ''}), then validate again.`,
      ),
    );
  }
  return issues;
}

/** The snapshot's `fields` column is JSONB written by our own adapters; keep only well-formed entries. */
function fieldsOf(value: unknown): FieldDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is FieldDescriptor => {
    if (typeof entry !== 'object' || entry === null) return false;
    const candidate = entry as Record<string, unknown>;
    return typeof candidate['name'] === 'string';
  });
}

function issue(
  nodeId: string | null,
  severity: 'error' | 'warning',
  code: string,
  message: string,
  remediation: string,
): ValidationIssue {
  return { id: randomUUID(), nodeId, severity, code, message, remediation };
}

/**
 * The persisted pass, in the shape `WorkflowSchema.validation` declares. `validated_at IS NULL` is
 * "nobody has checked this", which is neither valid nor invalid — the console renders it as
 * `not validated` and keeps Activate disabled.
 */
function validationOf(version: VersionRow): {
  valid: boolean;
  checkedAt: string | null;
  issues: ValidationIssue[];
} {
  if (version.validated_at === null || version.validated_at === undefined) {
    return { valid: false, checkedAt: null, issues: [] };
  }
  const issues = Array.isArray(version.validation_issues) ? version.validation_issues : [];
  return {
    valid: issues.every((entry) => entry.severity !== 'error'),
    checkedAt: version.validated_at.toISOString(),
    issues,
  };
}

function validationResult(pass: ValidationPass) {
  return {
    valid: pass.issues.every((entry) => entry.severity !== 'error'),
    checkedAt: pass.checkedAt.toISOString(),
    issues: pass.issues,
  };
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

/**
 * The column stores "no description" as `NULL`. An empty or whitespace-only string is the same
 * absence, and storing it verbatim is what broke the read path.
 */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim().length === 0 ? null : value;
}

function workflowNotFound(id: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No workflow ${id}.`,
    remediation: 'Refresh the workflow list.',
  });
}

function nodeNotFound(nodeId: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No node ${nodeId}.`,
    remediation: 'Reload the canvas; the node may have been deleted.',
  });
}

function internal(detail: string): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    detail,
    remediation: 'Retry; nothing was changed.',
  });
}

/** The sentence a failed run carries; an adapter refusal is the one an operator can act on. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
