import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRole, WorkflowExport } from '@seamnex/domain';
import {
  createTestDatabase,
  hasDatabase,
  skipUnlessDatabase,
  type TestDatabase,
} from '@seamnex/db/testing';
import { AppModule } from '../../src/app.module';
import type { RequestContext } from '../../src/common/identity/request-context';
import { WorkflowAuthoringService } from '../../src/modules/m13-workflow/authoring.service';
import {
  WORKFLOW_SERVICE,
  type WorkflowService,
} from '../../src/modules/m13-workflow/workflow.contract';
import { PdpService } from '../../src/modules/m09-access-control/pdp.service';

/**
 * FR-5.9 / AC-26 / NFR-4.4 — the negative cases the compliance review asked for, against a real
 * database.
 *
 * A unit test can prove the rule's arithmetic; only PostgreSQL can prove that the API *applies* it:
 * that a domain owner's target resolves through `catalog_entry.domain`, that a product administrator
 * cannot import a pipeline through two products, that an R1 with no elevation is refused while an
 * approved one is admitted and recorded, and that the list a scoped actor receives is their own.
 *
 * Nothing here signs in: the services are called with the subject id the platform would have
 * resolved, which is the only thing the rule reads.
 */
const redisUrl = process.env.REDIS_URL ?? '';
const canRun = hasDatabase && redisUrl.length > 0;
const skipReason = canRun
  ? false
  : hasDatabase
    ? 'Set REDIS_URL (pnpm dev:stack) to run the API integration suite.'
    : skipUnlessDatabase() || 'Set REDIS_URL to run the API integration suite.';

if (!canRun && process.env.SEAMNEX_REQUIRE_DATABASE_TESTS === '1') {
  throw new Error(
    `SEAMNEX_REQUIRE_DATABASE_TESTS=1 but the suite cannot run: ${String(skipReason)}`,
  );
}

const CRM_DOMAIN = 'CRM & Sales Pipeline';
const DOCS_DOMAIN = 'Document & Content Management';
const CRM_KEY = 'D01-01';
const DOCS_KEY = 'D08-01';

const R1 = 'it-wf-admin';
const R3_CRM = 'it-wf-domain-crm';
const R3_DOCS = 'it-wf-domain-docs';
const R4_CRM = 'it-wf-product-crm';

let app: INestApplicationContext | undefined;
let database: TestDatabase | undefined;
let pool: Pool;
let authoring: WorkflowAuthoringService;
let workflows: WorkflowService;
let pdp: PdpService;
let crmInstance: string;
let docsInstance: string;

