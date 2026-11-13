import { describe, expect, it } from 'vitest';
import { OperationHandlers, type OperationGroup } from '../../../src/contract/operation-handlers';
import type { OperationHandler } from '../../../src/contract/operation-handler';

const handler: OperationHandler = async () => ({ kind: 'noContent' });

function group(tag: string, keys: readonly string[]): OperationGroup {
  return {
    tag,
    handlers: () => new Map(keys.map((key) => [key, handler])),
  };
}

describe('OperationHandlers registry', () => {
  it('registers every handler and reports its size', () => {
    const registry = new OperationHandlers([
      group('jobs', ['GET /jobs', 'GET /jobs/:id']),
      group('admin', ['GET /admin/settings']),
    ]);

    expect(registry.size).toBe(3);
    expect(registry.keys()).toEqual(['GET /admin/settings', 'GET /jobs', 'GET /jobs/:id']);
    expect(registry.get('GET /jobs')).toBe(handler);
    expect(registry.get('POST /nothing')).toBeUndefined();
  });

  it('records which group owns a key', () => {
    const registry = new OperationHandlers([group('jobs', ['GET /jobs'])]);
    expect(registry.tagOf('GET /jobs')).toBe('jobs');
    expect(registry.tagOf('GET /other')).toBeUndefined();
  });

  it('fails the process when two groups implement the same operation', () => {
    expect(
      () => new OperationHandlers([group('jobs', ['GET /jobs']), group('phase-2', ['GET /jobs'])]),
    ).toThrow(/GET \/jobs is implemented twice \(jobs and phase-2\)/);
  });

  it('accepts an empty registry', () => {
    const registry = new OperationHandlers([]);
    expect(registry.size).toBe(0);
    expect(registry.keys()).toEqual([]);
  });

  it('keeps the insertion-independent sort for keys', () => {
    const registry = new OperationHandlers([
      group('b', ['POST /b', 'GET /z']),
      group('a', ['DELETE /a']),
    ]);
    expect(registry.keys()).toEqual(['DELETE /a', 'GET /z', 'POST /b']);
  });
});
