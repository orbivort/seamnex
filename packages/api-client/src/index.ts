/**
 * The build-time flags this package reads are ambient declarations. Referencing the file from the
 * entry point means every program that consumes the package — including `@seamnex/shell`, which
 * compiles this source as part of its own typecheck — sees them.
 *
 * A reference directive is the mechanism TypeScript provides for a declaration file that has no
 * import/export of its own; it is not the "import a module by path" the lint rule guards against.
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./globals.d.ts" />

export {
  ApiError,
  configureTransport,
  isAbortError,
  lastKnownStatusAt,
  onUnauthorized,
  openEventStream,
  request,
  resetTransport,
  toProblem,
  type RequestOptions,
} from './http';
export {
  createFetchTransport,
  DEFAULT_TIMEOUT_MS,
  type FetchTransportOptions,
  type HttpMethod,
  type Transport,
  type TransportRequest,
} from './transport';
export { createPrototypeTransport, type PrototypeTransportOptions } from './prototype-transport';
export {
  authKeys,
  beginSignIn,
  codeChallengeFor,
  completeSignIn,
  createCodeVerifier,
  endSession,
  fetchSession,
  providerLogoutUrl,
  readServerSession,
  rememberProviderLogout,
  safeNextPath,
  sessionRouting,
  signInWithStub,
  startSession,
  takeProviderLogout,
  type CallbackFailure,
  type CallbackOutcome,
  type SessionLocation,
  type SessionRouting,
} from './auth';
export {
  clearAssertedRole,
  devSignInAvailable,
  readAssertedRole,
  rememberAssertedRole,
  rememberAuthProvider,
} from './session-role';
export { queryKeys } from './query-keys';
export { ApiProvider, type ApiProviderProps } from './provider';

export * from './hooks/portal';
export * from './hooks/catalog';
export * from './hooks/instances';
export * from './hooks/jobs';
export * from './hooks/job-stream';
export * from './hooks/backups';
export * from './hooks/workflows';
export * from './hooks/governance';
export * from './hooks/admin';
export * from './hooks/recovery';
export * from './hooks/privacy';
