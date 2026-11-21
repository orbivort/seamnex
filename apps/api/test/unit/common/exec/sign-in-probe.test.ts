import { describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../../../src/common/exec/exec';
import { probeSignInPage } from '../../../../src/common/exec/sign-in-probe';

type RunCli = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

/**
 * The leg the platform was missing: every identity-provider stage can pass while the product offers no
 * provider at all. The probe therefore has to tell "the page answers and does not offer it" apart from
 * "nothing answered" — one is a configuration defect, the other an unreachable container.
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
  network: 'seamnex-inst-erpnext',
  host: 'erpnext',
  port: 8080,
  path: '/login',
  marker: 'login_via_keycloak',
};

describe('probeSignInPage', () => {
  it('runs the probe container on the instance network with the target and marker as positionals', async () => {
    const runCli = runner({ code: 0, stdout: 'SIGNIN offered\n' });

    const result = await probeSignInPage({ ...INPUT, runCli });

    expect(result).toMatchObject({ ok: true, failure: 'none' });
    expect(result.detail).toContain('/login offers the identity provider');
    expect(result.detail).toContain('login_via_keycloak');

    const [file, args, timeout] = runCli.mock.calls[0] as [string, string[], number];
    expect(file).toBe('docker');
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '--network', 'seamnex-inst-erpnext']);
    expect(args.slice(-5)).toEqual([
      'seamnex-signin-probe',
      'erpnext',
      '8080',
      '/login',
      'login_via_keycloak',
    ]);
    expect(timeout).toBe(30_000);
  });

  it('reports an answered page that omits the provider as its own failure', async () => {
    const runCli = runner({ code: 1, stdout: 'SIGNIN absent\n' });

    const result = await probeSignInPage({ ...INPUT, runCli });

    expect(result).toMatchObject({ ok: false, failure: 'absent' });
    expect(result.detail).toContain('does not offer the identity provider');
    expect(result.detail).toContain('login_via_keycloak');
  });

  it('reports a page that did not answer without blaming the product configuration', async () => {
    const result = await probeSignInPage({ ...INPUT, runCli: runner({ code: 2 }) });

    expect(result).toMatchObject({ ok: false, failure: 'no-answer' });
    expect(result.detail).toContain('erpnext:8080/login did not answer');
    expect(result.detail).toContain('seamnex-inst-erpnext');
  });

  it('does not trust exit code 0 without the offered marker', async () => {
    const result = await probeSignInPage({
      ...INPUT,
      runCli: runner({ code: 0, stdout: 'something else\n' }),
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('no-answer');
  });

  it('reports a probe container that cannot start, without claiming the product is broken', async () => {
    const runCli = vi.fn().mockRejectedValue(new Error('Cannot connect to the Docker daemon'));

    const result = await probeSignInPage({ ...INPUT, runCli });

    expect(result).toMatchObject({ ok: false, failure: 'no-answer' });
    expect(result.detail).toContain('could not run');
    expect(result.detail).toContain('Cannot connect to the Docker daemon');
  });

  it('stringifies a non-Error probe failure', async () => {
    const runCli = vi.fn().mockRejectedValue('daemon gone');

    const result = await probeSignInPage({ ...INPUT, runCli });

    expect(result.detail).toContain('daemon gone');
  });

  it('honours an explicit timeout', async () => {
    const runCli = runner({ code: 0, stdout: 'SIGNIN offered\n' });

    await probeSignInPage({ ...INPUT, runCli, timeoutMs: 2_000 });

    expect((runCli.mock.calls[0] as [string, string[], number])[2]).toBe(2_000);
  });
});
