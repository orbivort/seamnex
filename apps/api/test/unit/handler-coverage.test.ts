import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_OPERATIONS, operationKey } from '@seamnex/domain';
import { DEFERRED_OPERATIONS } from '../../src/contract/deferred-operations';

/**
 * Exit criterion 5, enforced.
 *
 * `route-parity` proves a route is **mounted**; it cannot prove a handler exists, because the
 * dispatcher happily routes an operation nothing implements. This test closes that gap: every
 * declared operation must have a handler key in `src/contract/handlers`, or an entry in
 * `DEFERRED_OPERATIONS` naming the phase that owns it.
 *
 * It reads the handler sources rather than instantiating them: building 8 Nest providers with 20
 * dependencies to read a Map would test the DI container, not the coverage.
 */
const HANDLER_DIR = fileURLToPath(new URL('../../src/contract/handlers', import.meta.url));

function declaredHandlerKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of readdirSync(HANDLER_DIR).filter((name) => name.endsWith('.handlers.ts'))) {
    // Normalise whitespace first: a `key('GET',\n '/x')` call is still a handler.
    const text = readFileSync(join(HANDLER_DIR, file), 'utf8').replace(/\s+/g, ' ');

    for (const key of handlerKeysIn(text)) keys.add(key);
  }
  return keys;
}

/** Every `METHOD path` a handler file claims, in source order, with the offset of its key. */
function handlerKeyPositions(text: string): { key: string; index: number }[] {
  const positions: { key: string; index: number }[] = [];
  const patterns = [
    /key\(\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*'([^']+)'\s*\)/g,
    /'(GET|POST|PUT|PATCH|DELETE) (\/[^']*)'\s*:/g,
    /\['(GET|POST|PUT|PATCH|DELETE) (\/[^']*)'/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      positions.push({ key: `${match[1]} ${match[2]}`, index: match.index ?? 0 });
    }
  }
  return positions.sort((left, right) => left.index - right.index);
}

function handlerKeysIn(text: string): string[] {
  return handlerKeyPositions(text).map((position) => position.key);
}

/**
 * Operations whose handler reads `input.body`.
 *
 * A handler is one array element, so the text between its key and the next key is its body. This is
 * the only static link available: `input.body` is `unknown`, and a cast inside a handler compiles
 * whatever the contract says.
 */
function bodyReadingKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of readdirSync(HANDLER_DIR).filter((name) => name.endsWith('.handlers.ts'))) {
    const text = readFileSync(join(HANDLER_DIR, file), 'utf8').replace(/\s+/g, ' ');
    // `key(...)` builds one array element per operation, so a segment is bounded by the next key.
    // The one file that maps literal keys to delegating methods (`auth.handlers.ts`) has no such
    // boundary: there, a method far below a key would be attributed to it. Its two body-bearing
    // operations are exercised end to end by the session suite instead.
    if (!text.includes('key(')) continue;
    const positions = handlerKeyPositions(text);
    for (const [index, position] of positions.entries()) {
      const next = positions[index + 1];
      const end = next === undefined ? text.length : next.index;
      if (/\binput\.body\b/.test(text.slice(position.index, end))) keys.add(position.key);
    }
  }
  return keys;
}

describe('handler coverage', () => {
  const handlers = declaredHandlerKeys();
  const declared = API_OPERATIONS.map((operation) => operationKey(operation));

  it('implements every declared operation or delegates it to a named phase', () => {
    const uncovered = declared.filter((key) => !handlers.has(key) && !DEFERRED_OPERATIONS.has(key));
    expect(uncovered, 'declared without a handler and without a deferred owner').toEqual([]);
  });

  it('does not implement a handler for an operation the contract does not declare', () => {
    const declaredSet = new Set(declared);
    const orphans = [...handlers].filter((key) => !declaredSet.has(key));
    expect(orphans, 'handler mounted for an undeclared operation').toEqual([]);
  });

  it('does not both implement and defer the same operation', () => {
    const both = declared.filter((key) => handlers.has(key) && DEFERRED_OPERATIONS.has(key));
    expect(both, 'implemented and deferred at once').toEqual([]);
  });

  it('reports a plausible count, so a broken parser cannot pass silently', () => {
    expect(handlers.size).toBeGreaterThanOrEqual(declared.length - DEFERRED_OPERATIONS.size);
  });

  /**
   * The dispatcher only hands a handler a parsed body when the operation declares `request`. A
   * handler that reads `input.body` for an operation without a schema therefore reads `undefined`
   * (the boundary rejects a supplied body with 422), and its `as { … }` cast documented a shape
   * nothing validated. This makes the pairing a gate instead of a convention.
   */
  it('declares a request schema for every operation whose handler reads a body', () => {
    const byKey = new Map(API_OPERATIONS.map((operation) => [operationKey(operation), operation]));
    const unbacked = [...bodyReadingKeys()].filter((key) => byKey.get(key)?.request === undefined);
    expect(
      unbacked,
      'handler reads input.body but the operation declares no request schema',
    ).toEqual([]);
  });
});
