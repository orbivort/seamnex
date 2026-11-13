import { describe, expect, it, vi } from 'vitest';
import { WorkflowSampleService } from '../../../../src/modules/m13-workflow/sample.service';

/**
 * FR-5.5 — the sample a mapping needs is the item the node *receives*, which n8n stores as the
 * previous node's output. Resolving it from the wrong node is the difference between offering
 * `lead.email` and offering this node's own response.
 */
const WORKFLOW = '6a7088ab-6955-47b2-88a2-797ae750f1a0';
const WRITE = 'e4b0c8f6-1111-4a2b-8c3d-000000000002';
const TRIGGER = 'e4b0c8f6-1111-4a2b-8c3d-000000000001';

function harness(
  options: {
    nodes?: string[];
    sample?: unknown[];
    /** The version's IR, when the test needs a shape the default cannot express. */
    ir?: unknown;
    /** Makes the audit chain refuse the read row. */
    auditFails?: boolean;
  } = {},
) {
  const nodes = (options.nodes ?? [TRIGGER, WRITE]).map((id) => ({ id }));
  const sample = options.sample ?? [];
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('JOIN workflow_version')) {
      if (options.ir === null) return { rows: [] };
      return {
        rows: [{ ir: options.ir ?? { nodes, edges: [{ source: TRIGGER, target: WRITE }] } }],
      };
    }
    return { rows: sample };
  });
  const audit = {
    append: vi.fn(async () => {
      if (options.auditFails === true) throw new Error('audit unavailable');
      return { seq: '1', hash: 'h' };
    }),
  };
  const service = new WorkflowSampleService({ query } as never, audit as never);
  return { service, query, audit };
}

describe('WorkflowSampleService', () => {
  it('returns the inbound source node’s sample for the mapped node', async () => {
    const captured = new Date('2026-11-12T08:41:00.000Z');
    const { service, query } = harness({
      sample: [
        {
          run_id: 'run-1',
          sample_item: { lead: { email: '********' } },
          sample_captured_at: captured,
          sample_truncated: true,
        },
      ],
    });

    const result = await service.latest(WORKFLOW, WRITE, 'actor');

    expect(result).toMatchObject({
      nodeId: WRITE,
      sourceNodeId: TRIGGER,
      runId: 'run-1',
      capturedAt: captured.toISOString(),
      truncated: true,
    });
    expect(query.mock.calls[1]?.[1]).toEqual([WORKFLOW, TRIGGER]);
  });

  it('treats a trigger node as its own source, because its output is the delivery', async () => {
    const { service, query } = harness({ sample: [] });

    const result = await service.latest(WORKFLOW, TRIGGER, 'actor');

    expect(result.sourceNodeId).toBe(TRIGGER);
    expect(query.mock.calls[1]?.[1]).toEqual([WORKFLOW, TRIGGER]);
    expect(result.item).toBeNull();
  });

  it('answers 404 for a node that is not part of the definition', async () => {
    const { service } = harness();

    await expect(service.latest(WORKFLOW, 'not-a-node', 'actor')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('answers 404 for a workflow with no current version', async () => {
    const { service } = harness({ ir: null });

    await expect(service.latest(WORKFLOW, WRITE, 'actor')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: expect.stringContaining('current version'),
    });
  });

  it('treats a definition without an edges array as having no inbound edge', async () => {
    const { service } = harness({ ir: { nodes: [{ id: TRIGGER }] } });

    const result = await service.latest(WORKFLOW, TRIGGER, 'actor');

    expect(result.sourceNodeId).toBe(TRIGGER);
  });

  it('answers the payload even when the audit chain refuses the read row', async () => {
    const { service } = harness({ sample: [], auditFails: true });

    await expect(service.latest(WORKFLOW, WRITE, 'actor')).resolves.toMatchObject({
      nodeId: WRITE,
      runId: null,
    });
  });

  it('audits the read without the item', async () => {
    const { service, audit } = harness({ sample: [] });

    await service.latest(WORKFLOW, WRITE, 'actor');

    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow.sample.read',
        targetId: WORKFLOW,
        detail: expect.objectContaining({ nodeId: WRITE }),
      }),
    );
    expect(JSON.stringify(audit.append.mock.calls[0])).not.toContain('lead');
  });
});
