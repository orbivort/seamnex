import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAssertedRole,
  devSignInAvailable,
  readAssertedRole,
  rememberAssertedRole,
  rememberAuthProvider,
} from '../../src/session-role';

/**
 * The asserted role is a rendering hint stored per tab. The two failure modes worth pinning are a
 * hand-edited value (which must not render a role the server never granted) and unavailable
 * storage (which must not stop the application from booting).
 */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('without storage', () => {
  it('degrades to the URL hint rather than throwing', () => {
    // Node has no `sessionStorage`: the same guard covers a blocked partition in a browser.
    expect(readAssertedRole()).toBeNull();
    expect(devSignInAvailable()).toBe(false);
    expect(() => rememberAssertedRole('R1')).not.toThrow();
    expect(() => rememberAuthProvider('stub')).not.toThrow();
    expect(() => clearAssertedRole()).not.toThrow();
  });
});

describe('with storage', () => {
  it('remembers and exposes the asserted role for this tab', () => {
    vi.stubGlobal('sessionStorage', memoryStorage());

    rememberAssertedRole('R3');
    expect(readAssertedRole()).toBe('R3');

    clearAssertedRole();
    expect(readAssertedRole()).toBeNull();
  });

  it('refuses a stored value that is not a platform role', () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);

    storage.setItem('seamnex:asserted-role', 'R9');
    expect(readAssertedRole()).toBeNull();

    storage.setItem('seamnex:asserted-role', '');
    expect(readAssertedRole()).toBeNull();
  });

  it('records which provider issued the session, which is what the switcher reads', () => {
    vi.stubGlobal('sessionStorage', memoryStorage());

    expect(devSignInAvailable()).toBe(false);
    rememberAuthProvider('stub');
    expect(devSignInAvailable()).toBe(true);
    rememberAuthProvider('oidc');
    expect(devSignInAvailable()).toBe(false);
  });

  it('survives a storage that refuses to read or write', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });

    expect(readAssertedRole()).toBeNull();
    expect(devSignInAvailable()).toBe(false);
    expect(() => rememberAssertedRole('R1')).not.toThrow();
    expect(() => rememberAuthProvider('oidc')).not.toThrow();
    expect(() => clearAssertedRole()).not.toThrow();
  });

  it('survives a partition where the storage property itself is unreachable', () => {
    // Some blocked partitions throw on the property access, before any method is called.
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });

    try {
      expect(readAssertedRole()).toBeNull();
      expect(devSignInAvailable()).toBe(false);
      expect(() => rememberAssertedRole('R1')).not.toThrow();
      expect(() => rememberAuthProvider('stub')).not.toThrow();
    } finally {
      Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  });
});
