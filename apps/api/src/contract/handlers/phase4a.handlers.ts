import { Inject, Injectable, Optional } from '@nestjs/common';
import { operationKey, type ApiOperation } from '@seamnex/domain';
import type { OperationGroup } from '../operation-handlers';
import type { OperationHandler, OperationResult } from '../operation-handler';
import { AppError } from '../../common/problem/app-error';
import {
  EXECUTOR_SERVICE,
  type ExecutorService,
} from '../../modules/m05-executor/executor.contract';
import {
  SOURCE_RESOLVER_SERVICE,
  type SourceResolverService,
} from '../../modules/m02-source-resolver/source-resolver.contract';
import { InstanceParamsService } from '../../modules/m22-catalog-repository/instance-params.service';
import {
  PORTAL_BFF_SERVICE,
  type PortalBffService,
} from '../../modules/m10-portal-bff/portal-bff.contract';
import {
  BACKUP_RESTORE_SERVICE,
  type BackupRestoreService,
} from '../../modules/m16-backup-restore/backup-restore.contract';
import { JobService } from '../../jobs/job.service';

const key = (method: ApiOperation['method'], path: string): string =>
  operationKey({ method, path });

type DeployBody = {
  entryKey: string;
  slug: string;
  profile?: string;
  resources?: { cpu: number; memoryMb: number; diskMb: number };
  envOverrides?: Record<string, string>;
};

type ActionBody = {
  dataRetention?: 'keep' | 'export' | 'delete';
  version?: string;
  justification?: string;
};

/**
 * 4A handler group: deploy, lifecycle, preview, prefetch and scaffold confirmation.
 *
 * Handlers orchestrate; they never touch Docker or SQL. Two pieces of sequencing live here because
 * they cross a module boundary the design keeps closed:
 *
 *   - `instances/<slug>/instance.yaml` is committed through M22 immediately after the instance row is
 *     created, and the job is cancelled if the commit fails (4A.8). M05 may not import M22.
 *   - an upgrade creates its pre-upgrade backup through M16 *before* the upgrade job exists, so the
 *     pipeline's precondition is a row, not a promise (AC-06). The dependency is `@Optional()` so a
 *     build without the backup module still boots and refuses the action honestly.
 *   - the deploying operator is granted portal access through M10 right after the instance row
 *     exists, because M05 may not import M10 and the portal lists `entitlement`, not `instance`.
 *     Without it a deployment is published at the edge and absent from the launcher — installed,
 *     listed for nobody, and reachable only by typing its hostname.
 */
@Injectable()
export class Phase4AHandlers implements OperationGroup {
  readonly tag = 'phase-4a';

  constructor(
    @Inject(EXECUTOR_SERVICE) private readonly executor: ExecutorService,
    @Inject(SOURCE_RESOLVER_SERVICE) private readonly sources: SourceResolverService,
    @Inject(InstanceParamsService) private readonly params: InstanceParamsService,
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(PORTAL_BFF_SERVICE) private readonly portal: PortalBffService,
    @Optional()
    @Inject(BACKUP_RESTORE_SERVICE)
    private readonly backups?: BackupRestoreService,
  ) {}

