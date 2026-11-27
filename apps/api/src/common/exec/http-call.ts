import type { ExecResult } from './exec';
import { BUSYBOX_IMAGE } from '../docker/images.generated';

/**
 * One authenticated JSON POST from a throwaway container on an instance network (FR-2.4).
 *
 * The same constraint that shapes `http-probe.ts` applies: the API is not attached to any instance
 * bridge, so an in-process `fetch` cannot reach a product. Unlike a probe this call carries a
 * credential, so the credential must not appear in the container's arguments — a `docker run -e
 * TOKEN=…` or a trailing argv is readable in the host's process list, and the role push is a write.
 *
 * The token and the JSON body are therefore written to `sh`'s **stdin**, read into shell variables
 * before the request is made. The target host, port and path stay positional parameters, so a slug
 * or a path can never become shell syntax. Only failures are returned, never the request.
 */

const CALL_IMAGE = BUSYBOX_IMAGE;

const CALL_SCRIPT = [
  'IFS= read -r token',
  'IFS= read -r payload',
  'out=$(wget -S -T 10 -O /dev/null ' +
    '--header="Authorization: Bearer $token" ' +
    '--header="Content-Type: application/json" ' +
    '--post-data="$payload" "http://$1:$2$3" 2>&1)',
  'line=$(echo "$out" | grep -m1 "HTTP/1")',
  'code=$(echo "$line" | tr -s " " | cut -d" " -f3)',
  'case "$code" in 2*) echo "HTTP $code"; exit 0;; esac',
  'echo "${line:-no HTTP answer}"',
  'exit 1',
].join('\n');

export type HttpCallInput = {
  readonly runCli: (
    file: string,
    args: readonly string[],
    options: { readonly timeoutMs: number; readonly input: string },
  ) => Promise<ExecResult>;
  /** Instance network the helper joins, e.g. `seamnex-inst-crm`. */
  readonly network: string;
  /** Host inside the instance network — the product's service alias, never an external name. */
  readonly host: string;
  readonly port: number;
  /** Absolute path beginning with `/`. */
  readonly path: string;
  readonly bearerToken: string;
  readonly payload: string;
  readonly timeoutMs: number;
};

export type HttpCallResult = {
  readonly ok: boolean;
  /** The status line, or the reason nothing answered. Never carries the token or the body. */
  readonly detail: string;
};

export async function postProductJson(input: HttpCallInput): Promise<HttpCallResult> {
  try {
    const result = await input.runCli(
      'docker',
      [
        'run',
        '--rm',
        '--interactive',
        '--network',
        input.network,
        CALL_IMAGE,
        'sh',
        '-c',
        CALL_SCRIPT,
        'seamnex-role-push',
        input.host,
        String(input.port),
        input.path,
      ],
      { timeoutMs: input.timeoutMs, input: `${input.bearerToken}\n${input.payload}\n` },
    );
    // `wget -S` prints the response head on stderr but can also echo a connect line first; the
    // status line is what the caller records, and an empty answer is named rather than blank.
    const [firstLine] = result.stdout.trim().split(/\r?\n/);
    return {
      ok: result.code === 0,
      detail: firstLine === undefined || firstLine === '' ? 'no HTTP answer' : firstLine,
    };
  } catch {
    // A helper that cannot run says so; it is a recorded reason for a pending entitlement, not a
    // crash of the sync cycle.
    return { ok: false, detail: 'the role-push helper could not be started' };
  }
}
