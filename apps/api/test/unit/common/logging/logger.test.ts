import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import type { RoleId } from '../../../../src/config/config';
import {
  createLogger,
  currentRequestId,
  requestStore,
} from '../../../../src/common/logging/logger';

/**
 * `pino` is exercised for real here: the redact paths and the level formatter are configuration,
 * and a mock would assert that the configuration was passed, not that it works. The instance's
 * destination symbol is swapped for an in-memory stream, which is the supported seam pino exposes.
 */
function capture(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0),
  };
}

function loggerTo(sink: ReturnType<typeof capture>, options: { level: string; role: RoleId }) {
  const logger = createLogger(options);
  (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = sink.stream;
  return logger;
}

describe('createLogger', () => {
  it('writes JSON with the process role and a label level', () => {
    const sink = capture();
    const logger = loggerTo(sink, { level: 'info', role: 'scheduler' });

    logger.info({ msg: 'started' });

    const line = JSON.parse(sink.lines()[0] ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({ role: 'scheduler', level: 'info', msg: 'started' });
    expect(typeof line.time).toBe('string');
  });

  it('masks a credential nested in a logged payload', () => {
    const sink = capture();
    const logger = loggerTo(sink, { level: 'info', role: 'api' });

    logger.info({
      req: { headers: { authorization: 'Bearer canary-token', cookie: 'seamnex_session=canary' } },
      payload: { client_secret: 'canary-secret' },
    });

    const rendered = sink.lines().join('\n');
    expect(rendered).not.toContain('canary-token');
    expect(rendered).not.toContain('canary-secret');
    expect(rendered).toContain('********');
  });

  it('masks a nested token, dek and ciphertext', () => {
    const sink = capture();
    const logger = loggerTo(sink, { level: 'info', role: 'api' });

    logger.info({
      payload: { token: 'canary-token', dek: 'canary-dek', ciphertext: 'canary-cipher' },
    });

    const rendered = sink.lines().join('\n');
    expect(rendered).not.toContain('canary-token');
    expect(rendered).not.toContain('canary-dek');
    expect(rendered).not.toContain('canary-cipher');
  });

  it('masks a set-cookie response header and a nested password', () => {
    const sink = capture();
    const logger = loggerTo(sink, { level: 'info', role: 'api' });

    logger.info({
      res: { headers: { 'set-cookie': ['seamnex_session=canary'] } },
      payload: { password: 'canary-password' },
    });

    const rendered = sink.lines().join('\n');
    expect(rendered).not.toContain('canary-password');
    expect(rendered).not.toContain('seamnex_session=canary');
  });

  it('drops a line below the configured level', () => {
    const sink = capture();
    const logger = loggerTo(sink, { level: 'warn', role: 'api' });

    logger.debug({ msg: 'invisible' });
    logger.warn({ msg: 'visible' });

    const rendered = sink.lines().join('\n');
    expect(rendered).not.toContain('invisible');
    expect(rendered).toContain('visible');
  });

  it('binds the provided role rather than the configuration default', () => {
    const sink = capture();
    const logger = loggerTo(sink, { level: 'info', role: 'deploy-worker' });

    logger.info({ msg: 'one line' });

    expect(sink.lines()[0]).toContain('"role":"deploy-worker"');
  });
});

describe('request-scoped logging context', () => {
  it('exposes the request id inside the store and nothing outside it', () => {
    expect(currentRequestId()).toBeUndefined();

    const inside = requestStore.run({ requestId: 'rid-log', role: 'api' }, () =>
      currentRequestId(),
    );

    expect(inside).toBe('rid-log');
    expect(currentRequestId()).toBeUndefined();
  });

  it('keeps nested stores isolated', () => {
    const observed = requestStore.run({ requestId: 'outer', role: 'api' }, () => {
      const before = currentRequestId();
      const inner = requestStore.run({ requestId: 'inner', role: 'api' }, () => currentRequestId());
      return { before, inner, after: currentRequestId() };
    });

    expect(observed).toEqual({ before: 'outer', inner: 'inner', after: 'outer' });
  });
});
