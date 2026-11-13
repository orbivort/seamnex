import { AsyncLocalStorage } from 'node:async_hooks';
import { pino, type Logger } from 'pino';
import type { RoleId } from '../../config/config';

export const LOGGER = Symbol('seamnex.logger');
export type { Logger };

/**
 * Request-scoped context. The request id lives in an AsyncLocalStorage so a service three calls
 * deep can attach it to a log line and to an audit row without threading a parameter through
 * every signature.
 */
export type RequestStore = {
  readonly requestId: string;
  readonly role: RoleId;
};

export const requestStore = new AsyncLocalStorage<RequestStore>();

export function currentRequestId(): string | undefined {
  return requestStore.getStore()?.requestId;
}

export function createLogger(options: { level: string; role: RoleId }): Logger {
  return pino({
    level: options.level,
    base: { role: options.role },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Defence in depth next to `maskDeep`: these paths are formatted by pino itself.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-seamnex-csrf"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.secret',
        '*.token',
        '*.client_secret',
        '*.dek',
        '*.ciphertext',
      ],
      censor: '********',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
