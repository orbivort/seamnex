import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowSchema } from '@seamnex/domain';
import type {
  FieldMapping,
  WorkflowImportRequest,
  WorkflowNode,
  WorkflowNodeCreateRequest,
  WorkflowTrigger,
} from '@seamnex/domain';
import { fakeDb } from '../../../support/fakes';
import type { FakeDb, QueryCall, Route, Row } from '../../../support/fakes';
import { AppError } from '../../../../src/common/problem/app-error';
import {
  compile,
  type EgressAddress,
  contentHash,
  WorkflowAuthoringService,
} from '../../../../src/modules/m13-workflow/authoring.service';

/**
 * Authoring (4E.1/4E.2) is the write half of module M13: every edit becomes a **new version** of the
 * IR, nothing mutates the live one, and each refusal is a `AppError` with the field that caused it.
 *
 * The fake pool answers statements by shape (see `test/support/fakes.ts`), so a test can read back
 * exactly what a mutation persisted — the IR is in the `INSERT INTO workflow_version` parameters —
 * and what it refused, without a database. `withTransaction` is real: `fakeDb` supplies `connect()`,
 * so the statements a transaction issues land in the same call list as the reads.
 */

const WORKFLOW_ID = '6a7088ab-6955-47b2-88a2-797ae750f1a0';
const VERSION_ID = '0f2a5c14-4d7e-4b2a-9d61-2f7a7d1e4c11';
const NEXT_VERSION_ID = '5b1e3a92-6c4d-4f8e-9a10-7d3c2b1f0a99';
const RUN_ID = 'c7d1f0a2-3b44-4c8d-9e21-0a1b2c3d4e5f';
const APPROVAL_ID = '3f4a5b6c-7777-4d8e-9f00-000000000001';
const OWNER_ID = '871a8c71-f44d-44bc-b388-253b182fa76a';
const SOURCE_INSTANCE = '1a2b3c4d-0000-4000-8000-000000000001';
const TARGET_INSTANCE = '1a2b3c4d-0000-4000-8000-000000000002';
const NODE_READ = 'e4b0c8f6-1111-4a2b-8c3d-000000000001';
const NODE_WRITE = 'e4b0c8f6-1111-4a2b-8c3d-000000000002';
const NODE_EXTRA = 'e4b0c8f6-1111-4a2b-8c3d-000000000003';
const NODE_UNBOUND = 'e4b0c8f6-1111-4a2b-8c3d-000000000004';
const NODE_ORPHAN = 'e4b0c8f6-1111-4a2b-8c3d-000000000005';
const NODE_GHOST = 'e4b0c8f6-1111-4a2b-8c3d-0000000000ff';
const EDGE_ID = 'd1c2b3a4-2222-4f5e-8a9b-000000000001';
const ACTOR = 'idp-actor-1';
const HASH = '91d0be32184a266392a8fab1d69a30854cfeabaeac441e4428e07022825465ad';
/** The broker each node calls, and the verb the catalog declares for its operation. */
const ADDRESSES = new Map<string, EgressAddress>([
  [NODE_READ, { url: `http://broker.test/broker/D01-01/contact.read`, method: 'GET' }],
  [NODE_WRITE, { url: `http://broker.test/broker/D02-01/contact.write`, method: 'POST' }],
]);
/** One n8n credential per product, created by activation just before the push. */
const CREDENTIALS = new Map([
  ['D01-01', 'cred-mautic'],
  ['D02-01', 'cred-crm'],
]);
const LATER = new Date(Date.now() + 86_400_000);
const EARLIER = new Date(Date.now() - 86_400_000);

// ---- fixtures ---------------------------------------------------------------------------------

const MAPPING: FieldMapping = { from: 'contact.email', to: 'email', transform: null };

type IrEdge = { id: string; source: string; target: string; mappings: FieldMapping[] };

function readNode(over: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: NODE_READ,
    kind: 'trigger',
    label: 'Read contacts',
    product: 'Mautic',
    entryKey: 'D01-01',
    operation: 'contact.read',
    mode: 'read',
    x: 0,
    y: 0,
    summary: 'Read contacts — D01-01 Mautic',
    mappings: [MAPPING],
    ...over,
  };
}

function writeNode(over: Partial<WorkflowNode> = {}): WorkflowNode {
  return readNode({
    id: NODE_WRITE,
    kind: 'action',
    label: 'Create contact',
    product: 'EspoCRM',
    entryKey: 'D02-01',
    operation: 'contact.write',
    mode: 'write',
    x: 260,
    summary: 'Create contact — D02-01 EspoCRM',
    ...over,
  });
}

function scheduleTrigger(over: Partial<WorkflowTrigger> = {}): WorkflowTrigger {
  return {
    type: 'schedule',
    label: 'Every day at 02:00 UTC',
    config: 'cron 0 2 * * *',
    timezone: 'UTC',
    cron: '0 2 * * *',
    ...over,
  };
}

function edge(source: string, target: string, mappings: IrEdge['mappings'] = []): IrEdge {
  return { id: EDGE_ID, source, target, mappings };
}

/**
 * The definition every happy path starts from: two bound nodes, one live edge. A non-trigger
 * node's field mappings live on its inbound edge, which is where `setMappings` files them and
 * where validation now reads them.
 */
function healthyIr(): { trigger: WorkflowTrigger; nodes: WorkflowNode[]; edges: IrEdge[] } {
  return {
    trigger: scheduleTrigger(),
    nodes: [readNode(), writeNode({ mappings: [] })],
    edges: [edge(NODE_READ, NODE_WRITE, [MAPPING])],
  };
}

function workflowRow(over: Row = {}): Row {
  return {
    id: WORKFLOW_ID,
    name: 'Invoice export',
    description: 'Nightly export.',
    owner_idp_id: OWNER_ID,
    owner_username: 'dev-admin',
    owner_display_name: 'Dev Admin',
    state: 'draft',
    current_version_id: VERSION_ID,
    write_targets: ['D02-01'],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    ...over,
  };
}

function versionRow(over: Row = {}): Row {
  return {
    id: VERSION_ID,
    workflow_id: WORKFLOW_ID,
    version: 2,
    ir: healthyIr(),
    ir_hash: HASH,
    compiled_n8n_id: null,
    n8n_credentials: {},
    validated_at: null,
    validation_issues: null,
    ...over,
  };
}

function scopeRow(over: Row = {}): Row {
  return {
    id: '5c9b1a2d-3333-4e4f-8a8b-000000000001',
    instance_id: TARGET_INSTANCE,
    entry_key: 'D02-01',
    operations: ['contact.write'],
    mode: 'write',
    issued_at: new Date('2026-01-05T00:00:00.000Z'),
    expires_at: LATER,
    revoked_at: null,
    ...over,
  };
}

function runRecord(over: Row = {}): Row {
  return {
    id: RUN_ID,
    workflow_id: WORKFLOW_ID,
    workflow_name: 'Invoice export',
    version: 2,
    trigger: 'manual',
    state: 'running',
    started_at: new Date('2026-02-02T10:00:00.000Z'),
    finished_at: null,
    idempotency_key: 'key:2',
    replay_of: null,
    error: null,
    ...over,
  };
}

function approvalRow(over: Row = {}): Row {
  return {
    id: APPROVAL_ID,
    run_id: RUN_ID,
    node_id: NODE_WRITE,
    state: 'waiting_approval',
    expires_at: LATER,
    ...over,
  };
}

// ---- fake pool wiring -------------------------------------------------------------------------

const route = (matcher: string | RegExp, result: unknown): Route => [matcher, result];

/** The version an activation has already compiled; a run needs one to have anything to execute. */
const compiledVersion: Route = route('JOIN workflow_version v ON v.id = w.current_version_id', [
  versionRow({ compiled_n8n_id: 'n8n-workflow-1' }),
]);

function instanceLookup(_sql: string, params: readonly unknown[]): Row[] {
  if (params[0] === SOURCE_INSTANCE) {
    return [{ entry_key: 'D01-01', product: 'Mautic', granularity: 'scoped' }];
  }
  if (params[0] === TARGET_INSTANCE) {
    return [{ entry_key: 'D02-01', product: 'EspoCRM', granularity: 'scoped' }];
  }
  // The validation credential rule and activation's mint resolve an instance from an entry key.
  if (params[0] === 'D01-01') return [{ id: SOURCE_INSTANCE, granularity: 'scoped' }];
  if (params[0] === 'D02-01') return [{ id: TARGET_INSTANCE, granularity: 'scoped' }];
  return [];
}

/**
 * The scopes a workflow already holds, per entry key: a second activation of the same product finds
 * the row it minted last time and reuses its token; the write target's row is the one a changed
 * definition has to rotate.
 */
function scopeLookup(_sql: string, params: readonly unknown[]): Row[] {
  const entryKey = params[1];
  if (entryKey === null || entryKey === undefined) return [scopeRow()];
  return entryKey === 'D02-01' ? [scopeRow()] : [];
}

function operationLookup(): Row[] {
  return [
    {
      operations: [
        {
          id: 'contact.read',
          label: 'Read contacts',
          mode: 'read',
          path: '/api/v1/Contact',
          method: 'GET',
        },
        {
          id: 'contact.write',
          label: 'Create contact',
          mode: 'write',
          path: '/api/v1/Contact',
          method: 'POST',
        },
        {
          id: 'contact.update',
          label: 'Update contact',
          mode: 'write',
          path: '/api/v1/Contact',
          method: 'PATCH',
        },
      ],
    },
  ];
}

/**
 * Every statement the service can issue, in the order a narrower matcher must win over a wider one.
 * A test overrides one entry by prepending a route for the same fragment.
 */
function defaultRoutes(): Route[] {
  return [
    route('FROM instance i', instanceLookup),
    route('FROM registry_snapshot WHERE instance_id', operationLookup),
    route('INSERT INTO workflow (', [{ id: WORKFLOW_ID }]),
    route('SELECT COALESCE(max(version)', [{ version: '1' }]),
    route('INSERT INTO workflow_version (', [{ id: NEXT_VERSION_ID }]),
    route('SELECT id FROM workflow_version WHERE workflow_id', [{ id: VERSION_ID }]),
    route('UPDATE workflow SET current_version_id', []),
    route("UPDATE workflow SET state = CASE WHEN state = 'active' THEN 'disabled'", []),
    route("UPDATE workflow SET state = CASE WHEN state = 'active' THEN state", []),
    route('UPDATE workflow_version SET validated_at', []),
    route('UPDATE workflow_version SET compiled_n8n_id', []),
    route("UPDATE workflow SET state = 'active'", []),
    route("UPDATE workflow SET state = 'disabled'", []),
    route('FROM credential_scope', scopeLookup),
    route('JOIN workflow_version v ON v.id = w.current_version_id', [versionRow()]),
    route('LEFT JOIN idp_user', [workflowRow()]),
    route('SELECT state, started_at FROM workflow_run WHERE workflow_id', []),
    route('FROM unnest($1::text[])', []),
    route('INSERT INTO workflow_run (', [{ id: RUN_ID }]),
    route('SELECT id FROM workflow_run WHERE workflow_id', []),
    route('INSERT INTO workflow_run_node (', []),
    route('FROM workflow_run r JOIN workflow w', [runRecord()]),
    route('FROM workflow_run_node rn', []),
    route('SELECT id, workflow_id, version_id, state, trigger FROM workflow_run', [
      runRecord({ version_id: VERSION_ID, state: 'failed' }),
    ]),
    route('FROM workflow_approval WHERE token_hash', [approvalRow()]),
    route("UPDATE workflow_approval SET state = 'expired'", []),
    route('UPDATE workflow_approval SET state = $2', []),
    route('UPDATE workflow_run_node SET state = $2', []),
    route('UPDATE workflow_run SET state = $2', []),
    // The run lifecycle: `queued` on insert, `running` once n8n accepted it, `failed` otherwise.
    route("UPDATE workflow_run SET state = 'running'", []),
    route("UPDATE workflow_run SET state = 'failed'", []),
    route('SELECT * FROM workflow_version WHERE id', [versionRow()]),
  ];
}

