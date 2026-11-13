import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/config/config';

/**
 * The three arms the main suite cannot reach: a flag that arrives as a real boolean (an environment
 * object built in code, not by the shell), a parse failure with no field path to name, and a
 * redirect list that survives `min(1)` while containing nothing but separators.
 */
const BASE = {
  DATABASE_URL: 'postgres://seamnex:secret@localhost:5432/seamnex_platform',
  REDIS_URL: 'redis://localhost:6379',
};

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // `loadConfig()` with no argument reads the live environment; a key left behind leaks into the
  // next suite in the same worker.
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe('boolean flags', () => {
  it('honours a value that is already a boolean instead of lower-casing it', () => {
    // A caller that assembles the environment in code passes `false`, not "false". Reading the flag
    // through `value.toLowerCase()` threw on the boolean and took the whole boot down.
    const config = loadConfig({
      ...BASE,
      SESSION_COOKIE_SECURE: false,
      SEAMNEX_METRICS_ENABLED: true,
    } as unknown as NodeJS.ProcessEnv);

    expect(config.SESSION_COOKIE_SECURE).toBe(false);
    expect(config.SEAMNEX_METRICS_ENABLED).toBe(true);
  });

  it('parses the string forms the shell can actually carry', () => {
    const on = loadConfig({ ...BASE, SEAMNEX_ROOT_KEY_STRICT_MODE: 'YES' });
    const off = loadConfig({ ...BASE, SEAMNEX_ROOT_KEY_STRICT_MODE: 'off' });

    expect(on.SEAMNEX_ROOT_KEY_STRICT_MODE).toBe(true);
    expect(off.SEAMNEX_ROOT_KEY_STRICT_MODE).toBe(false);
  });
});

describe('loading from the live environment', () => {
  it('reads process.env when no object is passed', () => {
    process.env.DATABASE_URL = BASE.DATABASE_URL;
    process.env.REDIS_URL = BASE.REDIS_URL;
    process.env.SEAMNEX_JOB_STREAM_MAX = '7';

    const config = loadConfig();

    expect(config.REDIS_URL).toBe(BASE.REDIS_URL);
    expect(config.SEAMNEX_JOB_STREAM_MAX).toBe(7);
  });
});

describe('refusals', () => {
  it('names the root when the failing issue has no field path of its own', () => {
    try {
      loadConfig(null as unknown as NodeJS.ProcessEnv);
      expect.unreachable('an environment that is not an object must not load');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      // A non-object root is reported at `path: []`; an empty path must still be legible.
      expect(issues[0]?.path).toBe('(root)');
      expect((error as ConfigError).message).toContain('(root): ');
    }
  });
});

describe('redirect paths', () => {
  it('falls back to the shipped callback path when the list holds only separators', () => {
    // `min(1)` accepts " , " — a typo in a deployment file. The screen the client appends to must
    // still be the registered one rather than an empty string.
    const config = loadConfig({ ...BASE, AUTH_REDIRECT_PATHS: ' , ' });

    expect(config.authRedirectPaths).toEqual([]);
    expect(config.authRedirectPath).toBe('/sign-in');
  });
});
