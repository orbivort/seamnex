import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { N8nClient } from '../../../../src/modules/m13-workflow/n8n.client';

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

describe('N8nClient.upsert', () => {
  it('updates an existing workflow by its name suffix, then activates it', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ id: 'wf-1', name: 'Mail [w-1]' }] }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({}));

    const id = await new N8nClient(CONFIG).upsert('w-1', { nodes: [] }, true);

    expect(id).toBe('wf-1');
    expect(fetchMock.mock.calls.map((call) => `${call[1]?.method} ${call[0]}`)).toEqual([
      'GET http://n8n.test/api/v1/workflows?limit=250',
      'PUT http://n8n.test/api/v1/workflows/wf-1',
      'POST http://n8n.test/api/v1/workflows/wf-1/activate',
    ]);
  });

  it('updates the recorded id without listing n8n first', async () => {
    fetchMock.mockResolvedValueOnce(json({}));

    expect(await new N8nClient(CONFIG).upsert('w-2', {}, false, 'wf-stored')).toBe('wf-stored');
    expect(fetchMock.mock.calls.map((call) => `${call[1]?.method} ${call[0]}`)).toEqual([
      'PUT http://n8n.test/api/v1/workflows/wf-stored',
    ]);
  });

  it('recreates a workflow whose recorded id was deleted in n8n', async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ id: 'wf-new' }));

    expect(await new N8nClient(CONFIG).upsert('w-6', { nodes: [] }, false, 'wf-gone')).toBe(
      'wf-new',
    );
  });

  it('does not repair a failure that is not a 404, so a 502 cannot mint a duplicate', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 502));

    await expect(new N8nClient(CONFIG).upsert('w-7', {}, false, 'wf-stored')).rejects.toMatchObject(
      {
        detail: expect.stringContaining('502'),
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates the workflow when none matches, then updates and activates it', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ id: 'wf-3' }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({}));

    const id = await new N8nClient(CONFIG).upsert('w-3', { nodes: [] }, true);

    expect(id).toBe('wf-3');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://n8n.test/api/v1/workflows');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('refuses when n8n creates a workflow without an id', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [] })).mockResolvedValueOnce(json({}));

    await expect(new N8nClient(CONFIG).upsert('w-4', {}, true)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('did not return a workflow id'),
    });
  });

  it('tolerates a listing with no data member', async () => {
    fetchMock
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ id: 'wf-5' }))
      .mockResolvedValueOnce(json({}));

    expect(await new N8nClient(CONFIG).upsert('w-5', {}, false)).toBe('wf-5');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://n8n.test/api/v1/workflows');
  });
});

