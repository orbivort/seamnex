import type { Workflow, WorkflowExport, WorkflowRun, WorkflowState } from '@seamnex/domain';

export const WORKFLOW_SERVICE = Symbol('seamnex.m13.workflow');

/**
 * The declared filters of `GET /workflows`. Every value is already validated against the contract
 * (closed state set, integer query types) before it reaches the service; the service only enforces
 * the ranges the OpenAPI description promises.
 */
export type WorkflowListFilter = {
  readonly state?: WorkflowState;
  readonly q?: string;
  readonly limit?: number;
  readonly offset?: number;
};

/**
 * A page of definitions plus the size of the whole match set, so a caller that passed `limit` can
 * tell a short list from a truncated one (`x-total-count`).
 */
export type WorkflowListResult = {
  readonly items: Workflow[];
  readonly total: number;
};

/** Owns workflow, workflow_version, workflow_run, workflow_run_node. Authoring is Phase 4E. */
export interface WorkflowService {
  list(filter: WorkflowListFilter): Promise<WorkflowListResult>;
  get(id: string): Promise<Workflow>;
  rename(
    id: string,
    patch: { name?: string; description?: string | null },
    expectedEtag: string | undefined,
    actorId: string,
  ): Promise<{ workflow: Workflow; etag: string }>;
  remove(id: string, actorId: string): Promise<void>;
  runs(workflowId: string): Promise<WorkflowRun[]>;
  run(runId: string): Promise<WorkflowRun>;
  export(id: string): Promise<WorkflowExport>;
}
