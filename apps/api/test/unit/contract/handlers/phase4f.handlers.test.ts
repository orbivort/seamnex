import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase4FHandlers } from '../../../../src/contract/handlers/phase4f.handlers';
import type { OperationHandler } from '../../../../src/contract/operation-handler';
import { callHandler, operationInput } from '../../../support/operation-input';

let s: ReturnType<typeof services>;
let handlers: ReadonlyMap<string, OperationHandler>;

function services() {
  return {
    governance: {
      requestBreakGlass: vi.fn().mockResolvedValue({ id: 'bg1' }),
      decideBreakGlass: vi.fn().mockResolvedValue({ id: 'bg1' }),
      reveal: vi.fn().mockResolvedValue({ credential: 'secret' }),
      decideException: vi.fn().mockResolvedValue({ id: 'pe1' }),
      decideAccessRequest: vi.fn().mockResolvedValue({ id: 'ar1' }),
      createWindow: vi.fn().mockResolvedValue({ id: 'mw1' }),
      patchWindow: vi.fn().mockResolvedValue({ id: 'mw1' }),
      cancelWindow: vi.fn().mockResolvedValue(undefined),
      verifyAuditRange: vi.fn().mockResolvedValue({ valid: true }),
      openDsar: vi.fn().mockResolvedValue({ id: 'ds1' }),
      advanceDsar: vi.fn().mockResolvedValue({ id: 'ds1' }),
    },
    audit: {
      page: vi.fn().mockResolvedValue({ items: [], nextCursor: null, total: 0 }),
      proof: vi.fn().mockResolvedValue({ seq: '7', valid: true }),
      exportRange: vi.fn().mockResolvedValue({ events: [] }),
    },
    privacy: { queue: vi.fn().mockResolvedValue([]) },
  };
}

beforeEach(() => {
  s = services();
  handlers = new Phase4FHandlers(
    s.governance as never,
    s.audit as never,
    s.privacy as never,
  ).handlers();
});

const call = (key: string, overrides = {}) =>
  callHandler(handlers, key, operationInput(key, overrides));

