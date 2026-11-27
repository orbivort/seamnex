import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProblemDetail } from '@seamnex/domain';
import {
  ApiError,
  configureTransport,
  isAbortError,
  lastKnownStatusAt,
  onUnauthorized,
  openDownload,
  openEventStream,
  request,
  resetTransport,
  toProblem,
} from '../../src/http';
import { openInstanceExport } from '../../src/hooks/instances';
import type { Transport } from '../../src/transport';

/**
 * The parts of the pipeline a screen depends on but `http.test.ts` does not reach: the request
 * headers (idempotency, CSRF, preconditions), the response side effects (ETag, success mark,
 * lapsed-session signal), the query validator, and the event-stream opener.
 */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

function respond(response: Response): Transport {
  return async () => response;
}

function problemDocument(status: number, code: string, detail = 'Refused.'): string {
  const problem: ProblemDetail = {
    type: 'https://platform.seamnex.local/problems/x',
    title: 'Refused',
    status,
    detail,
    code,
    fieldErrors: [],
    remediation: 'Retry.',
  };
  return JSON.stringify(problem);
}

function capture(): { transport: Transport; calls: Parameters<Transport>[0][] } {
  const calls: Parameters<Transport>[0][] = [];
  const transport: Transport = async (input) => {
    calls.push(input);
    return new Response(JSON.stringify({ sessionIdleMinutes: 30 }), { status: 200 });
  };
  return { transport, calls };
}

