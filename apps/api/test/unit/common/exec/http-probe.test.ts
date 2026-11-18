import { describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../../../src/common/exec/exec';
import {
  describeProbe,
  installerTarget,
  probeProductHttp,
} from '../../../../src/common/exec/http-probe';

/** The `docker` CLI runner the probe accepts, named so the mock carries a real signature. */
type RunCli = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

/**
 * The probe answers one question: does the product speak HTTP on its port? The verdict is read from
 * the status line, never from `wget`'s exit code — a 302 with an unresolvable relative Location
 * makes `wget` exit non-zero while proving the product is listening.
 */
function runner(result: {
  code: number;
  stdout?: string;
  stderr?: string;
}): ReturnType<typeof vi.fn<RunCli>> {
  return vi.fn<RunCli>().mockResolvedValue({
    code: result.code,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    truncated: false,
  });
}

const INPUT = { network: 'seamnex-inst-crm', host: 'crm', port: 8080 };

describe('probeProductHttp', () => {
  it('runs busybox wget with the target passed as positional parameters, not shell text', async () => {
    const runCli = runner({ code: 0, stdout: 'HTTP 200\n' });
    const result = await probeProductHttp({ ...INPUT, runCli });

    expect(result).toEqual({ ok: true, statusLine: 'HTTP 200', installer: null });

    const [file, args, timeout] = runCli.mock.calls[0] as [string, string[], number];
    expect(file).toBe('docker');
    expect(args.slice(0, 6)).toEqual([
      'run',
      '--rm',
      '--network',
      'seamnex-inst-crm',
      'busybox:1.36',
      'sh',
    ]);
    expect(args.slice(-3)).toEqual(['seamnex-probe', 'crm', '8080']);
    expect(timeout).toBe(30_000);
  });

  it('takes the first status line when the tool prints more', async () => {
    const runCli = runner({ code: 0, stdout: 'HTTP 204\nHTTP 204\n' });
    expect((await probeProductHttp({ ...INPUT, runCli })).statusLine).toBe('HTTP 204');
  });

  it('reports a failure when the probe script exits non-zero', async () => {
    const runCli = runner({ code: 1, stdout: 'no HTTP answer\n' });
    expect(await probeProductHttp({ ...INPUT, runCli })).toEqual({
      ok: false,
      statusLine: 'no HTTP answer',
      installer: null,
    });
  });

  it('honours an explicit timeout', async () => {
    const runCli = runner({ code: 0 });
    await probeProductHttp({ ...INPUT, runCli, timeoutMs: 5_000 });
    expect((runCli.mock.calls[0] as [string, string[], number])[2]).toBe(5_000);
  });

  it('treats a probe that cannot run as "did not answer", not a crash of the caller', async () => {
    const runCli = vi.fn().mockRejectedValue(new Error('Cannot connect to the Docker daemon'));
    expect(await probeProductHttp({ ...INPUT, runCli })).toEqual({
      ok: false,
      statusLine: '',
      installer: null,
    });
  });

  it('returns an empty status line when the tool printed nothing', async () => {
    const runCli = runner({ code: 0, stdout: '' });
    expect(await probeProductHttp({ ...INPUT, runCli })).toEqual({
      ok: true,
      statusLine: '',
      installer: null,
    });
  });
});

describe('installerTarget', () => {
  it('names a first-boot installer, whatever form the Location takes', () => {
    // EspoCRM answers a bare relative `install/`; OrangeHRM a path with its wizard behind it; the
    // absolute form is what a product behind a proxy sends.
    expect(installerTarget('install/')).toBe('install/');
    expect(installerTarget('/installer/index.php/welcome')).toBe('/installer/index.php/welcome');
    expect(installerTarget('https://h/wp-admin/install.php')).toBe(
      'https://h/wp-admin/install.php',
    );
    expect(installerTarget('/installation/index.php')).toBe('/installation/index.php');
  });

  it('leaves an ordinary redirect alone', () => {
    for (const location of [
      '/web/index.php/auth/login',
      '/login',
      '/setup',
      '/sites/installed',
      '',
    ]) {
      expect(installerTarget(location)).toBeNull();
    }
  });
});

describe('probeProductHttp, when the product answers with its installer', () => {
  it('reports the target as a second line, so "answered" and "installed" stay two facts', async () => {
    const runCli = runner({ code: 0, stdout: 'HTTP 302\nLOCATION /installer/index.php/welcome\n' });

    expect(await probeProductHttp({ ...INPUT, runCli })).toEqual({
      ok: true,
      statusLine: 'HTTP 302',
      installer: '/installer/index.php/welcome',
    });
  });

  it('keeps the installer out of the status line', async () => {
    const runCli = runner({ code: 0, stdout: 'HTTP 302\nLOCATION install/\n' });
    const result = await probeProductHttp({ ...INPUT, runCli });

    expect(describeProbe(result)).toBe('HTTP 302');
    expect(result.installer).toBe('install/');
  });
});

describe('describeProbe', () => {
  it('names an empty answer instead of leaving a blank cell', () => {
    expect(describeProbe({ ok: false, statusLine: '', installer: null })).toBe('no HTTP answer');
  });

  it('uses the status line when there is one', () => {
    expect(describeProbe({ ok: true, statusLine: 'HTTP 302', installer: null })).toBe('HTTP 302');
  });
});
