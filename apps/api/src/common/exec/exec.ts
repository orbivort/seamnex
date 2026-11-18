import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Process execution for the Phase 4 adapters (ADR-BE-12).
 *
 * Three rules, each learned the expensive way:
 *   - `shell: false` always. Arguments are an array, so a slug, a branch name or a compose key can
 *     never be re-interpreted as a command. A shell would turn `slug='a; rm -rf /'` into a feature.
 *   - a timeout always. A hung `docker save` holds a job lane and a worker slot forever.
 *   - bounded output. `docker inspect` on a large host is megabytes; reading it unbounded puts the
 *     control plane's memory at the mercy of the daemon.
 *
 * The environment is passed explicitly: the API's own environment carries the root key path and
 * the database URL, and a child process has no business inheriting them by accident.
 */

export type ExecOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
  /** Written to stdin, then the stream is closed. */
  readonly input?: string | Buffer;
};

export type ExecResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when output was capped; callers must not parse a truncated document. */
  readonly truncated: boolean;
};

export class ExecError extends Error {
  readonly file: string;
  readonly args: readonly string[];
  readonly code: number | null;
  readonly stderr: string;

  constructor(input: {
    file: string;
    args: readonly string[];
    code: number | null;
    stderr: string;
    message: string;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'ExecError';
    this.file = input.file;
    this.args = input.args;
    this.code = input.code;
    this.stderr = input.stderr;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** The child process, plus the bookkeeping needed to close stdin and to know when it exits. */
export type SpawnedProcess = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<ExecResult>;
};

/**
 * Starts a process without buffering its output. Used where the caller streams (a `docker save`
 * piped into a file, a `pg_dump` piped into an encryptor).
 */
export function spawnProcess(
  file: string,
  args: readonly string[],
  options: ExecOptions = {},
): SpawnedProcess {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env ?? childEnvironment(),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let truncated = false;
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    // SIGKILL, not SIGTERM: a CLI that ignores the polite signal is exactly the one that hung.
    child.kill('SIGKILL');
    stderr = `${stderr}\n[killed after ${timeoutMs} ms]`;
  }, timeoutMs);

  const onAbort = (): void => {
    if (settled) return;
    child.kill('SIGKILL');
    stderr = `${stderr}\n[aborted]`;
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  /*
   * The cap keeps the *tail*, not the head. A command's reason for failing is its last lines —
   * `ERROR: failed to solve: …`, `fatal: …` — and a head-keeping window threw exactly that away:
   * a 4 MB `docker compose build` reported `docker exited with 1: Image seamnex/orangehrm:5.9
   * Building`, its first progress frame, with the cause already discarded. `truncated` still tells
   * a caller that the document it received is incomplete, which is what a parser needs to know.
   */
  const collect = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
    const text = chunk.toString('utf8');
    const combined = (target === 'stdout' ? stdout : stderr) + text;
    if (Buffer.byteLength(combined) > maxOutputBytes) truncated = true;
    const kept = tailWithin(combined, maxOutputBytes);
    if (target === 'stdout') stdout = kept;
    else stderr = kept;
  };

  child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));

  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();

  const done = new Promise<ExecResult>((resolve, reject) => {
    child.on('error', (error) => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(
        new ExecError({
          file,
          args,
          code: null,
          stderr,
          message: `${file} could not be started: ${error.message}`,
          cause: error,
        }),
      );
    });

    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? -1, stdout, stderr, truncated });
    });
  });

  return { child, done };
}

/** Runs a process and returns its result, including a non-zero exit code. */
export function run(
  file: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return spawnProcess(file, args, options).done;
}

/** Runs a process and rejects on a non-zero exit code or a truncated document. */
export async function runOrThrow(
  file: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const result = await run(file, args, options);
  if (result.code !== 0) {
    throw new ExecError({
      file,
      args,
      code: result.code,
      stderr: result.stderr,
      message: `${file} exited with ${result.code}: ${failureReason(result.stdout, result.stderr)}`,
    });
  }
  return result;
}

/**
 * The environment a child receives: PATH and locale only, plus whatever the caller names.
 * `HOME` is included because `git` refuses to run without it on some hosts.
 */
export function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = process.env;
  const base: NodeJS.ProcessEnv = {
    PATH: inherited.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: inherited.HOME ?? '/tmp',
    LANG: inherited.LANG ?? 'C.UTF-8',
  };
  return { ...base, ...extra };
}

/**
 * The sentence a failed command is remembered by.
 *
 * `git` prints progress first and the reason last — `Cloning into '…'` then `fatal: unable to
 * access '…'` — while compose and buildx report the cause on **stdout** (`ERROR: failed to solve:
 * …`) and the progress chatter on stderr. Reading stderr alone produced `docker exited with 1:
 * Image seamnex/woocommerce:11.2.1 Building`: the line before the failure, with the reason nowhere.
 * Both streams are searched for a line that declares itself an error, then for the conclusion each
 * stream ends with — stdout first, because a tool that prints forward puts its verdict last.
 *
 * Stderr's *first* line was the previous fallback, and it is the worst candidate: BuildKit opens
 * with `Image … Building`, a progress frame, so that is what an operator was told a failed build
 * said. The tail of the same stream carries `[killed after 900000 ms]` instead.
 */
function failureReason(stdout: string, stderr: string): string {
  const err = linesOf(stderr);
  const out = linesOf(stdout);
  const declared = [...err, ...out].filter((line) => DECLARED_FAILURE.test(line));
  const meaningful = [...out, ...err].filter((line) => !SEPARATOR_ONLY.test(line));
  return declared[declared.length - 1] ?? meaningful[meaningful.length - 1] ?? '(no output)';
}

/**
 * A line that says what went wrong. The word may sit anywhere — BuildKit prefixes it with the step
 * (`#12 ERROR: process …`) — and `failed to solve` carries no `error:` at all.
 */
const DECLARED_FAILURE = /(?:^|[\s#\d])(?:fatal|error|panic|failed)\b/i;

/** BuildKit's plain progress draws `------` around every transfer; the last one is not a reason. */
const SEPARATOR_ONLY = /^[-=_*\s]+$/;

function linesOf(value: string): string[] {
  return value
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The last `maxBytes` of `text`, cut at a line boundary.
 *
 * The boundary matters twice: a window that starts mid-line would hand `failureReason` a fragment
 * that is neither the first line nor an error, and cutting raw bytes can split a UTF-8 sequence.
 */
function tailWithin(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  const from = buffer.length - maxBytes;
  const newline = buffer.indexOf(0x0a, from);
  let start = newline === -1 ? from : newline + 1;
  // No line boundary (one long line): skip UTF-8 continuation bytes so the window starts on a
  // character rather than in the middle of one.
  while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}
