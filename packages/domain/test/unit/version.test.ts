import { describe, expect, it } from 'vitest';
import {
  canonicalVersion,
  compareVersions,
  formatVersion,
  updateAvailable,
} from '../../src/version';

/**
 * The catalog writes `16.53.0`, an image tag writes `v16.53.0`. Comparing them verbatim announced an
 * update for the version a deployment was already running; prefixing a display string produced
 * `vv16.53.0`.
 */
describe('canonicalVersion', () => {
  it('drops a release prefix in front of a digit', () => {
    expect(canonicalVersion('v16.53.0')).toBe('16.53.0');
    expect(canonicalVersion('16.53.0')).toBe('16.53.0');
    expect(canonicalVersion('v5.9')).toBe('5.9');
  });

  it('collapses a doubled prefix left by the old render path', () => {
    expect(canonicalVersion('vv16.53.0')).toBe('16.53.0');
  });

  it('leaves a tag whose `v` is not a version prefix alone', () => {
    expect(canonicalVersion('vendor')).toBe('vendor');
    expect(canonicalVersion('v')).toBe('v');
  });

  it('treats missing or blank input as not known', () => {
    expect(canonicalVersion(null)).toBeNull();
    expect(canonicalVersion(undefined)).toBeNull();
    expect(canonicalVersion('   ')).toBeNull();
  });

  it('ignores surrounding whitespace', () => {
    expect(canonicalVersion(' 16.53.0\n')).toBe('16.53.0');
  });
});

describe('formatVersion', () => {
  it('adds the prefix exactly once', () => {
    expect(formatVersion('16.53.0')).toBe('v16.53.0');
    expect(formatVersion('v16.53.0')).toBe('v16.53.0');
    expect(formatVersion('vv16.53.0')).toBe('v16.53.0');
  });

  it('does not invent a version', () => {
    expect(formatVersion(null)).toBeNull();
    expect(formatVersion('')).toBeNull();
  });

  it('does not prefix a tag that is not numeric', () => {
    expect(formatVersion('unversioned')).toBe('unversioned');
  });
});

describe('compareVersions', () => {
  it('orders release segments numerically, not lexically', () => {
    expect(compareVersions('16.9.0', '16.10.0')).toBe(-1);
    expect(compareVersions('16.10.0', '16.9.0')).toBe(1);
    expect(compareVersions('2.18.4', '2.19.0')).toBe(-1);
  });

  it('treats a missing segment as zero', () => {
    expect(compareVersions('16.53', '16.53.0')).toBe(0);
    expect(compareVersions('5.9', '5.9.0')).toBe(0);
  });

  it('ignores build metadata', () => {
    expect(compareVersions('16.53.0+build.7', '16.53.0')).toBe(0);
    expect(compareVersions('16.53.0+8f3c1a', '16.53.0+zzz')).toBe(0);
  });

  it('ranks a pre-release below its release', () => {
    expect(compareVersions('16.53.0-rc.1', '16.53.0')).toBe(-1);
    expect(compareVersions('16.53.0', '16.53.0-rc.1')).toBe(1);
    expect(compareVersions('16.53.0-rc.2', '16.53.0-rc.10')).toBe(-1);
    expect(compareVersions('16.53.0-alpha', '16.53.0-beta')).toBe(-1);
  });

  it('pads a shorter side on either side of the comparison', () => {
    expect(compareVersions('16.53', '16.53.1')).toBe(-1);
    expect(compareVersions('16.53.1', '16.53')).toBe(1);
  });

  it('ranks a longer pre-release list above its prefix, and numeric below alphanumeric', () => {
    // `rc.1` is a prefix of `rc.1.2`, so the shorter list ranks lower (SemVer §11).
    expect(compareVersions('16.53.0-rc.1', '16.53.0-rc.1.2')).toBe(-1);
    expect(compareVersions('16.53.0-rc.1.2', '16.53.0-rc.1')).toBe(1);
    // Numeric identifiers always rank below alphanumeric ones.
    expect(compareVersions('16.53.0-1', '16.53.0-alpha')).toBe(-1);
    expect(compareVersions('16.53.0-alpha', '16.53.0-1')).toBe(1);
    // Two alphanumeric identifiers compare as strings, in both directions.
    expect(compareVersions('16.53.0-beta', '16.53.0-alpha')).toBe(1);
    expect(compareVersions('16.53.0-rc.10', '16.53.0-rc.2')).toBe(1);
  });

  it('ties two pre-release lists that agree identifier by identifier', () => {
    // Same core and same pre-release: every identifier matches, so the walk reaches its end without
    // a difference. Omitting this case left the "equal" arm of the comparator unexecuted.
    expect(compareVersions('16.53.0-rc.1', '16.53.0-rc.1')).toBe(0);
    expect(compareVersions('16.53.0-rc.1.2', '16.53.0-rc.1.2')).toBe(0);
    // A differing build metadata block must not turn that tie into an ordering.
    expect(compareVersions('16.53.0-rc.1+build.1', '16.53.0-rc.1+build.2')).toBe(0);
  });

  it('reports nothing for tags it cannot order', () => {
    expect(compareVersions('unversioned', '16.53.0')).toBeNull();
    expect(compareVersions(null, '16.53.0')).toBeNull();
    expect(compareVersions('', '')).toBeNull();
  });
});

/**
 * The badge claims "there is a newer release". Every case below is a reason that claim would be
 * false, and the contract is that each of them suppresses it.
 */
describe('updateAvailable', () => {
  it('suppresses the badge for the same version written two ways', () => {
    expect(updateAvailable('v16.53.0', '16.53.0')).toBe(false);
    expect(updateAvailable('16.53.0', 'v16.53.0')).toBe(false);
    expect(updateAvailable('16.53.0', '16.53.0')).toBe(false);
    expect(updateAvailable('vv16.53.0', '16.53.0')).toBe(false);
  });

  it('suppresses the badge when only build metadata differs', () => {
    expect(updateAvailable('16.53.0', '16.53.0+build.9')).toBe(false);
    expect(updateAvailable('16.53.0+sha.abc', '16.53.0+sha.def')).toBe(false);
  });

  it('suppresses the badge for a pre-release of the running release', () => {
    expect(updateAvailable('16.53.0', '16.53.0-rc.1')).toBe(false);
  });

  it('suppresses the badge when the catalog pin is older', () => {
    expect(updateAvailable('16.53.0', '16.52.9')).toBe(false);
    expect(updateAvailable('16.53.0', '16.9.0')).toBe(false);
  });

  it('suppresses the badge when either side is unknown', () => {
    expect(updateAvailable(null, '16.53.0')).toBe(false);
    expect(updateAvailable('16.53.0', null)).toBe(false);
    expect(updateAvailable('  ', '16.53.0')).toBe(false);
  });

  it('announces a genuinely newer release', () => {
    expect(updateAvailable('v16.53.0', '16.54.0')).toBe(true);
    expect(updateAvailable('16.53.0', '16.53.1')).toBe(true);
    expect(updateAvailable('16.9.0', '16.10.0')).toBe(true);
  });

  it('announces the release that supersedes a running pre-release', () => {
    expect(updateAvailable('16.53.0-rc.1', '16.53.0')).toBe(true);
  });

  it('announces a differing tag it cannot order, rather than hiding it', () => {
    expect(updateAvailable('unversioned', '16.53.0')).toBe(true);
    expect(updateAvailable('unversioned', 'unversioned')).toBe(false);
  });
});
