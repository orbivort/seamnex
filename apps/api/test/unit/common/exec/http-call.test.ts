import { describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../../../src/common/exec/exec';
import { postProductJson, type HttpCallInput } from '../../../../src/common/exec/http-call';

/**
 * FR-2.4 — the one place the platform writes into a product, and therefore the one place a
 * credential could escape.
 *
 * Two properties are asserted rather than assumed: the token never appears in the container's
 * arguments (a host process list is readable), and a failure is reported as a status line so the
 * sync worker can record why an entitlement stayed `pending`.
 */
type RunCli = HttpCallInput['runCli'];

function result(partial: Partial<ExecResult>): ExecResult {
  return {
    code: partial.code ?? 0,
    stdout: partial.stdout ?? '',
    stderr: partial.stderr ?? '',
    truncated: false,
  };
}

function runner(exec: ExecResult): ReturnType<typeof vi.fn<RunCli>> {
  return vi.fn<RunCli>().mockResolvedValue(exec);
}

const INPUT: Omit<HttpCallInput, 'runCli'> = {
  network: 'seamnex-inst-crm',
  host: 'crm',
  port: 8080,
  path: '/api/users/roles',
  bearerToken: 'admin-token-value',
  payload: '{"role":"Manager"}',
  timeoutMs: 5_000,
};

describe('postProductJson', () => {
  it('posts the body to the product with the token on stdin and nothing secret in argv', async () => {
    const runCli = runner(result({ code: 0, stdout: 'HTTP 201\n' }));

    const outcome = await postProductJson({ ...INPUT, runCli });

    expect(outcome).toEqual({ ok: true, detail: 'HTTP 201' });

    const [file, args, options] = runCli.mock.calls[0] as [
      string,
      string[],
      { timeoutMs: number; input: string },
    ];
    expect(file).toBe('docker');
    expect(args.slice(0, 6)).toEqual([
      'run',
      '--rm',
      '--interactive',
      '--network',
      'seamnex-inst-crm',
      'busybox:1.38.0@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4',
    ]);
    // Host, port and path are positional parameters of `sh`, so a slug or a path can never become
    // shell syntax.
    expect(args.slice(-4)).toEqual(['seamnex-role-push', 'crm', '8080', '/api/users/roles']);
    expect(options.timeoutMs).toBe(5_000);
    expect(options.input).toBe('admin-token-value\n{"role":"Manager"}\n');

    // The whole point: neither the credential nor the body is readable from the process list.
    const argv = args.join(' ');
    expect(argv).not.toContain('admin-token-value');
    expect(argv).not.toContain('Manager');
  });

  it('reports the first status line and ignores whatever else the tool printed', async () => {
    const runCli = runner(result({ code: 0, stdout: 'HTTP 204\r\nConnecting to crm:8080\r\n' }));

    expect((await postProductJson({ ...INPUT, runCli })).detail).toBe('HTTP 204');
  });

  it('reports a refusal as not applied, carrying only the status line', async () => {
    const runCli = runner(result({ code: 1, stdout: 'HTTP 403\n' }));

    const outcome = await postProductJson({ ...INPUT, runCli });

    expect(outcome).toEqual({ ok: false, detail: 'HTTP 403' });
  });

  it('says so when the product answered nothing at all', async () => {
    const runCli = runner(result({ code: 1, stdout: '' }));

    expect(await postProductJson({ ...INPUT, runCli })).toEqual({
      ok: false,
      detail: 'no HTTP answer',
    });
  });

  it('treats a helper that cannot start as a recorded reason, not a crash of the cycle', async () => {
    const runCli = vi
      .fn<RunCli>()
      .mockRejectedValue(new Error('Cannot connect to the Docker daemon'));

    expect(await postProductJson({ ...INPUT, runCli })).toEqual({
      ok: false,
      detail: 'the role-push helper could not be started',
    });
  });
});