function harness(overrides: Route[] = [], discovery?: unknown, samples?: unknown) {
  const db = fakeDb([...overrides, ...defaultRoutes()]);
  const audit = {
    lockChain: vi.fn(async () => undefined),
    append: vi.fn(async () => ({ seq: '1', hash: 'h' })),
  };
  const n8n = {
    assertReady: vi.fn(),
    upsert: vi.fn(async () => 'n8n-workflow-1'),
    deactivate: vi.fn(async () => undefined),
    trigger: vi.fn(async () => 'n8n-execution-1'),
    createCredential: vi.fn(async (name: string) => `cred-${name.split(' ')[1]}`),
    removeCredential: vi.fn(async () => undefined),
  };
  const broker = {
    mint: vi.fn(async (input: { operations: string[] }) => ({
      scopeId: 'scope-1',
      secretRef: 'secret-row-1',
      token: 'seamnex_token_1',
      expiresAt: LATER.toISOString(),
      mode: 'write' as const,
      operations: input.operations,
    })),
    revoke: vi.fn(async () => undefined),
  };
  const config = { SEAMNEX_BROKER_URL: 'http://broker.test' };
  const service = new WorkflowAuthoringService(
    db.pool,
    audit as never,
    config as never,
    n8n as never,
    broker as never,
    discovery as never,
    samples as never,
  );
  return { db, audit, n8n, broker, service };
}

/** The statement that persisted a version, so a test reads back exactly what the edit wrote. */
function statement(db: FakeDb, fragment: string): QueryCall | undefined {
  return db.calls.find((call) => call.sql.includes(fragment));
}

function persistedIr(
  db: FakeDb,
  at = -1,
): {
  trigger: WorkflowTrigger;
  nodes: WorkflowNode[];
  edges: IrEdge[];
} {
  const inserts = db.calls.filter((call) => call.sql.includes('INSERT INTO workflow_version ('));
  return JSON.parse(String(inserts.at(at)?.params[2])) as {
    trigger: WorkflowTrigger;
    nodes: WorkflowNode[];
    edges: IrEdge[];
  };
}

const CREATE_INPUT = {
  name: 'Invoice export',
  description: 'Nightly export.',
  triggerType: 'schedule' as const,
  sourceInstanceId: SOURCE_INSTANCE,
  targetInstanceId: TARGET_INSTANCE,
};

// ---- pure helpers -----------------------------------------------------------------------------

describe('contentHash', () => {
  it('is the content address of one definition and is stable across calls', () => {
    const first = contentHash(healthyIr());
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash(healthyIr())).toBe(first);
  });

  it('changes when the number of nodes changes', () => {
    const two = contentHash(healthyIr());
    const three = contentHash({
      ...healthyIr(),
      nodes: [readNode(), writeNode(), writeNode({ id: NODE_EXTRA })],
    });
    expect(three).not.toBe(two);
  });

  it('changes when a top-level member is absent', () => {
    const withEdges = contentHash(healthyIr());
    const withoutEdges = contentHash({ ...healthyIr(), edges: [] });
    expect(withoutEdges).not.toBe(withEdges);
  });

  /**
   * The digest is what `INSERT … ON CONFLICT (workflow_id, ir_hash)` dedupes on, so it has to
   * describe the content, not the shape: renaming a node, binding another operation or adding a
   * field mapping leaves the node and edge counts untouched. A hash that ignored those collapsed
   * every such edit onto the existing version and stored nothing.
   */
  it('changes when a node is edited without changing the shape', () => {
    const before = contentHash(healthyIr());
    expect(
      contentHash({ ...healthyIr(), nodes: [readNode(), writeNode({ label: 'Upsert' })] }),
    ).not.toBe(before);
    expect(
      contentHash({ ...healthyIr(), nodes: [readNode(), writeNode({ operation: 'x.write' })] }),
    ).not.toBe(before);
    expect(
      contentHash({
        ...healthyIr(),
        nodes: [
          readNode(),
          writeNode({
            mappings: [{ from: 'employee.firstName', to: 'firstName', transform: null }],
          }),
        ],
      }),
    ).not.toBe(before);
  });

  it('is indifferent to the key order of an equivalent definition', () => {
    const ir = healthyIr();
    const reordered = {
      edges: ir.edges,
      nodes: ir.nodes.map((node) =>
        Object.fromEntries(Object.entries(node).reverse()),
      ) as typeof ir.nodes,
      trigger: ir.trigger,
    };
    expect(contentHash(reordered)).toBe(contentHash(ir));
  });
});

describe('compile', () => {
  it('emits one httpRequest node per IR node behind a schedule trigger', async () => {
    const { service } = harness();
    const workflow = await service.load(WORKFLOW_ID);

    const document = compile(workflow, healthyIr(), ADDRESSES, CREDENTIALS);

    expect(document).toMatchObject({
      // The trailing marker is how `N8nClient.find` matches this platform's workflow again; an
      // activation without it created a second n8n workflow.
      name: `Invoice export v2 [${WORKFLOW_ID}]`,
      settings: { executionOrder: 'v1', timezone: 'UTC' },
      staticData: { irHash: `sha256:${HASH}` },
    });
    const nodes = document.nodes as Record<string, unknown>[];
    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({
      name: 'Trigger',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 2 * * *' }] } },
    });
    /*
     * Every node calls the **broker**, with the verb the catalog declares and the credential n8n
     * holds. It used to call `={{ $json.baseUrl }}/<operation>` with `{{ $json.credentialId }}`: no
     * item ever carried either field, so n8n asked for the relative `/contact.read` and failed with
     * `Invalid URL` before the request was made.
     */
    expect(nodes[1]).toMatchObject({
      name: 'Read contacts',
      typeVersion: 4.2,
      parameters: {
        method: 'GET',
        url: 'http://broker.test/broker/D01-01/contact.read',
        // The credential is only applied when the node names its family; without these the request
        // reached the broker with no Authorization header and was refused as unauthorized.
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: false,
      },
      credentials: { httpHeaderAuth: { id: 'cred-mautic' } },
    });
    expect(nodes[2]).toMatchObject({
      name: 'Create contact',
      typeVersion: 4.2,
      parameters: {
        method: 'POST',
        url: 'http://broker.test/broker/D02-01/contact.write',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'keypair',
        // FR-5.5: the mapped field is what the product receives. `from` stays an expression so the
        // value comes from the previous node's item rather than from the definition — and it is a
        // whole-value expression (`={{ … }}`), the only form n8n resolves. A `{{ … }}` inside
        // `jsonBody` was sent literally: EspoCRM stored a contact named
        // `{{ $json.data[0].firstName }} {{ $json.data[0].lastName }}`.
        bodyParameters: {
          parameters: [{ name: 'email', value: '={{ $json.contact.email }}' }],
        },
      },
      credentials: { httpHeaderAuth: { id: 'cred-crm' } },
    });
    // The trigger is not an IR node, so its edge to the entry node has to be added here. Without
    // it n8n runs an empty graph and calls that a success.
    expect(document.connections).toEqual({
      Trigger: { main: [[{ node: 'Read contacts', type: 'main', index: 0 }]] },
      'Read contacts': { main: [[{ node: 'Create contact', type: 'main', index: 0 }]] },
    });
  });

  /**
   * The sample parser emits bracket notation for keys that are not identifiers — a product may well
   * call a field `first name`. Prefixing that with `$json.` produced `$json.["first name"]`, which
   * n8n accepts at activation and rejects when it evaluates the expression, so the run failed after
   * the definition looked correct.
   */
  it('reads a bracket source path without adding a dot the expression cannot carry', async () => {
    const { service } = harness();
    const workflow = await service.load(WORKFLOW_ID);

    const document = compile(
      workflow,
      {
        trigger: scheduleTrigger(),
        nodes: [readNode(), writeNode({ mappings: [] })],
        edges: [
          edge(NODE_READ, NODE_WRITE, [
            { from: '["first name"]', to: 'firstName', transform: null },
          ]),
        ],
      },
      ADDRESSES,
      CREDENTIALS,
    );

    const write = (document.nodes as Record<string, unknown>[])[2] as {
      parameters: { bodyParameters: { parameters: { name: string; value: string }[] } };
    };
    expect(write.parameters.bodyParameters.parameters).toEqual([
      { name: 'firstName', value: '={{ $json["first name"] }}' },
    ]);
  });

  it('falls back to a webhook trigger, the default cron and UTC when the IR carries none', async () => {
    const { service } = harness();
    const workflow = await service.load(WORKFLOW_ID);
    const ir = {
      trigger: { type: 'schedule' as const, label: 'Nightly', config: 'cron', timezone: null },
      nodes: [],
      edges: [],
    };

    const document = compile(workflow, ir, ADDRESSES, CREDENTIALS);
    const [trigger] = document.nodes as Record<string, unknown>[];

    expect(trigger).toMatchObject({
      type: 'n8n-nodes-base.scheduleTrigger',
      parameters: { rule: { interval: [{ expression: '0 2 * * *' }] } },
    });
    expect(document.settings).toEqual({ executionOrder: 'v1', timezone: 'UTC' });

    const webhook = compile(
      workflow,
      {
        trigger: {
          type: 'webhook',
          label: 'On delivery',
          config: 'webhook',
          timezone: 'Europe/Berlin',
        },
        nodes: [],
        edges: [],
      },
      ADDRESSES,
      CREDENTIALS,
    );
    expect((webhook.nodes as Record<string, unknown>[])[0]).toMatchObject({
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      parameters: { path: WORKFLOW_ID, httpMethod: 'POST' },
    });
    expect(webhook.settings).toEqual({ executionOrder: 'v1', timezone: 'Europe/Berlin' });
  });

  it('refuses a node the plan has no address for, instead of emitting a relative URL', async () => {
    const { service } = harness();
    const workflow = await service.load(WORKFLOW_ID);
    const partial = new Map([...ADDRESSES].filter(([id]) => id === NODE_READ));

    // A node with no address cannot be executed: n8n answers `Invalid URL: /contact.write` and the
    // run fails after the definition is already live. `compile` states it up front.
    expect(() => compile(workflow, healthyIr(), partial, CREDENTIALS)).toThrow(AppError);
    expect(() => compile(workflow, healthyIr(), partial, CREDENTIALS)).toThrow(
      'Node "Create contact" has no address: its product publishes no callable endpoint for "contact.write".',
    );
  });

  it('skips an edge whose endpoints are gone and merges two edges out of one node', async () => {
    const { service } = harness();
    const workflow = await service.load(WORKFLOW_ID);

    const document = compile(
      workflow,
      {
        trigger: scheduleTrigger(),
        nodes: [readNode(), writeNode()],
        edges: [
          edge(NODE_READ, NODE_WRITE),
          edge(NODE_READ, NODE_WRITE),
          edge(NODE_GHOST, NODE_WRITE),
          edge(NODE_READ, NODE_GHOST),
        ],
      },
      ADDRESSES,
      CREDENTIALS,
    );

    expect(document.connections).toEqual({
      // The ghost edge cannot feed anything, so the read node is still a root the trigger starts.
      Trigger: { main: [[{ node: 'Read contacts', type: 'main', index: 0 }]] },
      'Read contacts': {
        main: [
          [
            { node: 'Create contact', type: 'main', index: 0 },
            { node: 'Create contact', type: 'main', index: 0 },
          ],
        ],
      },
    });
  });
});

