import type { FieldError, ProblemDetail } from '@seamnex/domain';

/**
 * One place where a failure code becomes a problem document (RFC 9457). The client already parses
 * `ProblemDetailSchema`, so a code that is not in this table cannot leak an ad-hoc shape.
 *
 * `remediation` is mandatory: a problem a user cannot act on is a support ticket.
 */
export type ProblemTemplate = {
  readonly status: number;
  readonly title: string;
  readonly remediation: string;
  readonly slug: string;
};

const BASE = 'https://platform.seamnex.local/problems';

export const PROBLEM_CATALOG = {
  VALIDATION_FAILED: {
    status: 400,
    title: 'The request does not match the platform contract',
    remediation: 'Correct the highlighted field. The generated OpenAPI document is the reference.',
    slug: 'validation-failed',
  },
  NOT_FOUND: {
    status: 404,
    title: 'The resource does not exist',
    remediation: 'Check the identifier. A deleted resource is not readable.',
    slug: 'not-found',
  },
  METHOD_NOT_ALLOWED: {
    status: 405,
    title: 'The operation is not declared for this path',
    remediation: 'Use the method declared in the OpenAPI document.',
    slug: 'method-not-allowed',
  },
  UNAUTHORIZED: {
    status: 401,
    title: 'The request is not authenticated',
    remediation: 'Sign in at /sign-in. A session is required for this operation.',
    slug: 'unauthorized',
  },
  /** AC-46: a password-only assertion for R1/R2 never becomes a session. */
  MFA_REQUIRED: {
    status: 401,
    title: 'A second factor is required to finish signing in',
    remediation: 'Enter the six-digit code from your authenticator and submit again.',
    slug: 'mfa-required',
  },
  MFA_INVALID: {
    status: 401,
    title: 'The second factor was not accepted',
    remediation: 'Wait for the next code and retry. No session was created.',
    slug: 'mfa-invalid',
  },
  SESSION_EXPIRED: {
    status: 401,
    title: 'The session has expired',
    remediation: 'Sign in again at /sign-in. The reason is the idle or absolute lifetime.',
    slug: 'session-expired',
  },
  FORBIDDEN: {
    status: 403,
    title: 'The subject is not permitted to perform this action',
    remediation: 'Ask the scope owner for the capability, or use the request-access flow.',
    slug: 'forbidden',
  },
  /** Deliverable 3.2: the browser origin is not one this platform serves. */
  ORIGIN_REJECTED: {
    status: 403,
    title: 'The request came from an origin this platform does not serve',
    remediation: 'Sign in from the platform sign-in page. The request was not applied.',
    slug: 'origin-rejected',
  },
  CSRF_FAILED: {
    status: 403,
    title: 'The request could not be verified as coming from your session',
    remediation: 'Reload the page and retry. The request was not applied.',
    slug: 'csrf-failed',
  },
  RATE_LIMITED: {
    status: 429,
    title: 'Too many attempts',
    remediation: 'Wait for the interval named in Retry-After, then try again.',
    slug: 'rate-limited',
  },
  AUTH_PROVIDER_UNAVAILABLE: {
    status: 503,
    title: 'The identity provider cannot be reached',
    remediation: 'Retry shortly. No session was created.',
    slug: 'auth-provider-unavailable',
  },
  INSTANCE_BUSY: {
    status: 409,
    title: 'Another job is already running for this instance',
    remediation: 'Wait for the blocking job to finish, or cancel it before apply.',
    slug: 'instance-busy',
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    title: 'The idempotency key was reused with a different request',
    remediation: 'Send a new Idempotency-Key for a different operation.',
    slug: 'idempotency-conflict',
  },
  STATE_CONFLICT: {
    status: 409,
    title: 'The resource is not in a state that allows this operation',
    remediation: 'Reload the resource. The allowed transitions are in the OpenAPI document.',
    slug: 'state-conflict',
  },
  /**
   * The resource already exists in the form the request assumes it does not. Distinct from
   * `STATE_CONFLICT`: that one is about the lifecycle, this one about a name or key. It was used
   * without an entry, so every duplicate was answered as a generic `500` with no detail.
   */
  CONFLICT: {
    status: 409,
    title: 'The resource already exists',
    remediation:
      'Choose another identifier, or update the existing resource instead of creating it.',
    slug: 'conflict',
  },
  GONE: {
    status: 410,
    title: 'The resource is no longer available',
    remediation: 'Read the collection again; the resource was deleted and will not come back.',
    slug: 'gone',
  },
  PRECONDITION_FAILED: {
    status: 412,
    title: 'The resource changed since it was read',
    remediation: 'Reload the resource and reapply the change.',
    slug: 'precondition-failed',
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    title: 'The request body is larger than the platform accepts',
    remediation: 'Reduce the payload size.',
    slug: 'payload-too-large',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    title: 'The request body is not in a format the platform reads',
    remediation: 'Send application/json with a schema from the OpenAPI document.',
    slug: 'unsupported-media-type',
  },
  STREAM_LIMIT: {
    status: 429,
    title: 'Too many open job streams on this replica',
    remediation: 'Poll GET /jobs/{id} instead, or retry when another stream closes.',
    slug: 'stream-limit',
  },
  INTERNAL_ERROR: {
    status: 500,
    title: 'The platform could not complete the request',
    remediation: 'Retry once. If it persists, quote the request id to the platform team.',
    slug: 'internal-error',
  },
  UNAVAILABLE: {
    status: 503,
    title: 'A dependency of the platform is not available',
    remediation: 'Retry shortly. Readiness reports which dependency failed.',
    slug: 'unavailable',
  },
  /** AD-20: the mutation is refused because its audit row could not be written. */
  AUDIT_UNAVAILABLE: {
    status: 503,
    title: 'The change was refused because the audit log is unavailable',
    remediation: 'Retry. The platform fails closed rather than writing an unaudited change.',
    slug: 'audit-unavailable',
  },
  SECRET_UNAVAILABLE: {
    status: 503,
    title: 'The secret store cannot be used',
    remediation: 'Check the root key file and the secret table; no secret value was returned.',
    slug: 'secret-unavailable',
  },
  SECRET_NOT_FOUND: {
    status: 404,
    title: 'The secret does not exist',
    remediation: 'Check the scope, owner and name. A missing secret is never created implicitly.',
    slug: 'secret-not-found',
  },
  OPERATION_NOT_IMPLEMENTED: {
    status: 501,
    title: 'The operation belongs to a later phase',
    remediation: 'The code names the phase that implements it. Nothing was changed.',
    slug: 'operation-not-implemented',
  },
  /**
   * Phase 2 answers a declared mutation it does not own with 501 and one code per owning phase
   * (plan §5.2 exit criterion 5: "a `code` naming its owning phase"). One generic 501 would make
   * "which phase do I wait for?" unanswerable from the response.
   */
  DEFERRED_PHASE_3: {
    status: 501,
    title: 'The operation is implemented in Phase 3 (authentication and authorization)',
    remediation: 'Phase 3 completes the session surface. Nothing was changed.',
    slug: 'deferred-phase-3',
  },
  DEFERRED_PHASE_4A: {
    status: 501,
    title: 'The operation is implemented in Phase 4A (deploy execution)',
    remediation: 'Phase 4A adds Docker render and apply. Nothing was changed.',
    slug: 'deferred-phase-4a',
  },
  DEFERRED_PHASE_4C: {
    status: 501,
    title: 'The operation is implemented in Phase 4C (backup and restore)',
    remediation: 'Phase 4C adds the backup runner and the restore engine. Nothing was changed.',
    slug: 'deferred-phase-4c',
  },
  DEFERRED_PHASE_4E: {
    status: 501,
    title: 'The operation is implemented in Phase 4E (workflow authoring)',
    remediation:
      'Phase 4E adds the workflow compiler and broker. Read endpoints already serve the frozen shape.',
    slug: 'deferred-phase-4e',
  },
  DEFERRED_PHASE_4F: {
    status: 501,
    title: 'The operation is implemented in Phase 4F (break-glass and privacy execution)',
    remediation:
      'Phase 4F adds elevation accounts and privacy fan-out. Nothing was changed; the audit log recorded the attempt.',
    slug: 'deferred-phase-4f',
  },
  /**
   * ADR-BE-12: `SEAMNEX_ADAPTERS_MODE=disabled` or a missing adapter setting. The detail names the
   * dependency, so an operator learns which one is missing instead of watching a job fail halfway.
   */
  ADAPTER_UNAVAILABLE: {
    status: 503,
    title: 'A platform adapter is not configured',
    remediation:
      'Configure the named adapter, or set SEAMNEX_ADAPTERS_MODE=real on a host that has it.',
    slug: 'adapter-unavailable',
  },
  /**
   * 4A.8: the working tree cannot accept `instances/<slug>/instance.yaml`. Distinct from
   * `STATE_CONFLICT`, which was the answer to the first `EACCES` and told the operator the *instance*
   * was in the wrong state while the truth was that a directory was not writable.
   */
  REPOSITORY_UNAVAILABLE: {
    status: 503,
    title: 'The catalog repository cannot be written by the platform',
    remediation:
      'Make the repository path named in the detail writable by the API user (the dev stack prepares `temp/catalog-repo/instances`), then retry.',
    slug: 'repository-unavailable',
  },
  SOURCE_URL_REJECTED: {
    status: 400,
    title: 'The source URL was refused',
    remediation: 'Use an https URL on an allow-listed host, without embedded credentials.',
    slug: 'source-url-rejected',
  },
  /** 4A.3: a compose file that the policy refuses; the diff names the offending key. */
  COMPOSE_POLICY_BLOCKED: {
    status: 422,
    title: 'The compose definition breaks a blocking policy rule',
    remediation:
      'Remove the offending key, or record an approved exception before the next deployment.',
    slug: 'compose-policy-blocked',
  },
  /**
   * 4A.4: the catalogue's `httpPort` names a port no single service exposes. A data error in the
   * entry, not a platform fault — but the code had no entry in this catalogue, so the renderer's
   * message (which names the port and what each service exposes) was replaced by a generic `500`.
   */
  HTTP_PORT_NOT_EXPOSED: {
    status: 422,
    title: 'The catalogue entry names a port no service exposes',
    remediation:
      'Set the entry httpPort to the port the product listens on inside its container; the left-hand side of a ports mapping is the host port and is never used.',
    slug: 'http-port-not-exposed',
  },
  /** AC-07: refused before any container starts, with the shortfall stated. */
  CAPACITY_EXCEEDED: {
    status: 422,
    title: 'The deployment does not fit the remaining capacity',
    remediation: 'Free capacity, lower the requested resources, or raise the reservation.',
    slug: 'capacity-exceeded',
  },
  BACKUP_UNUSABLE: {
    status: 422,
    title: 'The backup cannot be used',
    remediation:
      'A restore needs a stored render set, every image artefact and a readable manifest.',
    slug: 'backup-unusable',
  },
  /** 4C.4: product routes stay unpublished until an administrative login is verified. */
  RESTORE_GATE_CLOSED: {
    status: 409,
    title: 'Product routes are held by the restore gate',
    remediation: 'Complete the administrative login that verifies the restored identity provider.',
    slug: 'restore-gate-closed',
  },
  INTEGRATION_CHECK_FAILED: {
    status: 422,
    title: 'A post-deploy integration check did not pass',
    remediation: 'An instance is not `ready` until HTTP, SSO, DNS, backup and webhook checks pass.',
    slug: 'integration-check-failed',
  },
  WORKFLOW_INVALID: {
    status: 422,
    title: 'The workflow is not valid and cannot be activated',
    remediation: 'Resolve the per-node errors returned in `fieldErrors`, then validate again.',
    slug: 'workflow-invalid',
  },
  /** 4E.5: unknown, unsigned or stale trigger deliveries. */
  TRIGGER_REJECTED: {
    status: 401,
    title: 'The trigger delivery was rejected',
    remediation: 'Sign the raw body with the endpoint secret and send a fresh delivery id.',
    slug: 'trigger-rejected',
  },
  LICENCE_RESTRICTED: {
    status: 403,
    title: 'The licence does not allow this configuration',
    remediation:
      'The register records the restriction; hosted-service mode is blocked for this product.',
    slug: 'licence-restricted',
  },
  APPROVAL_REQUIRED: {
    status: 409,
    title: 'A second party must decide this request',
    remediation: 'The requester may not approve their own request. Ask an eligible approver.',
    slug: 'approval-required',
  },
  ROLE_NOT_IMPLEMENTED: {
    status: 503,
    title: 'This process role is registered but idle',
    remediation:
      'The role boots for topology parity in Phase 1; its capability arrives in a later phase.',
    slug: 'role-not-implemented',
  },
} as const satisfies Record<string, ProblemTemplate>;

export type ProblemCode = keyof typeof PROBLEM_CATALOG;

export function problemFor(
  code: ProblemCode,
  options: {
    detail: string;
    fieldErrors?: readonly FieldError[];
    /**
     * The HTTP status to answer with. It defaults to the catalogue entry, and a caller that knows
     * better about one *specific* instance of the code must say so: `VALIDATION_FAILED` is a 400
     * for a malformed body and a 422 for a well-formed one that breaks a business rule.
     */
    status?: number;
  },
): ProblemDetail {
  const template: ProblemTemplate = PROBLEM_CATALOG[code];
  return {
    type: `${BASE}/${template.slug}`,
    title: template.title,
    status: options.status ?? template.status,
    detail: options.detail,
    code,
    fieldErrors: [...(options.fieldErrors ?? [])],
    remediation: template.remediation,
  };
}

export function isKnownProblemCode(code: string): code is ProblemCode {
  return Object.hasOwn(PROBLEM_CATALOG, code);
}
