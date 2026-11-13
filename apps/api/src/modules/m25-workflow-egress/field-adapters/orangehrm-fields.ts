import type { FieldAdapter } from './adapter';

/**
 * OrangeHRM exposes no metadata endpoint: its REST API documents resources, not the writable fields
 * of a resource, and the schema lives in the PHP model layer. The adapter therefore declares the
 * absence instead of guessing field names — a guessed name would produce a mapping that passes
 * validation and fails the product on the first run.
 *
 * `GET /workflows/:id/nodes/:nodeId/fields` answers `status: 'unsupported'` with this sentence, and
 * the workbench keeps manual entry available.
 */
export const orangeHrmFields: FieldAdapter = {
  entryKey: 'D07-01',
  method: 'GET',
  path: '/api/v2/employees',
  supports: () => false,
  unsupportedDetail:
    'OrangeHRM publishes no schema for the fields an operation accepts, so field names have to be entered manually and are not validated.',
  extract: () => [],
};
