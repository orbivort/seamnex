/**
 * Version strings reach the platform in shapes that must not be compared as plain text.
 *
 * A catalog document records `16.53.0`; the image tag the host actually runs is
 * `frappe/erpnext:v16.53.0`, whose tag reads `v16.53.0`. Comparing those two strings verbatim
 * reported a pending update for the version a deployment was already on. Rendered versions have a
 * second, independent failure: a UI that prefixes its own `v` printed `vv16.53.0`.
 *
 * So there are three separate jobs, and they are separate functions:
 * `canonicalVersion` makes one string comparable, `formatVersion` renders it once, and
 * `updateAvailable` answers the only question the badge asks — is the catalog's version *newer*
 * than the running one? "Different" is not that answer.
 */
export function canonicalVersion(version: string | null | undefined): string | null {
  if (version === null || version === undefined) return null;
  const trimmed = version.trim();
  if (trimmed === '') return null;
  // Only a `v` in front of a digit is a version prefix; a tag such as `vendor` keeps its spelling.
  // A doubled prefix (`vv16.53.0`, the old render output) collapses too, so a stale value that
  // already reached a client heals on the next read instead of printing a third `v`.
  return trimmed.replace(/^v+(?=\d)/, '');
}

/** The display form: `v` plus the canonical version, so a prefix never doubles up. */
export function formatVersion(version: string | null | undefined): string | null {
  const canonical = canonicalVersion(version);
  if (canonical === null) return null;
  return /^\d/.test(canonical) ? `v${canonical}` : canonical;
}

type ParsedVersion = {
  /** Numeric release segments: `16.53.0` is `[16, 53, 0]`. */
  core: number[];
  /** Dot-separated pre-release identifiers, or `null` for a final release. */
  preRelease: string[] | null;
};

/**
 * Parses the canonical form down to what actually decides precedence.
 *
 * Build metadata (`+8f3c1a`) is dropped, not compared: SemVer §10 makes it irrelevant to ordering,
 * so `16.53.0+build.7` and `16.53.0` are the same version. `null` means "not a version this code
 * understands" (a date stamp, a branch tag, `unversioned`) — the caller must then say nothing
 * rather than guess.
 */
function parseVersion(version: string): ParsedVersion | null {
  const withoutBuild = version.split('+')[0] ?? version;
  const dash = withoutBuild.indexOf('-');
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const preRelease = dash === -1 ? null : withoutBuild.slice(dash + 1);
  // eslint-disable-next-line security/detect-unsafe-regex -- the input is a version string from an image tag (bounded upstream), and the pattern is the canonical SemVer core shape.
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return {
    core: core.split('.').map((part) => Number(part)),
    preRelease: preRelease === null || preRelease === '' ? null : preRelease.split('.'),
  };
}

function compareCore(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    // `16.53` and `16.53.0` are the same release: a missing segment is a zero.
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * SemVer §11 precedence for pre-release identifiers: a final release outranks any pre-release of
 * the same core, numeric identifiers compare numerically and rank below alphanumeric ones, and the
 * shorter identifier list wins when one is a prefix of the other.
 */
function comparePreRelease(left: string[] | null, right: string[] | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Precedence of two version strings, or `null` when either is not a version this code can order.
 * `a < b` means "`b` is newer than `a`".
 */
export function compareVersions(
  left: string | null | undefined,
  right: string | null | undefined,
): number | null {
  const a = canonicalVersion(left);
  const b = canonicalVersion(right);
  if (a === null || b === null) return null;
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);
  // Nothing can be said about two opaque tags beyond "they are written the same".
  if (parsedA === null || parsedB === null) return a === b ? 0 : null;
  const core = compareCore(parsedA.core, parsedB.core);
  if (core !== 0) return core;
  return comparePreRelease(parsedA.preRelease, parsedB.preRelease);
}

/**
 * The single condition behind the "available" badge: the catalog's version is **strictly newer**
 * than the running one. It is therefore suppressed when
 *
 * - either side is unknown (`null`, blank) — missing evidence is not an update;
 * - the two name the same version, whatever the prefix (`v16.53.0` vs `16.53.0`);
 * - they differ only in build metadata (`16.53.0+build.7` vs `16.53.0`);
 * - the catalog is a pre-release of the running release (`16.53.0-rc.1` when running `16.53.0`);
 * - the catalog's version is *older* (a rollback pin, `16.52.9` when running `16.53.0`);
 * - either side is an opaque tag that cannot be ordered (a date stamp, `unversioned`), unless the
 *   two are literally the same tag.
 */
export function updateAvailable(
  deployed: string | null | undefined,
  catalogLatest: string | null | undefined,
): boolean {
  const deployedVersion = canonicalVersion(deployed);
  const latestVersion = canonicalVersion(catalogLatest);
  if (deployedVersion === null || latestVersion === null) return false;
  const ordering = compareVersions(deployedVersion, latestVersion);
  if (ordering === null) return deployedVersion !== latestVersion;
  return ordering < 0;
}