describe('N8nClient lifecycle calls', () => {
  it('deactivates a workflow that exists', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ id: 'wf-1', name: '[w-1]' }] }))
      .mockResolvedValueOnce(json({}));

    await new N8nClient(CONFIG).deactivate('w-1');

    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://n8n.test/api/v1/workflows/wf-1/deactivate');
  });

  it('refuses when the workflow to deactivate is unknown, so a disable cannot claim success', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [] }));

    await expect(new N8nClient(CONFIG).deactivate('w-1')).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('holds no workflow'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed deactivate instead of swallowing it', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ id: 'wf-1', name: '[w-1]' }] }))
      .mockResolvedValueOnce(json({}, 500));

    await expect(new N8nClient(CONFIG).deactivate('w-1')).rejects.toMatchObject({
      detail: expect.stringContaining('500'),
    });
  });

  it('removes a workflow that exists and reports that it did', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ id: 'wf-1', name: '[w-1]' }] }))
      .mockResolvedValueOnce(json({}, 404));

    await expect(new N8nClient(CONFIG).remove('w-1')).resolves.toBe(true);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('reports no removal when the workflow is unknown', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [] }));

    await expect(new N8nClient(CONFIG).remove('w-1')).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('delivers to the queue-mode webhook route, which carries the workflow id', async () => {
    // `POST /api/v1/workflows/:id/run` does not exist in n8n's public API and answers 405; a manual
    // run is a webhook delivery, and queue mode registers it as `<id>/<node>/<path>`.
    fetchMock.mockResolvedValueOnce(json({ message: 'Workflow was started' }));

    await expect(new N8nClient(CONFIG).trigger('wf-1', 'platform-wf')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://n8n.test/webhook/wf-1/trigger/platform-wf');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('falls back to the bare webhook path of a single-process deployment', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({ ok: true }));

    await expect(new N8nClient(CONFIG).trigger('wf-1', 'platform-wf')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('http://n8n.test/webhook/platform-wf');
  });

  it('refuses when neither route is registered, so a run is not reported as started', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({}, 404));

    await expect(new N8nClient(CONFIG).trigger('wf-1', 'platform-wf')).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('no webhook registered'),
    });
  });

  it('surfaces a refused trigger without retrying the bare path', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));

    await expect(new N8nClient(CONFIG).trigger('wf-1', 'platform-wf')).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('500'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads execution history and defaults an absent list', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        data: [{ id: 7, finished: true, status: 'success', startedAt: '2026-11-09T15:00:00.000Z' }],
      }),
    );
    // The id is normalised to a string and `startedAt` is what the mirror matches a run against.
    expect(await new N8nClient(CONFIG).executions('w 1', 5)).toEqual([
      { id: '7', finished: true, status: 'success', startedAt: '2026-11-09T15:00:00.000Z' },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('workflowId=w%201&limit=5');

    fetchMock.mockResolvedValueOnce(json({}));
    expect(await new N8nClient(CONFIG).executions('w-1')).toEqual([]);
  });

  it('reads one execution with the per-node result', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        status: 'error',
        stoppedAt: '2026-11-09T15:00:00.700Z',
        data: {
          resultData: {
            error: { message: 'Invalid URL: /employees.read.' },
            runData: {
              Trigger: [
                { executionStatus: 'success', executionTime: 1, data: { main: [[{ json: {} }]] } },
              ],
              'Read employees': [
                {
                  executionStatus: 'error',
                  executionTime: 4,
                  error: { message: 'Invalid URL: /employees.read.' },
                  data: { main: [[]] },
                },
              ],
            },
          },
        },
      }),
    );

    const result = await new N8nClient(CONFIG).execution('5');
    expect(result).toMatchObject({
      status: 'error',
      error: 'Invalid URL: /employees.read.',
      // The mirror stamps `finished_at` from this, so it must survive the payload shape.
      stoppedAt: '2026-11-09T15:00:00.700Z',
    });
    expect(result.nodes).toEqual([
      // The item itself rides along: the mirror stores it (redacted) so the mapper can offer real
      // field paths. `{}` is an item with no keys — a path still has nothing to point at, and the
      // mirror writes `{}` rather than pretending the node produced data.
      { name: 'Trigger', state: 'succeeded', durationMs: 1, records: 1, error: null, sample: {} },
      {
        name: 'Read employees',
        state: 'failed',
        durationMs: 4,
        records: 0,
        error: 'Invalid URL: /employees.read.',
        // n8n returned no items for the failed node, so there is no sample — not an empty object.
        sample: null,
      },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/executions/5?includeData=true');
  });

  it("carries the product's own refusal, not only n8n's summary", async () => {
    // Measured: a write refused by EspoCRM reported `Bad request - please check your parameters`,
    // which names neither the product nor the field. The product's answer is in `description` and the
    // status in `httpCode`, so a run record built from `message` alone hid the whole cause.
    const refusal = {
      message: 'Bad request - please check your parameters',
      httpCode: '400',
      description: '400 - {"validationFailure":{"field":"lastName"}}',
    };
    fetchMock.mockResolvedValueOnce(
      json({
        status: 'error',
        data: {
          resultData: {
            error: refusal,
            runData: {
              'Create contact': [{ executionStatus: 'error', executionTime: 329, error: refusal }],
            },
          },
        },
      }),
    );

    const result = await new N8nClient(CONFIG).execution('6');

    expect(result.error).toBe(
      'Bad request - please check your parameters: 400 - {"validationFailure":{"field":"lastName"}}',
    );
    expect(result.nodes[0]?.error).toContain('validationFailure');
  });

  it('reads the product body out of `messages` when a 409 carries no description', async () => {
    // A duplicate refusal arrives as 409 with the existing record in `messages`: n8n's summary is
    // "Your request is invalid or could not be processed by the service", which names nothing.
    const refusal = {
      message: 'Your request is invalid or could not be processed by the service',
      httpCode: '409',
      messages: ['409 - "[{\\"id\\":\\"6af48dc1f245bc353\\",\\"name\\":\\"Dev Admin\\"}]"'],
    };
    fetchMock.mockResolvedValueOnce(
      json({ status: 'error', data: { resultData: { error: refusal, runData: {} } } }),
    );

    const result = await new N8nClient(CONFIG).execution('7');

    expect(result.error).toContain('409 - "[{\\"id\\":\\"6af48dc1f245bc353');
    expect(result.error).toContain('Dev Admin');
  });

  it('keeps a short message readable when n8n truncates nothing', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        status: 'error',
        data: { resultData: { error: { message: 'boom', messages: [''] }, runData: {} } },
      }),
    );

    const result = await new N8nClient(CONFIG).execution('8');

    expect(result.error).toBe('boom');
  });
});

