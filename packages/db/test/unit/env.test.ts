import { isAbsolute } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadRootEnv } from '../../src/env';

function errnoError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

describe('loadRootEnv', () => {
  it('loads the .env at the repository root, not one relative to the working directory', () => {
    const load = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined);

    loadRootEnv();

    expect(load).toHaveBeenCalledTimes(1);
    const loaded = load.mock.calls[0]?.[0];
    expect(typeof loaded).toBe('string');
    expect(String(loaded)).toMatch(/\.env$/);
    // Resolved from this module, so `pnpm --filter` and a direct `tsx` run behave identically.
    expect(isAbsolute(String(loaded))).toBe(true);
  });

  it('treats a missing root .env as "the caller supplies the variables"', () => {
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw errnoError('ENOENT: no such file or directory', 'ENOENT');
    });

    expect(() => loadRootEnv()).not.toThrow();
  });

  it('rethrows an unreadable .env instead of hiding it', () => {
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw errnoError('EACCES: permission denied', 'EACCES');
    });

    expect(() => loadRootEnv()).toThrow(/permission denied/);
  });

  it('rethrows a failure with no errno code, because that is not a missing file', () => {
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw new Error('the environment could not be parsed');
    });

    expect(() => loadRootEnv()).toThrow(/could not be parsed/);
  });

  it('rethrows a non-Error rejection as well, without reading a code from it', () => {
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw 'env loader exploded';
    });

    expect(() => loadRootEnv()).toThrow();
  });
});
