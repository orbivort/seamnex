import { Inject, Injectable } from '@nestjs/common';
import { operationKey, type ApiOperation, type WorkflowState } from '@seamnex/domain';
import type { OperationGroup } from '../operation-handlers';
import type { OperationHandler, OperationResult } from '../operation-handler';
import { CATALOG_SERVICE, type CatalogService } from '../../modules/m01-catalog/catalog.contract';
import {
  RENDERER_SERVICE,
  type RendererService,
} from '../../modules/m03-renderer/renderer.contract';
import {
  EXECUTOR_SERVICE,
  type ExecutorService,
} from '../../modules/m05-executor/executor.contract';
import {
  STATUS_HEALTH_SERVICE,
  type StatusHealthService,
} from '../../modules/m06-status-health/status-health.contract';
import {
  INTEGRATION_SERVICE,
  type IntegrationService,
} from '../../modules/m07-integration/integration.contract';
import {
  IDENTITY_SYNC_SERVICE,
  type IdentitySyncService,
} from '../../modules/m08-identity-sync/identity-sync.contract';
import {
  ACCESS_CONTROL_SERVICE,
  type AccessControlService,
} from '../../modules/m09-access-control/access-control.contract';
import {
  PORTAL_BFF_SERVICE,
  type PortalBffService,
} from '../../modules/m10-portal-bff/portal-bff.contract';
import {
  REGISTRY_SERVICE,
  type RegistryService,
} from '../../modules/m12-integration-registry/registry.contract';
import {
  WORKFLOW_SERVICE,
  type WorkflowService,
} from '../../modules/m13-workflow/workflow.contract';
import {
  GOVERNANCE_SERVICE,
  type GovernanceService,
} from '../../modules/m18-governance/governance.contract';
import {
  CAPACITY_SERVICE,
  type CapacityService,
} from '../../modules/m19-capacity/capacity.contract';
import {
  ADMIN_CREDENTIAL_SERVICE,
  PRODUCT_ACCOUNT_SERVICE,
  type AdminCredentialService,
  type ProductAccountService,
} from '../../modules/m24-sign-in-relay/relay.contract';
import { InstanceParamsService } from '../../modules/m22-catalog-repository/instance-params.service';
import {
  CATALOG_REPOSITORY,
  type CatalogRepositoryService,
} from '../../modules/m22-catalog-repository/catalog-repo.contract';
import type { IntegrationMetadataPatch } from '../../modules/m01-catalog/catalog.contract';
import { AppError } from '../../common/problem/app-error';

const key = (method: ApiOperation['method'], path: string): string =>
  operationKey({ method, path });

/**
 * The Phase 2 handler set.
 *
 * Handlers orchestrate: they read the validated input, call one module service and shape the
 * result. They contain no SQL (each table has one owner) and no HTTP status logic (the dispatcher
 * derives 200/202/204/412 from the operation).
 */
@Injectable()
export class Phase2Handlers implements OperationGroup {
  readonly tag = 'phase-2';

  constructor(
    @Inject(CATALOG_SERVICE) private readonly catalog: CatalogService,
    @Inject(RENDERER_SERVICE) private readonly env: RendererService,
    @Inject(EXECUTOR_SERVICE) private readonly executor: ExecutorService,
    @Inject(STATUS_HEALTH_SERVICE) private readonly status: StatusHealthService,
    @Inject(INTEGRATION_SERVICE) private readonly integration: IntegrationService,
    @Inject(IDENTITY_SYNC_SERVICE) private readonly identity: IdentitySyncService,
    @Inject(ACCESS_CONTROL_SERVICE) private readonly access: AccessControlService,
    @Inject(PORTAL_BFF_SERVICE) private readonly portal: PortalBffService,
    @Inject(REGISTRY_SERVICE) private readonly registry: RegistryService,
    @Inject(WORKFLOW_SERVICE) private readonly workflows: WorkflowService,
    @Inject(GOVERNANCE_SERVICE) private readonly governance: GovernanceService,
    @Inject(CAPACITY_SERVICE) private readonly capacity: CapacityService,
    @Inject(InstanceParamsService) private readonly params: InstanceParamsService,
    @Inject(CATALOG_REPOSITORY) private readonly repository: CatalogRepositoryService,
    @Inject(ADMIN_CREDENTIAL_SERVICE) private readonly adminCredential: AdminCredentialService,
    @Inject(PRODUCT_ACCOUNT_SERVICE) private readonly accounts: ProductAccountService,
  ) {}

