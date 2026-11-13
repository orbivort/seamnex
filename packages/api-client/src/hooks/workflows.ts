import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  NodeFieldsSchema,
  NodeSampleSchema,
  WorkflowActionResponseSchema,
  WorkflowExportSchema,
  WorkflowRunSchema,
  WorkflowSchema,
  type FieldMapping,
  type Workflow,
  type WorkflowExport,
  type WorkflowNode,
  type WorkflowRun,
  type WorkflowTriggerUpdate,
} from '@seamnex/domain';
import { request } from '../http';
import { queryKeys } from '../query-keys';

const WorkflowListSchema = z.array(WorkflowSchema);
const WorkflowRunListSchema = z.array(WorkflowRunSchema);

export function useWorkflows() {
  return useQuery({
    queryKey: queryKeys.workflows,
    queryFn: ({ signal }) => request('/workflows', { schema: WorkflowListSchema, signal }),
  });
}

/**
 * A caller-supplied poll interval, decided from the data already on screen.
 *
 * `false` stops the timer, which is the common answer: only a run that is still in flight is worth
 * re-reading. Without this the run history was a snapshot — an operator who started a run watched
 * `Running` until they remembered the "Refresh runs" button, and the API had settled the run seconds
 * earlier.
 */
type PollWhile<T> = (data: T | undefined) => number | false;

/**
 * The interval callback receives an un-narrowed `Query<unknown>` — the option object's generics are
 * not inferred from the query it sits in — so the cached value is re-typed here rather than at every
 * call site.
 */
function pollWith<T>(pollWhile: PollWhile<T>) {
  return (query: { state: { data: unknown } }): number | false =>
    pollWhile(query.state.data as T | undefined);
}

export function useWorkflow(id: string, pollWhile?: PollWhile<Workflow>) {
  return useQuery({
    queryKey: queryKeys.workflow(id),
    queryFn: ({ signal }) => request(`/workflows/${id}`, { schema: WorkflowSchema, signal }),
    enabled: id.length > 0,
    ...(pollWhile === undefined ? {} : { refetchInterval: pollWith(pollWhile) }),
  });
}

export function useWorkflowRuns(id: string, pollWhile?: PollWhile<WorkflowRun[]>) {
  return useQuery({
    queryKey: queryKeys.workflowRuns(id),
    queryFn: ({ signal }) =>
      request(`/workflows/${id}/runs`, { schema: WorkflowRunListSchema, signal }),
    enabled: id.length > 0,
    ...(pollWhile === undefined ? {} : { refetchInterval: pollWith(pollWhile) }),
  });
}

export function useWorkflowRun(runId: string) {
  return useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: ({ signal }) =>
      request(`/workflow-runs/${runId}`, { schema: WorkflowRunSchema, signal }),
    enabled: runId.length > 0,
  });
}

export function useWorkflowAction(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: 'validate' | 'activate' | 'disable' | 'run' | 'duplicate') =>
      request(`/workflows/${id}/${action}`, {
        schema: WorkflowActionResponseSchema,
        method: 'POST',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.workflow(id) });
      void client.invalidateQueries({ queryKey: queryKeys.workflows });
      void client.invalidateQueries({ queryKey: queryKeys.workflowRuns(id) });
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/**
 * FR-5.1: rename or re-describe. Mapping edits stay out of scope (exception EX-2).
 * `description: null` clears it; an empty string is refused by the contract.
 */
export function usePatchWorkflow(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; description?: string | null }) =>
      request(`/workflows/${id}`, { schema: WorkflowSchema, method: 'PATCH', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.workflow(id) });
      void client.invalidateQueries({ queryKey: queryKeys.workflows });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/** FR-5.11: an imported document lands as a disabled draft that still needs validation. */
