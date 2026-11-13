import { Inject, Injectable } from '@nestjs/common';
import type {
  AuditRangeVerifyRequest,
  MaintenanceWindowCreateRequest,
  MaintenanceWindowPatchRequest,
  PlatformRole,
} from '@seamnex/domain';
import { operationKey, type ApiOperation } from '@seamnex/domain';
import type { OperationGroup } from '../operation-handlers';
import type { OperationHandler, OperationResult } from '../operation-handler';
import { AppError } from '../../common/problem/app-error';
import { GovernanceWritesService } from '../../modules/m18-governance/governance-writes.service';
import { PrivacyQueueService } from '../../modules/m18-governance/privacy-queue.service';
import { AuditQueryService } from '../../modules/m17-audit/audit-query.service';

const key = (method: ApiOperation['method'], path: string): string =>
  operationKey({ method, path });

/**
 * 4F handler group: break-glass lifecycle, decisions, maintenance windows, audit range verification
 * and DSAR execution. Every one of these is a governance write, so each answers with the resulting
 * record rather than `204`: an operator must see the state the platform now believes in.
 */
@Injectable()
export class Phase4FHandlers implements OperationGroup {
  readonly tag = 'phase-4f';

  constructor(
    @Inject(GovernanceWritesService) private readonly governance: GovernanceWritesService,
    @Inject(AuditQueryService) private readonly audit: AuditQueryService,
    @Inject(PrivacyQueueService) private readonly privacy: PrivacyQueueService,
  ) {}

  handlers(): ReadonlyMap<string, OperationHandler> {
    const actor = (input: { context: { subject: { idpId: string } } }): string =>
      input.context.subject.idpId;
    /*
     * The action route is admitted by "any of approve or revoke", so the handler has to know which
     * of the two the caller holds. The PDP has already established that one of them applies.
     */
    const role = (input: { context: { role: PlatformRole } }): PlatformRole => input.context.role;

    return new Map<string, OperationHandler>([
      [
        key('POST', '/break-glass-sessions'),
        async (input) => {
          const request = input.body as {
            instanceId: string;
            accessMode: string;
            justification: string;
          };
          return body(await this.governance.requestBreakGlass(request, actor(input)));
        },
      ],
      [
        key('POST', '/break-glass-sessions/:id/:action'),
        async (input) =>
          body(
            await this.governance.decideBreakGlass(
              param(input, 'id'),
              param(input, 'action'),
              actor(input),
              role(input),
            ),
          ),
      ],
      [
        key('POST', '/break-glass-sessions/:id/reveal'),
        async (input) => body(await this.governance.reveal(param(input, 'id'), actor(input))),
      ],
      [
        key('POST', '/admin/policy-exceptions/:id/:decision'),
        async (input) => {
          const decision = decisionOf(param(input, 'decision'));
          return body(
            await this.governance.decideException(param(input, 'id'), decision, actor(input)),
          );
        },
      ],
      [
        key('POST', '/admin/access-requests/:id/:decision'),
        async (input) => {
          const decision = decisionOf(param(input, 'decision'));
          return body(
            await this.governance.decideAccessRequest(param(input, 'id'), decision, actor(input)),
          );
        },
      ],
      [
        key('POST', '/admin/maintenance-windows'),
        async (input) =>
          body(
            await this.governance.createWindow(
              input.body as MaintenanceWindowCreateRequest,
              actor(input),
            ),
          ),
      ],
      [
        key('PATCH', '/admin/maintenance-windows/:id'),
        async (input) =>
          body(
            await this.governance.patchWindow(
              param(input, 'id'),
              input.body as MaintenanceWindowPatchRequest,
              actor(input),
            ),
          ),
      ],
      [
        key('DELETE', '/admin/maintenance-windows/:id'),
        async (input) => {
          await this.governance.cancelWindow(param(input, 'id'), actor(input));
          return { kind: 'noContent' } satisfies OperationResult;
        },
      ],
      [
        key('POST', '/audit-events/verify'),
        async (input) => {
          const request = input.body as AuditRangeVerifyRequest;
          return body(await this.governance.verifyAuditRange(request.fromSeq, request.toSeq));
        },
      ],
      [
        // FR-4.3 / AC-15: the audit log was write-only until now, so the console had nothing to page.
        key('GET', '/audit-events'),
        async (input) =>
          body(
            await this.audit.page({
              ...(input.query.action === undefined ? {} : { action: input.query.action }),
              ...(input.query.actor === undefined ? {} : { actor: input.query.actor }),
              ...(input.query.outcome === undefined ? {} : { outcome: input.query.outcome }),
              ...(input.query.target === undefined ? {} : { target: input.query.target }),
              ...(input.query.cursor === undefined ? {} : { cursor: input.query.cursor }),
              ...(input.query.limit === undefined ? {} : { limit: input.query.limit }),
            }),
          ),
      ],
      [
        key('GET', '/audit-events/:seq/proof'),
        async (input) => body(await this.audit.proof(param(input, 'seq'))),
      ],
      [
        key('POST', '/audit-events/export'),
        async (input) => {
          const request = input.body as { from: string; to: string };
          return body(await this.audit.exportRange(request.from, request.to));
        },
      ],
      [key('GET', '/privacy/requests'), async () => body(await this.privacy.queue())],
      [
        key('POST', '/privacy/requests'),
        async (input) => {
          const request = input.body as { subjectRef: string; kind: 'export' | 'delete' };
          return body(await this.governance.openDsar(request, actor(input)));
        },
      ],
      [
        key('POST', '/privacy/requests/:id/advance'),
        async (input) => body(await this.governance.advanceDsar(param(input, 'id'), actor(input))),
      ],
    ]);
  }
}

function body(value: unknown): OperationResult {
  return { kind: 'body', body: value };
}

function decisionOf(value: string): 'approve' | 'reject' {
  if (value === 'approve' || value === 'reject') return value;
  throw new AppError({
    code: 'VALIDATION_FAILED',
    status: 422,
    detail: `Unknown decision "${value}".`,
    remediation: 'Use approve or reject.',
  });
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
