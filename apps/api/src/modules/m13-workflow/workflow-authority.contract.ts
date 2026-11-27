import type { PlatformRole } from '@seamnex/domain';

/** Injection token for the FR-5.9 gate. Modules depend on this file, never on the implementation. */
export const WORKFLOW_AUTHORITY = Symbol('seamnex.m13.workflow-authority');

/**
 * The write a caller is asking to perform.
 *
 * `action` is not decoration: it is what the audit row and the refusal say, and it keeps a `run`
 * from reading like an `edit` in the trail. `validate` is deliberately absent — it changes no
 * definition and mints no credential, so gating it would block the check that tells an author what
 * is wrong with their own draft.
 */
export type WorkflowWriteAction =
  | 'create'
  | 'import'
  | 'edit'
  | 'rename'
  | 'delete'
  | 'activate'
  | 'disable'
  | 'duplicate'
  | 'run'
  | 'replay';

export type WorkflowAuthorityRequest = {
  readonly actorId: string;
  /**
   * The session role, used only when the subject has no live `role_binding` row — the same fallback
   * the PDP applies. Omitted reads the request context; a direct call with neither is `R5`, which
   * holds nothing.
   */
  readonly role?: PlatformRole;
  readonly action: WorkflowWriteAction;
  readonly policyKey: 'workflow.author' | 'workflow.run';
  /** The write-target entry keys of the definition as it will be after this call. */
  readonly entryKeys?: readonly string[];
  /** Explicit instances, for a create, where the caller chose the target and no IR exists yet. */
  readonly instanceIds?: readonly string[];
  /** The definition being changed, for the audit row and for a readable refusal. */
  readonly workflowId?: string;
};

/** The elevations a permitted write leaned on (FR-5.9 / §5.1). */
export type WorkflowAuthorityEvidence = {
  readonly elevations: readonly { readonly instanceId: string; readonly elevationId: string }[];
};

/**
 * The workflows one actor may see, as a predicate the list query can apply.
 *
 * `unrestricted` is the R1/R2 answer (platform-wide read). The scoped answer names the domains and
 * instances the actor holds; the query filters on those rather than loading and discarding rows in
 * memory, so `x-total-count` stays the size of the filtered set.
 */
export type WorkflowListScope =
  | { readonly unrestricted: true }
  | {
      readonly unrestricted: false;
      readonly domains: readonly string[];
      readonly instanceIds: readonly string[];
    };

export interface WorkflowAuthority {
  /**
   * Refuses the write unless FR-5.9 holds for **every** write target, and returns the elevations
   * used so the caller can record them on the change it is about to make. Throws an `AppError`
   * (`403 WORKFLOW_WRITE_NOT_PERMITTED`) and leaves an `access.denied` row otherwise.
   */
  assertPermitted(request: WorkflowAuthorityRequest): Promise<WorkflowAuthorityEvidence>;

  /** What this actor may read, for the workflow list. */
  listScope(actorId: string, role?: PlatformRole): Promise<WorkflowListScope>;
}
