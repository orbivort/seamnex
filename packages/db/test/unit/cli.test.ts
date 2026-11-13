import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/**
 * `cli.ts` is a script: it parses `process.argv`, builds a pool and exits. Rather than refactor it
 * for testability, the three collaborators are mocked and the module is imported afresh with the
 * argv of the command under test — which also exercises the wiring (env load, exit codes, pool
 * shutdown) that a refactor would have hidden.
 */
const doubles = vi.hoisted(() => ({
  createPool: vi.fn(),
  loadRootEnv: vi.fn(),
  migrateUp: vi.fn(),
  migrateDown: vi.fn(),
  migrationStatus: vi.fn(),
  end: vi.fn(),
}));

vi.mock('../../src/client', () => ({ createPool: doubles.createPool }));
vi.mock('../../src/env', () => ({ loadRootEnv: doubles.loadRootEnv }));
vi.mock('../../src/migrate', () => ({
  migrateUp: doubles.migrateUp,
  migrateDown: doubles.migrateDown,
  migrationStatus: doubles.migrationStatus,
}));

const CONNECTION = 'postgres://seamnex:seamnex@localhost:5432/seamnex';
const originalEnv = { DATABASE_URL: process.env.DATABASE_URL };
const originalArgv = [...process.argv];

let logSpy: MockInstance<typeof console.log>;
let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  doubles.createPool.mockReturnValue({ query: vi.fn(), end: doubles.end });
  doubles.end.mockResolvedValue(undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  process.argv = [...originalArgv];
  if (originalEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalEnv.DATABASE_URL;
  process.exitCode = undefined;
});

/**
 * Runs the CLI with the given arguments and resolves with the exit code it chose.
 *
 * `process.exitCode` is restored before returning: leaving a `1` behind would fail the worker that
 * is running this suite.
 */
async function runCli(
  args: readonly string[],
  env: Record<string, string | undefined> = { DATABASE_URL: CONNECTION },
): Promise<number | string | undefined> {
  const previousExitCode = process.exitCode;
  process.argv = ['node', 'cli.ts', ...args];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.exitCode = undefined;

  vi.resetModules();
  await import('../../src/cli');

  await vi.waitFor(() => {
    expect(process.exitCode).toBeDefined();
  });

  const chosen = process.exitCode;
  process.exitCode = previousExitCode;
  return chosen;
}

function loggedLines(): unknown[] {
  return logSpy.mock.calls.map((call) => call[0]);
}

