import { describe, expect, it } from 'vitest';
import { dockerMountSource } from '../../../../src/common/docker/mount';

/**
 * `SEAMNEX_DOCKER_PATH_MAP` is the only thing standing between a helper container and an empty
 * mount: the daemon resolves a bind source on the host, this process knows only its own spelling of
 * the same directory. The mapping therefore has to be exact where it applies and inert where it does
 * not — a false match mounts the wrong tree just as quietly as a missed one mounts an empty one.
 */
describe('docker mount source: unmapped deployments', () => {
  it('returns the path unchanged when nothing is configured', () => {
    expect(dockerMountSource('/var/lib/seamnex/backups', '')).toBe('/var/lib/seamnex/backups');
  });

  it('returns the path unchanged when the map carries no usable pair', () => {
    for (const map of ['   ', '/var/lib/seamnex', ',,,', '=/host', '/var/lib/seamnex=']) {
      expect(dockerMountSource('/var/lib/seamnex/backups', map)).toBe('/var/lib/seamnex/backups');
    }
  });

  it('returns a path outside every prefix unchanged, so a shared host is not disturbed', () => {
    const map = '/var/lib/seamnex/backups=/host/backups';

    expect(dockerMountSource('/var/lib/seamnex/edge', map)).toBe('/var/lib/seamnex/edge');
    expect(dockerMountSource('/tmp/seamnex', map)).toBe('/tmp/seamnex');
  });
});

describe('docker mount source: applying a pair', () => {
  it('rewrites a path equal to the container prefix', () => {
    expect(
      dockerMountSource('/var/lib/seamnex/backups', '/var/lib/seamnex/backups=/host/backups'),
    ).toBe('/host/backups');
  });

  it('rewrites a nested path and keeps the remainder, so the mount names the same subdirectory', () => {
    expect(
      dockerMountSource(
        '/var/lib/seamnex/backups/dump-1.sql',
        '/var/lib/seamnex/backups=/host/backups',
      ),
    ).toBe('/host/backups/dump-1.sql');
  });

  it('accepts a Windows separator as the boundary of a match', () => {
    expect(
      dockerMountSource(
        '/var/lib/seamnex/backups\\dump-1.sql',
        '/var/lib/seamnex/backups=/D/backups',
      ),
    ).toBe('/D/backups\\dump-1.sql');
  });

  it('refuses a prefix that merely shares the first characters', () => {
    const map = '/var/lib/seamnex/backups=/host/backups';

    expect(dockerMountSource('/var/lib/seamnex/backups-2024', map)).toBe(
      '/var/lib/seamnex/backups-2024',
    );
    expect(dockerMountSource('/var/lib/seamnex/backups.old', map)).toBe(
      '/var/lib/seamnex/backups.old',
    );
  });
});

describe('docker mount source: parsing the map', () => {
  it('applies the longest matching prefix whichever order the pairs are written in', () => {
    const narrowFirst =
      '/var/lib/seamnex/backups/dumps=/host/dumps,/var/lib/seamnex/backups=/host/backups';
    const broadFirst =
      '/var/lib/seamnex/backups=/host/backups,/var/lib/seamnex/backups/dumps=/host/dumps';

    for (const map of [narrowFirst, broadFirst]) {
      expect(dockerMountSource('/var/lib/seamnex/backups/dumps/a.sql', map)).toBe(
        '/host/dumps/a.sql',
      );
      expect(dockerMountSource('/var/lib/seamnex/backups/b.sql', map)).toBe('/host/backups/b.sql');
    }
  });

  it('trims whitespace around pairs and around the separator', () => {
    expect(
      dockerMountSource(
        '/var/lib/seamnex/backups/a.sql',
        '  /var/lib/seamnex/backups = /host/backups  ',
      ),
    ).toBe('/host/backups/a.sql');
  });

  it('strips trailing separators from both sides, so a pair may be written like a mount target', () => {
    expect(
      dockerMountSource(
        '/var/lib/seamnex/backups/a.sql',
        '/var/lib/seamnex/backups/=/host/backups/',
      ),
    ).toBe('/host/backups/a.sql');
    expect(
      dockerMountSource(
        '/var/lib/seamnex/backups/a.sql',
        '/var/lib/seamnex/backups\\\\=/host/backups//',
      ),
    ).toBe('/host/backups/a.sql');
  });

  it('splits on the first `=` so a host path that contains one survives', () => {
    expect(dockerMountSource('/in/a.sql', '/in=C:\\work=a\\out')).toBe('C:\\work=a\\out/a.sql');
  });
});