beforeEach(() => {
  const storage = memoryStorage();
  vi.stubGlobal('sessionStorage', storage);
  vi.stubGlobal('window', {
    sessionStorage: storage,
    dispatchEvent: vi.fn(() => true),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('document', { cookie: '' });
});

afterEach(() => {
  resetTransport();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('success mark', () => {
  it('records when the API last answered, for the offline notice', async () => {
    configureTransport(respond(new Response(null, { status: 204 })));

    await request('/me/logout', { method: 'POST' });

    const mark = lastKnownStatusAt();
    expect(mark).not.toBeNull();
    expect(Number.isNaN(Date.parse(mark ?? ''))).toBe(false);
  });
});

describe('request headers', () => {
  it('sends an idempotency key on every mutation, and the caller key when given', async () => {
    const { transport, calls } = capture();
    configureTransport(transport);

    await request('/admin/settings', { method: 'PUT', body: { sessionIdleMinutes: 30 } });
    await request('/admin/settings', {
      method: 'PUT',
      body: { sessionIdleMinutes: 30 },
      idempotencyKey: 'caller-key',
    });
    await request('/admin/settings', {});

    expect(calls[0]?.headers?.['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1]?.headers?.['Idempotency-Key']).toBe('caller-key');
    // A read carries no replay key: there is nothing to replay.
    expect(calls[2]?.headers?.['Idempotency-Key']).toBeUndefined();
  });

  it('echoes the readable CSRF cookie on mutations', async () => {
    document.cookie = 'other=1; seamnex_csrf=token%2B1';
    const { transport, calls } = capture();
    configureTransport(transport);

    await request('/admin/settings', { method: 'PUT', body: { sessionIdleMinutes: 30 } });

    expect(calls[0]?.headers?.['x-seamnex-csrf']).toBe('token+1');
  });

  it('sends no CSRF header when the cookie is absent or undecodable', async () => {
    const { transport, calls } = capture();
    configureTransport(transport);

    await request('/admin/settings', { method: 'PUT', body: { sessionIdleMinutes: 30 } });
    expect(calls[0]?.headers?.['x-seamnex-csrf']).toBeUndefined();

    document.cookie = 'seamnex_csrf=%E0%A4%A';
    await request('/admin/settings', { method: 'PUT', body: { sessionIdleMinutes: 31 } });
    expect(calls[1]?.headers?.['x-seamnex-csrf']).toBeUndefined();
  });

  it('uses the ETag of the last read as the precondition, and an explicit one when given', async () => {
    const settings = z.object({ sessionIdleMinutes: z.number() });
    const { transport, calls } = capture();
    configureTransport(transport);

    // The GET stored the tag; the conditional PUT must offer it back.
    configureTransport(
      respond(
        new Response(JSON.stringify({ sessionIdleMinutes: 30 }), {
          status: 200,
          headers: { ETag: '"v1"' },
        }),
      ),
    );
    await request('/admin/settings', { schema: settings });

    configureTransport(transport);
    await request('/admin/settings', {
      schema: settings,
      method: 'PUT',
      body: { sessionIdleMinutes: 30 },
    });
    expect(calls[0]?.headers?.['If-Match']).toBe('"v1"');

    await request('/admin/settings', {
      schema: settings,
      method: 'PUT',
      body: { sessionIdleMinutes: 30 },
      ifMatch: '"explicit"',
    });
    expect(calls[1]?.headers?.['If-Match']).toBe('"explicit"');
  });

  it('sends no precondition when the stored ETag cannot be read', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    const { transport, calls } = capture();
    configureTransport(transport);

    await request('/admin/settings', { method: 'PUT', body: { sessionIdleMinutes: 30 } });

    // Optimistic concurrency degrades to a plain write rather than failing the mutation.
    expect(calls[0]?.headers?.['If-Match']).toBeUndefined();
  });

  it('mints an idempotency key without a UUID source', async () => {
    // A hardened runtime may expose `crypto` without `randomUUID`; the key must still be unique
    // enough to replay one request rather than the whole session.
    vi.stubGlobal('crypto', {});
    const { transport, calls } = capture();
    configureTransport(transport);

    await request('/admin/settings', { method: 'PUT', body: { sessionIdleMinutes: 30 } });

    expect(calls[0]?.headers?.['Idempotency-Key']).toMatch(/^idem-\d+-\d+$/);
  });

  it('clears a stored ETag when a later read has none', async () => {
    const settings = z.object({ sessionIdleMinutes: z.number() });
    configureTransport(
      respond(
        new Response(JSON.stringify({ sessionIdleMinutes: 30 }), {
          status: 200,
          headers: { ETag: '"v2"' },
        }),
      ),
    );
    await request('/admin/settings', { schema: settings });
    expect(sessionStorage.getItem('seamnex:etag:/admin/settings')).toBe('"v2"');

    configureTransport(respond(new Response(JSON.stringify({ sessionIdleMinutes: 30 }))));
    await request('/admin/settings', { schema: settings });

    expect(sessionStorage.getItem('seamnex:etag:/admin/settings')).toBeNull();
  });
});

describe('query validation', () => {
  it('refuses a value outside the declared set, and a mistyped integer', async () => {
    await expect(request('/catalog?packaging=snap', {})).rejects.toMatchObject({
      problem: { code: 'REQUEST_CONTRACT', fieldErrors: [{ field: 'packaging', code: 'enum' }] },
    });
    await expect(request('/jobs?limit=lots', {})).rejects.toMatchObject({
      problem: { code: 'REQUEST_CONTRACT', fieldErrors: [{ field: 'limit', code: 'type' }] },
    });
  });

  it('refuses a query value that is not true or false', async () => {
    await expect(request('/instances/inst-crm/status?refresh=yes', {})).rejects.toMatchObject({
      problem: { fieldErrors: [{ field: 'refresh', code: 'type' }] },
    });
  });

  it('accepts the declared values', async () => {
    // A fresh response per call: a Response body can be read only once.
    configureTransport(async () => new Response(JSON.stringify([]), { status: 200 }));
    await expect(
      request('/catalog?packaging=compose', { schema: z.array(z.unknown()) }),
    ).resolves.toEqual([]);
    await expect(request('/jobs?limit=10', { schema: z.array(z.unknown()) })).resolves.toEqual([]);
    await expect(
      request('/instances/inst-crm/status?refresh=true', { schema: z.array(z.unknown()) }),
    ).resolves.toEqual([]);
  });
});

describe('lapsed session', () => {
  it('signals a 401 on a data call and clears the asserted role', async () => {
    sessionStorage.setItem('seamnex:asserted-role', 'R1');
    configureTransport(respond(new Response('', { status: 401 })));

    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    await request('/me', {}).catch(() => undefined);

    expect(window.dispatchEvent).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('seamnex:asserted-role')).toBeNull();

    // The bridge turns the DOM event back into the problem a screen renders.
    const addEventListener = window.addEventListener as unknown as {
      mock: { calls: unknown[][] };
    };
    const handler = addEventListener.mock.calls[0]?.[1] as (event: Event) => void;
    const detail = { title: 'expired' };
    handler({ detail } as unknown as Event);
    handler({} as Event);
    expect(listener).toHaveBeenCalledWith(detail);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(window.removeEventListener).toHaveBeenCalled();
  });

  it('does not treat the sign-in exchange as a lapsed session', async () => {
    configureTransport(
      respond(
        new Response(problemDocument(401, 'MFA_REQUIRED'), {
          status: 401,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
      ),
    );

    await request('/auth/session', {
      method: 'POST',
      body: {
        code: 'stub:lena',
        codeVerifier: 'a'.repeat(43),
        codeChallenge: 'b'.repeat(43),
        redirectUri: 'https://portal.seamnex.local/sign-in',
      },
    }).catch(() => undefined);

    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it('normalises a 401 without a problem body into an UNAUTHORIZED problem', async () => {
    configureTransport(respond(new Response('nope', { status: 401 })));

    const error = await request('/me', {}).catch((thrown: unknown) => thrown);
    expect((error as ApiError).problem.code).toBe('UNAUTHORIZED');
    expect((error as ApiError).problem.status).toBe(401);
  });

  it('has no subscription surface outside a browser', async () => {
    vi.stubGlobal('window', undefined);
    expect(onUnauthorized(() => undefined)()).toBeUndefined();
    // The 401 still normalises; there is simply nowhere to announce it.
    configureTransport(respond(new Response('', { status: 401 })));
    await expect(request('/me', {})).rejects.toBeInstanceOf(ApiError);
  });
});

describe('Retry-After', () => {
  it('parses both the seconds and the HTTP-date form', async () => {
    configureTransport(
      respond(
        new Response(problemDocument(429, 'RATE_LIMITED'), {
          status: 429,
          headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '7' },
        }),
      ),
    );
    const seconds = await request('/me', {}).catch((thrown: unknown) => thrown);
    expect((seconds as ApiError).retryAfterMs).toBe(7_000);

    const future = new Date(Date.now() + 30_000).toUTCString();
    configureTransport(
      respond(
        new Response(problemDocument(429, 'RATE_LIMITED'), {
          status: 429,
          headers: { 'Content-Type': 'application/problem+json', 'Retry-After': future },
        }),
      ),
    );
    const date = await request('/me', {}).catch((thrown: unknown) => thrown);
    expect((date as ApiError).retryAfterMs).toBeGreaterThan(0);

    configureTransport(
      respond(
        new Response(problemDocument(429, 'RATE_LIMITED'), {
          status: 429,
          headers: { 'Content-Type': 'application/problem+json', 'Retry-After': 'soon' },
        }),
      ),
    );
    const invalid = await request('/me', {}).catch((thrown: unknown) => thrown);
    expect((invalid as ApiError).retryAfterMs).toBeNull();
  });
});

describe('payload shapes', () => {
  it('returns the payload when the operation declares no response schema', async () => {
    configureTransport(respond(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(request('/instances', {})).resolves.toBeDefined();
  });

  it('turns an empty or unparseable success body into null rather than throwing', async () => {
    configureTransport(respond(new Response('<html>', { status: 200 })));
    await expect(request('/instances', {})).resolves.toBeNull();
  });

  it('keeps an abort an abort and exposes the guard', () => {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(isAbortError(aborted)).toBe(true);
    expect(isAbortError(new Error('nope'))).toBe(false);
    expect(isAbortError('nope')).toBe(false);
  });

  it('uses the default detail when the failure carries no message', () => {
    expect(toProblem(new Error('')).detail).toBe('No response was received from the API.');
  });
});

describe('openEventStream', () => {
  it('asks for an event stream and forwards resume headers', async () => {
    const calls: Parameters<Transport>[0][] = [];
    configureTransport(async (input) => {
      calls.push(input);
      return new Response('data: {}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const response = await openEventStream('/jobs/job-1/stream', undefined, {
      'Last-Event-ID': '42',
    });

    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': '42' },
    });
  });

  it('reports a refused stream with the problem the server sent', async () => {
    configureTransport(
      respond(
        new Response(problemDocument(404, 'JOB_NOT_FOUND', 'No such job.'), {
          status: 404,
          headers: { 'Content-Type': 'application/problem+json' },
        }),
      ),
    );

    const error = await openEventStream('/jobs/x/stream').catch((thrown: unknown) => thrown);
    expect((error as ApiError).problem.code).toBe('JOB_NOT_FOUND');
    expect((error as ApiError).problem.detail).toBe('No such job.');
  });

  it('normalises a refusal with no problem body, and a network failure', async () => {
    configureTransport(respond(new Response('gateway down', { status: 502 })));
    const refused = await openEventStream('/jobs/x/stream').catch((thrown: unknown) => thrown);
    expect((refused as ApiError).problem.code).toBe('UNEXPECTED_RESPONSE');

    configureTransport(async () => {
      throw new TypeError('fetch failed');
    });
    const failed = await openEventStream('/jobs/x/stream').catch((thrown: unknown) => thrown);
    expect((failed as ApiError).problem.code).toBe('NETWORK_ERROR');
  });

  it('passes an abort through unchanged', async () => {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    configureTransport(async () => {
      throw aborted;
    });

    await expect(openEventStream('/jobs/x/stream')).rejects.toBe(aborted);
  });
});

/**
 * FR-1.13 — an export is a body, not a JSON document.
 *
 * `openDownload` shares the transport, the credentials and the problem handling with `request` but
 * none of the body reading: validating a multi-gigabyte archive as JSON is the one thing an export
 * endpoint must never do. The tests below pin the parts that are shared and the part that is not.
 */
describe('openDownload', () => {
  it('asks for the archive and hands the unread body back with its filename', async () => {
    const calls: Parameters<Transport>[0][] = [];
    configureTransport(async (input) => {
      calls.push(input);
      return new Response(null, {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="crm-2026-02-01.tar.gz"' },
      });
    });

    const handle = await openDownload('/instances/inst-crm/exports/exp-1/archive');

    expect(calls[0]).toMatchObject({
      path: '/instances/inst-crm/exports/exp-1/archive',
      method: 'GET',
      headers: { Accept: 'application/gzip' },
    });
    // The caller owns the body; reading it here would defeat the point of a streamed export.
    expect(handle.response.status).toBe(200);
    expect(handle.fileName).toBe('crm-2026-02-01.tar.gz');
  });

  it('derives a filename from the path when the header is missing or unhelpful', async () => {
    configureTransport(respond(new Response(null, { status: 200 })));
    const fallback = await openDownload('/instances/inst-crm/exports/exp-1/archive');
    expect(fallback.fileName).toBe('archive');

    // A compromised server must not be able to hand the browser a path.
    configureTransport(
      respond(
        new Response(null, {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename="../../etc/passwd"' },
        }),
      ),
    );
    const stripped = await openDownload('/instances/inst-crm/exports/exp-1/archive');
    // Every separator becomes an underscore, so the result cannot escape the save directory.
    expect(stripped.fileName).toBe('.._.._etc_passwd');

    // An empty name cannot become an empty save dialog.
    configureTransport(
      respond(
        new Response(null, {
          status: 200,
          headers: { 'Content-Disposition': 'attachment; filename=""' },
        }),
      ),
    );
    const empty = await openDownload('/instances/inst-crm/exports/');
    expect(empty.fileName).toBe('export.tar.gz');
  });

  it('reports a refusal with the problem, the retry window and the lapsed-session signal', async () => {
    configureTransport(
      respond(
        new Response(
          problemDocument(409, 'EXPORT_NOT_READY', 'The archive is still being written.'),
          {
            status: 409,
            headers: { 'Content-Type': 'application/problem+json' },
          },
        ),
      ),
    );
    const refused = await openDownload('/instances/inst-crm/exports/exp-1/archive').catch(
      (thrown: unknown) => thrown,
    );
    expect((refused as ApiError).problem.code).toBe('EXPORT_NOT_READY');

    configureTransport(
      respond(
        new Response(problemDocument(429, 'RATE_LIMITED'), {
          status: 429,
          headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '3' },
        }),
      ),
    );
    const limited = await openDownload('/instances/inst-crm/exports/exp-1/archive').catch(
      (thrown: unknown) => thrown,
    );
    expect((limited as ApiError).retryAfterMs).toBe(3_000);

    configureTransport(respond(new Response('gateway down', { status: 502 })));
    const unexpected = await openDownload('/instances/inst-crm/exports/exp-1/archive').catch(
      (thrown: unknown) => thrown,
    );
    expect((unexpected as ApiError).problem.code).toBe('UNEXPECTED_RESPONSE');

    // A download is a data call like any other: a 401 must reach the sign-in bridge.
    configureTransport(respond(new Response('', { status: 401 })));
    await openDownload('/instances/inst-crm/exports/exp-1/archive').catch(() => undefined);
    expect(window.dispatchEvent).toHaveBeenCalledOnce();
  });

  it('normalises a network failure and passes an abort through', async () => {
    configureTransport(async () => {
      throw new TypeError('fetch failed');
    });
    const failed = await openDownload('/instances/inst-crm/exports/exp-1/archive').catch(
      (thrown: unknown) => thrown,
    );
    expect((failed as ApiError).problem.code).toBe('NETWORK_ERROR');

    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    configureTransport(async () => {
      throw aborted;
    });
    await expect(openDownload('/instances/inst-crm/exports/exp-1/archive')).rejects.toBe(aborted);
  });

  it('gives the instance export opener a window that a large archive can use', async () => {
    const calls: Parameters<Transport>[0][] = [];
    configureTransport(async (input) => {
      calls.push(input);
      return new Response(null, { status: 200 });
    });
    const controller = new AbortController();

    await openInstanceExport('inst-crm', 'exp-1');
    await openInstanceExport('inst-crm', 'exp-1', { signal: controller.signal });

    expect(calls[0]).toMatchObject({
      path: '/instances/inst-crm/exports/exp-1/archive',
      // The 15 s JSON default would abort before the first byte of a large archive.
      timeoutMs: 120_000,
    });
    // No signal is "null", not "undefined": the transport contract declares it nullable.
    expect(calls[0]).toMatchObject({ signal: null });
    expect(calls[1]).toMatchObject({ signal: controller.signal });
  });
});