describe('migrate cli', () => {
  it('refuses to start without DATABASE_URL, and does not open a pool', async () => {
    const code = await runCli(['up'], { DATABASE_URL: undefined });

    expect(code).toBe(1);
    expect(doubles.loadRootEnv).toHaveBeenCalledTimes(1);
    expect(doubles.createPool).not.toHaveBeenCalled();
    expect(doubles.end).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/DATABASE_URL is required/);
  });

  it('treats an empty DATABASE_URL as absent', async () => {
    const code = await runCli(['up'], { DATABASE_URL: '' });

    expect(code).toBe(1);
    expect(doubles.createPool).not.toHaveBeenCalled();
  });

  it('applies pending migrations and reports how many ran', async () => {
    doubles.migrateUp.mockResolvedValue(['0001_create_alpha', '0002_add_beta']);

    const code = await runCli(['up']);

    expect(code).toBe(0);
    expect(doubles.createPool).toHaveBeenCalledWith({
      connectionString: CONNECTION,
      max: 2,
      applicationName: 'seamnex-migrate',
    });
    expect(doubles.migrateUp).toHaveBeenCalledTimes(1);
    expect(loggedLines()).toEqual(['2 migration(s) applied']);
    expect(doubles.end).toHaveBeenCalledTimes(1);
  });

  it('says the schema is up to date when nothing was pending', async () => {
    doubles.migrateUp.mockResolvedValue([]);

    const code = await runCli(['up']);

    expect(code).toBe(0);
    expect(loggedLines()).toEqual(['schema is up to date']);
  });

  it('passes a logger the runner can write through', async () => {
    doubles.migrateUp.mockResolvedValue([]);

    await runCli(['up']);

    const options = doubles.migrateUp.mock.calls[0]?.[0] as { log: (line: string) => void };
    options.log('applied 0001_create_alpha (3 ms)');

    expect(logSpy).toHaveBeenCalledWith('applied 0001_create_alpha (3 ms)');
  });

  it('defaults `down` to one step', async () => {
    doubles.migrateDown.mockResolvedValue(['0002_add_beta']);

    const code = await runCli(['down']);

    expect(code).toBe(0);
    expect(doubles.migrateDown).toHaveBeenCalledWith(
      expect.objectContaining({ steps: 1, pool: expect.anything() }),
    );
    expect(loggedLines()).toEqual(['1 migration(s) reverted']);
  });

  it('honours an explicit step count', async () => {
    doubles.migrateDown.mockResolvedValue(['0003_add_gamma', '0002_add_beta']);

    const code = await runCli(['down', '2']);

    expect(code).toBe(0);
    expect(doubles.migrateDown).toHaveBeenCalledWith(expect.objectContaining({ steps: 2 }));
    expect(loggedLines()).toEqual(['2 migration(s) reverted']);
  });

  it.each([
    ['not a number', 'abc'],
    ['zero', '0'],
    ['negative', '-3'],
  ])('falls back to one step for a %s argument', async (_label, argument) => {
    doubles.migrateDown.mockResolvedValue([]);

    const code = await runCli(['down', argument]);

    expect(code).toBe(0);
    expect(doubles.migrateDown).toHaveBeenCalledWith(expect.objectContaining({ steps: 1 }));
  });

  it('says there is nothing to roll back on an empty ledger', async () => {
    doubles.migrateDown.mockResolvedValue([]);

    const code = await runCli(['down']);

    expect(code).toBe(0);
    expect(loggedLines()).toEqual(['nothing to roll back']);
  });

  it('reports applied and pending migrations, and exits 2 while work is pending', async () => {
    doubles.migrationStatus.mockResolvedValue({
      applied: [{ id: '0001_create_alpha', appliedAt: '2025-01-01T00:00:00.000Z', durationMs: 7 }],
      pending: [{ id: '0002_add_beta' }],
    });

    const code = await runCli(['status']);

    expect(code).toBe(2);
    expect(loggedLines()).toEqual([
      'applied: 1',
      '  ✓ 0001_create_alpha (7 ms)',
      'pending: 1',
      '  · 0002_add_beta',
    ]);
  });

  it('exits 0 when the schema is fully applied', async () => {
    doubles.migrationStatus.mockResolvedValue({
      applied: [{ id: '0001_create_alpha', appliedAt: '2025-01-01T00:00:00.000Z', durationMs: 7 }],
      pending: [],
    });

    const code = await runCli(['status']);

    expect(code).toBe(0);
    expect(loggedLines()).toEqual(['applied: 1', '  ✓ 0001_create_alpha (7 ms)', 'pending: 0']);
  });

  it('defaults to `status` when no command is given', async () => {
    doubles.migrationStatus.mockResolvedValue({ applied: [], pending: [] });

    const code = await runCli([]);

    expect(code).toBe(0);
    expect(doubles.migrationStatus).toHaveBeenCalledTimes(1);
    expect(loggedLines()).toEqual(['applied: 0', 'pending: 0']);
  });

  it('rejects an unknown command without touching the database', async () => {
    const code = await runCli(['frobnicate']);

    expect(code).toBe(1);
    expect(doubles.migrateUp).not.toHaveBeenCalled();
    expect(doubles.migrationStatus).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]?.[0]).toBe(
      'Unknown command "frobnicate". Expected up, down or status.',
    );
  });

  it('reports a failing migration and still closes the pool', async () => {
    doubles.migrateUp.mockRejectedValue(new Error('Migration 0002_add_beta failed: syntax error'));

    const code = await runCli(['up']);

    expect(code).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('Migration 0002_add_beta failed: syntax error');
    expect(doubles.end).toHaveBeenCalledTimes(1);
  });

  it('stringifies a non-Error failure', async () => {
    doubles.migrateUp.mockRejectedValue('connection terminated');

    const code = await runCli(['up']);

    expect(code).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('connection terminated');
  });
});
