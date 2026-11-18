/**
 * How the scripts beside this directory start pnpm.
 *
 * `pnpm` is a `.cmd` shim on Windows, and since Node's fix for CVE-2024-27980 a `.cmd` cannot be
 * spawned with `shell: false` (it fails with `EINVAL`). Every call site therefore passed an argument
 * *array* together with `shell: true`, which Node deprecated as DEP0190: the arguments are
 * concatenated into one command line, not escaped, so the pair silently claimed a safety it did not
 * have — and `pnpm dev` printed the warning on every Windows start.
 *
 * The way out is to stop handing a list to the shell. The command line is built here from tokens
 * checked against a character set that both `cmd.exe` and a POSIX shell pass through untouched;
 * everything else throws instead of being quoted. Quoting is where the bugs would live, and every
 * call site passes literals — a subcommand, a `--flag`, an `@scope/name` — so a rejected token means
 * that call site needs its own `spawn`, not a cleverer helper.
 */

/** `pnpm` as the platform spawns it: a `.cmd` shim on Windows, a script on POSIX. */
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * The characters these scripts actually pass: `--filter`, `@seamnex/db`, `migrate:up`,
 * `--frozen-lockfile`. Deliberately excludes everything a shell reinterprets — space, quote, `%`,
 * `$`, `&`, `|`, `>`, `<`, `^`, `(`, `)`.
 */
const SAFE_TOKEN = /^[A-Za-z0-9@._/:+=,-]+$/;

/**
 * One command line for `spawn`/`spawnSync` with `shell: true`.
 *
 * Spawn the returned string *without* an argument array: that is the pair DEP0190 is about.
 *
 * @param {readonly string[]} args pnpm arguments, each a literal that needs no escaping.
 * @returns {string} The command line to spawn.
 */
export function pnpmCommandLine(args) {
  const unsafe = args.filter((argument) => !SAFE_TOKEN.test(argument));
  if (unsafe.length > 0) {
    throw new Error(
      `refusing to hand ${unsafe.map((argument) => JSON.stringify(argument)).join(', ')} to a ` +
        'shell: a space, a quote or a metacharacter would be interpreted rather than passed. Spawn ' +
        'that command directly instead of going through pnpmCommandLine().',
    );
  }
  return [PNPM, ...args].join(' ');
}