  handlers(): ReadonlyMap<string, OperationHandler> {
    const actor = (input: { context: { subject: { idpId: string } } }): string =>
      input.context.subject.idpId;

    return new Map<string, OperationHandler>([
      [
        key('POST', '/instances'),
        async (input): Promise<OperationResult> => {
          const request = input.body as DeployBody;
          const actorId = actor(input);
          // The definition is committed into the catalog repository immediately after the row is
          // created. Probing first turns "the mount is read-only" into a refusal that costs nothing,
          // instead of a reserved slug and an instance that no job will ever start.
          this.params.assertWritable();
          const deployed = await this.executor.deploy({
            entryKey: request.entryKey,
            slug: request.slug,
            ...(request.profile === undefined ? {} : { profileKey: request.profile }),
            ...(request.resources === undefined ? {} : { resources: request.resources }),
            ...(request.envOverrides === undefined ? {} : { envOverrides: request.envOverrides }),
            actorId,
          });

          /**
           * Access is created with the instance, before anything runs.
           *
           * The grant is the caller's own, and the only one: an install must not open the product to
           * a role, a group or the whole platform, which is why nobody else is granted here and the
           * launcher keeps its deny-by-default shape. It is attempted before the definition commit
           * so a failure cannot leave a committed `instance.yaml` behind for a deployment that was
           * rolled back.
           */
          try {
            const granted = await this.portal.grantInstanceOwner(deployed.instanceId, actorId);
            // No row and no error means the instance the executor just returned is already gone: the
            // grant then protects nothing, which is the same outcome as a failed write.
            if (!granted)
              throw new Error('the instance row was not found when the grant was written');
          } catch (error) {
            await this.jobs.cancel(deployed.jobId, actorId).catch(() => undefined);
            await this.executor.abandonDeployment(
              deployed.instanceId,
              actorId,
              'the deploying operator could not be granted portal access',
            );
            throw new AppError({
              code: 'INTERNAL_ERROR',
              detail: `The operator's portal access for the new instance could not be recorded: ${
                error instanceof Error ? error.message : String(error)
              }`,
              remediation:
                'The deployment was rolled back and nothing is running. Retry; if it persists, the entitlement write is failing and the platform team should read the API log.',
              cause: error,
            });
          }

          try {
            await this.params.write(deployed.instanceId, actorId);
          } catch (error) {
            // The pipeline refuses to apply without the committed definition, so leaving the job
            // queued would only produce a confusing failure 30 seconds later.
            await this.jobs.cancel(deployed.jobId, actorId).catch(() => undefined);
            // Undo the half-created deployment. Without this the instance stayed in `requested` —
            // visible in the fleet, impossible to start, holding the slug — while the response said
            // nothing had been applied.
            await this.executor.abandonDeployment(
              deployed.instanceId,
              actorId,
              'instance.yaml could not be committed to the catalog repository',
            );
            throw new AppError({
              code: 'REPOSITORY_UNAVAILABLE',
              detail: `instances/<slug>/instance.yaml could not be committed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              remediation:
                'Make the catalog repository writable by the API user, then deploy again. The instance record and its job were rolled back; nothing is running.',
              cause: error,
            });
          }
          return { kind: 'accepted', jobId: deployed.jobId };
        },
      ],
      [
        key('POST', '/instances/preview'),
        async (input) => {
          const request = input.body as DeployBody;
          return body(
            await this.executor.preview({
              entryKey: request.entryKey,
              slug: request.slug,
              ...(request.profile === undefined ? {} : { profileKey: request.profile }),
              ...(request.resources === undefined ? {} : { resources: request.resources }),
              ...(request.envOverrides === undefined ? {} : { envOverrides: request.envOverrides }),
            }),
          );
        },
      ],
      [
        key('POST', '/instances/:id/:action'),
        async (input): Promise<OperationResult> => {
          const instanceId = param(input, 'id');
          const action = param(input, 'action');
          const body_ = (input.body ?? {}) as ActionBody;
          const actorId = actor(input);

          let backupJobId: string | undefined;
          if (action === 'upgrade') {
            if (this.backups === undefined) {
              throw new AppError({
                code: 'ADAPTER_UNAVAILABLE',
                detail: 'An upgrade requires the backup runner, which is not part of this build.',
                remediation:
                  'Deploy M16 (4C) or run the backup before the upgrade; nothing was changed.',
              });
            }
            const backup = await this.backups.createInstanceBackup(instanceId, actorId);
            backupJobId = backup.jobId;
          }

          const result = await this.executor.lifecycle({
            instanceId,
            action,
            actorId,
            ...(body_.dataRetention === undefined ? {} : { dataRetention: body_.dataRetention }),
            ...(body_.justification === undefined ? {} : { justification: body_.justification }),
            ...(backupJobId === undefined ? {} : { backupJobId }),
            ...(body_.version === undefined ? {} : { renderSetId: body_.version }),
          });
          return { kind: 'accepted', jobId: result.jobId };
        },
      ],
      [
        key('POST', '/catalog/:key/prefetch'),
        async (input): Promise<OperationResult> => {
          const result = await this.executor.prefetch(param(input, 'key'), actor(input));
          return { kind: 'accepted', jobId: result.jobId };
        },
      ],
      [
        // The draft the entry screen renders before a commit exists. It was declared in Phase 2 and
        // never mounted; the scaffold write path is useless without the read that precedes it.
        key('GET', '/catalog/:key/scaffold'),
        async (input) => body(await this.sources.scaffold(param(input, 'key'))),
      ],
      [
        key('POST', '/catalog/:key/scaffold/:draftId/confirm'),
        async (input) =>
          body(
            await this.sources.confirmScaffold(
              param(input, 'key'),
              param(input, 'draftId'),
              actor(input),
            ),
          ),
      ],
    ]);
  }
}

function body(value: unknown): OperationResult {
  return { kind: 'body', body: value };
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