  handlers(): ReadonlyMap<string, OperationHandler> {
    const actor = (input: { context: { subject: { idpId: string } } }): string =>
      input.context.subject.idpId;

    return new Map<string, OperationHandler>([
      // ---- Portal ------------------------------------------------------------------------------
      [
        key('GET', '/me'),
        async (input) =>
          body(
            await this.portal.me(input.context.subject.idpId, {
              roles: [input.context.role],
              mfaSatisfied: input.context.mfaSatisfied,
              mfaMethod: input.context.mfaMethod,
              sessionExpiresAt: input.context.sessionExpiresAt ?? new Date().toISOString(),
              groups: input.context.groups,
            }),
          ),
      ],
      [
        key('GET', '/me/entitlements'),
        async (input) => body(await this.portal.entitlements(input.context.subject.idpId)),
      ],
      [
        key('GET', '/me/launcher'),
        async (input) => body(await this.portal.launcher(input.context.subject.idpId)),
      ],
      [key('GET', '/portal/status-banner'), async () => body(await this.portal.statusBanner())],
      [
        key('GET', '/portal/launch-targets/:instanceId'),
        async (input) =>
          body(
            await this.portal.launchTarget(input.context.subject.idpId, param(input, 'instanceId')),
          ),
      ],
      [
        key('POST', '/portal/launch-tickets/:instanceId'),
        async (input) =>
          body(
            await this.portal.launchTicket(
              input.context.subject.idpId,
              param(input, 'instanceId'),
              input.context.sessionId,
            ),
          ),
      ],
      [
        key('POST', '/portal/launch-events/:instanceId'),
        async (input) =>
          body(
            await this.portal.recordLaunch(input.context.subject.idpId, param(input, 'instanceId')),
          ),
      ],
      [
        key('GET', '/portal/products/:slug'),
        async (input) =>
          body(await this.portal.product(input.context.subject.idpId, param(input, 'slug'))),
      ],
      [
        key('GET', '/portal/requestable'),
        async (input) => body(await this.portal.requestable(input.context.subject.idpId)),
      ],

      // ---- Catalog -----------------------------------------------------------------------------
      [
        key('GET', '/catalog'),
        async (input) =>
          body(
            await this.catalog.list({
              ...optional('q', input.query.q),
              ...optional('cluster', input.query.cluster),
              ...optional('packaging', input.query.packaging),
            }),
          ),
      ],
      [
        key('POST', '/catalog/reload'),
        /**
         * One read of the working tree, two projections.
         *
         * M01 may not import M03 (`module-boundaries.json`), so the sequencing lives here, like
         * 4A.8's instance.yaml commit. Entries are written first because
         * `env_schema_var.entry_key` references `catalog_entry.key`; the environment pass then
         * projects `catalog/env/<KEY>.json` and reports its own delta. A file that would invalidate
         * a running instance is refused whole and appears in `environment.refused` — never rolled
         * into a silent success.
         */
        async (input) => {
          const actorId = actor(input);
          const tree = await this.repository.load();
          const entries = await this.catalog.reload({ actorId, tree });
          const environment = await this.env.applySchemas({
            schemas: tree.envSchemas,
            revision: tree.revision,
            actorId,
          });
          return body({ ...entries, environment, invalid: [...tree.invalid] });
        },
      ],
      [
        key('GET', '/catalog/:key'),
        async (input) => body(await this.catalog.entry(param(input, 'key'))),
      ],
      [
        key('GET', '/catalog/:key/env-schema'),
        async (input) => body(await this.env.schema(param(input, 'key'))),
      ],
      [
        key('GET', '/catalog/:key/env-plan'),
        async (input) =>
          body(
            await this.env.plan({
              entryKey: param(input, 'key'),
              ...(input.query.profile === undefined ? {} : { profileKey: input.query.profile }),
              overrides: input.families.env ?? {},
            }),
          ),
      ],
      [
        key('POST', '/catalog/:key/env-import'),
        async (input) => {
          const request = input.body as { source: 'dotenv' | 'compose'; content: string };
          return body(
            await this.env.importEnv({ entryKey: param(input, 'key'), ...request }, actor(input)),
          );
        },
      ],
      [key('GET', '/env-profiles'), async () => body(await this.env.profiles())],
      [
        key('PATCH', '/catalog/:key/integration-metadata'),
        async (input) =>
          body(
            await this.catalog.patchIntegrationMetadata(
              param(input, 'key'),
              // `validateRequest` parsed this against `IntegrationMetadataRequestSchema`, so the two
              // fields are the only ones that can be present and `credentialGranularity` is already
              // one of the three enum members.
              input.body as IntegrationMetadataPatch,
              actor(input),
            ),
          ),
      ],

      // ---- Instances ----------------------------------------------------------------------------
      [
        key('GET', '/instances'),
        async (input) =>
          body(
            await this.executor.instances({
              ...optional('q', input.query.q),
              ...optional('state', input.query.state),
              ...optional('entryKey', input.query.entryKey),
            }),
          ),
      ],
      [
        key('GET', '/instances/:id'),
        async (input) => {
          const instance = await this.executor.instance(param(input, 'id'));
          return body({
            ...instance,
            integrationChecks: await this.integration.checks(param(input, 'id')),
          });
        },
      ],
      [
        key('GET', '/instances/:id/status'),
        async (input) =>
          body(await this.status.status(param(input, 'id'), input.query.refresh === 'true')),
      ],
      [
        key('GET', '/instances/:id/containers'),
        async (input) => body(await this.status.containers(param(input, 'id'))),
      ],
      [
        key('GET', '/instances/:id/env'),
        async (input) => body(await this.env.instanceEnv(param(input, 'id'))),
      ],
      [
        key('PUT', '/instances/:id/env'),
        async (input): Promise<OperationResult> => {
          const instanceId = param(input, 'id');
          const updated = await this.env.updateInstanceEnv(
            instanceId,
            (input.body as { values: Record<string, string> }).values,
            actor(input),
          );
          // 4A.8: the committed definition lists the environment variable *names*, so adding one
          // makes `instances/<slug>/instance.yaml` stale. It has to be rewritten here — nothing else
          // does it after a deployment, and a stale definition is exactly what invariant 13 exists
          // to catch (the next boot would mark the instance drifted and refuse to apply).
          if (updated.diff.length > 0) {
            await this.params.write(instanceId, actor(input)).catch((error: unknown) => {
              throw new AppError({
                code: 'REPOSITORY_UNAVAILABLE',
                detail: `The values were stored but instances/<slug>/instance.yaml could not be committed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                remediation:
                  'Make the catalog repository writable by the API user and retry: the values are saved, but the definition on disk disagrees with them until the commit succeeds.',
              });
            });
          }
          if (updated.diff.length === 0) return body(updated);

          // A stored value that never reaches the container is not a change. The pipeline always had
          // a `reconfigure` stage list; nothing could enqueue it, so "requires recreate" was advice
          // with no action behind it.
          const job = await this.executor
            .lifecycle({ instanceId, action: 'reconfigure', actorId: actor(input) })
            .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
          if (job instanceof Error) {
            // The values are persisted, so failing the request would misreport what happened; the
            // caller is told the apply did not start, and why, instead of a 500 over a stored change.
            return body({
              ...updated,
              applied: false,
              note: `Stored, but the reconfigure job could not be queued (${job.message}). Retry POST /instances/${instanceId}/reconfigure once the instance is idle.`,
            });
          }
          return body({
            ...updated,
            applied: true,
            note: `Stored and queued as reconfigure job ${job.jobId}: the containers are recreated with these values.`,
          });
        },
      ],
      /*
       * ADR-BE-22: the token is write-only. The handler never reads it back, and the response is the
       * metadata `status` reports — so a client cannot echo the value it just sent and the console
       * has nothing to render in plain text.
       */
      [
        key('GET', '/instances/:id/admin-credential'),
        async (input) => body(await this.adminCredential.status(param(input, 'id'))),
      ],
      [
        key('PUT', '/instances/:id/admin-credential'),
        async (input) =>
          body(
            await this.adminCredential.store(
              param(input, 'id'),
              (input.body as { token: string }).token,
              { type: 'user', id: actor(input) },
            ),
          ),
      ],
      /*
       * ADR-BE-22: the on-demand pass. Same work the deployment event and the sweep do — one
       * selection, one provisioning path — so this route cannot create a mapping the sweep would
       * refuse, and it answers in counts rather than in reassurance.
       *
       * The actor is passed for the same reason `PUT .../admin-credential` passes it: a pass can
       * create an account, reset a password or fail with `login_collision`, and the audit row must
       * name the person who asked rather than the role the process happens to run as.
       */
      [
        key('POST', '/instances/:id/relay/provision'),
        async (input) =>
          body(
            await this.accounts.provisionInstance(param(input, 'id'), undefined, {
              type: 'user',
              id: actor(input),
            }),
          ),
      ],
      [
        key('GET', '/instances/:id/drift'),
        async (input) => body(await this.executor.drift(param(input, 'id'))),
      ],
      [
        key('GET', '/instances/:id/images'),
        async (input) => body(await this.executor.images(param(input, 'id'))),
      ],
      [
        key('GET', '/instances/:id/plan'),
        async (input) =>
          body(await this.executor.plan(param(input, 'id'), input.query.action ?? 'upgrade')),
      ],

      // ---- Admin -------------------------------------------------------------------------------
      [
        key('GET', '/admin/users'),
        // `after` is the keyset cursor; the page cap is a safety bound, so a caller that expects the
        // whole directory pages until a short page comes back.
        async (input) => body(await this.identity.users(input.query.q, input.query.after)),
      ],
      [
        key('GET', '/admin/users/:id'),
        async (input) => body(await this.identity.user(param(input, 'id'))),
      ],
      [
        key('GET', '/admin/users/:id/entitlements'),
        async (input) => body(await this.identity.userEntitlements(param(input, 'id'))),
      ],
      [key('GET', '/admin/groups'), async () => body(await this.identity.groups())],
      [
        key('PUT', '/admin/groups/:id/mapping'),
        async (input) =>
          body(
            await this.identity.mapGroup(
              param(input, 'id'),
              input.body as {
                role: string;
                scopeType: string;
                scopeLabel: string;
                propagate: boolean;
              },
              actor(input),
            ),
          ),
      ],
      [key('GET', '/admin/identity-sync'), async () => body(await this.identity.syncRuns())],
      [
        key('GET', '/admin/settings'),
        async () => {
          const result = await this.access.settings();
          return { kind: 'body', body: result.settings, etag: result.etag };
        },
      ],
      [
        key('PUT', '/admin/settings'),
        async (input) => {
          const result = await this.access.putSettings(
            input.body as Record<string, number>,
            header(input.headers, 'if-match'),
            actor(input),
          );
          return { kind: 'body', body: result.settings, etag: result.etag };
        },
      ],
      [
        key('GET', '/admin/access-requests'),
        async () => body(await this.identity.accessRequests()),
      ],
      [
        key('POST', '/admin/access-requests'),
        async (input) =>
          body(
            await this.identity.createAccessRequest(
              input.body as { entryKey: string; justification: string },
              input.context.subject.idpId,
            ),
          ),
      ],
      [
        key('GET', '/admin/maintenance-windows'),
        async () => body(await this.governance.maintenance()),
      ],
      [
        key('GET', '/admin/policy-exceptions'),
        async () => body(await this.governance.policyExceptions()),
      ],
      [key('GET', '/admin/dsar'), async () => body(await this.governance.dsar())],

      // ---- Governance ---------------------------------------------------------------------------
      [key('GET', '/licenses'), async () => body(await this.governance.licenses())],
      [
        key('PUT', '/licenses/:instanceId/hosted-service'),
        async (input) =>
          body(
            await this.governance.setHostedService(
              param(input, 'instanceId'),
              (input.body as { enabled: boolean }).enabled,
              actor(input),
            ),
          ),
      ],
      [key('GET', '/patch-register'), async () => body(await this.governance.patches())],
      [key('GET', '/posture'), async () => body(await this.governance.posture())],
      [key('GET', '/break-glass-sessions'), async () => body(await this.governance.breakGlass())],

      // ---- Capacity -----------------------------------------------------------------------------
      [key('GET', '/capacity'), async () => body(await this.capacity.snapshot())],
      [key('GET', '/capacity/forecast'), async () => body(await this.capacity.forecast())],

      // ---- Registry -----------------------------------------------------------------------------
      [key('GET', '/registry/instances'), async () => body(await this.registry.entries())],
      [
        key('GET', '/registry/instances/:slug'),
        async (input) => body(await this.registry.entry(param(input, 'slug'))),
      ],
      [key('GET', '/registry/stale'), async () => body(await this.registry.stale())],

      // ---- Workflows ----------------------------------------------------------------------------
      /**
       * The collection answers with an array (that is the declared response), so the size of the
       * match set travels in `x-total-count`: a caller that passed `limit` can tell a short page from
       * a truncated one without a second request.
       */
      [
        key('GET', '/workflows'),
        async (input) => {
          const result = await this.workflows.list({
            ...(input.query.state === undefined
              ? {}
              : { state: input.query.state as WorkflowState }),
            ...(input.query.q === undefined ? {} : { q: input.query.q }),
            ...intOrUndefined('limit', input.query.limit),
            ...intOrUndefined('offset', input.query.offset),
          });
          return {
            kind: 'body',
            body: result.items,
            headers: { 'x-total-count': String(result.total) },
          };
        },
      ],
      [
        key('GET', '/workflows/:id'),
        async (input) => body(await this.workflows.get(param(input, 'id'))),
      ],
      [
        key('PATCH', '/workflows/:id'),
        async (input) => {
          const result = await this.workflows.rename(
            param(input, 'id'),
            input.body as { name?: string; description?: string | null },
            header(input.headers, 'if-match'),
            actor(input),
          );
          return { kind: 'body', body: result.workflow, etag: result.etag };
        },
      ],
      [
        key('DELETE', '/workflows/:id'),
        async (input) => {
          await this.workflows.remove(param(input, 'id'), actor(input));
          return { kind: 'noContent' };
        },
      ],
      [
        key('GET', '/workflows/:id/runs'),
        async (input) => body(await this.workflows.runs(param(input, 'id'))),
      ],
      [
        key('GET', '/workflow-runs/:runId'),
        async (input) => body(await this.workflows.run(param(input, 'runId'))),
      ],
      [
        key('GET', '/workflows/:id/export'),
        async (input) => body(await this.workflows.export(param(input, 'id'))),
      ],
    ]);
  }
}

function body(value: unknown): OperationResult {
  return { kind: 'body', body: value };
}

/**
 * The dispatcher has already coerced and type-checked a declared `integer` query parameter, so a
 * value that fails to parse here is a contract defect rather than a user error. Absent stays absent.
 */
function intOrUndefined(name: string, value: string | undefined): Record<string, number> {
  if (value === undefined) return {};
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: `"${name}" is not an integer.`,
      fieldErrors: [{ field: name, code: 'invalid_type', message: 'Use a whole number.' }],
    });
  }
  return { [name]: parsed };
}

function param(input: { params: Readonly<Record<string, string>> }, name: string): string {
  const value = input.params[name];
  if (value === undefined) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: `Missing path parameter ${name}.`,
    });
  }
  return value;
}

function header(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function optional<K extends string>(
  name: K,
  value: string | undefined,
): Record<K, string> | Record<string, never> {
  return value === undefined ? {} : ({ [name]: value } as Record<K, string>);
}
