import { describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../../../src/common/exec/exec';
import { describeProbe, probeProductHttp } from '../../../../src/common/exec/http-probe';

/** The `docker` CLI runner the probe accepts, named so the mock carries a real signature. */
type RunCli = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

/**
 * The probe hands the target to `sh -c` as positional parameters precisely so a slug can never be
 * read as shell syntax. That property is asserted on the argv the CLI receives, because it is the
 * only place it is observable: a host interpolated into the script would look identical from the
 * result.
 *
 * The verdict is `code === 0`, never the status line on its own: the script exits 0 only for 2xx,
 * 3xx and 4xx, so a tool that printed `HTTP 200` and then failed must not read as healthy.
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

describe('the target never becomes shell text', () => {
  it('passes a hostile host as its own argv entry, outside the script', async () => {
    const runCli = runner({ code: 1, stdout: 'no HTTP answer\n' });
    const hostile = 'crm; rm -rf /tmp/x';

    await probeProductHttp({ ...INPUT, host: hostile, runCli });

    const [, args] = runCli.mock.calls[0] as [string, readonly string[], number];
    const script = args[args.indexOf('-c') + 1] ?? '';
    expect(script).not.toContain(hostile);
    expect(args.at(-2)).toBe(hostile);
    expect(args.at(-1)).toBe('8080');
  });

  it('stringifies the port so a numeric target cannot arrive as a number in argv', async () => {
    const runCli = runner({ code: 0, stdout: 'HTTP 200\n' });
    await probeProductHttp({ ...INPUT, port: 65_535, runCli });

    expect((runCli.mock.calls[0] as [string, readonly string[], number])[1].at(-1)).toBe('65535');
  });
});

describe('the verdict comes from the exit code', () => {
  it('reports a failure even when a status line was printed before the script failed', async () => {
    const result = await probeProductHttp({
      ...INPUT,
      runCli: runner({ code: 1, stdout: 'HTTP 200\nbad address\n' }),
    });

    expect(result).toEqual({ ok: false, statusLine: 'HTTP 200' });
  });

  it('names an answerless probe for a job log', () => {
    // A 5xx is a product answering in a broken state: it is reported, not hidden behind "no answer".
    expect(describeProbe({ ok: false, statusLine: 'HTTP 503' })).toBe('HTTP 503');
  });

  it('reads a non-zero exit other than 1 as a failure too', async () => {
    // 137 is SIGKILL and -1 is a killed child; the script's own `exit 1` is not the only failure the
    // runner can report, so the verdict cannot be `code !== 1`.
    for (const code of [2, 137, -1]) {
      const result = await probeProductHttp({
        ...INPUT,
        runCli: runner({ code, stdout: 'HTTP 503\n' }),
      });

      expect(result).toEqual({ ok: false, statusLine: 'HTTP 503' });
    }
  });
});

describe('the status line is the first non-blank line the tool printed', () => {
  it('strips CRLF endings so a Windows-side line cannot smuggle a trailing carriage return', async () => {
    const result = await probeProductHttp({
      ...INPUT,
      runCli: runner({ code: 0, stdout: 'HTTP 200 OK\r\nHTTP 200 OK\r\n' }),
    });

    expect(result).toEqual({ ok: true, statusLine: 'HTTP 200 OK' });
  });

  it('drops the leading blank lines wget writes before the status line', async () => {
    const result = await probeProductHttp({
      ...INPUT,
      runCli: runner({ code: 0, stdout: '\n\nHTTP 302 Found\nLocation: install/\n' }),
    });

    expect(result).toEqual({ ok: true, statusLine: 'HTTP 302 Found' });
  });

  it('reports whitespace-only output as no answer rather than as a status line', async () => {
    const result = await probeProductHttp({
      ...INPUT,
      runCli: runner({ code: 0, stdout: '  \r\n\t\n' }),
    });

    expect(result).toEqual({ ok: true, statusLine: '' });
    expect(describeProbe(result)).toBe('no HTTP answer');
  });

  it('never lets a missing line reach the caller as the string "undefined"', async () => {
    // `split` always yields at least one element, so the `?? ''` on the first line is depth rather
    // than a path a real runner reaches; it is still executed here, because a fallback nobody ran is
    // a fallback nobody has checked.
    const runCli = vi.fn<RunCli>().mockResolvedValue({
      code: 0,
      stdout: { trim: () => ({ split: () => [] }) } as unknown as string,
      stderr: '',
      truncated: false,
    });

    expect(await probeProductHttp({ ...INPUT, runCli })).toEqual({ ok: true, statusLine: '' });
  });
});

describe('the probe runs once, with a timeout that is always a number', () => {
  it('does not retry: one probe is one container', async () => {
    const runCli = runner({ code: 1, stdout: 'no HTTP answer\n' });

    await probeProductHttp({ ...INPUT, runCli });

    expect(runCli).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit zero timeout instead of replacing it with the default', async () => {
    // `??` and not `||`: 0 is a value the caller chose, and silently substituting 30 s would hide a
    // misconfiguration behind a probe that runs far longer than intended.
    const runCli = runner({ code: 0, stdout: 'HTTP 200\n' });
    await probeProductHttp({ ...INPUT, runCli, timeoutMs: 0 });

    expect((runCli.mock.calls[0] as [string, readonly string[], number])[2]).toBe(0);
  });

  it('stringifies a boundary port', async () => {
    const runCli = runner({ code: 0, stdout: 'HTTP 200\n' });
    await probeProductHttp({ ...INPUT, port: 0, runCli });

    expect((runCli.mock.calls[0] as [string, readonly string[], number])[1].at(-1)).toBe('0');
  });
});

describe('a probe that cannot run is an answerless failure', () => {
  it('survives a runner that throws something that is not an Error', async () => {
    const runCli = vi.fn<RunCli>().mockRejectedValue('docker: not found');

    expect(await probeProductHttp({ ...INPUT, runCli })).toEqual({ ok: false, statusLine: '' });
    expect(describeProbe(await probeProductHttp({ ...INPUT, runCli }))).toBe('no HTTP answer');
  });

  it('survives a runner that rejects synchronously', async () => {
    const runCli = vi.fn<RunCli>(() => {
      throw new Error('spawn docker ENOENT');
    });

    expect(await probeProductHttp({ ...INPUT, runCli })).toEqual({ ok: false, statusLine: '' });
  });
});