// ---- field discovery ---------------------------------------------------------------------------

describe('fields', () => {
  /**
   * The one screen built to explain a degraded product is the screen that must still open. An
   * imported definition whose product was never deployed answered `422` here, so the drawer reported
   * a failed request where the field list belongs and manual entry looked broken too.
   */
  it('answers unavailable, with a reason, when the product has no deployed instance', async () => {
    const discovery = { snapshot: vi.fn() };
    const { service } = harness([route('FROM instance i', [])], discovery);

    const result = await service.fields(WORKFLOW_ID, NODE_WRITE, { refresh: false }, ACTOR);

    expect(result).toMatchObject({
      nodeId: NODE_WRITE,
      entryKey: 'D02-01',
      operation: 'contact.write',
      status: 'unavailable',
      fields: [],
      fetchedAt: null,
    });
    expect(result.detail).toContain('No deployed D02-01 instance');
    // Nothing was read from the product: the failure is the platform's own resolution, and the
    // discovery service is not asked to dial a product the platform cannot address.
    expect(discovery.snapshot).not.toHaveBeenCalled();
  });

  it('answers the snapshot for a node that is bound and deployed', async () => {
    const row = {
      instance_id: TARGET_INSTANCE,
      entry_key: 'D02-01',
      operation: 'contact.write',
      status: 'available',
      fields: [{ name: 'emailAddress', label: 'Email', type: 'string', required: true }],
      detail: null,
      fetched_at: new Date('2026-02-02T10:00:00.000Z'),
      retry_after: null,
    };
    const discovery = { snapshot: vi.fn(async () => row) };
    const { service } = harness([], discovery);

    const result = await service.fields(WORKFLOW_ID, NODE_WRITE, { refresh: false }, ACTOR);

    expect(result.status).toBe('available');
    expect(result.fields).toEqual(row.fields);
    expect(result.fetchedAt).toBe('2026-02-02T10:00:00.000Z');
    expect(discovery.snapshot).toHaveBeenCalledWith(
      { instanceId: TARGET_INSTANCE, entryKey: 'D02-01', operation: 'contact.write' },
      { refresh: false, actorId: ACTOR },
    );
  });

  it('refuses when this process has no field discovery configured', async () => {
    const { service } = harness();

    await expect(
      service.fields(WORKFLOW_ID, NODE_WRITE, { refresh: false }, ACTOR),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: expect.stringContaining('Field discovery is not configured'),
    });
  });

  it('answers 404 for a node that is not on the canvas', async () => {
    const { service } = harness([], { snapshot: vi.fn() });

    await expect(
      service.fields(WORKFLOW_ID, NODE_GHOST, { refresh: false }, ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers unsupported for a node with nothing bound, without dialling a product', async () => {
    const discovery = { snapshot: vi.fn() };
    const { service } = harness(
      [
        route('JOIN workflow_version v ON v.id = w.current_version_id', [
          versionRow({
            ir: {
              trigger: scheduleTrigger(),
              nodes: [readNode({ id: NODE_UNBOUND, entryKey: null, operation: null })],
              edges: [],
            },
          }),
        ]),
      ],
      discovery,
    );

    const result = await service.fields(WORKFLOW_ID, NODE_UNBOUND, { refresh: false }, ACTOR);

    expect(result).toMatchObject({
      nodeId: NODE_UNBOUND,
      entryKey: null,
      operation: null,
      status: 'unsupported',
      fields: [],
      fetchedAt: null,
    });
    expect(discovery.snapshot).not.toHaveBeenCalled();
  });

  it('answers the plain message when the resolution failed for a reason of its own', async () => {
    const { service } = harness(
      [
        route('FROM instance i', () => {
          throw new Error('resolver is unreachable');
        }),
      ],
      { snapshot: vi.fn() },
    );

    const result = await service.fields(WORKFLOW_ID, NODE_WRITE, { refresh: false }, ACTOR);

    expect(result).toMatchObject({ status: 'unavailable', fields: [], fetchedAt: null });
    expect(result.detail).toBe('resolver is unreachable');
  });
});

describe('sample', () => {
  it('refuses when this process has no sample store configured', async () => {
    const { service } = harness();

    await expect(service.sample(WORKFLOW_ID, NODE_WRITE, ACTOR)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: expect.stringContaining('Run samples are not configured'),
    });
  });

  it('answers through the sample store with the caller as the reader', async () => {
    const latest = vi.fn(async () => ({
      nodeId: NODE_WRITE,
      sourceNodeId: NODE_READ,
      runId: 'run-1',
      capturedAt: null,
      item: null,
      truncated: false,
    }));
    const { service } = harness([], undefined, { latest });

    await expect(service.sample(WORKFLOW_ID, NODE_WRITE, ACTOR)).resolves.toMatchObject({
      runId: 'run-1',
      sourceNodeId: NODE_READ,
    });
    expect(latest).toHaveBeenCalledWith(WORKFLOW_ID, NODE_WRITE, ACTOR);
  });
});

// ---- reads ------------------------------------------------------------------------------------

describe('load', () => {
  it('reports the stored workflow and satisfies the response contract', async () => {
    const { db, service } = harness([
      route('FROM credential_scope', []),
      route('LEFT JOIN idp_user', [workflowRow({ write_targets: [] })]),
    ]);

    const workflow = await service.load(WORKFLOW_ID);

    expect(() => WorkflowSchema.parse(workflow)).not.toThrow();
    expect(workflow).toMatchObject({
      id: WORKFLOW_ID,
      name: 'Invoice export',
      description: 'Nightly export.',
      owner: { id: OWNER_ID, name: 'Dev Admin' },
      state: 'draft',
      version: 2,
      enabled: false,
      lastRunAt: null,
      lastRunState: null,
      // Nobody has run a validation pass: not valid, and not invalid either.
      validation: { valid: false, checkedAt: null, issues: [] },
    });
    expect(workflow.irHash).toBe(`sha256:${HASH}`);
    expect(workflow.trigger.type).toBe('schedule');
    // No write targets declared is answered without a second query.
    expect(statement(db, 'FROM unnest($1::text[])')).toBeUndefined();
  });

  it('maps a recorded credential scope, including one that was revoked', async () => {
    const { service } = harness([
      route('FROM credential_scope', [
        scopeRow(),
        scopeRow({ id: '5c9b1a2d-3333-4e4f-8a8b-000000000002', revoked_at: EARLIER }),
      ]),
    ]);

    const workflow = await service.load(WORKFLOW_ID);

    expect(workflow.credentialScopes).toEqual([
      expect.objectContaining({
        id: '5c9b1a2d-3333-4e4f-8a8b-000000000001',
        instanceId: TARGET_INSTANCE,
        // The contract requires a non-empty product; `load` passes a null entry key, so the value
        // has to come from the row rather than from the filter.
        product: 'D02-01',
        operations: ['contact.write'],
        mode: 'write',
        issuedAt: '2026-01-05T00:00:00.000Z',
        expiresAt: LATER.toISOString(),
        revokedAt: null,
        brokered: true,
      }),
      expect.objectContaining({ revokedAt: EARLIER.toISOString() }),
    ]);
  });

  it('reports the recorded pass with its issues and the time it ran', async () => {
    const { service } = harness([
      route('FROM credential_scope', []),
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({
          validated_at: new Date('2026-02-01T00:00:00.000Z'),
          validation_issues: [
            {
              id: 'd4b1a2f8-6f2e-4a37-9f3f-4f6c0b7d5a11',
              nodeId: NODE_WRITE,
              severity: 'error',
              code: 'CREDENTIAL_MISSING',
              message: 'no live write credential',
              remediation: 'Request a write scope.',
            },
          ],
        }),
      ]),
    ]);

    const workflow = await service.load(WORKFLOW_ID);

    expect(workflow.validation.valid).toBe(false);
    expect(workflow.validation.checkedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(workflow.validation.issues).toHaveLength(1);
  });

  it('treats a missing validated_at column as an unvalidated version', async () => {
    const { service } = harness([
      route('FROM credential_scope', []),
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({ validated_at: undefined }),
      ]),
    ]);

    const workflow = await service.load(WORKFLOW_ID);

    expect(workflow.validation).toEqual({ valid: false, checkedAt: null, issues: [] });
  });

  it('treats a non-array issue column as no recorded issues', async () => {
    const { service } = harness([
      route('FROM credential_scope', []),
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({
          validated_at: new Date('2026-02-01T00:00:00.000Z'),
          validation_issues: { x: 1 },
        }),
      ]),
    ]);

    const workflow = await service.load(WORKFLOW_ID);

    expect(workflow.validation).toEqual({
      valid: true,
      checkedAt: '2026-02-01T00:00:00.000Z',
      issues: [],
    });
  });

  it('names the owner from the username when the mirror has no display name, and falls back to the id', async () => {
    const { service } = harness([
      route('FROM credential_scope', []),
      route('LEFT JOIN idp_user', [workflowRow({ owner_display_name: null })]),
    ]);

    expect((await service.load(WORKFLOW_ID)).owner.name).toBe('dev-admin');

    const anonymous = harness([
      route('FROM credential_scope', []),
      route('LEFT JOIN idp_user', [
        workflowRow({ owner_display_name: null, owner_username: null }),
      ]),
    ]);
    expect((await anonymous.service.load(WORKFLOW_ID)).owner.name).toBe(OWNER_ID);
  });

  it('keeps an absent description absent and normalises a legacy blank one', async () => {
    const missing = harness([
      route('FROM credential_scope', []),
      route('LEFT JOIN idp_user', [workflowRow({ description: null })]),
    ]);
    expect((await missing.service.load(WORKFLOW_ID)).description).toBeNull();

    const blank = harness([
      route('FROM credential_scope', []),
      route('LEFT JOIN idp_user', [workflowRow({ description: '   ' })]),
    ]);
    expect((await blank.service.load(WORKFLOW_ID)).description).toBeNull();
  });

  it('reports a version without a hash as sha256:none', async () => {
    const { service } = harness([
      route('FROM credential_scope', []),
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({ ir_hash: null }),
      ]),
    ]);

    expect((await service.load(WORKFLOW_ID)).irHash).toBe('sha256:none');
  });

  it('takes the product from the catalog and the entry key when the catalog row is missing', async () => {
    const { service } = harness([
      route('FROM credential_scope', []),
      route('FROM unnest($1::text[])', [
        { entry_key: 'D02-01', product: 'EspoCRM' },
        { entry_key: 'D03-01', product: null },
      ]),
      route('LEFT JOIN idp_user', [workflowRow({ write_targets: ['D02-01', 'D03-01'] })]),
    ]);

    expect((await service.load(WORKFLOW_ID)).writeTargets).toEqual([
      { entryKey: 'D02-01', product: 'EspoCRM', mode: 'write' },
      { entryKey: 'D03-01', product: 'D03-01', mode: 'write' },
    ]);
  });

  it('reports the most recent run when the workflow has run', async () => {
    const { service } = harness([
      route('FROM credential_scope', []),
      route('SELECT state, started_at FROM workflow_run WHERE workflow_id', [
        { state: 'succeeded', started_at: new Date('2026-02-03T10:00:00.000Z') },
      ]),
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
    ]);

    const workflow = await service.load(WORKFLOW_ID);

    expect(workflow.enabled).toBe(true);
    expect(workflow.lastRunAt).toBe('2026-02-03T10:00:00.000Z');
    expect(workflow.lastRunState).toBe('succeeded');
  });

  it('answers 404 for a workflow that does not exist', async () => {
    const { service } = harness([route('LEFT JOIN idp_user', [])]);

    const error = await service.load(WORKFLOW_ID).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'NOT_FOUND', detail: `No workflow ${WORKFLOW_ID}.` });
  });
});

