import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { N8nClient } from '../../../../src/modules/m13-workflow/n8n.client';

/**
 * Two seams of the n8n adapter that the main suite cannot reach through a status code: a transport
 * failure during `remove`, which must not bubble (the workflow definition is already gone from the
 * platform's point of view), and the ordering of the two availability guards — `requireAdapters`
 * runs first and already refuses an empty API key, which is why the client's own key check can
 * never fire.
 */
const CONFIG = {
  SEAMNEX_ADAPTERS_MODE: 'real',
  SEAMNEX_N8N_URL: 'http://n8n.test',
  SEAMNEX_N8N_API_KEY: 'api-key',
} as unknown as AppConfig;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('N8nClient.remove', () => {
  it('surfaces a transport failure so the caller can record it, not swallow it', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ id: 'wf-1', name: 'Mail [w-1]' }] }))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5678'));

    // The definition is already gone from the platform's side; `WorkflowService.remove` still deletes
    // the row and records `n8nRemoved: false`, which a swallowed failure would have hidden.
    await expect(new N8nClient(CONFIG).remove('w-1')).rejects.toThrow('ECONNREFUSED');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
  });
});

describe('N8nClient availability guards', () => {
  it('is refused by the shared adapter guard before its own key check is reached', async () => {
    // Both guards test `SEAMNEX_N8N_API_KEY`, and `requireAdapters` runs first — so the message names the
    // setting from `common/adapters`, and the client's own throw is dead code.
    await expect(
      new N8nClient({ ...CONFIG, SEAMNEX_N8N_API_KEY: '' } as AppConfig).upsert('w', {}, true),
    ).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: 'the n8n REST API is not configured (SEAMNEX_N8N_API_KEY is empty).',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