export function useImportWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (document: WorkflowExport) =>
      request('/workflows/import', { schema: WorkflowSchema, method: 'POST', body: { document } }),
    onSuccess: (workflow) => {
      void client.invalidateQueries({ queryKey: queryKeys.workflows });
      void client.invalidateQueries({ queryKey: queryKeys.workflow(workflow.id) });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export type WorkflowDraftInput = {
  name: string;
  description?: string;
  triggerType: 'schedule' | 'webhook' | 'poll' | 'manual';
  sourceInstanceId: string;
  targetInstanceId: string;
};

export function useCreateWorkflow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: WorkflowDraftInput) =>
      request('/workflows', { schema: WorkflowSchema, method: 'POST', body }),
    onSuccess: (workflow) => {
      void client.invalidateQueries({ queryKey: queryKeys.workflows });
      void client.invalidateQueries({ queryKey: queryKeys.workflow(workflow.id) });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useDeleteWorkflow() {
  const client = useQueryClient();
  return useMutation({
    // DELETE answers 204 by contract, so there is no body to parse.
    mutationFn: (id: string) => request<void>(`/workflows/${id}`, { method: 'DELETE' }),
    onSuccess: (_result, id) => {
      client.removeQueries({ queryKey: queryKeys.workflow(id) });
      client.removeQueries({ queryKey: queryKeys.workflowRuns(id) });
      void client.invalidateQueries({ queryKey: queryKeys.workflows });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useReplayRun(workflowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      request(`/workflow-runs/${runId}/replay`, { schema: WorkflowRunSchema, method: 'POST' }),
    onSuccess: (run) => {
      void client.invalidateQueries({ queryKey: queryKeys.workflows });
      void client.invalidateQueries({ queryKey: queryKeys.workflow(workflowId) });
      void client.invalidateQueries({ queryKey: queryKeys.workflowRuns(workflowId) });
      void client.invalidateQueries({ queryKey: queryKeys.run(run.id) });
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useExportWorkflow() {
  return useMutation({
    mutationFn: (id: string) =>
      request(`/workflows/${id}/export`, { schema: WorkflowExportSchema }),
  });
}

// ---------------------------------------------------------------------------------------------
// CL-02 authoring. Every mutation returns the whole workflow, so one response re-renders the canvas
// and the invalidation set stays small: the workflow, its list entry, and the audit trail.
// ---------------------------------------------------------------------------------------------

function useAuthoringMutation<TInput>(id: string, send: (input: TInput) => Promise<Workflow>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => send(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.workflow(id) });
      void client.invalidateQueries({ queryKey: queryKeys.workflows });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useAddWorkflowNode(id: string) {
  return useAuthoringMutation<{ node: WorkflowNode; connectFrom?: string | null }>(id, (input) =>
    request(`/workflows/${id}/nodes`, {
      schema: WorkflowSchema,
      method: 'POST',
      body: { node: input.node, connectFrom: input.connectFrom },
    }),
  );
}

export function usePatchWorkflowNode(id: string) {
  return useAuthoringMutation<{ nodeId: string; patch: Partial<WorkflowNode> }>(id, (input) =>
    request(`/workflows/${id}/nodes/${input.nodeId}`, {
      schema: WorkflowSchema,
      method: 'PATCH',
      body: input.patch,
    }),
  );
}

export function useRemoveWorkflowNode(id: string) {
  return useAuthoringMutation<string>(id, (nodeId) =>
    request(`/workflows/${id}/nodes/${nodeId}`, { schema: WorkflowSchema, method: 'DELETE' }),
  );
}

export function usePutWorkflowMappings(id: string) {
  return useAuthoringMutation<{ nodeId: string; mappings: FieldMapping[] }>(id, (input) =>
    request(`/workflows/${id}/nodes/${input.nodeId}/mappings`, {
      schema: WorkflowSchema,
      method: 'PUT',
      body: { mappings: input.mappings },
    }),
  );
}

/** FR-5.4: the trigger is part of the definition, so it is versioned with it. */
export function usePutWorkflowTrigger(id: string) {
  return useAuthoringMutation<WorkflowTriggerUpdate>(id, (input) =>
    request(`/workflows/${id}/trigger`, { schema: WorkflowSchema, method: 'PUT', body: input }),
  );
}

// ---------------------------------------------------------------------------------------------
// FR-5.5 authoring aids. Both are reads that make the mapper pickable instead of typed: the fields
// the operation accepts, and a redacted sample of what the node last received.
// ---------------------------------------------------------------------------------------------

/**
 * The fields the node's operation accepts.
 *
 * `enabled` is the caller's permission, not a convenience: the route is `workflow.author`, so a
 * read-only viewer of the mapper must not ask for it and then render a `403` where the field list
 * belongs.
 */
export function useWorkflowNodeFields(
  id: string,
  nodeId: string,
  operation: string | null,
  refresh = false,
  enabled = true,
) {
  return useQuery({
    // The operation is part of the key: rebinding a node to another operation must not render the
    // previous operation's fields as this one's.
    queryKey: [...queryKeys.workflowNodeFields(id, nodeId), operation, refresh] as const,
    queryFn: ({ signal }) =>
      request(`/workflows/${id}/nodes/${nodeId}/fields${refresh ? '?refresh=true' : ''}`, {
        schema: NodeFieldsSchema,
        signal,
      }),
    enabled: enabled && id.length > 0 && nodeId.length > 0 && operation !== null,
    /*
     * No retry: `unsupported` and `unavailable` are answers, not failures, so a retry only delays
     * the manual-entry fallback the author needs.
     */
    retry: false,
  });
}

/**
 * The redacted item the node last received.
 *
 * `enabled` is the caller's consent, not a convenience: the answer is production data and the read
 * is audited, so a drawer that opens on the paste tab must not fetch it before the author asks for
 * it.
 */
export function useWorkflowNodeSample(id: string, nodeId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.workflowNodeSample(id, nodeId),
    queryFn: ({ signal }) =>
      request(`/workflows/${id}/nodes/${nodeId}/sample`, { schema: NodeSampleSchema, signal }),
    enabled: enabled && id.length > 0 && nodeId.length > 0,
    retry: false,
  });
}
