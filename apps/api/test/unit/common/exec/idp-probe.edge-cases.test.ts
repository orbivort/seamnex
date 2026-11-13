import { describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../../../src/common/exec/exec';
import { probeIdpFromNetwork } from '../../../../src/common/exec/idp-probe';

/** The `docker` CLI runner the probe accepts, named so the mock carries a real signature. */
type RunCli = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

/**
 * The exit code is only evidence for `ANSWER`. The failure branches are read from the marker the
 * script printed, so a shell that answered 0 because of a quirk in `wget` still produces `dns`
 * rather than a green check — the leg this probe exists for was exactly the one that reported
 * healthy while the product could not resolve the IdP.
 *
 * The detail ends up in a check row, so the quoted output is cut at 160 characters: a probe that
 * dumped a TLS handshake into `detail` would push the actual verdict out of the table.
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

describe('the marker decides the verdict, not the exit code', () => {
  it('reports dns for a zero exit code that carries the DNS marker', async () => {
    const result = await probeIdpFromNetwork({
      ...INPUT,
      runCli: runner({ code: 0, stdout: 'DNS keycloak does not resolve on this network\n' }),
    });

    expect(result).toMatchObject({ ok: false, failure: 'dns' });
  });

  it('quotes an answer that carried nothing after the marker', async () => {
    const result = await probeIdpFromNetwork({
      ...INPUT,
      runCli: runner({ code: 0, stdout: 'ANSWER' }),
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toBe('keycloak:8080 answers from seamnex-inst-crm ()');
  });
});

describe('the quoted output stays readable', () => {
  it('cuts the quoted line at 160 characters', async () => {
    const line = `FAIL ${'y'.repeat(400)}`;
    const result = await probeIdpFromNetwork({
      ...INPUT,
      runCli: runner({ code: 1, stdout: line }),
    });

    expect(result.detail).toBe(
      `keycloak:8080 did not answer from seamnex-inst-crm: ${line.slice(0, 160)}`,
    );
  });

  it('takes only the first line, so a multi-line handshake does not become the detail', async () => {
    const result = await probeIdpFromNetwork({
      ...INPUT,
      runCli: runner({ code: 1, stdout: 'connecting...\ntimeout after 5 s\n' }),
    });

    expect(result.detail).toBe('keycloak:8080 did not answer from seamnex-inst-crm: connecting...');
  });
});