// ---- create -----------------------------------------------------------------------------------

describe('create', () => {
  it('binds the first discovered read and write operation of each instance', async () => {
    const { db, audit, service } = harness();

    const workflow = await service.create(CREATE_INPUT, ACTOR);

    const ir = persistedIr(db);
    expect(ir.nodes.map((node) => [node.kind, node.operation, node.label])).toEqual([
      ['trigger', 'contact.read', 'Read contacts'],
      ['action', 'contact.write', 'Create contact'],
    ]);
    expect(ir.nodes.map((node) => node.product)).toEqual(['Mautic', 'EspoCRM']);
    expect(ir.nodes[1]?.summary).toBe(
      `Create contact — D02-01 EspoCRM (instance ${TARGET_INSTANCE})`,
    );
    // The nodes are wired to each other, so the draft is a graph and not two islands.
    expect(ir.edges).toEqual([
      { id: expect.any(String), source: ir.nodes[0]?.id, target: ir.nodes[1]?.id, mappings: [] },
    ]);
    expect(ir.trigger).toEqual(scheduleTrigger());

    const insert = statement(db, 'INSERT INTO workflow (');
    expect(insert?.params).toEqual(['Invoice export', 'Nightly export.', ACTOR, ['D02-01']]);
    // Version 1 of the new workflow, written in the same transaction as the row.
    expect(statement(db, 'INSERT INTO workflow_version (')?.params?.[1]).toBe(2);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.created',
        actorId: ACTOR,
        targetType: 'workflow',
        targetId: WORKFLOW_ID,
        detail: { name: 'Invoice export' },
      }),
      db.client,
    );
    expect(workflow.id).toBe(WORKFLOW_ID);
  });

  it.each([undefined, '', '   '])('stores NULL when the description is %j', async (description) => {
    const { db, service } = harness();

    // The draft's own description must be *removed*, not overwritten with `undefined`: under
    // `exactOptionalPropertyTypes` an absent key is how "no description" is expressed.
    const { description: _draftDescription, ...withoutDescription } = CREATE_INPUT;
    await service.create(
      { ...withoutDescription, ...(description === undefined ? {} : { description }) },
      ACTOR,
    );

    expect(statement(db, 'INSERT INTO workflow (')?.params?.[1]).toBeNull();
  });

  it('starts a webhook draft without a cron', async () => {
    const { db, service } = harness();

    await service.create({ ...CREATE_INPUT, triggerType: 'webhook' }, ACTOR);

    expect(persistedIr(db).trigger).toEqual({
      type: 'webhook',
      label: 'On webhook delivery',
      config: 'On webhook delivery',
      timezone: 'UTC',
    });
  });

  it.each([
    ['account', /account-wide credentials/],
    ['none', /exposes no API credential at all/],
  ])('refuses a %s write target before writing anything', async (granularity, detail) => {
    const { db, service } = harness([
      route('FROM instance i', (_sql: string, params: readonly unknown[]) => [
        params[0] === SOURCE_INSTANCE
          ? { entry_key: 'D01-01', product: 'Mautic', granularity: 'scoped' }
          : { entry_key: 'D02-01', product: 'EspoCRM', granularity },
      ]),
    ]);

    await expect(service.create(CREATE_INPUT, ACTOR)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: expect.stringMatching(detail),
      fieldErrors: [
        expect.objectContaining({ field: 'targetInstanceId', code: 'write_ineligible' }),
      ],
      remediation: 'Choose a write-eligible target, or make the node read-only.',
    });
    // Refused before anything is written: no workflow row, so no version either.
    expect(statement(db, 'INSERT INTO workflow_version (')).toBeUndefined();
  });

  it('refuses a source the platform cannot broker a credential for', async () => {
    const { service } = harness([
      route('FROM instance i', (_sql: string, params: readonly unknown[]) => [
        params[0] === SOURCE_INSTANCE
          ? { entry_key: 'D01-01', product: 'Mautic', granularity: 'none' }
          : { entry_key: 'D02-01', product: 'EspoCRM', granularity: 'scoped' },
      ]),
    ]);

    await expect(service.create(CREATE_INPUT, ACTOR)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: expect.stringContaining('Mautic cannot be a source'),
      fieldErrors: [
        expect.objectContaining({ field: 'sourceInstanceId', code: 'workflow_ineligible' }),
      ],
    });
  });

  it('answers 404 for a source instance that does not exist', async () => {
    const { service } = harness([
      route('FROM instance i', (_sql: string, params: readonly unknown[]) =>
        params[0] === TARGET_INSTANCE
          ? [{ entry_key: 'D02-01', product: 'EspoCRM', granularity: 'scoped' }]
          : [],
      ),
    ]);

    await expect(
      service.create({ ...CREATE_INPUT, sourceInstanceId: NODE_GHOST }, ACTOR),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No instance ${NODE_GHOST}.`,
      remediation: 'Pick a deployed product.',
    });
  });

  it('answers 404 for a target instance that does not exist', async () => {
    const { service } = harness([
      route('FROM instance i', (_sql: string, params: readonly unknown[]) =>
        params[0] === SOURCE_INSTANCE
          ? [{ entry_key: 'D01-01', product: 'Mautic', granularity: 'scoped' }]
          : [],
      ),
    ]);

    await expect(
      service.create({ ...CREATE_INPUT, targetInstanceId: NODE_GHOST }, ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', detail: `No instance ${NODE_GHOST}.` });
  });

  it('treats an unrecognised granularity as none, and an absent catalog row as the entry key', async () => {
    const { service } = harness([
      route('FROM instance i', (_sql: string, params: readonly unknown[]) => [
        params[0] === SOURCE_INSTANCE
          ? { entry_key: 'D01-01', product: null, granularity: 'scoped' }
          : { entry_key: 'D02-01', product: 'EspoCRM', granularity: 'per-tenant' },
      ]),
    ]);

    // `per-tenant` is not a granularity the platform knows, so it is refused as `none`.
    await expect(service.create(CREATE_INPUT, ACTOR)).rejects.toMatchObject({
      detail:
        'EspoCRM cannot be a write target: The product exposes no API credential at all, so no workflow may write to it (C-11).',
    });
  });

  it('leaves a node unbound when the registry publishes no operation of that mode', async () => {
    const { db, service } = harness([
      route('FROM registry_snapshot WHERE instance_id', [
        { operations: [{ id: 'contact.write', label: 'Create contact', mode: 'write' }] },
      ]),
    ]);

    await service.create(CREATE_INPUT, ACTOR);

    const [source, target] = persistedIr(db).nodes;
    expect(source).toMatchObject({ operation: null, label: 'Mautic (read)' });
    expect(source?.summary).toBe(
      `read D01-01 with no operation bound (instance ${SOURCE_INSTANCE})`,
    );
    expect(target).toMatchObject({ operation: 'contact.write', label: 'Create contact' });
  });

  it('treats a registry row without an operations array as nothing discovered', async () => {
    const { db, service } = harness([
      route('FROM registry_snapshot WHERE instance_id', [{ operations: { broken: true } }]),
    ]);

    await service.create(CREATE_INPUT, ACTOR);

    expect(persistedIr(db).nodes.map((node) => node.operation)).toEqual([null, null]);
  });

  it('skips registry entries that are not a usable operation', async () => {
    const { db, service } = harness([
      route('FROM registry_snapshot WHERE instance_id', [
        {
          operations: [
            'nonsense',
            null,
            { label: 'No id', mode: 'read' },
            { id: '', label: 'Empty id', mode: 'read' },
            { id: 'x', mode: 'read' },
            { id: 'y', label: '', mode: 'read' },
            { id: 'z', label: 'Bad mode', mode: 'delete' },
            { id: 'contact.read', label: 'Read contacts', mode: 'read' },
            { id: 'contact.write', label: 'Create contact', mode: 'write' },
          ],
        },
      ]),
    ]);

    await service.create(CREATE_INPUT, ACTOR);

    expect(persistedIr(db).nodes.map((node) => node.operation)).toEqual([
      'contact.read',
      'contact.write',
    ]);
  });

  it('refuses when the workflow row was not created', async () => {
    const { audit, service } = harness([route('INSERT INTO workflow (', [])]);

    await expect(service.create(CREATE_INPUT, ACTOR)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The workflow row was not created.',
      remediation: 'Retry; nothing was changed.',
    });
    expect(audit.append).not.toHaveBeenCalled();
  });
});

// ---- import -----------------------------------------------------------------------------------

function importRequest(over: Row = {}): WorkflowImportRequest {
  return {
    document: {
      apiVersion: 'seamnex.workflow/v1',
      exportedAt: '2026-02-01T00:00:00.000Z',
      irHash: `sha256:${HASH}`,
      workflow: {
        name: 'Invoice export',
        description: 'Nightly export.',
        trigger: scheduleTrigger(),
        nodes: [readNode(), writeNode()],
        edges: [edge(NODE_READ, NODE_WRITE)],
        writeTargets: [{ entryKey: 'D02-01', product: 'EspoCRM', mode: 'write' }],
        ...over,
      },
    },
  } as unknown as WorkflowImportRequest;
}

describe('importDocument', () => {
  it('refuses a document from another platform build, naming the field', async () => {
    const { db, service } = harness();
    const request = importRequest();
    (request.document as { apiVersion: string }).apiVersion = 'seamnex/v1';

    await expect(service.importDocument(request, ACTOR)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'Expected apiVersion seamnex.workflow/v1, received seamnex/v1.',
      fieldErrors: [
        {
          field: 'document.apiVersion',
          code: 'unsupported',
          message: 'Only seamnex.workflow/v1 is accepted.',
        },
      ],
    });
    expect(statement(db, 'INSERT INTO workflow (')).toBeUndefined();
  });

  it('imports as a disabled draft and records the source hash', async () => {
    const { db, audit, service } = harness();

    await service.importDocument(importRequest(), ACTOR);

    const insert = statement(db, 'INSERT INTO workflow (');
    expect(insert?.sql).toContain("'disabled'");
    expect(insert?.params).toEqual([
      'Invoice export (imported)',
      'Nightly export.',
      ACTOR,
      ['D02-01'],
    ]);
    expect(persistedIr(db).nodes.map((node) => node.id)).toEqual([NODE_READ, NODE_WRITE]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.imported',
        detail: { irHash: `sha256:${HASH}` },
      }),
      db.client,
    );
  });

  it('refuses when the imported row was not created', async () => {
    const { service } = harness([route('INSERT INTO workflow (', [])]);

    await expect(service.importDocument(importRequest(), ACTOR)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The imported workflow was not created.',
    });
  });
});

// ---- node edits -------------------------------------------------------------------------------

const newNode = (over: Partial<WorkflowNode> = {}): WorkflowNode =>
  readNode({
    id: NODE_EXTRA,
    kind: 'action',
    label: 'Enrich contact',
    operation: 'contact.enrich',
    ...over,
  });

const addRequest = (node: WorkflowNode, connectFrom?: string | null): WorkflowNodeCreateRequest =>
  connectFrom === undefined ? { node } : { node, connectFrom };

describe('addNode', () => {
  it('appends the node and connects it from the requested source', async () => {
    const { db, audit, service } = harness();

    await service.addNode(WORKFLOW_ID, addRequest(newNode(), NODE_READ), ACTOR);

    const ir = persistedIr(db);
    expect(ir.nodes).toHaveLength(3);
    expect(ir.nodes[2]).toMatchObject({ id: NODE_EXTRA, label: 'Enrich contact' });
    expect(ir.edges[1]).toMatchObject({ source: NODE_READ, target: NODE_EXTRA });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.node.added', targetId: WORKFLOW_ID }),
      db.client,
    );
  });

  it.each([null, undefined])(
    'adds the node without an edge when connectFrom is %j',
    async (connectFrom) => {
      const { db, service } = harness();

      await service.addNode(WORKFLOW_ID, addRequest(newNode(), connectFrom), ACTOR);

      expect(persistedIr(db).edges).toHaveLength(1);
    },
  );

  it('refuses a node id that is already on the canvas', async () => {
    const { db, service } = harness();

    await expect(
      service.addNode(WORKFLOW_ID, addRequest(newNode({ id: NODE_READ })), ACTOR),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      detail: `Node ${NODE_READ} already exists.`,
    });
    expect(statement(db, 'INSERT INTO workflow_version (')).toBeUndefined();
  });

  it('refuses to connect from a node that does not exist', async () => {
    const { service } = harness();

    await expect(
      service.addNode(WORKFLOW_ID, addRequest(newNode(), NODE_GHOST), ACTOR),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: `Node ${NODE_GHOST} does not exist.`,
    });
  });
});

describe('patchNode', () => {
  it('applies only the fields the patch carries', async () => {
    const { db, service } = harness();

    await service.patchNode(
      WORKFLOW_ID,
      NODE_WRITE,
      { label: 'Create sales order', x: 300, y: undefined },
      ACTOR,
    );

    // `y: undefined` is "not supplied", so the node keeps its coordinate instead of losing it.
    expect(persistedIr(db).nodes[1]).toMatchObject({
      label: 'Create sales order',
      x: 300,
      y: 0,
      operation: 'contact.write',
    });
  });

  it('answers 404 for a node that is not on the canvas', async () => {
    const { service } = harness();

    await expect(
      service.patchNode(WORKFLOW_ID, NODE_GHOST, { label: 'x' }, ACTOR),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No node ${NODE_GHOST}.`,
      remediation: 'Reload the canvas; the node may have been deleted.',
    });
  });
});

