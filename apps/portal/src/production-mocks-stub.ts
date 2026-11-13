/**
 * Production alias for `@seamnex/mocks` / `@seamnex/mocks/browser`.
 *
 * The mock platform is a development and demo artefact. In a production build the module
 * is aliased to this stub, so neither MSW nor the fixtures can reach the bundle — and any
 * accidental call fails loudly instead of pretending to work.
 */

const MESSAGE =
  'The mock platform is not part of a production build. Point the API client at the real control plane.';

export function resetState(): never {
  throw new Error(MESSAGE);
}

export function startMockWorker(): never {
  throw new Error(MESSAGE);
}
