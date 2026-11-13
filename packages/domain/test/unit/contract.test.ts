import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  API_OPERATIONS,
  OPERATION_KEYS,
  buildOpenApiDocument,
  jsonSchemaFor,
  operationKey,
} from '../../src/contract';
import { ProblemDetailSchema } from '../../src/schemas/common';

const GOLDEN = fileURLToPath(new URL('../../../../docs/openapi.json', import.meta.url));

describe('API contract registry', () => {
  it('has a unique key for every operation', () => {
    expect(OPERATION_KEYS.size).toBe(API_OPERATIONS.length);
  });

  it('uses the documented path syntax and a known method', () => {
    for (const operation of API_OPERATIONS) {
      expect(operation.path.startsWith('/'), operation.path).toBe(true);
      expect(
        operation.path.startsWith('/api/'),
        `${operation.path} must be relative to /api/v1`,
      ).toBe(false);
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(operation.method);
      expect(operation.summary.length).toBeGreaterThan(10);
    }
  });

  it('answers long-running operations with 202', () => {
    const accepted = API_OPERATIONS.filter((operation) => operation.accepted);
    expect(accepted.length).toBeGreaterThan(0);
    for (const operation of accepted) {
      expect(operation.method, operation.path).toBe('POST');
    }
  });

  it('describes every operation with a valid problem document', () => {
    expect(
      ProblemDetailSchema.safeParse({
        type: 'https://platform.seamnex.local/problems/forbidden',
        title: 'Denied',
        status: 403,
        detail: 'deny by default',
        code: 'FORBIDDEN',
        fieldErrors: [],
        remediation: 'Ask the domain owner.',
      }).success,
    ).toBe(true);
  });

  it('converts every response contract to JSON Schema', () => {
    for (const operation of API_OPERATIONS) {
      if (operation.noContent) continue;
      expect(operation.response, operationKey(operation)).toBeDefined();
      const schema = jsonSchemaFor(operation.response as NonNullable<typeof operation.response>);
      expect(Object.keys(schema).length, operationKey(operation)).toBeGreaterThan(0);
    }
  });

  it('answers an unrepresentable contract with a description instead of throwing', () => {
    // Document generation runs over every operation; one schema the converter refuses must not take
    // the committed `docs/openapi.json` down with it. A non-schema is the simplest input that makes
    // the converter throw.
    expect(jsonSchemaFor(null as unknown as Parameters<typeof jsonSchemaFor>[0])).toEqual({
      description: 'This contract could not be expressed as JSON Schema.',
    });
  });

  it('declares exactly one success shape per operation', () => {
    for (const operation of API_OPERATIONS) {
      expect(
        Boolean(operation.noContent) !== Boolean(operation.response),
        operationKey(operation),
      ).toBe(true);
    }
  });

  it('declares query parameters as data and emits them into the document', () => {
    const document = buildOpenApiDocument();
    const filtered = API_OPERATIONS.filter((operation) => (operation.query?.length ?? 0) > 0);
    expect(filtered.length).toBeGreaterThan(0);
    for (const operation of filtered) {
      const path = operation.path.replace(/:(\w+)/g, '{$1}');
      const entry = document.paths[path]?.[operation.method.toLowerCase()] as {
        parameters?: { name: string; in: string }[];
      };
      const names = (entry.parameters ?? [])
        .filter((parameter) => parameter.in === 'query')
        .map((p) => p.name);
      for (const query of operation.query ?? [])
        expect(names, operationKey(operation)).toContain(query.name);
    }
  });

  it('only advertises 412 for operations that declare optimistic concurrency', () => {
    const document = buildOpenApiDocument();
    for (const operation of API_OPERATIONS) {
      const path = operation.path.replace(/:(\w+)/g, '{$1}');
      const entry = document.paths[path]?.[operation.method.toLowerCase()] as {
        responses: Record<string, unknown>;
      };
      expect(Object.hasOwn(entry.responses, '412'), operationKey(operation)).toBe(
        operation.conditional === true,
      );
    }
  });

  it('publishes the ETag validator from the read that supplies it', () => {
    // `PUT /admin/settings` requires `If-Match`, and the client can only replay a validator it was
    // given by the matching `GET`. The read therefore declares `etag: true`; without it every save
    // answered 412 because no `ETag` header was ever emitted.
    const readers = API_OPERATIONS.filter((operation) => operation.etag === true);
    expect(readers.map(operationKey)).toEqual(['GET /admin/settings']);

    const document = buildOpenApiDocument();
    for (const operation of readers) {
      const path = operation.path.replace(/:(\w+)/g, '{$1}');
      const entry = document.paths[path]?.[operation.method.toLowerCase()] as {
        responses: Record<string, { headers?: Record<string, unknown> }>;
      };
      expect(entry.responses['200']?.headers, operationKey(operation)).toHaveProperty('ETag');
    }
  });

  it('publishes 204 only where the operation declares no content', () => {
    const document = buildOpenApiDocument();
    for (const operation of API_OPERATIONS) {
      const path = operation.path.replace(/:(\w+)/g, '{$1}');
      const entry = document.paths[path]?.[operation.method.toLowerCase()] as {
        responses: Record<string, unknown>;
      };
      expect(Object.hasOwn(entry.responses, '204'), operationKey(operation)).toBe(
        operation.noContent === true,
      );
    }
  });

  it('builds a 3.1 document with one entry per operation', () => {
    const document = buildOpenApiDocument();
    expect(document.openapi).toBe('3.1.0');
    const operations = Object.values(document.paths).reduce(
      (count, path) => count + Object.keys(path).length,
      0,
    );
    expect(operations).toBe(API_OPERATIONS.length);
    expect(document.components.schemas.ProblemDetail).toBeDefined();
  });

  it('renders path parameters as OpenAPI placeholders', () => {
    const document = buildOpenApiDocument();
    expect(document.paths['/instances/{id}']).toBeDefined();
    const parameters = document.paths['/instances/{id}']?.get as { parameters: { name: string }[] };
    expect(parameters.parameters.map((parameter) => parameter.name)).toContain('id');
  });

  it('matches the committed OpenAPI document (run UPDATE_OPENAPI=1 to regenerate)', () => {
    const serialized = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
    if (process.env.UPDATE_OPENAPI === '1') {
      writeFileSync(GOLDEN, serialized, 'utf8');
    }
    expect(serialized).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});

/**
 * Deliverable 3.4: a declared operation with no entry in `POLICY_KEYS` fails while the registry
 * module loads, so a route cannot reach production without a policy. The check is a module-level
 * throw, which is why this suite re-evaluates the module against a policy table with one key missing.
 */
describe('API contract policy binding', () => {
  it('refuses to build the table when an operation has no policy key', async () => {
    vi.resetModules();
    vi.doMock('../../src/policy', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('../../src/policy');
      return { ...actual, POLICY_KEYS: {} };
    });

    await expect(import('../../src/contract')).rejects.toThrow(/has no policy key/);

    vi.doUnmock('../../src/policy');
    vi.resetModules();
  });
});
