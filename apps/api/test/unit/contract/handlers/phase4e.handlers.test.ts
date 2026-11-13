import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase4EHandlers } from '../../../../src/contract/handlers/phase4e.handlers';
import type { OperationHandler } from '../../../../src/contract/operation-handler';
import { callHandler, operationInput } from '../../../support/operation-input';

let s: ReturnType<typeof services>;
let handlers: ReadonlyMap<string, OperationHandler>;

function services() {
  return {
    authoring: {
      create: vi.fn().mockResolvedValue({ id: 'w1' }),
      importDocument: vi.fn().mockResolvedValue({ id: 'w1' }),
      action: vi.fn().mockResolvedValue({ value: { kind: 'run', id: 'r1' } }),
      addNode: vi.fn().mockResolvedValue({ id: 'w1' }),
      patchNode: vi.fn().mockResolvedValue({ id: 'w1' }),
      removeNode: vi.fn().mockResolvedValue({ id: 'w1' }),
      setMappings: vi.fn().mockResolvedValue({ id: 'w1' }),
      setTrigger: vi.fn().mockResolvedValue({ id: 'w1' }),
      replay: vi.fn().mockResolvedValue({ id: 'r2' }),
      decideApproval: vi.fn().mockResolvedValue({ id: 'r1' }),
    },
    broker: {
      mint: vi.fn().mockResolvedValue({ scopeId: 'cs1', secret: 's' }),
      revoke: vi.fn().mockResolvedValue(undefined),
    },
    triggers: {
      list: vi.fn().mockResolvedValue([]),
      register: vi.fn().mockResolvedValue({ id: 't1' }),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  };
}

beforeEach(() => {
  s = services();
  handlers = new Phase4EHandlers(
    s.authoring as never,
    s.broker as never,
    s.triggers as never,
  ).handlers();
});

const call = (key: string, overrides = {}) =>
  callHandler(handlers, key, operationInput(key, overrides));

describe('workflow authoring', () => {
  it('POST /workflows creates the draft as the caller', async () => {
    const body = {
      name: 'mail sync',
      triggerType: 'schedule',
      sourceInstanceId: 'i1',
      targetInstanceId: 'i2',
    };
    const result = await call('POST /workflows', { body });

    expect(s.authoring.create).toHaveBeenCalledWith(body, 'sub-1');
    expect(result).toEqual({ kind: 'body', body: { id: 'w1' } });
  });

  it('POST /workflows/import imports the document', async () => {
    const body = { document: { nodes: [] } };
    await call('POST /workflows/import', { body });
    expect(s.authoring.importDocument).toHaveBeenCalledWith(body, 'sub-1');
  });

  it('POST /workflows/:id/:action returns the action value', async () => {
    const result = await call('POST /workflows/:id/:action', {
      params: { id: 'w1', action: 'run' },
    });

    expect(s.authoring.action).toHaveBeenCalledWith('w1', 'run', 'sub-1', undefined);
    expect(result).toEqual({ kind: 'body', body: { kind: 'run', id: 'r1' } });
  });

  it('POST /workflows/:id/:action forwards the caller idempotency key', async () => {
    // A retried submit carries the same key, so the run it already created is returned instead of
    // a second execution of the same write workflow.
    await call('POST /workflows/:id/:action', {
      params: { id: 'w1', action: 'run' },
      headers: { 'idempotency-key': 'submit-1234' },
    });

    expect(s.authoring.action).toHaveBeenCalledWith('w1', 'run', 'sub-1', 'submit-1234');
  });

  it('POST /workflows/:id/nodes adds a node', async () => {
    const body = { operation: 'GET /jobs' };
    await call('POST /workflows/:id/nodes', { params: { id: 'w1' }, body });
    expect(s.authoring.addNode).toHaveBeenCalledWith('w1', body, 'sub-1');
  });

  it('PATCH /workflows/:id/nodes/:nodeId patches the node', async () => {
    const body = { label: 'renamed' };
    await call('PATCH /workflows/:id/nodes/:nodeId', {
      params: { id: 'w1', nodeId: 'n1' },
      body,
    });
    expect(s.authoring.patchNode).toHaveBeenCalledWith('w1', 'n1', body, 'sub-1');
  });

  it('DELETE /workflows/:id/nodes/:nodeId removes the node', async () => {
    await call('DELETE /workflows/:id/nodes/:nodeId', { params: { id: 'w1', nodeId: 'n1' } });
    expect(s.authoring.removeNode).toHaveBeenCalledWith('w1', 'n1', 'sub-1');
  });

  it('PUT /workflows/:id/nodes/:nodeId/mappings replaces the mappings', async () => {
    const mappings = [{ from: 'a', to: 'b' }];
    await call('PUT /workflows/:id/nodes/:nodeId/mappings', {
      params: { id: 'w1', nodeId: 'n1' },
      body: { mappings },
    });
    expect(s.authoring.setMappings).toHaveBeenCalledWith('w1', 'n1', mappings, 'sub-1');
  });

  it('PUT /workflows/:id/trigger sets the trigger', async () => {
    const body = { triggerType: 'schedule' };
    await call('PUT /workflows/:id/trigger', { params: { id: 'w1' }, body });
    expect(s.authoring.setTrigger).toHaveBeenCalledWith('w1', body, 'sub-1');
  });

  it('POST /workflow-runs/:runId/replay replays the run', async () => {
    const result = await call('POST /workflow-runs/:runId/replay', { params: { runId: 'r1' } });
    expect(s.authoring.replay).toHaveBeenCalledWith('r1', 'sub-1');
    expect(result).toEqual({ kind: 'body', body: { id: 'r2' } });
  });

  it('POST /workflow-approvals/:token/decision forwards the decision', async () => {
    await call('POST /workflow-approvals/:token/decision', {
      params: { token: 'tok' },
      body: { decision: 'approve' },
    });
    expect(s.authoring.decideApproval).toHaveBeenCalledWith('tok', 'approve', 'sub-1');
  });

  it('refuses an authoring edit without its path parameter', async () => {
    await expect(
      call('PATCH /workflows/:id/nodes/:nodeId', { params: { id: 'w1' }, body: {} }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('triggers and credential scopes', () => {
  it('GET /instances/:id/triggers lists the endpoints', async () => {
    const result = await call('GET /instances/:id/triggers', { params: { id: 'i1' } });
    expect(s.triggers.list).toHaveBeenCalledWith('i1');
    expect(result).toEqual({ kind: 'body', body: [] });
  });

  it('POST /instances/:id/triggers registers with or without a workflow', async () => {
    await call('POST /instances/:id/triggers', {
      params: { id: 'i1' },
      body: { eventName: 'push', workflowId: 'w1' },
    });
    expect(s.triggers.register).toHaveBeenCalledWith(
      'i1',
      { eventName: 'push', workflowId: 'w1' },
      'sub-1',
    );

    await call('POST /instances/:id/triggers', {
      params: { id: 'i1' },
      body: { eventName: 'push' },
    });
    expect(s.triggers.register).toHaveBeenLastCalledWith('i1', { eventName: 'push' }, 'sub-1');
  });

  it('DELETE /instances/:id/triggers/:triggerId revokes and answers 204', async () => {
    const result = await call('DELETE /instances/:id/triggers/:triggerId', {
      params: { id: 'i1', triggerId: 't1' },
    });

    expect(s.triggers.remove).toHaveBeenCalledWith('t1', 'sub-1');
    expect(result).toEqual({ kind: 'noContent' });
  });

  it('POST /instances/:id/credential-scopes mints with the default ttl', async () => {
    const result = await call('POST /instances/:id/credential-scopes', {
      params: { id: 'i1' },
      body: {
        workflowId: 'w1',
        operations: ['GET /jobs'],
        mode: 'read',
      },
    });

    expect(s.broker.mint).toHaveBeenCalledWith({
      instanceId: 'i1',
      workflowId: 'w1',
      operations: ['GET /jobs'],
      mode: 'read',
      ttlSeconds: 90 * 24 * 60 * 60,
    });
    expect(result).toMatchObject({ kind: 'body', body: { instanceId: 'i1', scopeId: 'cs1' } });
  });

  it('POST /instances/:id/credential-scopes forwards an explicit ttl and idempotency key', async () => {
    await call('POST /instances/:id/credential-scopes', {
      params: { id: 'i1' },
      body: {
        workflowId: 'w1',
        operations: ['POST /jobs'],
        mode: 'write',
        ttlSeconds: 60,
        idempotencyKey: 'idem-1',
      },
    });

    expect(s.broker.mint).toHaveBeenCalledWith({
      instanceId: 'i1',
      workflowId: 'w1',
      operations: ['POST /jobs'],
      mode: 'write',
      ttlSeconds: 60,
      idempotencyKey: 'idem-1',
    });
  });

  it('DELETE /credential-scopes/:id revokes and answers 204', async () => {
    const result = await call('DELETE /credential-scopes/:id', { params: { id: 'cs1' } });
    expect(s.broker.revoke).toHaveBeenCalledWith('cs1', 'sub-1');
    expect(result).toEqual({ kind: 'noContent' });
  });

  it('refuses a scope deletion without an id', async () => {
    await expect(call('DELETE /credential-scopes/:id', { params: {} })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('phase 4e registry', () => {
  it('implements every 4E operation, including the two field-discovery reads', () => {
    // 15 authoring operations + the field list and the node sample the mapping workbench reads.
    expect(handlers.size).toBe(17);
  });
});
