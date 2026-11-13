import type { LoggerService } from '@nestjs/common';
import type { Logger as PinoLogger } from 'pino';

/**
 * Routes Nest's own `Logger` through pino.
 *
 * Without this, every `new Logger('jobs')` in the codebase wrote through Nest's `ConsoleLogger`:
 * human-formatted text on stdout with no `redact` paths and no request id. That made the error
 * handler the one place a secret could reach the log — the exact inversion of the mask-by-default
 * requirement (exit criterion 7).
 *
 * The argument shapes are not uniform, so they are disambiguated rather than guessed:
 *   - `logger.error({ err }, 'message')` — our services: an object payload plus the message text.
 *   - `logger.error('message', stack, 'Context')` — Nest internals: the context comes last.
 *   - `logger.log('message')` — the common case.
 */
export function pinoAdapter(logger: PinoLogger): LoggerService {
  const write = (
    level: 'info' | 'warn' | 'error' | 'debug',
    message: unknown,
    params: unknown[],
  ): void => {
    const strings = params.filter((value): value is string => typeof value === 'string');
    const payload = isPlainObject(message) ? message : undefined;

    // A payload-first call puts the message text first; a textual call puts the context last.
    const context = payload === undefined ? strings.at(-1) : strings.at(1);
    const text = payload === undefined ? message : (strings[0] ?? 'nestjs');
    const stack = strings.find((value) => /\n\s+at /.test(value));

    const bound = context === undefined ? logger : logger.child({ context });

    if (message instanceof Error) {
      bound[level]({ err: message.message, stack: message.stack }, 'nestjs');
      return;
    }
    if (payload !== undefined) {
      bound[level](stack === undefined ? payload : { ...payload, stack }, stringifySafe(text));
      return;
    }
    bound[level](stack === undefined ? {} : { stack }, stringifySafe(message));
  };

  return {
    log: (message: unknown, ...params: unknown[]) => write('info', message, params),
    warn: (message: unknown, ...params: unknown[]) => write('warn', message, params),
    error: (message: unknown, ...params: unknown[]) => write('error', message, params),
    debug: (message: unknown, ...params: unknown[]) => write('debug', message, params),
    verbose: (message: unknown, ...params: unknown[]) => write('debug', message, params),
    fatal: (message: unknown, ...params: unknown[]) => write('error', message, params),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Error);
}

function stringifySafe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