describe('N8nClient credentials', () => {
  it('reports readiness from its configuration instead of throwing at the poller', () => {
    expect(new N8nClient(CONFIG).ready()).toBe(true);
    expect(new N8nClient({ ...CONFIG, SEAMNEX_N8N_API_KEY: '' } as AppConfig).ready()).toBe(false);
    expect(
      new N8nClient({ ...CONFIG, SEAMNEX_ADAPTERS_MODE: 'disabled' } as AppConfig).ready(),
    ).toBe(false);
  });

  it('creates the broker credential the compiled nodes resolve', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'cred-1' }));

    await expect(
      new N8nClient(CONFIG).createCredential('Seamnex broker', 'seamnex_token'),
    ).resolves.toBe('cred-1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://n8n.test/api/v1/credentials');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: 'Seamnex broker',
      type: 'httpHeaderAuth',
      data: { name: 'Authorization', value: 'Bearer seamnex_token' },
    });
  });

  it('refuses a credential response without an id, because nothing could be activated', async () => {
    fetchMock.mockResolvedValueOnce(json({}));

    await expect(new N8nClient(CONFIG).createCredential('name', 'token')).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('did not return a credential id'),
    });
  });

  it('removes a rotated credential by its encoded id', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404));

    await expect(new N8nClient(CONFIG).removeCredential('cred/one')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://n8n.test/api/v1/credentials/cred%2Fone');
  });
});