beforeAll(async () => {
  if (!canRun) return;

  const rootKeyFile = resolve(process.cwd(), 'temp/test/seamnex-root-key');
  mkdirSync(dirname(rootKeyFile), { recursive: true });
  writeFileSync(rootKeyFile, `${randomBytes(32).toString('base64')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  process.env.SEAMNEX_ROOT_KEY_FILE = rootKeyFile;

  database = await createTestDatabase();
  process.env.DATABASE_URL = database.url;
  pool = database.pool;

  for (const [idpId, role, scopeType, scopeId] of [
    [R1, 'R1', 'platform', null],
    [R3_CRM, 'R3', 'domain', CRM_DOMAIN],
    [R3_DOCS, 'R3', 'domain', DOCS_DOMAIN],
    [R4_CRM, 'R4', 'instance', 'SCOPED_INSTANCE'],
  ] as const) {
    await pool.query(`INSERT INTO idp_user (idp_id, username, enabled) VALUES ($1, $2, true)`, [
      idpId,
      idpId,
    ]);
    if (scopeId === 'SCOPED_INSTANCE') continue; // written below, once the instance exists
    await pool.query(
      `INSERT INTO role_binding (subject_idp_id, role, scope_type, scope_id, granted_by)
       VALUES ($1, $2, $3, $4, 'integration-test')`,
      [idpId, role, scopeType, scopeId],
    );
  }

  crmInstance = await instanceFor(CRM_KEY, CRM_DOMAIN, 'EspoCRM');
  docsInstance = await instanceFor(DOCS_KEY, DOCS_DOMAIN, 'Paperless-ngx');

  await pool.query(
    `INSERT INTO role_binding (subject_idp_id, role, scope_type, scope_id, granted_by)
     VALUES ($1, 'R4', 'instance', $2, 'integration-test')`,
    [R4_CRM, crmInstance],
  );

  app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: ['error'],
  });
  authoring = app.get(WorkflowAuthoringService);
  workflows = app.get<WorkflowService>(WORKFLOW_SERVICE);
  pdp = app.get(PdpService);
});

afterAll(async () => {
  if (!canRun) return;
  await app?.close().catch(() => undefined);
  await database?.drop();
});

/**
 * A catalogue entry whose credential granularity is `scoped`, because a write target must be
 * write-eligible before FR-5.9 is even reached (C-11) — and a domain, because that is the string the
 * rule compares.
 */
async function instanceFor(key: string, domain: string, product: string): Promise<string> {
  // The display name the platform reads is `payload->>'product'` (both `related()` and the authority
  // gate use it), so the fixture writes it there rather than only in the column.
  await pool.query(
    `INSERT INTO catalog_entry (key, domain, product, guarantee_class, packaging, payload)
     VALUES ($1, $2, $3::text, 'native', 'compose', jsonb_build_object(
               'product', $3::text,
               'integration', jsonb_build_object('credentialGranularity', 'scoped')))
     ON CONFLICT (key) DO UPDATE SET domain = EXCLUDED.domain, payload = EXCLUDED.payload`,
    [key, domain, product],
  );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO instance (id, entry_key, slug, domain_route, state)
     VALUES ($1, $2, $3, $4, 'ready')`,
    [id, key, `slug-${id.slice(0, 8)}`, `host-${id.slice(0, 8)}.test`],
  );
  return id;
}

function contextFor(idpId: string, role: PlatformRole): RequestContext {
  return {
    requestId: randomUUID(),
    processRole: 'api',
    subject: { idpId, username: idpId },
    role,
    actorType: 'user',
    sessionId: null,
    instanceId: null,
    scopes: [],
    mfaSatisfied: true,
    mfaMethod: 'totp',
    mfaAsserted: true,
    sessionExpiresAt: null,
    sessionIdleExpiresAt: null,
    csrfToken: null,
    groups: [],
  };
}

function createAs(actorId: string, targetInstanceId: string) {
  return authoring.create(
    {
      name: `Authority test ${randomUUID().slice(0, 8)}`,
      triggerType: 'manual',
      sourceInstanceId: crmInstance,
      targetInstanceId,
    },
    actorId,
  );
}

/** A portable document whose write targets are given, for the import path. */
function documentWith(targets: readonly string[]): WorkflowExport {
  return {
    apiVersion: 'seamnex.workflow/v1',
    exportedAt: new Date().toISOString(),
    irHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    workflow: {
      id: randomUUID(),
      name: 'Imported pipeline',
      description: null,
      version: 1,
      state: 'draft',
      owner: { id: R1, name: R1 },
      trigger: {
        type: 'manual',
        label: 'Manual',
        config: 'Manual trigger',
        timezone: null,
      },
      nodes: [],
      edges: [],
      writeTargets: targets.map((entryKey) => ({ entryKey, product: entryKey, mode: 'write' })),
      credentialScopes: [],
      validation: { valid: false, checkedAt: null, issues: [] },
      irHash: 'sha256:none',
      enabled: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastRunAt: null,
      lastRunState: null,
    },
  };
}

async function deniedFor(actorId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_event
      WHERE action = 'access.denied' AND actor_id = $1 AND outcome = 'denied'`,
    [actorId],
  );
  return result.rows[0]?.n ?? 0;
}

describe.skipIf(skipReason !== false)('workflow write authority', () => {
  it('lets a domain owner create a workflow whose write target is in their domain', async () => {
    const created = await createAs(R3_CRM, crmInstance);

    expect(created.writeTargets).toEqual([
      { entryKey: CRM_KEY, product: 'EspoCRM', mode: 'write' },
    ]);
  });

  it('refuses a domain owner naming another domain, and audits the refusal', async () => {
    const before = await deniedFor(R3_CRM);

    const error = await createAs(R3_CRM, docsInstance).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: 'WORKFLOW_WRITE_NOT_PERMITTED', status: 403 });
    // Which target, and which authority — the design's requirement for this code.
    expect((error as Error).message).toContain(`Paperless-ngx (${DOCS_KEY})`);
    expect(await deniedFor(R3_CRM)).toBe(before + 1);
  });

  it('refuses a product administrator importing two write targets (AC-26)', async () => {
    const error = await authoring
      .importDocument({ document: documentWith([CRM_KEY, DOCS_KEY]) }, R4_CRM)
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: 'WORKFLOW_WRITE_NOT_PERMITTED', status: 403 });
    expect((error as Error).message).toContain('exactly one instance');
  });

  it('lets that administrator import a single target they administer', async () => {
    const created = await authoring.importDocument({ document: documentWith([CRM_KEY]) }, R4_CRM);

    expect(created.state).toBe('disabled');
  });

  it('refuses an R1 with no elevation, then admits one with an active read-write session', async () => {
    await expect(createAs(R1, crmInstance)).rejects.toMatchObject({
      code: 'WORKFLOW_WRITE_NOT_PERMITTED',
      status: 403,
    });

    const session = await pool.query<{ id: string }>(
      `INSERT INTO break_glass_session
         (requester, instance_id, access_mode, state, justification, approver, granted_at, expires_at)
       VALUES ($1, $2, 'read_write', 'active', 'Integration test: FR-5.9 elevation', 'it-approver',
               now(), now() + interval '1 hour')
       RETURNING id`,
      [R1, crmInstance],
    );
    const sessionId = session.rows[0]?.id as string;

    const created = await createAs(R1, crmInstance);

    // The elevation is recorded on the change it authorised, not merely on the session.
    const audit = await pool.query<{ detail: { elevations?: { elevationId: string }[] } }>(
      `SELECT detail FROM audit_event
        WHERE action = 'workflow.created' AND target_id = $1`,
      [created.id],
    );
    // The elevation is named on the change; `elevationId` survives the audit detail's key masker,
    // which blanks anything matching `session[-_]?id`.
    expect(audit.rows[0]?.detail.elevations).toEqual([
      { instanceId: crmInstance, elevationId: sessionId },
    ]);
  });

  it('shows a scoped actor only the workflows they hold authority over', async () => {
    const crm = await createAs(R3_CRM, crmInstance);
    const docs = await createAs(R3_DOCS, docsInstance);

    const asCrmOwner = await workflows.list({ actorId: R3_CRM, limit: 200 });
    const ids = asCrmOwner.items.map((workflow) => workflow.id);
    expect(ids).toContain(crm.id);
    expect(ids).not.toContain(docs.id);
    // And every row they do see writes only inside their domain.
    expect(
      asCrmOwner.items.every((workflow) =>
        workflow.writeTargets.every((target) => target.entryKey === CRM_KEY),
      ),
    ).toBe(true);

    const asProductAdmin = await workflows.list({ actorId: R4_CRM, limit: 200 });
    const productIds = asProductAdmin.items.map((workflow) => workflow.id);
    expect(productIds).toContain(crm.id);
    expect(productIds).not.toContain(docs.id);
  });

  it('authorises reads through the same write targets, at the route layer', async () => {
    const crm = await createAs(R3_CRM, crmInstance);
    const docs = await createAs(R3_DOCS, docsInstance);

    // Before this change every one of these was refused: `{type:'workflow'}` could not be mapped to
    // an instance, so a domain owner could not even open a definition they had just created.
    await expect(
      pdp.decide({
        context: contextFor(R3_CRM, 'R3'),
        policyKey: 'workflow.view_runs',
        resource: { type: 'workflow', id: crm.id },
      }),
    ).resolves.toMatchObject({ allowed: true });

    await expect(
      pdp.decide({
        context: contextFor(R3_CRM, 'R3'),
        policyKey: 'workflow.view_runs',
        resource: { type: 'workflow', id: docs.id },
      }),
    ).resolves.toMatchObject({ allowed: false });

    // A product administrator reaches a definition whose single write target is their instance.
    await expect(
      pdp.decide({
        context: contextFor(R4_CRM, 'R4'),
        policyKey: 'workflow.view_runs',
        resource: { type: 'workflow', id: crm.id },
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('refuses a second write target added to a product administrator workflow', async () => {
    const created = await authoring.importDocument({ document: documentWith([CRM_KEY]) }, R4_CRM);

    await expect(
      authoring.addNode(
        created.id,
        {
          node: {
            id: randomUUID(),
            kind: 'action',
            label: 'Write to documents',
            product: 'Paperless-ngx',
            entryKey: DOCS_KEY,
            mode: 'write',
            operation: 'document.write',
            x: 240,
            y: 0,
            summary: 'Upload the document to Paperless-ngx',
            mappings: [],
          },
          connectFrom: null,
        },
        R4_CRM,
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_WRITE_NOT_PERMITTED' });
  });
});
