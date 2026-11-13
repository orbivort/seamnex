import type { TriggerEndpoint } from '@seamnex/domain';

export const TRIGGER_INGRESS_SERVICE = Symbol('seamnex.m23.trigger-ingress');

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
    input: { eventName: string; workflowId?: string },
    actorId: string,
  ): Promise<TriggerEndpoint>;
  remove(triggerId: string, actorId: string): Promise<void>;
  /** HMAC over the raw body; unknown, unsigned, stale or repeated deliveries are rejected and audited. */
  accept(input: {
    endpointToken: string;
    rawBody: Buffer;
    signature: string | null;
    deliveryId: string | null;
  }): Promise<{ accepted: boolean; reason: string }>;
}