describe('removeNode', () => {
  it('removes the node and every edge that referenced it', async () => {
    const { db, service } = harness();

    await service.removeNode(WORKFLOW_ID, NODE_WRITE, ACTOR);

    const ir = persistedIr(db);
    expect(ir.nodes.map((node) => node.id)).toEqual([NODE_READ]);
    expect(ir.edges).toEqual([]);
  });

  it('answers 404 when the node was not on the canvas', async () => {
    const { db, service } = harness();

    await expect(service.removeNode(WORKFLOW_ID, NODE_GHOST, ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(statement(db, 'INSERT INTO workflow_version (')).toBeUndefined();
  });
});

describe('setMappings', () => {
  it('writes the mappings on the edge that feeds the node', async () => {
    const { db, audit, service } = harness();

    await service.setMappings(WORKFLOW_ID, NODE_WRITE, [MAPPING], ACTOR);

    expect(persistedIr(db).edges[0]?.mappings).toEqual([MAPPING]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.mappings.updated' }),
      db.client,
    );
  });

  it('keeps a source node’s mappings on the node, leaving the edge it feeds alone', async () => {
    const { db, service } = harness([
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({
          ir: {
            trigger: scheduleTrigger(),
            nodes: [readNode({ mappings: [] }), writeNode({ mappings: [] })],
            // Only the outbound edge exists, so the source node has no inbound one.
            edges: [edge(NODE_READ, NODE_WRITE)],
          },
        }),
      ]),
    ]);

    await service.setMappings(WORKFLOW_ID, NODE_READ, [MAPPING], ACTOR);

    // The edge carries what the node it *feeds* receives; the source node carries its own fields.
    // Writing the source's mappings onto that edge silently replaced the downstream node's.
    const ir = persistedIr(db);
    expect(ir.nodes.find((node) => node.id === NODE_READ)?.mappings).toEqual([MAPPING]);
    expect(ir.edges[0]?.mappings).toEqual([]);
  });

  it('writes the mappings on the node itself when it has no edge at all', async () => {
    const { db, service } = harness([
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({ ir: { trigger: scheduleTrigger(), nodes: [readNode()], edges: [] } }),
      ]),
    ]);

    await service.setMappings(WORKFLOW_ID, NODE_READ, [MAPPING], ACTOR);

    const ir = persistedIr(db);
    expect(ir.nodes[0]?.mappings).toEqual([MAPPING]);
    expect(ir.edges).toEqual([]);
  });

  it('answers 404 for a node that is not on the canvas', async () => {
    const { service } = harness();

    await expect(service.setMappings(WORKFLOW_ID, NODE_GHOST, [], ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('setTrigger', () => {
  it.each([
    ['schedule', 'Every day at 02:00 UTC'],
    ['webhook', 'On webhook delivery'],
    ['poll', 'On a poll interval'],
    ['manual', 'Manual'],
  ] as const)('labels a %s trigger with the wording the canvas reads', async (type, label) => {
    const { db, service } = harness();

    await service.setTrigger(WORKFLOW_ID, { type }, ACTOR);

    expect(persistedIr(db).trigger).toMatchObject({ type, label, timezone: null });
  });

  it('describes a cron schedule from the expression it was given', async () => {
    const { db, service } = harness();

    await service.setTrigger(
      WORKFLOW_ID,
      { type: 'schedule', cron: '0 3 * * 1-5', timezone: 'Europe/Berlin' },
      ACTOR,
    );

    expect(persistedIr(db).trigger).toEqual({
      type: 'schedule',
      label: 'Every day at 02:00 UTC',
      config: 'cron 0 3 * * 1-5',
      timezone: 'Europe/Berlin',
      cron: '0 3 * * 1-5',
    });
  });

  it('describes a poll interval in minutes', async () => {
    const { db, service } = harness();

    await service.setTrigger(WORKFLOW_ID, { type: 'poll', minimumIntervalMinutes: 5 }, ACTOR);

    expect(persistedIr(db).trigger).toEqual({
      type: 'poll',
      label: 'On a poll interval',
      config: 'every 5 minute(s)',
      timezone: null,
      minimumIntervalMinutes: 5,
    });
  });

  it('falls back to the trigger label when an explicit null means "none"', async () => {
    const { db, service } = harness();

    await service.setTrigger(
      WORKFLOW_ID,
      { type: 'manual', cron: null, minimumIntervalMinutes: null },
      ACTOR,
    );

    // An explicit null is stored as sent: the caller said "no cron", not "leave it alone".
    expect(persistedIr(db).trigger).toEqual({
      type: 'manual',
      label: 'Manual',
      config: 'Manual',
      timezone: null,
      cron: null,
      minimumIntervalMinutes: null,
    });
  });
});

describe('version bookkeeping', () => {
  it('numbers the new version after the highest one on record', async () => {
    const { db, service } = harness([route('SELECT COALESCE(max(version)', [{ version: '7' }])]);

    await service.setTrigger(WORKFLOW_ID, { type: 'manual' }, ACTOR);

    expect(statement(db, 'INSERT INTO workflow_version (')?.params?.[1]).toBe(8);
  });

  it('starts at version 1 when the workflow has no version row yet', async () => {
    const { db, service } = harness([route('SELECT COALESCE(max(version)', [])]);

    await service.setTrigger(WORKFLOW_ID, { type: 'manual' }, ACTOR);

    expect(statement(db, 'INSERT INTO workflow_version (')?.params?.[1]).toBe(1);
  });

  it('reuses the version that already holds this content instead of writing a second one', async () => {
    const { db, service } = harness([
      route('INSERT INTO workflow_version (', []),
      route('SELECT id FROM workflow_version WHERE workflow_id', [{ id: VERSION_ID }]),
    ]);

    await service.setTrigger(WORKFLOW_ID, { type: 'manual' }, ACTOR);

    expect(statement(db, 'UPDATE workflow SET current_version_id')?.params).toEqual([
      WORKFLOW_ID,
      VERSION_ID,
    ]);
  });

  it('leaves the current version alone when the row was neither written nor found', async () => {
    const { db, service } = harness([
      route('INSERT INTO workflow_version (', []),
      route('SELECT id FROM workflow_version WHERE workflow_id', []),
    ]);

    await service.setTrigger(WORKFLOW_ID, { type: 'manual' }, ACTOR);

    expect(statement(db, 'UPDATE workflow SET current_version_id')).toBeUndefined();
  });

  it('reports a workflow whose current version row is gone', async () => {
    const { service } = harness([
      route('JOIN workflow_version v ON v.id = w.current_version_id', []),
    ]);

    await expect(service.load(WORKFLOW_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No workflow ${WORKFLOW_ID}.`,
      remediation: 'Refresh the workflow list.',
    });
  });
});

// ---- the action endpoint ----------------------------------------------------------------------

type ValidationValue = {
  valid: boolean;
  checkedAt: string;
  issues: {
    code: string;
    severity: string;
    nodeId: string | null;
    message?: string;
    remediation?: string;
  }[];
};

async function validate(overrides: Route[] = []): Promise<{ value: ValidationValue; db: FakeDb }> {
  const { db, service } = harness(overrides);
  const result = await service.action(WORKFLOW_ID, 'validate', ACTOR);
  return { value: result.value as unknown as ValidationValue, db };
}

describe('action: validate', () => {
  it('records a clean pass on the version and promotes the workflow', async () => {
    const { value, db } = await validate();

    expect(value.valid).toBe(true);
    expect(value.issues).toEqual([]);
    expect(value.checkedAt).toBe(new Date(value.checkedAt).toISOString());

    const recorded = statement(db, 'UPDATE workflow_version SET validated_at');
    expect(recorded?.params?.[0]).toBe(VERSION_ID);
    expect(recorded?.params?.[1]).toBeInstanceOf(Date);
    expect(recorded?.params?.[2]).toBe('[]');
    // `valid` is what turns a draft into a validated workflow.
    expect(
      statement(db, "UPDATE workflow SET state = CASE WHEN state = 'active' THEN state")?.params,
    ).toEqual([WORKFLOW_ID, true]);
  });

  it('reports every issue the definition has, per node, with a remediation', async () => {
    const { operation: _omitted, ...unbound } = readNode({ id: NODE_UNBOUND });
    const { value } = await validate([
      // No recorded scope: irrelevant now that activation mints one.
      route('FROM credential_scope', []),
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({
          ir: {
            trigger: scheduleTrigger(),
            nodes: [
              readNode({ operation: null, mappings: [] }),
              { ...unbound, kind: 'action', mode: 'write' },
              writeNode({ id: NODE_EXTRA, entryKey: null }),
              writeNode({ id: NODE_ORPHAN }),
            ],
            edges: [
              edge(NODE_READ, NODE_WRITE),
              // The same target twice, and a cycle: both must terminate.
              edge(NODE_READ, NODE_WRITE),
              edge(NODE_READ, NODE_EXTRA),
              edge(NODE_WRITE, NODE_READ),
              // A deleted source leaves the edge behind.
              edge(NODE_GHOST, NODE_EXTRA),
            ],
          },
        }),
      ]),
    ]);

    expect(value.valid).toBe(false);
    const codes = codesOf(value.issues);
    expect(codes).toEqual(
      expect.arrayContaining([
        'UNBOUND_NODE',
        'EMPTY_MAPPINGS',
        'DANGLING_EDGE',
        'UNREACHABLE_NODE',
        'CREDENTIAL_MISSING',
      ]),
    );
    expect(countOf(codes, 'UNBOUND_NODE')).toBe(2);
    // Only the node with no entry key is credential-blocked: D02-01 is a scoped product, so its
    // scope is activation's job rather than a precondition.
    expect(countOf(codes, 'CREDENTIAL_MISSING')).toBe(1);
    // A node with an empty mapping list is advice, never a blocker.
    const empty = value.issues.find((issue) => issue.code === 'EMPTY_MAPPINGS');
    expect(empty?.severity).toBe('warning');
    expect(empty?.nodeId).toBe(NODE_READ);
  });

  it('sees the mappings setMappings filed on the inbound edge', async () => {
    // `setMappings` writes a non-trigger node's fields onto its inbound edge; validation read the
    // node's own list, so the write node warned EMPTY_MAPPINGS whatever the canvas held.
    const { value } = await validate([
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({
          ir: {
            trigger: scheduleTrigger(),
            nodes: [readNode(), writeNode({ mappings: [] })],
            edges: [
              {
                ...edge(NODE_READ, NODE_WRITE),
                mappings: [{ from: 'employee.firstName', to: 'firstName', transform: null }],
              },
            ],
          },
        }),
      ]),
    ]);

    expect(value.issues.map((entry) => entry.code)).not.toContain('EMPTY_MAPPINGS');
  });

  it('reports the mappings a node sends, not only the ones filed on the node', async () => {
    // The read model returned `ir.nodes` verbatim, so the canvas said "No field mapping yet" for a
    // node with two — the operator could not see what the workflow would send.
    const { service } = harness([
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({
          ir: {
            trigger: scheduleTrigger(),
            nodes: [readNode(), writeNode({ mappings: [] })],
            edges: [
              {
                ...edge(NODE_READ, NODE_WRITE),
                mappings: [{ from: 'employee.firstName', to: 'firstName', transform: null }],
              },
            ],
          },
        }),
      ]),
    ]);

    const loaded = await service.load(WORKFLOW_ID);

    expect(loaded.nodes.find((node) => node.id === NODE_WRITE)?.mappings).toEqual([
      { from: 'employee.firstName', to: 'firstName', transform: null },
    ]);
  });

  it('reports a workflow with a single node as unfit to run', async () => {
    const { value } = await validate([
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({ ir: { trigger: scheduleTrigger(), nodes: [readNode()], edges: [] } }),
      ]),
    ]);

    expect(value.issues).toEqual([
      expect.objectContaining({
        code: 'NODE_COUNT',
        nodeId: null,
        message: 'A workflow needs at least a source and a target node.',
      }),
    ]);
  });

  /**
   * The credential rule is eligibility, not a row that must already exist. Activation mints the
   * scope, so requiring the row here made a newly authored definition impossible to activate: the
   * row could only appear after the activation that the check was blocking.
   */
  it('accepts a write node whose product can scope a write, before any scope exists', async () => {
    const { value, db } = await validate();

    expect(value.issues).toEqual([]);
    // `load` reads the workflow's scopes once; the pass itself must not ask for them per node.
    const scopeQueries = db.calls.filter((call) => call.sql.includes('FROM credential_scope'));
    expect(scopeQueries).toHaveLength(1);
    expect(scopeQueries[0]?.params).toEqual([WORKFLOW_ID, null]);
  });

  it('reports a write node whose product cannot scope a write (C-11)', async () => {
    const { value } = await validate([
      route('FROM instance i', [{ id: TARGET_INSTANCE, granularity: 'account' }]),
    ]);

    expect(value.issues).toEqual([
      expect.objectContaining({
        code: 'CREDENTIAL_MISSING',
        nodeId: NODE_WRITE,
        severity: 'error',
        message:
          'Node "Create contact" writes but D02-01 cannot issue an operation-scoped credential.',
      }),
    ]);
  });

  it('reports a write node bound to no deployed product', async () => {
    const { value } = await validate([
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({
          ir: {
            trigger: scheduleTrigger(),
            nodes: [readNode(), writeNode({ entryKey: null })],
            edges: [edge(NODE_READ, NODE_WRITE, [MAPPING])],
          },
        }),
      ]),
    ]);

    expect(value.issues).toEqual([
      expect.objectContaining({
        code: 'CREDENTIAL_MISSING',
        nodeId: NODE_WRITE,
        severity: 'error',
        message: 'Node "Create contact" writes but no deployed product is bound to the node.',
      }),
    ]);
  });
});

describe('action: validate with field discovery', () => {
  it('warns, without blocking, when the product published no field list', async () => {
    const cached = vi.fn(async () => new Map());
    const { service } = harness([], { snapshot: vi.fn(), cached });

    const result = await service.action(WORKFLOW_ID, 'validate', ACTOR);
    const value = result.value as unknown as ValidationValue;

    expect(cached).toHaveBeenCalledWith([
      { instanceId: TARGET_INSTANCE, operation: 'contact.write' },
    ]);
    expect(value.valid).toBe(true);
    expect(value.issues).toEqual([
      expect.objectContaining({
        code: 'FIELD_SCHEMA_UNAVAILABLE',
        severity: 'warning',
        nodeId: NODE_WRITE,
      }),
    ]);
  });

  it('refuses a target field the product does not accept, naming the field and an alternative', async () => {
    const snapshots = new Map([
      [
        `${TARGET_INSTANCE}|contact.write`,
        {
          status: 'available',
          fields: [{ name: 'firstName', label: 'First name', type: 'string', required: false }],
        },
      ],
    ]);
    const { service } = harness([], { snapshot: vi.fn(), cached: vi.fn(async () => snapshots) });

    const result = await service.action(WORKFLOW_ID, 'validate', ACTOR);
    const value = result.value as unknown as ValidationValue;

    expect(value.valid).toBe(false);
    const issue = value.issues.find((entry) => entry.code === 'UNKNOWN_TARGET_FIELD');
    expect(issue).toMatchObject({ severity: 'error', nodeId: NODE_WRITE });
    expect(issue?.message).toContain('"email"');
    expect(issue?.remediation).toContain('firstName');
  });

  it('advises without an example when the product published an empty field list', async () => {
    const snapshots = new Map([
      [`${TARGET_INSTANCE}|contact.write`, { status: 'available', fields: [] }],
    ]);
    const { service } = harness([], { snapshot: vi.fn(), cached: vi.fn(async () => snapshots) });

    const result = await service.action(WORKFLOW_ID, 'validate', ACTOR);
    const value = result.value as unknown as ValidationValue;

    const issue = value.issues.find((entry) => entry.code === 'UNKNOWN_TARGET_FIELD');
    expect(issue?.remediation).toBe('Choose a field the operation publishes, then validate again.');
  });

  it('does not ask for snapshots when no write node is mapped or deployed', async () => {
    const cached = vi.fn(async () => new Map());
    const { service } = harness([route('FROM instance i', [])], {
      snapshot: vi.fn(),
      cached,
    });

    const result = await service.action(WORKFLOW_ID, 'validate', ACTOR);
    const value = result.value as unknown as ValidationValue;

    expect(cached).not.toHaveBeenCalled();
    expect(value.valid).toBe(false);
  });
});

describe('action: activate', () => {
  it('mints the write scope, then compiles, activates and audits', async () => {
    const { db, audit, n8n, broker, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'validated' })]),
    ]);

    const result = await service.action(WORKFLOW_ID, 'activate', ACTOR);

    expect(result.kind).toBe('workflow');
    // One scope per product, each carrying the operations that product's nodes declare.
    expect(broker.mint).toHaveBeenCalledWith({
      instanceId: SOURCE_INSTANCE,
      workflowId: WORKFLOW_ID,
      operations: ['contact.read'],
      mode: 'read',
      ttlSeconds: 90 * 24 * 60 * 60,
      idempotencyKey: `${WORKFLOW_ID}:${VERSION_ID}:D01-01:read`,
    });
    expect(broker.mint).toHaveBeenCalledWith({
      instanceId: TARGET_INSTANCE,
      workflowId: WORKFLOW_ID,
      operations: ['contact.write'],
      mode: 'write',
      ttlSeconds: 90 * 24 * 60 * 60,
      idempotencyKey: `${WORKFLOW_ID}:${VERSION_ID}:D02-01:write`,
    });
    /*
     * A live scope that still matches this version is **reused**, not rotated: the token n8n already
     * carries maps to it, and revoking would invalidate the credential of a workflow that is still
     * pointing at it. The broker's idempotency key is what makes the retry find the same row.
     */
    expect(broker.revoke).not.toHaveBeenCalled();
    // The adapter is checked, then the scope is minted, then n8n is pushed: a failure at each step
    // leaves nothing behind that the next one would have to undo.
    expect(n8n.assertReady.mock.invocationCallOrder[0]).toBeLessThan(
      broker.mint.mock.invocationCallOrder[0] ?? 0,
    );
    expect(broker.mint.mock.invocationCallOrder[0]).toBeLessThan(
      n8n.upsert.mock.invocationCallOrder[0] ?? 0,
    );
    expect(n8n.upsert).toHaveBeenCalledWith(
      WORKFLOW_ID,
      expect.objectContaining({ name: `Invoice export v2 [${WORKFLOW_ID}]` }),
      true,
      // No compiled id has been recorded for this version yet.
      null,
    );
    // Each node is pushed at the **broker**, carrying the credential activation just created: this is
    // what n8n executes, and the reason a manual run no longer dies on `Invalid URL` or a missing
    // credential.
    expect(n8n.upsert).toHaveBeenCalledWith(
      WORKFLOW_ID,
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            name: 'Read contacts',
            parameters: expect.objectContaining({
              url: 'http://broker.test/broker/D01-01/contact.read',
              method: 'GET',
            }),
            credentials: { httpHeaderAuth: expect.objectContaining({ id: 'cred-D01-01' }) },
          }),
          expect.objectContaining({
            name: 'Create contact',
            parameters: expect.objectContaining({
              url: 'http://broker.test/broker/D02-01/contact.write',
              method: 'POST',
            }),
            credentials: { httpHeaderAuth: expect.objectContaining({ id: 'cred-D02-01' }) },
          }),
        ]),
      }),
      true,
      null,
    );
    expect(statement(db, 'UPDATE workflow_version SET compiled_n8n_id')?.params).toEqual([
      VERSION_ID,
      'n8n-workflow-1',
      JSON.stringify({ 'D01-01': 'cred-D01-01', 'D02-01': 'cred-D02-01' }),
    ]);
    expect(statement(db, "UPDATE workflow SET state = 'active'")?.params).toEqual([
      WORKFLOW_ID,
      ['D02-01'],
    ]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.activated',
        detail: { version: 2 },
        targetId: WORKFLOW_ID,
      }),
      db.client,
    );
  });

  it('mints for the new version and retires the scope the previous version held', async () => {
    /*
     * Regression. Re-activation reused the scope of the previous version (the idempotency key carried
     * no version), and `verifyToken` only honours a token whose `version_id` is the workflow's current
     * version — so the first run after any edit failed every node with `401 the broker token … belongs
     * to a version the workflow has moved past`, while the definition showed as active and correct.
     */
    const { broker, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'validated' })]),
      // Two readers of the same table: the read model, and `mintEgress` asking which version bounds
      // each live row. The version-aware query is the one that selects `version_id`.
      route('FROM credential_scope', (sql: string) =>
        sql.includes('version_id')
          ? [
              {
                id: '9d1f0c55-1111-4c2a-9a2a-000000000009',
                version_id: NEXT_VERSION_ID,
                mode: 'read',
                operations: ['contact.read'],
              },
            ]
          : [scopeRow()],
      ),
    ]);

    await service.action(WORKFLOW_ID, 'activate', ACTOR);

    expect(broker.revoke).toHaveBeenCalledWith('9d1f0c55-1111-4c2a-9a2a-000000000009');
    expect(broker.mint).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `${WORKFLOW_ID}:${VERSION_ID}:D01-01:read` }),
    );
  });

  it('refuses before minting when the n8n adapter is not configured', async () => {
    const { n8n, broker, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'validated' })]),
    ]);
    n8n.assertReady.mockImplementationOnce(() => {
      throw Object.assign(new Error('No n8n API key is configured.'), {
        code: 'ADAPTER_UNAVAILABLE',
        status: 503,
      });
    });

    await expect(service.action(WORKFLOW_ID, 'activate', ACTOR)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      status: 503,
    });
    // The refusal claims nothing changed, so no scope may be left behind for a workflow that
    // never went live.
    expect(broker.mint).not.toHaveBeenCalled();
    expect(n8n.upsert).not.toHaveBeenCalled();
  });

  it('refuses before minting when an operation has no callable endpoint', async () => {
    const { n8n, broker, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'validated' })]),
      // The write target's product publishes the operation without a path and method.
      route('FROM registry_snapshot WHERE instance_id', [
        {
          operations: [
            { id: 'contact.read', label: 'Read contacts', mode: 'read', path: '/x', method: 'GET' },
            { id: 'contact.write', label: 'Create contact', mode: 'write' },
          ],
        },
      ]),
    ]);

    await expect(service.action(WORKFLOW_ID, 'activate', ACTOR)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'The workflow has 1 blocking issue(s).',
      // The validator owns the wording now, so the refusal has to carry it: a count names nothing.
      fieldErrors: [
        {
          field: NODE_WRITE,
          code: 'OPERATION_NOT_CALLABLE',
          message: expect.stringContaining('D02-01 "contact.write"'),
        },
      ],
    });
    // The plan is resolved first, so an uncallable operation costs neither a scope nor a push.
    expect(broker.mint).not.toHaveBeenCalled();
    expect(n8n.createCredential).not.toHaveBeenCalled();
    expect(n8n.upsert).not.toHaveBeenCalled();
  });

  it('reports an uncallable operation in validation, so the preflight and activation agree', async () => {
    // Without this the screen answered "activation is available" from `validate` and `422` from
    // `activate`, both from the same rows: the operator could not trust either answer.
    const { service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'validated' })]),
      route('FROM registry_snapshot WHERE instance_id', [
        {
          operations: [
            { id: 'contact.read', label: 'Read contacts', mode: 'read', path: '/x', method: 'GET' },
            { id: 'contact.write', label: 'Create contact', mode: 'write' },
          ],
        },
      ]),
    ]);

    const pass = await service.action(WORKFLOW_ID, 'validate', ACTOR);
    const value = pass.value as unknown as ValidationValue;

    expect(value.valid).toBe(false);
    expect(value.issues).toEqual([
      expect.objectContaining({
        code: 'OPERATION_NOT_CALLABLE',
        severity: 'error',
        nodeId: NODE_WRITE,
        message: expect.stringContaining('D02-01 "contact.write"'),
      }),
    ]);
  });

  it('mints one scope carrying every operation of a shared write target', async () => {
    const { broker, n8n, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'validated' })]),
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({
          ir: {
            trigger: scheduleTrigger(),
            nodes: [
              readNode(),
              writeNode(),
              writeNode({ id: NODE_EXTRA, operation: 'contact.update' }),
            ],
            edges: [edge(NODE_READ, NODE_WRITE), edge(NODE_READ, NODE_EXTRA)],
          },
        }),
      ]),
    ]);

    await service.action(WORKFLOW_ID, 'activate', ACTOR);

    // A scope is a set of operations, so one row (and one n8n credential) covers both nodes.
    expect(broker.mint).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: TARGET_INSTANCE,
        operations: ['contact.write', 'contact.update'],
        mode: 'write',
      }),
    );
    // One per product: the read source and the write target.
    expect(broker.mint).toHaveBeenCalledTimes(2);
    expect(n8n.createCredential).toHaveBeenCalledTimes(2);
  });

  it('refuses to activate a definition with blocking issues, naming how many', async () => {
    const { n8n, broker, service } = harness([
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({ ir: { trigger: scheduleTrigger(), nodes: [readNode()], edges: [] } }),
      ]),
    ]);

    await expect(service.action(WORKFLOW_ID, 'activate', ACTOR)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'The workflow has 1 blocking issue(s).',
      remediation: 'Fix the node issues reported by validate, then activate again.',
    });
    expect(n8n.upsert).not.toHaveBeenCalled();
    // Nothing is minted for a definition that never became live.
    expect(broker.mint).not.toHaveBeenCalled();
  });
});

describe('action: activate credential rotation', () => {
  it('removes only the credentials a superseded version minted', async () => {
    const { n8n, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'validated' })]),
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({
          n8n_credentials: { 'D01-01': 'cred-stale', 'D02-01': 'cred-D02-01' },
        }),
      ]),
    ]);
    // A failed delete leaves an orphan in n8n's store; the activation is already live and must not
    // be reported as failed because of it.
    n8n.removeCredential.mockRejectedValueOnce(new Error('n8n is gone'));

    await expect(service.action(WORKFLOW_ID, 'activate', ACTOR)).resolves.toMatchObject({
      kind: 'workflow',
    });

    expect(n8n.removeCredential).toHaveBeenCalledOnce();
    expect(n8n.removeCredential).toHaveBeenCalledWith('cred-stale');
  });
});

describe('action: disable', () => {
  it('disables locally and records success when n8n accepts', async () => {
    const { db, audit, n8n, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
    ]);

    await service.action(WORKFLOW_ID, 'disable', ACTOR);

    // The recorded id is handed over so the deactivation does not depend on a name search that may
    // miss; `null` here because this fixture has never been compiled.
    expect(n8n.deactivate).toHaveBeenCalledWith(WORKFLOW_ID, null);
    expect(statement(db, "UPDATE workflow SET state = 'disabled'")?.params).toEqual([WORKFLOW_ID]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.disabled', outcome: 'success', detail: {} }),
      db.client,
    );
  });

  it('still disables locally when n8n is unreachable, and says so in the audit row', async () => {
    const { db, audit, n8n, service } = harness();

    n8n.deactivate.mockRejectedValueOnce(new Error('n8n unreachable'));

    const result = await service.action(WORKFLOW_ID, 'disable', ACTOR);

    expect(result.kind).toBe('workflow');
    expect(statement(db, "UPDATE workflow SET state = 'disabled'")).toBeDefined();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.disabled',
        outcome: 'failure',
        detail: { n8nDeactivationFailed: 'n8n unreachable', localStateOnly: true },
      }),
      db.client,
    );
  });

  it('captures a rejection that is not an Error as its string form', async () => {
    const { audit, n8n, service } = harness();

    n8n.deactivate.mockRejectedValueOnce('gateway down');

    await service.action(WORKFLOW_ID, 'disable', ACTOR);

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { n8nDeactivationFailed: 'gateway down', localStateOnly: true },
      }),
      expect.anything(),
    );
  });
});

describe('action: duplicate', () => {
  it('copies the current IR into a draft and collects its write targets', async () => {
    const { db, service } = harness([
      route('JOIN workflow_version v ON v.id = w.current_version_id', [
        versionRow({
          ir: {
            trigger: scheduleTrigger(),
            nodes: [
              readNode(),
              writeNode(),
              writeNode({ id: NODE_EXTRA }),
              writeNode({ id: NODE_UNBOUND, entryKey: null }),
            ],
            edges: [edge(NODE_READ, NODE_WRITE)],
          },
        }),
      ]),
    ]);

    await service.action(WORKFLOW_ID, 'duplicate', ACTOR);

    expect(statement(db, 'INSERT INTO workflow (')?.params).toEqual([
      'Invoice export (copy)',
      'Nightly export.',
      ACTOR,
      // Two nodes write to D2 and one has no entry key: one target, deduplicated.
      ['D02-01'],
    ]);
    expect(persistedIr(db).nodes).toHaveLength(4);
  });

  it('refuses when the copy was not created', async () => {
    const { service } = harness([route('INSERT INTO workflow (', [])]);

    await expect(service.action(WORKFLOW_ID, 'duplicate', ACTOR)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The copy was not created.',
    });
  });
});

describe('action: run', () => {
  it('starts a manual run of an active workflow', async () => {
    const { db, audit, n8n, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
      compiledVersion,
    ]);

    const result = await service.action(WORKFLOW_ID, 'run', ACTOR);
    const run = result.value as unknown as { id: string; state: string; idempotencyKey: string };

    expect(result.kind).toBe('run');
    expect(run.id).toBe(RUN_ID);
    expect(run.state).toBe('running');
    const insert = statement(db, 'INSERT INTO workflow_run (');
    expect(insert?.params?.slice(0, 3)).toEqual([WORKFLOW_ID, VERSION_ID, 'manual']);
    expect(String(insert?.params?.[3])).toMatch(/:0f2a5c14-4d7e-4b2a-9d61-2f7a7d1e4c11$/);
    expect(insert?.params?.[4]).toBeNull();
    // The row is created as `queued` and only becomes `running` once n8n accepted the execution:
    // a run the executor never started must not claim to be in flight.
    expect(insert?.sql).toContain("'queued'");
    expect(n8n.trigger).toHaveBeenCalledWith('n8n-workflow-1', WORKFLOW_ID);
    // The unique index behind this clause is partial, so the inference clause has to carry its
    // predicate; without it Postgres answers 42P10 and every manual run fails.
    expect(insert?.sql).toContain(
      'ON CONFLICT (workflow_id, idempotency_key) WHERE idempotency_key IS NOT NULL',
    );
    // One queued node per IR node, and one audit row for the run.
    expect(
      db.calls.filter((call) => call.sql.includes('INSERT INTO workflow_run_node (')),
    ).toHaveLength(2);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.run.started',
        targetType: 'workflow_run',
        detail: { trigger: 'manual', version: 2, replayOf: null },
      }),
      db.client,
    );
  });

  it('runs a validated workflow as well as an active one', async () => {
    const { service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'validated' })]),
      compiledVersion,
    ]);

    await expect(service.action(WORKFLOW_ID, 'run', ACTOR)).resolves.toMatchObject({ kind: 'run' });
  });

  it('refuses before writing anything when the n8n adapter is not configured', async () => {
    const { db, n8n, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
      compiledVersion,
    ]);
    n8n.assertReady.mockImplementation(() => {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: 'No n8n API key is configured.',
        remediation: 'Set SEAMNEX_N8N_API_KEY; workflow activation cannot be faked.',
      });
    });

    await expect(service.action(WORKFLOW_ID, 'run', ACTOR)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
    expect(statement(db, 'INSERT INTO workflow_run (')).toBeUndefined();
    expect(n8n.trigger).not.toHaveBeenCalled();
  });

  it('refuses a version that was never compiled, because there is nothing to execute', async () => {
    const { db, n8n, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
    ]);

    await expect(service.action(WORKFLOW_ID, 'run', ACTOR)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail:
        'Workflow Invoice export has no compiled n8n definition, so there is nothing to execute.',
    });
    expect(statement(db, 'INSERT INTO workflow_run (')).toBeUndefined();
    expect(n8n.trigger).not.toHaveBeenCalled();
  });

  it.each(['draft', 'disabled'])('refuses to run a %s workflow', async (state) => {
    const { db, service } = harness([route('LEFT JOIN idp_user', [workflowRow({ state })])]);

    await expect(service.action(WORKFLOW_ID, 'run', ACTOR)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: `Workflow Invoice export is ${state}; a run needs an active workflow.`,
      remediation: 'Activate the workflow, then run it.',
    });
    expect(statement(db, 'INSERT INTO workflow_run (')).toBeUndefined();
  });
});

describe('action: unknown', () => {
  it.each(['status', '', 'Validate'])(
    'refuses the action %j and lists the supported ones',
    async (action) => {
      const { service } = harness();

      await expect(service.action(WORKFLOW_ID, action, ACTOR)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `Unknown workflow action "${action}".`,
        remediation: 'Use validate, activate, disable, duplicate or run.',
      });
    },
  );
});

// ---- runs -------------------------------------------------------------------------------------

describe('startRun idempotency', () => {
  it('reuses the run the same key already created', async () => {
    const { db, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
      compiledVersion,
      // The insert hit the unique constraint, so the existing run is read back instead.
      route('INSERT INTO workflow_run (', []),
      route('SELECT id FROM workflow_run WHERE workflow_id', [{ id: RUN_ID }]),
    ]);

    const result = await service.action(WORKFLOW_ID, 'run', ACTOR);

    expect(result.kind).toBe('run');
    expect(statement(db, 'SELECT id FROM workflow_run WHERE workflow_id')).toBeDefined();
  });

  it('refuses when neither the insert nor the lookup produced a run', async () => {
    const { service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
      compiledVersion,
      route('INSERT INTO workflow_run (', []),
      route('SELECT id FROM workflow_run WHERE workflow_id', []),
    ]);

    await expect(service.action(WORKFLOW_ID, 'run', ACTOR)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The run could not be created or found.',
    });
  });

  it('answers 404 when the run cannot be read back', async () => {
    const { service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
      compiledVersion,
      route('FROM workflow_run r JOIN workflow w', []),
    ]);

    await expect(service.action(WORKFLOW_ID, 'run', ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No workflow run ${RUN_ID}.`,
    });
  });

  it('reports a run without a key or a finish time from what it knows', async () => {
    const { service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
      compiledVersion,
      route('FROM workflow_run r JOIN workflow w', [runRecord({ idempotency_key: null })]),
      route('FROM workflow_run_node rn', [
        {
          node_id: NODE_READ,
          label: 'Read contacts',
          state: 'succeeded',
          attempt: 1,
          duration_ms: null,
          error: null,
        },
      ]),
    ]);

    const result = await service.action(WORKFLOW_ID, 'run', ACTOR);
    const run = result.value as unknown as {
      idempotencyKey: string;
      finishedAt: string | null;
      durationMs: number;
      nodes: { label: string; durationMs: number; error: string | null }[];
      error: string | null;
      recordsProcessed: number;
    };

    expect(run.idempotencyKey).toBe(RUN_ID);
    expect(run.finishedAt).toBeNull();
    // An unfinished run is measured to now, as the runs list does: `0` read as "finished
    // instantly" for a run that had been going for hours.
    expect(run.durationMs).toBeGreaterThan(0);
    // The IR label, not the node id: the run returned here and the same run in the history agree.
    expect(run.nodes[0]).toMatchObject({
      label: 'Read contacts',
      durationMs: 0,
      error: null,
    });
    expect(run.error).toBeNull();
    expect(run.recordsProcessed).toBe(0);
  });

  it('reports the finishing time and the node error when the run has them', async () => {
    const { service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
      compiledVersion,
      route('FROM workflow_run r JOIN workflow w', [
        runRecord({
          finished_at: new Date('2026-02-02T10:00:04.000Z'),
          error: { message: 'HTTP 502 from the target' },
        }),
      ]),
      route('FROM workflow_run_node rn', [
        {
          node_id: NODE_WRITE,
          label: 'Create or update contact',
          state: 'failed',
          attempt: 2,
          duration_ms: 1_500,
          error: { message: 'timeout' },
        },
      ]),
    ]);

    const result = await service.action(WORKFLOW_ID, 'run', ACTOR);
    const run = result.value as unknown as {
      finishedAt: string | null;
      durationMs: number;
      error: string | null;
      nodes: { durationMs: number; error: string | null }[];
    };

    expect(run.finishedAt).toBe('2026-02-02T10:00:04.000Z');
    expect(run.durationMs).toBe(4_000);
    expect(run.error).toBe('HTTP 502 from the target');
    expect(run.nodes[0]).toMatchObject({ durationMs: 1_500, error: 'timeout' });
  });

  it('records the execution refusal on the run instead of leaving it in flight', async () => {
    const { audit, n8n, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
      compiledVersion,
      route('FROM workflow_run r JOIN workflow w', [
        runRecord({
          state: 'failed',
          error: { message: 'n8n POST /workflows/n8n-workflow-1/run answered 500.' },
        }),
      ]),
    ]);
    n8n.trigger.mockRejectedValue(
      new Error('n8n POST /workflows/n8n-workflow-1/run answered 500.'),
    );

    const result = await service.action(WORKFLOW_ID, 'run', ACTOR);
    const run = result.value as unknown as { state: string; error: string | null };

    expect(run.state).toBe('failed');
    expect(run.error).toBe('n8n POST /workflows/n8n-workflow-1/run answered 500.');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.run.failed', outcome: 'failure' }),
    );
  });

  it('starts one execution per idempotency key, however often the submit is retried', async () => {
    const { db, n8n, service } = harness([
      route('LEFT JOIN idp_user', [workflowRow({ state: 'active' })]),
      compiledVersion,
      route('INSERT INTO workflow_run (', []),
      route('SELECT id FROM workflow_run WHERE workflow_id', [{ id: RUN_ID }]),
    ]);

    await service.action(WORKFLOW_ID, 'run', ACTOR, 'submit-1234');

    // The key the caller sent is the one the unique index sees, so the retry collides with the
    // first submit instead of queuing a second execution of a write workflow.
    expect(statement(db, 'INSERT INTO workflow_run (')?.params?.[3]).toBe(
      `submit-1234:${VERSION_ID}`,
    );
    expect(n8n.trigger).not.toHaveBeenCalled();
  });
});

