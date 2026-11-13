import { describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../../../src/common/exec/exec';
import { probeIdpFromNetwork } from '../../../../src/common/exec/idp-probe';

/** The `docker` CLI runner the probe accepts, named so the mock carries a real signature. */
type RunCli = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

/**
 * The leg that broke invisibly: the product could not resolve the IdP from its own network while
 * every platform-side check stayed green. The probe must therefore keep `dns` and `connect` apart —
 * they send an operator to two different fixes.
 */
function runner(result: { code: number; stdout?: string }): ReturnType<typeof vi.fn<RunCli>> {
  return vi.fn<RunCli>().mockResolvedValue({
    code: result.code,
    stdout: result.stdout ?? '',
    stderr: '',
    truncated: false,
  });
}

const INPUT = {
  network: 'seamnex-inst-crm',
  host: 'keycloak',
  port: 8080,
  path: '/realms/seamnex/x',
};

describe('probeIdpFromNetwork', () => {
  it('runs the probe container on the instance network with positional parameters', async () => {
    const runCli = runner({ code: 0, stdout: 'ANSWER HTTP/1.1 200 OK\n' });

    const result = await probeIdpFromNetwork({ ...INPUT, runCli });

    expect(result.ok).toBe(true);
    expect(result.failure).toBe('none');
    expect(result.detail).toContain('keycloak:8080 answers from seamnex-inst-crm');
    expect(result.detail).toContain('HTTP/1.1 200 OK');

    const [file, args, timeout] = runCli.mock.calls[0] as [string, string[], number];
    expect(file).toBe('docker');
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--network', 'seamnex-inst-crm']);
    expect(args.slice(-4)).toEqual(['seamnex-idp-probe', 'keycloak', '8080', '/realms/seamnex/x']);
    expect(timeout).toBe(30_000);
  });

  it('reports DNS as its own failure', async () => {
    const runCli = runner({
      code: 2,
      stdout: 'DNS keycloak does not resolve on this network\n',
    });

    const result = await probeIdpFromNetwork({ ...INPUT, runCli });

    expect(result).toMatchObject({ ok: false, failure: 'dns' });
    expect(result.detail).toContain('does not resolve from seamnex-inst-crm');
    expect(result.detail).toContain('JWKS');
  });

  it('reports connect as its own failure', async () => {
    const runCli = runner({
      code: 3,
      stdout: 'CONNECT nothing accepts connections on keycloak:8080\n',
    });

    const result = await probeIdpFromNetwork({ ...INPUT, runCli });

    expect(result).toMatchObject({ ok: false, failure: 'connect' });
    expect(result.detail).toContain('nothing accepts connections on port 8080');
  });

  it('reports any other output as no-answer, truncated for a log line', async () => {
    const runCli = runner({ code: 1, stdout: `FAIL ${'x'.repeat(400)}\n` });

    const result = await probeIdpFromNetwork({ ...INPUT, runCli });

    expect(result).toMatchObject({ ok: false, failure: 'no-answer' });
    expect(result.detail.length).toBeLessThan(300);
  });

  it('names "no output" when the script printed nothing', async () => {
    const result = await probeIdpFromNetwork({ ...INPUT, runCli: runner({ code: 1 }) });
    expect(result.detail).toContain('no output');
  });

  it('does not trust exit code 0 without the ANSWER marker', async () => {
    const result = await probeIdpFromNetwork({
      ...INPUT,
      runCli: runner({ code: 0, stdout: 'something else\n' }),
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('no-answer');
  });

  it('reports a probe container that cannot start, without claiming the product is broken', async () => {
    const runCli = vi.fn().mockRejectedValue(new Error('Cannot connect to the Docker daemon'));

    const result = await probeIdpFromNetwork({ ...INPUT, runCli });

    expect(result).toMatchObject({ ok: false, failure: 'no-answer' });
    expect(result.detail).toContain('could not run');
    expect(result.detail).toContain('Cannot connect to the Docker daemon');
  });

  it('stringifies a non-Error probe failure', async () => {
    const runCli = vi.fn().mockRejectedValue('daemon gone');
    const result = await probeIdpFromNetwork({ ...INPUT, runCli });
    expect(result.detail).toContain('daemon gone');
  });

  it('honours an explicit timeout', async () => {
    const runCli = runner({ code: 0, stdout: 'ANSWER HTTP/1.1 200 OK\n' });
    await probeIdpFromNetwork({ ...INPUT, runCli, timeoutMs: 2_000 });
    expect((runCli.mock.calls[0] as [string, string[], number])[2]).toBe(2_000);
  });
});
