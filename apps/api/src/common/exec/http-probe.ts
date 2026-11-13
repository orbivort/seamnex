import type { ExecResult } from './exec';

/**
 * One HTTP readiness probe, executed from a throwaway container on the instance network.
 *
 * A probe container is unavoidable: the platform never publishes a host port (the compose policy
 * forbids it), and the API process is not attached to any instance's bridge network, so an
 * in-process `fetch` cannot reach the product.
 *
 * Why `wget -S` and not a hand-rolled request over `nc`: the probe used to write
 * `GET / HTTP/1.0` + `Connection: close` into `nc -w 3`. That is a fine HTTP client in theory and a
 * silent liar in practice — against the nginx frontend of an ERPNext deployment (D6) every probe
 * was logged by nginx as `499` with `0` bytes sent and the probe reported "no HTTP answer", for
 * twenty minutes, while `curl`, Node's `http` and Node's raw socket all read `200 OK` in under
 * 100 ms from the same network, and `nc` against the gunicorn backend answered `HTTP/1.0 200 OK`.
 * The instance was healthy and the readiness signal was wrong — the worst possible failure for this
 * check, because "not ready" is what a sampler turns into a `degraded` badge and what a verify stage
 * turns into a failed deployment.
 *
 * `wget -S` prints the status line it received on stderr whatever happens next, and the verdict is
 * read from that line, never from wget's exit code. That also removes the old reason this probe
 * avoided wget: wget follows redirects, and a *relative* `Location` cannot be resolved without a
 * base URL. EspoCRM answers `302 Found` with `Location: install/` until it is installed, so wget
 * exits non-zero with "bad address 'install'" — but the `302` it already printed is the answer this
 * probe needs. Any HTTP status below 500 proves what the probe is for: the product listens on its
 * port and speaks HTTP. A 5xx is still a failure, because that is the product answering in a broken
 * state.
 *
 * The target never appears inside the script: `sh -c` receives the host and the port as positional
 * parameters, so a slug cannot become shell syntax.
 */

const PROBE_IMAGE = 'busybox:1.36';

const PROBE_SCRIPT = [
  'line=$(wget -S -T 5 -O /dev/null "http://$1:$2/" 2>&1 | grep -m1 "HTTP/1")',
  'code=$(echo "$line" | tr -s " " | cut -d" " -f3)',
  'case "$code" in 2*|3*|4*) echo "HTTP $code"; exit 0;; esac',
  'echo "${line:-no HTTP answer}"',
  'exit 1',
].join('\n');

export type HttpProbeResult = {
  readonly ok: boolean;
  /** The status line the product answered with, or an empty string when nothing answered. */
  readonly statusLine: string;
};

export type HttpProbeInput = {
  /** `docker` CLI runner of the calling module (each module owns its client). */
  readonly runCli: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<ExecResult>;
  /** Instance network the probe container joins, e.g. `seamnex-inst-crm`. */
  readonly network: string;
  /** Host to address; the platform aliases the product service as `<slug>`. */
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
};

export async function probeProductHttp(input: HttpProbeInput): Promise<HttpProbeResult> {
  try {
    const result = await input.runCli(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        input.network,
        PROBE_IMAGE,
        'sh',
        '-c',
        PROBE_SCRIPT,
        'seamnex-probe',
        input.host,
        String(input.port),
      ],
      input.timeoutMs ?? 30_000,
    );
    const statusLine = result.stdout.trim().split(/\r?\n/)[0] ?? '';
    return { ok: result.code === 0, statusLine };
  } catch {
    // A probe that cannot run (no docker, image missing) is a failure to answer, not a crash of the
    // caller: the deploy stage reports it, the sampler records it.
    return { ok: false, statusLine: '' };
  }
}

/** A short, human-readable outcome for a job log or a probe row. */
export function describeProbe(result: HttpProbeResult): string {
  return result.statusLine === '' ? 'no HTTP answer' : result.statusLine;
}