describe('replay', () => {
  it('answers 404 for a run that does not exist', async () => {
    const { service } = harness([
      route('SELECT id, workflow_id, version_id, state, trigger FROM workflow_run', []),
    ]);

    await expect(service.replay(RUN_ID, ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No workflow run ${RUN_ID}.`,
      remediation: 'Refresh the runs list.',
    });
  });

  it.each(['succeeded', 'running', 'queued'])('refuses to replay a %s run', async (state) => {
    const { service } = harness([
      route('SELECT id, workflow_id, version_id, state, trigger FROM workflow_run', [
        runRecord({ version_id: VERSION_ID, state }),
      ]),
    ]);

    await expect(service.replay(RUN_ID, ACTOR)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: `Run ${RUN_ID} is ${state}; only a failed run can be replayed.`,
      remediation: 'Replay exists to retry a failure, not to re-execute a success.',
    });
  });

  it('refuses a failed run that has no version to replay', async () => {
    const { service } = harness([
      route('SELECT id, workflow_id, version_id, state, trigger FROM workflow_run', [
        runRecord({ version_id: null, state: 'failed' }),
      ]),
    ]);

    await expect(service.replay(RUN_ID, ACTOR)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The run has no version to replay.',
    });
  });

  it('refuses a failed run whose version row is gone', async () => {
    const { service } = harness([
      route('SELECT id, workflow_id, version_id, state, trigger FROM workflow_run', [
        runRecord({ version_id: VERSION_ID, state: 'failed' }),
      ]),
      route('SELECT * FROM workflow_version WHERE id', []),
    ]);

    await expect(service.replay(RUN_ID, ACTOR)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: `No workflow version ${VERSION_ID}.`,
    });
  });

  it('replays under a key derived from the original run, so a retry cannot duplicate', async () => {
    const { db, audit, service } = harness();

    await service.replay(RUN_ID, ACTOR);

    const insert = statement(db, 'INSERT INTO workflow_run (');
    expect(insert?.params?.[3]).toBe(`${RUN_ID}:${VERSION_ID}`);
    expect(insert?.params?.[4]).toBe(RUN_ID);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.run.replayed',
        targetId: RUN_ID,
        detail: { trigger: 'manual', version: 2, replayOf: RUN_ID },
      }),
      db.client,
    );
  });
});

// ---- approvals ---------------------------------------------------------------------------------

describe('decideApproval', () => {
  it('answers 404 for a token it does not recognise, having hashed it', async () => {
    const { db, service } = harness([route('FROM workflow_approval WHERE token_hash', [])]);

    await expect(service.decideApproval('raw-token', 'approve', ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'The approval token is not recognised.',
      remediation: 'Use the link from the approval notification.',
    });
    // The token is never stored or compared in the clear.
    expect(statement(db, 'FROM workflow_approval WHERE token_hash')?.params).toEqual([
      createHash('sha256').update('raw-token').digest('hex'),
    ]);
  });

  it.each(['approved', 'rejected', 'expired'])(
    'refuses a token that is already %s',
    async (state) => {
      const { db, service } = harness([
        route('FROM workflow_approval WHERE token_hash', [approvalRow({ state })]),
      ]);

      await expect(service.decideApproval('raw-token', 'approve', ACTOR)).rejects.toMatchObject({
        code: 'STATE_CONFLICT',
        detail: `This approval is already ${state}.`,
        remediation: 'A token is single-use.',
      });
      expect(statement(db, 'INSERT INTO workflow_run_node (')).toBeUndefined();
    },
  );

  it('expires a token whose window has closed and refuses the decision', async () => {
    const { db, service } = harness([
      route('FROM workflow_approval WHERE token_hash', [approvalRow({ expires_at: EARLIER })]),
    ]);

    await expect(service.decideApproval('raw-token', 'approve', ACTOR)).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'The approval window has closed.',
      remediation: 'Ask the operator to re-run the workflow.',
    });
    expect(statement(db, "UPDATE workflow_approval SET state = 'expired'")?.params).toEqual([
      APPROVAL_ID,
    ]);
  });

  it('approves: resumes the run and marks the node succeeded', async () => {
    const { db, audit, service } = harness();

    const decision = await service.decideApproval('raw-token', 'approve', ACTOR);

    expect(decision).toEqual({
      runId: RUN_ID,
      nodeId: NODE_WRITE,
      state: 'running',
      decidedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(statement(db, 'UPDATE workflow_approval SET state = $2')?.params).toEqual([
      APPROVAL_ID,
      'approved',
      ACTOR,
    ]);
    expect(statement(db, 'UPDATE workflow_run_node SET state = $2')?.params).toEqual([
      RUN_ID,
      'succeeded',
      NODE_WRITE,
    ]);
    expect(statement(db, 'UPDATE workflow_run SET state = $2')?.params).toEqual([
      RUN_ID,
      'running',
    ]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.approval.approve',
        targetType: 'workflow_run',
        targetId: RUN_ID,
        detail: { nodeId: NODE_WRITE },
      }),
      db.client,
    );
  });

  it('rejects: fails the run and the node', async () => {
    const { db, audit, service } = harness();

    const decision = await service.decideApproval('raw-token', 'reject', ACTOR);

    expect(decision.state).toBe('failed');
    expect(statement(db, 'UPDATE workflow_approval SET state = $2')?.params?.[1]).toBe('rejected');
    expect(statement(db, 'UPDATE workflow_run_node SET state = $2')?.params?.[1]).toBe('failed');
    expect(statement(db, 'UPDATE workflow_run SET state = $2')?.params?.[1]).toBe('failed');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow.approval.reject' }),
      db.client,
    );
  });
});

// ---- helpers at the bottom so the reading order is behaviour first ------------------------------

function codesOf(issues: readonly { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

function countOf(codes: readonly string[], code: string): number {
  return codes.filter((candidate) => candidate === code).length;
}
