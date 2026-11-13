import type { Logger as PinoLogger } from 'pino';
import { describe, expect, it } from 'vitest';
import { pinoAdapter } from '../../../../src/common/logging/nest-logger';

/**
 * The adapter is the seam between two logging conventions. It shipped once with the message text
 * silently moved into the context field, so every `logger.error({ err }, 'text')` lost its `text`
 * and an operator saw `"msg":"nestjs"`. These cases pin both shapes down.
 */

type Call = { level: string; fields: Record<string, unknown>; message: string | undefined };

function capture(): {
  logger: PinoLogger;
  calls: Call[];
  bound: () => Record<string, unknown>;
} {
  const calls: Call[] = [];
  let extra: Record<string, unknown> = {};

  const at = (level: string) => (fields: unknown, message?: string) => {
    calls.push({ level, fields: (fields ?? {}) as Record<string, unknown>, message });
  };

  const logger = {
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    debug: at('debug'),
    child(context: Record<string, unknown>) {
      extra = context;
      return logger;
    },
  };

  return { logger: logger as unknown as PinoLogger, calls, bound: () => extra };
}

describe('nest logger adapter', () => {
  it('keeps the message text when the call is payload-first', () => {
    const { logger, calls, bound } = capture();
    pinoAdapter(logger).error({ err: 'boom' }, 'partition upkeep failed', 'scheduler');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe('partition upkeep failed');
    expect(calls[0]?.fields).toMatchObject({ err: 'boom' });
    expect(bound()).toMatchObject({ context: 'scheduler' });
  });

  it('treats the last string as the context for a textual call', () => {
    const { logger, calls, bound } = capture();
    pinoAdapter(logger).log('started', 'JobService');

    expect(calls[0]?.message).toBe('started');
    expect(bound()).toMatchObject({ context: 'JobService' });
  });

  it('logs a bare string without inventing a context', () => {
    const { logger, calls, bound } = capture();
    pinoAdapter(logger).warn('careful');

    expect(calls[0]?.message).toBe('careful');
    expect(bound()).toEqual({});
  });

  it('keeps an error stack out of the message', () => {
    const { logger, calls } = capture();
    pinoAdapter(logger).error('failed', 'Error: x\n    at foo (file.ts:1:1)', 'Boot');

    expect(calls[0]?.message).toBe('failed');
    expect(calls[0]?.fields['stack']).toContain('at foo');
  });

  it('routes an Error instance through the err field with its stack', () => {
    const { logger, calls } = capture();
    pinoAdapter(logger).log(new Error('kaboom'));

    expect(calls[0]).toMatchObject({ level: 'info', message: 'nestjs' });
    expect(calls[0]?.fields['err']).toBe('kaboom');
    expect(calls[0]?.fields['stack']).toContain('kaboom');
  });

  it('names the message nestjs when a payload arrives without message text', () => {
    const { logger, calls } = capture();
    pinoAdapter(logger).warn({ detail: 'x' });

    expect(calls[0]?.message).toBe('nestjs');
    expect(calls[0]?.fields).toMatchObject({ detail: 'x' });
  });

  it('stringifies a non-string message rather than dropping it', () => {
    const { logger, calls } = capture();
    pinoAdapter(logger).log(42);
    pinoAdapter(logger).log(true);

    expect(calls[0]?.message).toBe('42');
    expect(calls[1]?.message).toBe('true');
  });

  it('stringifies a value JSON cannot represent', () => {
    const { logger, calls } = capture();
    pinoAdapter(logger).log(Symbol('sym'));

    expect(calls[0]?.message).toBe('Symbol(sym)');
  });

  it('maps verbose and fatal onto debug and error', () => {
    const { logger, calls } = capture();
    const adapter = pinoAdapter(logger);
    adapter.verbose?.('detail');
    adapter.fatal?.('dead');
    adapter.debug?.('debug');

    expect(calls.map((call) => call.level)).toEqual(['debug', 'error', 'debug']);
    expect(calls.map((call) => call.message)).toEqual(['detail', 'dead', 'debug']);
  });

  it('does not invent a context from a payload and one trailing string', () => {
    const { logger, calls, bound } = capture();
    pinoAdapter(logger).error({ err: 'x' }, 'failed');

    expect(calls[0]?.message).toBe('failed');
    expect(bound()).toEqual({});
  });

  it('merges a stack found in a payload-first call into the payload', () => {
    const { logger, calls } = capture();
    pinoAdapter(logger).error({ err: 'x' }, 'failed', 'Error: y\n    at z (f.ts:1:1)');

    expect(calls[0]?.message).toBe('failed');
    expect(calls[0]?.fields['stack']).toContain('at z');
  });
});
