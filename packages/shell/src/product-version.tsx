import { Mono } from '@seamnex/ui';

/** The value the build injects when the root manifest carried no usable version. */
const UNKNOWN_VERSION = 'unknown';

/**
 * The version of the product that is running, printed in both shells.
 *
 * The value arrives as a prop rather than being read here: `__SEAMNEX_VERSION__` is a build-time
 * constant from the root `package.json` (`define` in `@seamnex/config/vite/app`), and this component
 * stays a pure renderer so both apps cannot format the same fact two different ways — a bug report
 * that quotes the console sidebar and one that quotes the portal footer name the same build.
 *
 * An unusable value says so. A footer that silently omits the version leaves an operator unable to
 * tell two builds apart, which is exactly the question the line exists to answer.
 */
export function ProductVersion({ version }: { version: string }) {
  const value = version.trim();
  const known = value.length > 0 && value !== UNKNOWN_VERSION;

  return (
    <Mono className="text-micro text-faint">{known ? `v${value}` : 'version unavailable'}</Mono>
  );
}
