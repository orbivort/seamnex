import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_OPERATIONS, operationKey } from '@seamnex/domain';
import { handlers } from '@seamnex/mocks';

/** Every TypeScript source file in the API client, concatenated. */
function apiClientSource(): string {
  // jsdom gives `import.meta.url` an http scheme, so locate the package from the runner's cwd.
  const root = [
    resolve(process.cwd(), '../../packages/api-client/src'),
    resolve(process.cwd(), 'packages/api-client/src'),
  ].find((candidate) => existsSync(candidate));
  if (root === undefined)
    throw new Error('packages/api-client/src was not found from the test working directory');
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(readFileSync(path, 'utf8'));
    }
  };
  walk(root);
  return files.join('\n');
}

/**
 * Parity between the documented contract and what the mock actually serves.
 *
 * Any handler added, renamed or removed without updating `API_OPERATIONS` fails here,
 * which is what keeps `docs/openapi.json` from drifting away from the fixtures.
 */
function servedOperations(): Set<string> {
  const served = new Set<string>();
  for (const handler of handlers) {
    const info = (handler as { info?: { method?: string; path?: string | RegExp } }).info;
    if (!info?.method || typeof info.path !== 'string') continue;
    if (info.path === '/api/v1/*') continue;
    const path = info.path.replace('/api/v1', '');
    served.add(`${info.method.toUpperCase()} ${path}`);
  }
  return served;
}

describe('mock/contract parity', () => {
  it('serves exactly the operations in the contract registry', () => {
    const served = servedOperations();
    const documented = new Set(API_OPERATIONS.map(operationKey));

    const missingHandlers = [...documented].filter((key) => !served.has(key));
    const undocumented = [...served].filter((key) => !documented.has(key));

    expect(missingHandlers, 'documented but not served by the mock').toEqual([]);
    expect(undocumented, 'served by the mock but missing from the contract').toEqual([]);
  });

  /**
   * A `consumer: 'ui'` operation must be reachable from a hook. Operations marked
   * `external` (machine-readable registry, simulation control) are exempt by declaration,
   * so pruning the last caller of a screen-facing endpoint fails here instead of rotting.
   */
  it('keeps every screen-facing operation wired to the API client', () => {
    const source = apiClientSource();
    const orphans = API_OPERATIONS.filter((operation) => operation.consumer !== 'external')
      .filter((operation) => {
        // `:param` becomes "anything inside one template literal", so `${id}` and
        // `${containerId ?? ''}` both match without spanning statements.
        const pattern = operation.path
          .split(/:[A-Za-z_]+/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^`\\n]*');
        return !new RegExp(pattern).test(source);
      })
      .map(operationKey);

    expect(orphans, 'screen-facing operations with no hook consumer').toEqual([]);
  });
});
