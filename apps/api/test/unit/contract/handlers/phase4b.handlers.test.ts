import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase4BHandlers } from '../../../../src/contract/handlers/phase4b.handlers';
import type { OperationHandler } from '../../../../src/contract/operation-handler';
import { callHandler, operationInput } from '../../../support/operation-input';

let s: ReturnType<typeof services>;
let handlers: ReadonlyMap<string, OperationHandler>;

function services() {
  return {
    status: {
      containerLogs: vi.fn().mockResolvedValue([{ line: 'boot' }]),
    },
    notifications: {
      channels: vi.fn().mockResolvedValue([{ id: 'c1' }]),
      replaceChannels: vi.fn().mockResolvedValue([{ id: 'c1' }]),
      testChannel: vi.fn().mockResolvedValue({
        ok: true,
        detail: 'delivered',
        deliveredAt: '2026-01-01T00:00:00.000Z',
      }),
    },
  };
}

beforeEach(() => {
  s = services();
  handlers = new Phase4BHandlers(s.status as never, s.notifications as never).handlers();
});

const call = (key: string, overrides = {}) =>
  callHandler(handlers, key, operationInput(key, overrides));

describe('Phase4BHandlers', () => {
  it('tags the group phase-4b', () => {
    expect(new Phase4BHandlers(s.status as never, s.notifications as never).tag).toBe('phase-4b');
  });

  it('GET container logs reads the last 200 lines without shell access', async () => {
    const result = await call('GET /instances/:id/containers/:cid/logs', {
      params: { id: 'i1', cid: 'c1' },
    });

    expect(s.status.containerLogs).toHaveBeenCalledWith('i1', 'c1', 200);
    expect(result).toEqual({ kind: 'body', body: [{ line: 'boot' }] });
  });

  it('refuses container logs without a container id', async () => {
    await expect(
      call('GET /instances/:id/containers/:cid/logs', { params: { id: 'i1' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  it('GET /admin/settings/alerts lists the channels', async () => {
    const result = await call('GET /admin/settings/alerts');
    expect(s.notifications.channels).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: 'body', body: [{ id: 'c1' }] });
  });

  it('PUT /admin/settings/alerts replaces them as the caller', async () => {
    const body = [{ id: 'c1', kind: 'email', target: 'ops@example.test' }];
    const result = await call('PUT /admin/settings/alerts', { body });

    expect(s.notifications.replaceChannels).toHaveBeenCalledWith(body, 'sub-1');
    expect(result).toEqual({ kind: 'body', body: [{ id: 'c1' }] });
  });

  it('POST /admin/settings/alerts/:id/test reports the delivery result', async () => {
    const result = await call('POST /admin/settings/alerts/:id/test', { params: { id: 'c1' } });

    expect(s.notifications.testChannel).toHaveBeenCalledWith('c1');
    expect(result).toEqual({
      kind: 'body',
      body: {
        channelId: 'c1',
        ok: true,
        detail: 'delivered',
        deliveredAt: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it('refuses a test without a channel id', async () => {
    await expect(
      call('POST /admin/settings/alerts/:id/test', { params: {} }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('implements the four 4B operations', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'GET /admin/settings/alerts',
      'GET /instances/:id/containers/:cid/logs',
      'POST /admin/settings/alerts/:id/test',
      'PUT /admin/settings/alerts',
    ]);
  });
});
