import { Inject, Injectable } from '@nestjs/common';
import type {
  CredentialScopeCreateRequest,
  FieldMapping,
  TriggerEndpointCreateRequest,
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
          const request = input.body as TriggerEndpointCreateRequest;
          return body(
            await this.triggers.register(
              param(input, 'id'),
              { eventName: request.eventName, workflowId: request.workflowId },
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
      /*
       * FR-5.4 / NFR-2.8: the delivery ingress. This handler composes the two modules rather than
       * letting either depend on the other: m23 authenticates and de-duplicates the delivery, m13
       * owns what a run is. The receipt tells a sender what happened without ever revealing whether
       * an endpoint exists — every authentication failure is the same 401, and the `reason` of a
       * success is about this delivery only.
       */
      [
        key('POST', '/trigger/:token'),
        async (input) => {
          const startedAt = performance.now();
          const outcome = await this.triggers.accept({
            endpointToken: param(input, 'token'),
            // A capture that overflowed leaves no bytes; an empty buffer fails the HMAC, which is
            // the same answer as a wrong signature and does not blame the sender for our ceiling.
            rawBody: input.rawBody ?? Buffer.alloc(0),
            signature: header(input, 'x-seamnex-signature'),
            deliveryId: header(input, 'x-seamnex-delivery-id'),
          });

          if (outcome.reason === 'duplicate delivery') {
            return body({
              accepted: false,
              reason: 'duplicate delivery',
              workflowId: outcome.workflowId,
              runId: null,
            });
          }

          /*
           * Reachable only by a caller that signed the body: an endpoint registered before the
           * binding was required has nothing to execute, so it is a configuration defect to report,
           * not a delivery to acknowledge.
           */
          if (outcome.reason === 'unbound endpoint') {
            throw new AppError({
              code: 'STATE_CONFLICT',
              detail:
                'This trigger endpoint is not bound to a workflow, so the delivery cannot start.',
              remediation:
                'Re-register the endpoint with a workflow id; the URL and secret are issued once.',
            });
          }

          if (!outcome.accepted || outcome.workflowId === null || outcome.endpointId === null) {
            throw new AppError({
              code: 'UNAUTHORIZED',
              detail: 'The delivery could not be authenticated.',
              remediation:
                'Sign the exact request body with the endpoint secret, in `x-seamnex-signature`.',
            });
          }

          // Narrowed once, here, so the receipt and the delivery record cannot disagree about which
          // endpoint and delivery they are describing.
          const binding = { endpointId: outcome.endpointId, deliveryId: outcome.deliveryId };

          try {
            const run = await this.authoring.dispatchTriggerRun({
              workflowId: outcome.workflowId,
              endpointId: binding.endpointId,
              deliveryId: binding.deliveryId,
            });
            /*
             * `failed` here is not a duplicate: the run row was created for this delivery and n8n
             * refused it. The delivery is recorded as failed so the operator sees what happened, and
             * the sender is told the attempt did not execute rather than being told "done" for a run
             * whose per-node history is a single error.
             */
            if (run.state === 'failed') {
              await this.record(
                binding,
                'failed',
                run.id,
                startedAt,
                'the execution engine failed the run',
              );
              throw new AppError({
                code: 'UNAVAILABLE',
                detail:
                  'The run this delivery started failed and is waiting in the failed-run queue.',
                remediation:
                  'Replay the failed run from the workflow runs screen; do not re-deliver.',
              });
            }
            await this.record(binding, 'forwarded', run.id, startedAt, null);
            return body({
              accepted: true,
              reason: 'accepted',
              workflowId: outcome.workflowId,
              runId: run.id,
            });
          } catch (error) {
            if (error instanceof AppError) throw error;
            await this.record(binding, 'failed', null, startedAt, errorMessage(error));
            throw error;
          }
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

  /**
   * NFR-2.8: the delivery's fate, with the latency the ingress measured. A failed write here must
   * not turn a started run into an error the sender retries, so the failure path is best effort and
   * the forwarded path is not: a delivery that stopped being tracked is worse than a loud error.
   */
  private async record(
    outcome: { endpointId: string; deliveryId: string },
    state: 'forwarded' | 'failed',
    runId: string | null,
    startedAt: number,
    detail: string | null,
  ): Promise<void> {
    const input = {
      endpointId: outcome.endpointId,
      deliveryId: outcome.deliveryId,
      state,
      runId,
      latencyMs: Math.round(performance.now() - startedAt),
      detail,
    };
    if (state === 'forwarded') {
      await this.triggers.recordOutcome(input);
      return;
    }
    await this.triggers.recordOutcome(input).catch(() => undefined);
  }
}

function body(value: unknown): OperationResult {
  return { kind: 'body', body: value };
}

function header(
  input: { headers: Readonly<Record<string, string | string[] | undefined>> },
  name: string,
): string | null {
  const raw = input.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === undefined || value.trim().length === 0 ? null : value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