describe('break-glass lifecycle', () => {
  it('POST /break-glass-sessions requests elevation', async () => {
    const body = { instanceId: 'i1', accessMode: 'read', justification: 'incident' };
    const result = await call('POST /break-glass-sessions', { body });

    expect(s.governance.requestBreakGlass).toHaveBeenCalledWith(body, 'sub-1');
    expect(result).toEqual({ kind: 'body', body: { id: 'bg1' } });
  });

  it('POST /break-glass-sessions/:id/:action passes the actor role', async () => {
    await call('POST /break-glass-sessions/:id/:action', {
      params: { id: 'bg1', action: 'approve' },
    });
    expect(s.governance.decideBreakGlass).toHaveBeenCalledWith(
      'bg1',
      'approve',
      'sub-1',
      'platform-admin',
    );
  });

  it('POST /break-glass-sessions/:id/reveal returns the credential', async () => {
    const result = await call('POST /break-glass-sessions/:id/reveal', { params: { id: 'bg1' } });
    expect(s.governance.reveal).toHaveBeenCalledWith('bg1', 'sub-1');
    expect(result).toEqual({ kind: 'body', body: { credential: 'secret' } });
  });

  it('refuses a break-glass action without an id', async () => {
    await expect(
      call('POST /break-glass-sessions/:id/:action', { params: { action: 'approve' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('decision routes', () => {
  it.each(['approve', 'reject'])('POST policy exceptions accepts %s', async (decision) => {
    await call('POST /admin/policy-exceptions/:id/:decision', {
      params: { id: 'pe1', decision },
    });
    expect(s.governance.decideException).toHaveBeenCalledWith('pe1', decision, 'sub-1');
  });

  it.each(['approve', 'reject'])('POST access requests accepts %s', async (decision) => {
    await call('POST /admin/access-requests/:id/:decision', {
      params: { id: 'ar1', decision },
    });
    expect(s.governance.decideAccessRequest).toHaveBeenCalledWith('ar1', decision, 'sub-1');
  });

  it('refuses an unknown decision', async () => {
    await expect(
      call('POST /admin/policy-exceptions/:id/:decision', {
        params: { id: 'pe1', decision: 'maybe' },
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: expect.stringContaining('maybe'),
    });
    expect(s.governance.decideException).not.toHaveBeenCalled();
  });
});

describe('maintenance windows', () => {
  it('POST creates a window', async () => {
    const body = { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-01-01T02:00:00.000Z' };
    await call('POST /admin/maintenance-windows', { body });
    expect(s.governance.createWindow).toHaveBeenCalledWith(body, 'sub-1');
  });

  it('PATCH moves a window', async () => {
    const body = { startsAt: '2026-01-02T00:00:00.000Z' };
    await call('PATCH /admin/maintenance-windows/:id', { params: { id: 'mw1' }, body });
    expect(s.governance.patchWindow).toHaveBeenCalledWith('mw1', body, 'sub-1');
  });

  it('DELETE cancels a window and answers 204', async () => {
    const result = await call('DELETE /admin/maintenance-windows/:id', { params: { id: 'mw1' } });
    expect(s.governance.cancelWindow).toHaveBeenCalledWith('mw1', 'sub-1');
    expect(result).toEqual({ kind: 'noContent' });
  });
});

describe('audit surfaces', () => {
  it('POST /audit-events/verify verifies the requested range', async () => {
    const result = await call('POST /audit-events/verify', { body: { fromSeq: '1', toSeq: '9' } });
    expect(s.governance.verifyAuditRange).toHaveBeenCalledWith('1', '9');
    expect(result).toEqual({ kind: 'body', body: { valid: true } });
  });

  it('GET /audit-events pages with no filter when the query is empty', async () => {
    await call('GET /audit-events');
    expect(s.audit.page).toHaveBeenCalledWith({});
  });

  it('GET /audit-events forwards every present filter', async () => {
    await call('GET /audit-events', {
      query: {
        action: 'auth.signin.failed',
        actor: 'alice',
        outcome: 'denied',
        target: 'session',
        cursor: 'c1',
        limit: '25',
      },
    });

    expect(s.audit.page).toHaveBeenCalledWith({
      action: 'auth.signin.failed',
      actor: 'alice',
      outcome: 'denied',
      target: 'session',
      cursor: 'c1',
      limit: '25',
    });
  });

  it('GET /audit-events/:seq/proof returns the proof', async () => {
    const result = await call('GET /audit-events/:seq/proof', { params: { seq: '7' } });
    expect(s.audit.proof).toHaveBeenCalledWith('7');
    expect(result).toEqual({ kind: 'body', body: { seq: '7', valid: true } });
  });

  it('POST /audit-events/export exports the requested range', async () => {
    const result = await call('POST /audit-events/export', {
      body: { from: '2026-01-01', to: '2026-01-02' },
    });
    expect(s.audit.exportRange).toHaveBeenCalledWith('2026-01-01', '2026-01-02');
    expect(result).toEqual({ kind: 'body', body: { events: [] } });
  });
});

describe('privacy requests', () => {
  it('GET /privacy/requests lists the queue', async () => {
    const result = await call('GET /privacy/requests');
    expect(s.privacy.queue).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: 'body', body: [] });
  });

  it('POST /privacy/requests opens a DSAR', async () => {
    const body = { subjectRef: 'user@example.test', kind: 'export' };
    const result = await call('POST /privacy/requests', { body });

    expect(s.governance.openDsar).toHaveBeenCalledWith(body, 'sub-1');
    expect(result).toEqual({ kind: 'body', body: { id: 'ds1' } });
  });

  it('POST /privacy/requests/:id/advance advances the request', async () => {
    const result = await call('POST /privacy/requests/:id/advance', { params: { id: 'ds1' } });
    expect(s.governance.advanceDsar).toHaveBeenCalledWith('ds1', 'sub-1');
    expect(result).toEqual({ kind: 'body', body: { id: 'ds1' } });
  });

  it('refuses an advance without an id', async () => {
    await expect(call('POST /privacy/requests/:id/advance', { params: {} })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('phase 4f registry', () => {
  it('implements the fifteen 4F operations', () => {
    expect(handlers.size).toBe(15);
  });

  it('tags the group phase-4f', () => {
    expect(
      new Phase4FHandlers(s.governance as never, s.audit as never, s.privacy as never).tag,
    ).toBe('phase-4f');
  });
});
