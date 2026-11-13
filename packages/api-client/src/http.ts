import type { ApiOperation, FieldError, ProblemDetail } from '@seamnex/domain';
import { API_OPERATIONS, ProblemDetailSchema } from '@seamnex/domain';
import type { ZodType } from 'zod';
import { clearAssertedRole } from './session-role';
import { createFetchTransport, type HttpMethod, type Transport } from './transport';

/**
 * One request pipeline for every platform call:
 * transport → JSON parse → problem+json normalisation → Zod contract check.
 *
 * The transport is the only replaceable part. Everything below is environment-agnostic
 * and must never contain prototype behaviour (synthetic latency, demo headers, fake outages).
 */

let transport: Transport = createFetchTransport();

export function configureTransport(next: Transport): void {
  transport = next;
}

/** Restores the production transport. Used by tests and by the prototype teardown. */
export function resetTransport(): void {
  transport = createFetchTransport();
}

const LAST_SUCCESS_KEY = 'seamnex:last-success-at';
const ETAG_PREFIX = 'seamnex:etag:';

/**
 * Request-side contract validation is a development guard, not a runtime control: the API
 * validates the same body and query again, and a rejected request is reported through the normal
 * problem path either way. In a production build the flag is `false`, so the Zod parse of every
 * mutation body and the parameter scan of every query disappear under dead-code elimination.
 *
 * The response-side parse below is *not* gated: it is how a contract breach becomes a visible,
 * reportable problem instead of an undefined value reaching a screen.
 */
const CONTRACT_CHECKS_ENABLED =
  typeof __SEAMNEX_CONTRACT_CHECKS__ !== 'undefined' && __SEAMNEX_CONTRACT_CHECKS__;

/**
 * The offline notice needs a timestamp, not a per-request audit log. Writing on every successful
 * call put a synchronous storage write on the main thread for each poll (jobs tick at 1.2 s,
 * logs at 1.5 s), which is exactly the work that makes a live screen stutter.
 */
const SUCCESS_MARK_INTERVAL_MS = 5_000;
let lastSuccessMark = 0;

function markSuccess(): void {
  const now = Date.now();
  if (now - lastSuccessMark < SUCCESS_MARK_INTERVAL_MS) return;
  lastSuccessMark = now;
  try {
    sessionStorage.setItem(LAST_SUCCESS_KEY, new Date(now).toISOString());
  } catch {
    // Storage can be unavailable (private mode, SSR); the notice simply shows no timestamp.
  }
}

