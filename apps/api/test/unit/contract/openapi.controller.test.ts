import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPERATION_KEYS } from '@seamnex/domain';
import { OpenApiController } from '../../../src/contract/openapi.controller';

// `test/unit/contract` is one level deeper than the `src/contract` this suite came from.
const GOLDEN = fileURLToPath(new URL('../../../../../docs/openapi.json', import.meta.url));

/**
 * Exit criterion 1: what the API serves must equal the committed document. Phase 1 adds no
 * operation, so this is a byte-for-byte assertion — a drift here means the contract changed
 * without the golden file being regenerated.
 */
describe('served OpenAPI document', () => {
  it('is byte-identical to docs/openapi.json', () => {
    const served = new OpenApiController().document();
    const golden = readFileSync(GOLDEN, 'utf8');

    expect(served.length).toBe(golden.length);
    expect(served).toBe(golden);
  });

  it('is valid JSON describing exactly the registry', () => {
    const document = JSON.parse(new OpenApiController().document()) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.openapi).toBe('3.1.0');
    const operations = Object.values(document.paths).reduce(
      (count, path) => count + Object.keys(path).length,
      0,
    );
    // Derived, not literal: an additive contract change must regenerate the document, but it must
    // not require editing a number here (see ADR-BE-12 D8).
    expect(operations).toBe(OPERATION_KEYS.size);
  });

  it('names the policy key for every operation (ADR-BE-05)', () => {
    const document = JSON.parse(new OpenApiController().document()) as {
      paths: Record<string, Record<string, { 'x-policy-key'?: string; 'x-anonymous'?: boolean }>>;
    };
    const missing = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, operation]) => operation['x-policy-key'] === undefined)
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(missing).toEqual([]);
  });
});
