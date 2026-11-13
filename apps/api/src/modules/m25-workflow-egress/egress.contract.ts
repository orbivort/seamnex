import type { FieldDescriptor } from '@seamnex/domain';

export const WORKFLOW_EGRESS_SERVICE = Symbol('seamnex.m25.workflow-egress');

/**
 * One call n8n makes on a workflow's behalf.
 *
 * The node carries no address and no credential: the operation id is the whole request, and the
 * broker resolves the product, the path, the verb and the credential from the platform's own records.
 */
export type EgressRequest = {
  /** The `Bearer` value n8n was given at activation, or `null` when the caller sent none. */
  readonly token: string | null;
  readonly entryKey: string;
  readonly operation: string;
  /** The verb n8n sent. It must equal the operation's declared verb — a read token cannot POST. */
  readonly method: string;
  /** Query string with its leading `?`, or `''`. Passed through untouched (paging, filters). */
  readonly query: string;
  readonly contentType: string | null;
  readonly accept: string | null;
  readonly body: Buffer | null;
};

export type EgressResponse = {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer | null;
};

/**
 * 4E.4 — the only path from a workflow to a product.
 *
 * AD-10 makes egress one hop for three reasons, all of which used to be broken in the compiled
 * definition: the product is reachable only by its instance-network alias (which n8n cannot
 * resolve), the credential is held by the platform and not by n8n, and the scope that authorises the
 * call is checked per operation rather than per workflow.
 */
/**
 * Authoring-time schema read (FR-5.5). Deliberately not part of `EgressRequest`: it never carries a
 * broker token, because it runs while the workflow is still a draft and no scope has been minted.
 * The caller is an authenticated author; this service is the only holder of the product credential.
 */
export type FieldDiscoveryRequest = {
  readonly instanceId: string;
  readonly entryKey: string;
  readonly operation: string;
};

/**
 * Three answers, never an exception: a product that cannot describe itself or does not answer is a
 * fact the console has to render, not a 5xx that takes the mapper down with it.
 */
export type FieldDiscoveryResult =
  | { readonly status: 'available'; readonly fields: readonly FieldDescriptor[] }
  | { readonly status: 'unsupported' | 'unavailable'; readonly detail: string };

export interface WorkflowEgressService {
  forward(input: EgressRequest): Promise<EgressResponse>;
  discoverFields(input: FieldDiscoveryRequest): Promise<FieldDiscoveryResult>;
}