/** Last moment the API answered successfully, used by the offline notice. */
export function lastKnownStatusAt(): string | null {
  try {
    return sessionStorage.getItem(LAST_SUCCESS_KEY);
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  readonly problem: ProblemDetail;
  /** Seconds the server asked us to wait (`Retry-After`), when it sent one. */
  readonly retryAfterMs: number | null;

  constructor(
    problem: ProblemDetail,
    options: { retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    super(problem.title, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.problem = problem;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

function networkProblem(error: unknown): ProblemDetail {
  const timedOut = error instanceof Error && error.name === 'TimeoutError';
  const detail =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'No response was received from the API.';
  return {
    type: 'https://platform.seamnex.local/problems/network-error',
    title: timedOut
      ? 'The platform API did not answer in time'
      : 'The platform API could not be reached',
    status: timedOut ? 504 : 503,
    detail,
    code: timedOut ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
    fieldErrors: [],
    remediation: timedOut
      ? 'Retry the action. If the API stays slow, check the control-plane health page.'
      : 'Retry the action. If it keeps failing, check connectivity, the API base URL and CORS configuration.',
  };
}

function nonJsonProblem(status: number, statusText: string, path: string): ProblemDetail {
  return {
    type: 'https://platform.seamnex.local/problems/unexpected-response',
    title: statusText.length > 0 ? statusText : 'The API returned an unexpected response',
    status,
    detail: `The response from ${path} was HTTP ${status} without a problem+json body.`,
    code: 'UNEXPECTED_RESPONSE',
    fieldErrors: [],
    remediation: 'Retry the action. If it persists, report the endpoint and the response status.',
  };
}

/**
 * The operation registry is compiled once: method + anchored path pattern + operation.
 * Static patterns sort first, so `/instances/:id/backups` wins over `/instances/:id/:action`
 * even though both match a three-segment path.
 */
type CompiledOperation = {
  method: HttpMethod;
  regex: RegExp;
  wildcards: number;
  operation: ApiOperation;
};

const COMPILED_OPERATIONS: CompiledOperation[] = API_OPERATIONS.map((operation) => {
  const wildcards = (operation.path.match(/:[^/]+/g) ?? []).length;
  const pattern = operation.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[^/]+/g, '[^/]+');
  return {
    method: operation.method,
    regex: new RegExp(`^${pattern}$`),
    wildcards,
    operation,
  };
}).sort((left, right) => left.wildcards - right.wildcards);

function resolveOperation(method: HttpMethod, pathOnly: string): ApiOperation | undefined {
  return COMPILED_OPERATIONS.find((item) => item.method === method && item.regex.test(pathOnly))
    ?.operation;
}

/** Contract violations are normalised problems, so they render instead of hiding in a console. */
function requestContractProblem(detail: string, fieldErrors: FieldError[]): ProblemDetail {
  return {
    type: 'https://platform.seamnex.local/problems/request-contract',
    title: 'The request does not match the platform contract',
    status: 400,
    detail,
    code: 'REQUEST_CONTRACT',
    fieldErrors,
    remediation: 'Correct the highlighted field. The generated OpenAPI document is the reference.',
  };
}

function unknownOperationProblem(method: HttpMethod, path: string): ProblemDetail {
  return {
    type: 'https://platform.seamnex.local/problems/unknown-operation',
    title: 'The platform API does not declare this operation',
    status: 500,
    detail: `${method} ${path} is not in the operation registry. This is a contract defect, not a user error.`,
    code: 'UNKNOWN_OPERATION',
    fieldErrors: [],
    remediation: 'Register the operation in packages/domain/src/contract.ts before calling it.',
  };
}

function validateQuery(path: string, operation: ApiOperation, search: string): void {
  const declared = operation.query ?? [];
  const issues: FieldError[] = [];

  for (const [key, value] of new URLSearchParams(search)) {
    const parameter = declared.find(
      (item) => item.name === key || (item.prefix === true && key.startsWith(`${item.name}.`)),
    );
    if (parameter === undefined) {
      issues.push({
        field: key,
        code: 'unknown_query',
        message: `${key} is not a declared query parameter for ${operation.method} ${path}.`,
      });
      continue;
    }
    if (parameter.values !== undefined && !parameter.values.includes(value)) {
      issues.push({
        field: key,
        code: 'enum',
        message: `Expected one of: ${parameter.values.join(', ')}.`,
      });
    }
    if (parameter.type === 'integer' && !/^-?\d+$/.test(value)) {
      issues.push({ field: key, code: 'type', message: 'Expected an integer.' });
    }
    if (parameter.type === 'boolean' && value !== 'true' && value !== 'false') {
      issues.push({ field: key, code: 'type', message: 'Expected true or false.' });
    }
  }

  if (issues.length > 0) {
    throw new ApiError(
      requestContractProblem(`The query sent to ${path} is not in the contract.`, issues),
    );
  }
}

function validateBody(path: string, operation: ApiOperation, body: unknown): void {
  if (operation.request === undefined) return;
  const parsed = operation.request.safeParse(body ?? {});
  if (parsed.success) return;
  const fieldErrors: FieldError[] = parsed.error.issues.map((issue) => ({
    field: issue.path.length === 0 ? 'body' : issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  throw new ApiError(
    requestContractProblem(
      `The body sent to ${operation.method} ${path} is not in the contract.`,
      fieldErrors,
    ),
  );
}

function contractProblem(path: string): ProblemDetail {
  return {
    type: 'https://platform.seamnex.local/problems/contract-mismatch',
    title: 'Response did not match the platform contract',
    status: 500,
    detail: `The response from ${path} failed schema validation. This is a contract defect, not a user error.`,
    code: 'RESPONSE_CONTRACT',
    fieldErrors: [],
    remediation:
      'Report the failing endpoint to the platform team; the OpenAPI document is the reference.',
  };
}

/**
 * Narrows any thrown value to a renderable problem. This never returns null: a network
 * failure, a timeout or an unexpected exception must still produce a visible error state.
 */
export function toProblem(error: unknown): ProblemDetail {
  if (error instanceof ApiError) return error.problem;
  if (error instanceof Error) return networkProblem(error);
  return networkProblem(new Error(String(error)));
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1_000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(date - Date.now(), 0);
}

function notifyUnauthorized(problem: ProblemDetail): void {
  // A lapsed session invalidates the asserted role; keeping it would render the previous tab's
  // chrome on the sign-in page.
  clearAssertedRole();
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('seamnex:unauthorized', { detail: problem }));
}

/**
 * Subscribes to lapsed-session signals. The platform has no local credential store
 * (FR-3.2), so a `401` cannot be repaired in the app: it must be shown, not swallowed.
 */
export function onUnauthorized(listener: (problem: ProblemDetail) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<ProblemDetail>).detail;
    if (detail !== undefined) listener(detail);
  };
  window.addEventListener('seamnex:unauthorized', handler);
  return () => window.removeEventListener('seamnex:unauthorized', handler);
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const pair of document.cookie.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    if (pair.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The double-submit token, parsed at most once per cookie state.
 *
 * `document.cookie` is a single string, so comparing it costs one property read while splitting
 * and decoding it costs an allocation per pair. Mutations are click-rate, but every one of them
 * used to re-split the whole cookie jar.
 */
let csrfCache: { raw: string; token: string | null } | null = null;

function csrfToken(): string | null {
  const raw = typeof document === 'undefined' ? '' : document.cookie;
  if (csrfCache !== null && csrfCache.raw === raw) return csrfCache.token;
  const token = readCookie('seamnex_csrf');
  csrfCache = { raw, token };
  return token;
}

function readEtag(path: string): string | null {
  try {
    return sessionStorage.getItem(`${ETAG_PREFIX}${path}`);
  } catch {
    return null;
  }
}

/**
 * Last value written per path, so an unchanged `ETag` costs nothing. A resource that is polled
 * every second returns the same tag every time; without this, every poll paid a storage write for
 * a value that had not moved.
 */
const writtenEtags = new Map<string, string | null>();

function writeEtag(path: string, etag: string | null): void {
  if (writtenEtags.get(path) === etag && writtenEtags.has(path)) return;
  writtenEtags.set(path, etag);
  try {
    if (etag === null) sessionStorage.removeItem(`${ETAG_PREFIX}${path}`);
    else sessionStorage.setItem(`${ETAG_PREFIX}${path}`, etag);
  } catch {
    // Optimistic concurrency degrades to no If-Match when storage is unavailable.
  }
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  return `idem-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export type RequestOptions<T> = {
  /** Response contract. Omitted only for operations that declare `noContent`. */
  schema?: ZodType<T>;
  method?: HttpMethod;
  body?: unknown;
  signal?: AbortSignal;
  /** Explicit optimistic-concurrency precondition; defaults to the ETag of the last GET. */
  ifMatch?: string;
  /** Replay-safe key for a mutation; generated per call when the caller has none. */
  idempotencyKey?: string;
};

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function request<T>(path: string, options: RequestOptions<T>): Promise<T> {
  const { schema, method = 'GET', body, signal, ifMatch, idempotencyKey } = options;

  const queryIndex = path.indexOf('?');
  const pathOnly = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const search = queryIndex === -1 ? '' : path.slice(queryIndex + 1);

  const operation = resolveOperation(method, pathOnly);
  if (operation === undefined) {
    throw new ApiError(unknownOperationProblem(method, pathOnly));
  }
  // The registry lookup stays unconditional: it is one array scan and it produces the
  // `UNKNOWN_OPERATION` problem, which is a contract defect rather than a developer aid.
  if (CONTRACT_CHECKS_ENABLED) {
    if (method !== 'GET') validateBody(pathOnly, operation, body);
    validateQuery(pathOnly, operation, search);
  }

  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['Idempotency-Key'] = idempotencyKey ?? newIdempotencyKey();
  // Double-submit CSRF token. The cookie is readable by design; the server compares it with the
  // token bound to the session record, so a forged cookie alone is not enough.
  if (method !== 'GET') {
    const csrf = csrfToken();
    if (csrf !== null) headers['x-seamnex-csrf'] = csrf;
  }
  // Only resources that declare optimistic concurrency receive If-Match (412 otherwise).
  const precondition =
    ifMatch ?? (method !== 'GET' && operation.conditional ? readEtag(pathOnly) : null);
  if (precondition !== null) headers['If-Match'] = precondition;

  let response: Response;
  try {
    response = await transport({ path, method, body, signal: signal ?? null, headers });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError(networkProblem(error), { cause: error });
  }

  const payload = await readPayload(response);

  if (!response.ok) {
    const parsed = ProblemDetailSchema.safeParse(payload);
    const problem = parsed.success
      ? parsed.data
      : response.status === 401 || response.status === 403
        ? {
            type: 'https://platform.seamnex.local/problems/unauthorized',
            title: 'Your session is not authorised for this action',
            status: response.status,
            detail: 'The platform refused the request before reading a problem document.',
            code: 'UNAUTHORIZED',
            fieldErrors: [],
            remediation: 'Sign in again, or ask the domain owner for the missing capability.',
          }
        : nonJsonProblem(response.status, response.statusText, path);

    // The sign-in exchange answers 401 for `MFA_REQUIRED`; that is a step in the flow, not a
    // lapsed session, so it must not trigger the redirect/notice path.
    if (response.status === 401 && pathOnly !== '/auth/session') notifyUnauthorized(problem);
    throw new ApiError(problem, {
      retryAfterMs: parseRetryAfter(response.headers.get('Retry-After')),
    });
  }

  if (method === 'GET') writeEtag(pathOnly, response.headers.get('ETag'));

  // A declared empty success (204) carries no body; so does an operation without a schema.
  if (operation.noContent || response.status === 204) {
    markSuccess();
    return undefined as T;
  }

  if (schema === undefined) {
    markSuccess();
    return payload as T;
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.error('Contract mismatch', path, parsed.error.issues);
    throw new ApiError(contractProblem(path));
  }
  markSuccess();
  return parsed.data;
}

/**
 * Opens a `text/event-stream` response through the same transport, so authentication and
 * base URL behave exactly as for JSON calls. The caller owns the reader and the abort signal.
 *
 * `headers` exists for the SSE resume contract: the server replays from `Last-Event-ID`, so a
 * dropped connection continues instead of restarting the log.
 */
export async function openEventStream(
  path: string,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await transport({
      path,
      method: 'GET',
      signal: signal ?? null,
      headers: { Accept: 'text/event-stream', ...headers },
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError(networkProblem(error), { cause: error });
  }

  if (!response.ok) {
    const payload = await readPayload(response);
    const parsed = ProblemDetailSchema.safeParse(payload);
    throw new ApiError(
      parsed.success ? parsed.data : nonJsonProblem(response.status, response.statusText, path),
    );
  }

  return response;
}