describe('N8nClient execution parsing', () => {
  it('defaults what n8n omitted instead of inventing a verdict', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: 1 }] }));
    await expect(new N8nClient(CONFIG).executions('w-1')).resolves.toEqual([
      { id: '1', finished: false, status: 'unknown', startedAt: '' },
    ]);

    fetchMock.mockResolvedValueOnce(json({}));
    await expect(new N8nClient(CONFIG).execution('9')).resolves.toEqual({
      status: 'unknown',
      stoppedAt: null,
      nodes: [],
      error: null,
    });
  });

  it('keeps a node with no runs as an empty success rather than dropping it', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ status: 'success', data: { resultData: { runData: { Empty: [] } } } }),
    );

    const result = await new N8nClient(CONFIG).execution('10');

    expect(result.nodes).toEqual([
      { name: 'Empty', state: 'succeeded', durationMs: 0, records: 0, error: null, sample: null },
    ]);
  });

  it('counts items but stores no sample when the item carries no json object', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        status: 'running',
        data: {
          resultData: {
            runData: {
              Primitive: [
                {
                  executionStatus: 'success',
                  executionTime: 2,
                  data: { main: [[{ json: 'scalar' }, { json: ['array'] }]] },
                },
              ],
            },
          },
        },
      }),
    );

    const result = await new N8nClient(CONFIG).execution('11');

    expect(result.nodes[0]).toMatchObject({ records: 2, sample: null });
  });

  it('keeps the description alone when n8n sent no summary', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ status: 'error', data: { resultData: { error: { description: '400 - nope' } } } }),
    );

    await expect(new N8nClient(CONFIG).execution('12')).resolves.toMatchObject({
      error: '400 - nope',
    });
  });

  it('does not repeat a description that is already the summary', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        status: 'error',
        data: { resultData: { error: { message: 'same', description: 'same' } } },
      }),
    );

    await expect(new N8nClient(CONFIG).execution('13')).resolves.toMatchObject({ error: 'same' });
  });

  it('qualifies the product answer with the status code only when it does not carry it', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          status: 'error',
          data: {
            resultData: { error: { message: 'refused', description: 'field x', httpCode: '422' } },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          status: 'error',
          data: {
            resultData: {
              error: { message: 'refused', description: '422 - field x', httpCode: '422' },
            },
          },
        }),
      );

    const client = new N8nClient(CONFIG);
    await expect(client.execution('14')).resolves.toMatchObject({
      error: 'refused: 422 field x',
    });
    await expect(client.execution('15')).resolves.toMatchObject({
      error: 'refused: 422 - field x',
    });
  });

  it('truncates a long product body so a table cell stays readable', async () => {
    const long = 'x'.repeat(500);
    fetchMock.mockResolvedValueOnce(
      json({ status: 'error', data: { resultData: { error: { messages: ['', long] } } } }),
    );

    const result = await new N8nClient(CONFIG).execution('16');

    expect(result.error).toHaveLength(401);
    expect(result.error?.endsWith('…')).toBe(true);
  });

  it('drops a messages member that carries no non-empty string', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        status: 'error',
        data: { resultData: { error: { message: 'plain', messages: [42, ''] } } },
      }),
    );

    await expect(new N8nClient(CONFIG).execution('17')).resolves.toMatchObject({
      error: 'plain',
    });
  });
});

describe('N8nClient request guard', () => {
  it('refuses when the adapter is disabled', async () => {
    await expect(
      new N8nClient({ ...CONFIG, SEAMNEX_ADAPTERS_MODE: 'disabled' } as AppConfig).upsert(
        'w',
        {},
        true,
      ),
    ).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when no API key is configured, naming the setting', async () => {
    await expect(
      new N8nClient({ ...CONFIG, SEAMNEX_N8N_API_KEY: '' } as AppConfig).upsert('w', {}, true),
    ).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('SEAMNEX_N8N_API_KEY'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a failed non-DELETE call with the status in the detail', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 502));
    await expect(new N8nClient(CONFIG).upsert('w', {}, false)).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('502'),
    });
  });

  it('sends the API key and a JSON content type only when there is a body', async () => {
    fetchMock.mockResolvedValue(json({ data: [{ id: 'wf-1', name: '[w]' }] }));
    await new N8nClient(CONFIG).upsert('w', { nodes: [] }, false);

    const listing = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(listing.headers).toMatchObject({ 'X-N8N-API-KEY': 'api-key' });
    expect(listing.headers).not.toHaveProperty('content-type');

    const update = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(update.headers).toMatchObject({
      'X-N8N-API-KEY': 'api-key',
      'content-type': 'application/json',
    });
    expect(update.body).toBe(JSON.stringify({ nodes: [] }));
  });
});
