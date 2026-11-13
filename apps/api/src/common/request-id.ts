import { randomUUID } from 'node:crypto';
import type { RoleId } from '../config/config';
import { requestStore } from './logging/logger';

export const REQUEST_ID_HEADER = 'x-request-id';

/** A client-supplied id is honoured only if it cannot be used to forge a log line. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  if (candidate !== undefined && SAFE_REQUEST_ID.test(candidate)) return candidate;
  return randomUUID();
}

/** Binds a request id (and the process role) to everything the request triggers. */
export function runWithRequestContext<T>(requestId: string, role: RoleId, fn: () => T): T {
  return requestStore.run({ requestId, role }, fn);
}
