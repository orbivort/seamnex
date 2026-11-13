import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import type { AppConfig } from '../../../../src/config/config';

/**
 * The encryptor is a thin, audited wrapper around the `age` CLI. What it owns is the argument list,
 * the refusal when the adapter is disabled, and the refusal to restore without the escrowed identity.
 */
const state = vi.hoisted(() => ({
  runOrThrow: vi.fn(),
  identityExists: true,
  identityContent: '',
}));

vi.mock('../../../../src/common/exec/exec', () => ({ runOrThrow: state.runOrThrow }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    existsSync: (path: string) =>
      path === '/keys/seamnex.agekey' ? state.identityExists : actual.existsSync(path),
    readFileSync: (path: string, encoding: BufferEncoding) => {
      if (path !== '/keys/seamnex.agekey') return actual.readFileSync(path, encoding);
      if (!state.identityExists) throw new Error('ENOENT: no such file');
      return state.identityContent;
    },
  };
});

const { AgeEncryptor } = await import('../../../../src/modules/m16-backup-restore/age');

const CONFIG = {
  SEAMNEX_ADAPTERS_MODE: 'real',
  SEAMNEX_AGE_RECIPIENT: 'age1recipient',
  SEAMNEX_AGE_BINARY: 'age',
  SEAMNEX_AGE_IDENTITY_FILE: '/keys/seamnex.agekey',
} as unknown as AppConfig;

beforeEach(() => {
  state.runOrThrow.mockReset();
  state.runOrThrow.mockResolvedValue({ stdout: '', stderr: '' });
  state.identityExists = true;
  state.identityContent =
    '# created: 2026-01-01\n# public key: age1public\nAGE-SECRET-KEY-1SECRET\n';
});

describe('AgeEncryptor.encrypt', () => {
  it('streams the file through the audited CLI and returns the encrypted path', async () => {
    const result = await new AgeEncryptor(CONFIG).encrypt('/backups/dump.sql');

    expect(result).toEqual({ path: '/backups/dump.sql.age', recipient: 'age1recipient' });
    expect(state.runOrThrow).toHaveBeenCalledWith(
      'age',
      [
        '--encrypt',
        '--recipient',
        'age1recipient',
        '--output',
        '/backups/dump.sql.age',
        '/backups/dump.sql',
      ],
      { timeoutMs: 600_000 },
    );
  });

  it('refuses when the age adapter is disabled rather than writing plaintext', async () => {
    const encryptor = new AgeEncryptor({
      ...CONFIG,
      SEAMNEX_ADAPTERS_MODE: 'disabled',
    } as AppConfig);

    await expect(encryptor.encrypt('/backups/x')).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });

  it('refuses when no recipient is configured', async () => {
    const encryptor = new AgeEncryptor({ ...CONFIG, SEAMNEX_AGE_RECIPIENT: '' } as AppConfig);
    await expect(encryptor.encrypt('/backups/x')).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('SEAMNEX_AGE_RECIPIENT'),
    });
  });

  it('propagates a CLI failure rather than reporting an encrypted artefact', async () => {
    state.runOrThrow.mockRejectedValue(new Error('age not installed'));
    await expect(new AgeEncryptor(CONFIG).encrypt('/backups/x')).rejects.toThrow(
      'age not installed',
    );
  });
});

describe('AgeEncryptor.decrypt', () => {
  it('writes the plaintext next to the archive', async () => {
    const target = await new AgeEncryptor(CONFIG).decrypt('/backups/dump.sql.age');

    expect(target).toBe('/backups/dump.sql');
    expect(state.runOrThrow).toHaveBeenCalledWith(
      'age',
      [
        '--decrypt',
        '--identity',
        '/keys/seamnex.agekey',
        '--output',
        '/backups/dump.sql',
        '/backups/dump.sql.age',
      ],
      { timeoutMs: 600_000 },
    );
  });

  it('refuses when the escrowed identity is not on this host', async () => {
    state.identityExists = false;

    await expect(new AgeEncryptor(CONFIG).decrypt('/backups/x.age')).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('/keys/seamnex.agekey'),
      remediation: expect.stringContaining('escrowed identity'),
    });
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });

  it('keeps a path that does not end in .age', async () => {
    expect(await new AgeEncryptor(CONFIG).decrypt('/backups/x')).toBe('/backups/x');
  });
});

describe('AgeEncryptor identifiers', () => {
  it('reports the configured recipient, or unconfigured', () => {
    expect(new AgeEncryptor(CONFIG).recipientId()).toBe('age1recipient');
    expect(
      new AgeEncryptor({ ...CONFIG, SEAMNEX_AGE_RECIPIENT: '   ' } as AppConfig).recipientId(),
    ).toBe('unconfigured');
  });

  it('reads the public key line from the identity file and never the secret material', () => {
    const id = new AgeEncryptor(CONFIG).identityId();

    expect(id).toBe('public key: age1public');
    expect(id).not.toContain('AGE-SECRET-KEY');
  });

  it('reports escrowed when the file cannot be read', () => {
    state.identityExists = false;
    expect(new AgeEncryptor(CONFIG).identityId()).toBe('escrowed');
  });

  it('reports escrowed when the file has no comment naming the public key', () => {
    state.identityContent = 'AGE-SECRET-KEY-1SECRET\n';
    expect(new AgeEncryptor(CONFIG).identityId()).toBe('escrowed');
  });
});
