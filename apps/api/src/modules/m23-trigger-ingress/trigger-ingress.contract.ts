import type { TriggerEndpoint } from '@seamnex/domain';

export const TRIGGER_INGRESS_SERVICE = Symbol('seamnex.m23.trigger-ingress');

/**
 * What happened to one delivery, as far as authentication and de-duplication are concerned.
 *
 * `accepted` is deliberately not the whole answer: the caller still has to start the run, because
 * this module owns `trigger_endpoint`/`trigger_delivery` and must not learn how a workflow is
 * executed. The facts the caller needs travel with the verdict so it never re-reads the row it was
 * just told about.
 */
export type TriggerDeliveryOutcome = {
  readonly accepted: boolean;
  /** A fixed phrase; never names the endpoint, so a refusal cannot enumerate registrations. */
  readonly reason: string;
  readonly endpointId: string | null;
  readonly instanceId: string | null;
  readonly workflowId: string | null;
  /** Derived from the body hash when the sender supplied none. */
  readonly deliveryId: string;
};

/**
 * Owns `trigger_endpoint`, `trigger_delivery`. Phase 4E.
 *
 * Attached to `seamnex-control` only - never to an instance network (AD-23). The URL token is stored as a
 * hash and the HMAC secret lives in M15: a leaked table yields neither.
 */
export interface TriggerIngressService {
  list(instanceId: string): Promise<TriggerEndpoint[]>;
  /** Returns the URL and secret **once**; they are not recoverable afterwards. */
  register(
    instanceId: string,
    input: { eventName: string; workflowId: string },
    actorId: string,
  ): Promise<TriggerEndpoint>;
  remove(triggerId: string, actorId: string): Promise<void>;
  /** HMAC over the raw body; unknown, unsigned, stale or repeated deliveries are rejected and audited. */
  accept(input: {
    endpointToken: string;
    rawBody: Buffer;
    signature: string | null;
    deliveryId: string | null;
  }): Promise<TriggerDeliveryOutcome>;
  /**
   * Records the delivery's fate once the caller has tried to execute it.
   *
   * NFR-2.8 measures event-received → first-node-executed, so the latency belongs to the delivery
   * record rather than to a log line nobody samples. `state` is the row's own vocabulary:
   * `forwarded` when a run exists, `failed` when it does not.
   */
  recordOutcome(input: {
    endpointId: string;
    deliveryId: string;
    state: 'forwarded' | 'failed';
    runId: string | null;
    latencyMs: number;
    detail: string | null;
  }): Promise<void>;
}
