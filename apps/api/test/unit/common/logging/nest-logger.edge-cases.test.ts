import type { Logger as PinoLogger } from 'pino';
import { describe, expect, it } from 'vitest';
import { pinoAdapter } from '../../../../src/common/logging/nest-logger';

/**
 * The adapter must never throw while formatting, because it runs inside the exception filter: a
 * message it cannot serialise would replace the error it was called to record. `JSON.stringify`
 * throws on a `bigint`, so that case goes through the fallback instead of taking the process down.
 *
 * Nest also calls `logger.error(error, 'Context')` with the context last and no message text; the
 * stack must survive as a field and the bound context must still be the class name.
 */
type Call = { level: string; fields: Record<string, unknown>; message: string | undefined };

function capture(): { logger: PinoLogger; calls: Call[]; bound: () => Record<string, unknown> } {
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

describe('values the adapter cannot serialise', () => {
  it('stringifies a bigint instead of letting JSON.stringify throw inside the filter', () => {
    const { logger, calls } = capture();

    expect(() => pinoAdapter(logger).error(10n)).not.toThrow();
    expect(calls[0]?.message).toBe('10');
    expect(calls[0]?.level).toBe('error');
  });

  it('stringifies a missing message as null rather than dropping the line', () => {
    const { logger, calls } = capture();
    pinoAdapter(logger).log(null);

    expect(calls[0]?.message).toBe('null');
  });

  it('keeps an Error as the err field even when a context follows it', () => {
    const { logger, calls, bound } = capture();
    pinoAdapter(logger).error(new Error('ledger locked'), 'LedgerService');

    expect(bound()).toEqual({ context: 'LedgerService' });
    expect(calls[0]).toMatchObject({ level: 'error', message: 'nestjs' });
    expect(calls[0]?.fields['err']).toBe('ledger locked');
    expect(calls[0]?.fields['stack']).toContain('ledger locked');
  });

  it('does not treat an Error as a payload, even though typeof says object', () => {
    const { logger, calls } = capture();
    pinoAdapter(logger).warn(new TypeError('bad shape'));

    // A payload would have been merged as fields and lost `err`.
    expect(calls[0]?.fields).toMatchObject({ err: 'bad shape' });
    expect(calls[0]?.message).toBe('nestjs');
  });
});
