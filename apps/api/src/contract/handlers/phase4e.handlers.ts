import { Inject, Injectable } from '@nestjs/common';
import type {
  CredentialScopeCreateRequest,
  FieldMapping,
  WorkflowApprovalDecisionRequest,
  WorkflowImportRequest,
  WorkflowMappingsRequest,
  WorkflowNodeCreateRequest,
  WorkflowNodePatchRequest,
  WorkflowTriggerUpdate,
} from '@seamnex/domain';
import { operationKey, type ApiOperation } from '@seamnex/domain';
import type { OperationGroup } from '../operation-handlers';
import type { OperationHandler, OperationResult } from '../operation-handler';
import { AppError } from '../../common/problem/app-error';
import { WorkflowAuthoringService } from '../../modules/m13-workflow/authoring.service';
import {
  CREDENTIAL_BROKER_SERVICE,
  type CredentialBrokerService,
} from '../../modules/m14-credential-broker/credential-broker.contract';
import {
  TRIGGER_INGRESS_SERVICE,
  type TriggerIngressService,
} from '../../modules/m23-trigger-ingress/trigger-ingress.contract';

const key = (method: ApiOperation['method'], path: string): string =>
  operationKey({ method, path });

/**
 * 4E handler group: authoring, workflow actions, replay, approvals, trigger endpoints and
 * credential scopes.
 *
 * Every authoring edit answers with the whole workflow, so the canvas re-renders from one response
 * instead of stitching a patch into local state. Actions answer with one of three shapes (validation,
 * workflow or run) exactly as the contract's union declares.
 */
@Injectable()
export class Phase4EHandlers implements OperationGroup {
  readonly tag = 'phase-4e';

  constructor(
    @Inject(WorkflowAuthoringService) private readonly authoring: WorkflowAuthoringService,
    @Inject(CREDENTIAL_BROKER_SERVICE) private readonly broker: CredentialBrokerService,
    @Inject(TRIGGER_INGRESS_SERVICE) private readonly triggers: TriggerIngressService,
  ) {}

  handlers(): ReadonlyMap<string, OperationHandler> {
    const actor = (input: { context: { subject: { idpId: string } } }): string =>
      input.context.subject.idpId;

    return new Map<string, OperationHandler>([
      [
        key('POST', '/workflows'),
        async (input) => {
          const request = input.body as {
            name: string;
            description?: string;
            triggerType: 'schedule' | 'webhook' | 'poll' | 'manual';
            sourceInstanceId: string;
            targetInstanceId: string;
          };
          return body(await this.authoring.create(request, actor(input)));
        },
      ],
      [
        key('POST', '/workflows/import'),
        async (input) =>
          body(
            await this.authoring.importDocument(input.body as WorkflowImportRequest, actor(input)),
          ),
      ],
      [
        key('POST', '/workflows/:id/:action'),
        async (input) => {
          /*
           * The caller's `Idempotency-Key` decides whether a retried submit is the same run: a
           * fresh key per request made a double-click two executions of a write workflow.
           */
          const result = await this.authoring.action(
            param(input, 'id'),
            param(input, 'action'),
            actor(input),
            idempotencyKey(input),
          );
          return body(result.value);
        },
      ],
      [
        key('POST', '/workflows/:id/nodes'),
        async (input) =>
          body(
            await this.authoring.addNode(
              param(input, 'id'),
              input.body as WorkflowNodeCreateRequest,
              actor(input),
            ),
          ),
      ],
      [
        key('PATCH', '/workflows/:id/nodes/:nodeId'),
        async (input) =>
          body(
            await this.authoring.patchNode(
              param(input, 'id'),
              param(input, 'nodeId'),
              input.body as WorkflowNodePatchRequest,
              actor(input),
            ),
          ),
      ],
      [
        key('DELETE', '/workflows/:id/nodes/:nodeId'),
        async (input) =>
          body(
            await this.authoring.removeNode(
              param(input, 'id'),
              param(input, 'nodeId'),
              actor(input),
            ),
          ),
      ],
      [
        key('PUT', '/workflows/:id/nodes/:nodeId/mappings'),
        async (input) => {
          const request = input.body as WorkflowMappingsRequest;
          return body(
            await this.authoring.setMappings(
              param(input, 'id'),
              param(input, 'nodeId'),
              request.mappings satisfies FieldMapping[],
              actor(input),
            ),
          );
        },
      ],
      [
        key('GET', '/workflows/:id/nodes/:nodeId/fields'),
        async (input) =>
          body(
            await this.authoring.fields(
              param(input, 'id'),
              param(input, 'nodeId'),
              { refresh: input.query.refresh === 'true' },
              actor(input),
            ),
          ),
      ],
      [
        key('GET', '/workflows/:id/nodes/:nodeId/sample'),
        async (input) =>
          body(
            await this.authoring.sample(param(input, 'id'), param(input, 'nodeId'), actor(input)),
          ),
      ],
      [
        key('PUT', '/workflows/:id/trigger'),
        async (input) =>
          body(
            await this.authoring.setTrigger(
              param(input, 'id'),
              input.body as WorkflowTriggerUpdate,
              actor(input),
            ),
          ),
      ],
      [
        key('POST', '/workflow-runs/:runId/replay'),
        async (input) => body(await this.authoring.replay(param(input, 'runId'), actor(input))),
      ],
      [
        key('POST', '/workflow-approvals/:token/decision'),
        async (input) => {
          const request = input.body as WorkflowApprovalDecisionRequest;
          return body(
            await this.authoring.decideApproval(
              param(input, 'token'),
              request.decision,
              actor(input),
            ),
          );
        },
      ],
      [
        key('GET', '/instances/:id/triggers'),
        async (input) => body(await this.triggers.list(param(input, 'id'))),
      ],
      [
        key('POST', '/instances/:id/triggers'),
        async (input) => {
          const request = input.body as { eventName: string; workflowId?: string };
          return body(
            await this.triggers.register(
              param(input, 'id'),
              {
                eventName: request.eventName,
                ...(request.workflowId === undefined ? {} : { workflowId: request.workflowId }),
              },
              actor(input),
            ),
          );
        },
      ],
      [
        key('DELETE', '/instances/:id/triggers/:triggerId'),
        async (input) => {
          await this.triggers.remove(param(input, 'triggerId'), actor(input));
          return { kind: 'noContent' } satisfies OperationResult;
        },
      ],
      [
        key('POST', '/instances/:id/credential-scopes'),
        async (input) => {
          const request = input.body as CredentialScopeCreateRequest;
          const instanceId = param(input, 'id');
          return body({
            ...(await this.broker.mint({
              instanceId,
              workflowId: request.workflowId,
              operations: request.operations,
              mode: request.mode,
              ttlSeconds: request.ttlSeconds ?? 90 * 24 * 60 * 60,
              ...(request.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: request.idempotencyKey }),
            })),
            instanceId,
          });
        },
      ],
      [
        key('DELETE', '/credential-scopes/:id'),
        async (input) => {
          await this.broker.revoke(param(input, 'id'), actor(input));
          return { kind: 'noContent' } satisfies OperationResult;
        },
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

/** One header value, never the `string[]` a repeated header produces. */
function idempotencyKey(input: {
  headers: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const raw = input.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.trim().length === 0 ? undefined : value.trim();
}
