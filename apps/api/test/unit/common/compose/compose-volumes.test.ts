import { describe, expect, it } from 'vitest';
import {
  composeDocumentOf,
  declaredVolumeKeys,
  mountPathForVolume,
} from '../../../../src/common/compose/compose-volumes';

/**
 * The two questions M05 (registration) and M16 (backup completeness) must answer identically, from
 * the document that was actually applied. The cases below are the shapes the shipped render sets
 * use: short mounts, long mounts, and a definition with no volumes at all.
 */
const COMPOSE = `
name: seamnex-orangehrm
services:
  orangehrm-db:
    image: mariadb:11.4
    volumes:
      - orangehrm-db:/var/lib/mysql
  orangehrm:
    image: orangehrm/orangehrm:5.9
    volumes:
      - orangehrm-conf:/var/www/html/lib/confs
      - type: volume
        source: long-syntax
        target: /srv/long
      - /host/path:/srv/bind
volumes:
  orangehrm-conf:
  orangehrm-db:
  long-syntax:
`;

describe('composeDocumentOf', () => {
  it('parses a document, and answers null for content it cannot read', () => {
    expect(composeDocumentOf(COMPOSE)).toMatchObject({ name: 'seamnex-orangehrm' });
    expect(composeDocumentOf('services: [unclosed')).toBeNull();
    expect(composeDocumentOf('just a string')).toBeNull();
  });
});

describe('declaredVolumeKeys', () => {
  it('returns the top-level keys, sorted, including the ones no service mounts', () => {
    const document = composeDocumentOf(COMPOSE);
    expect(document).not.toBeNull();
    expect(declaredVolumeKeys(document!)).toEqual([
      'long-syntax',
      'orangehrm-conf',
      'orangehrm-db',
    ]);
  });

  it('answers an empty list for a definition with no volumes block', () => {
    expect(declaredVolumeKeys({ services: { app: { image: 'x:1' } } })).toEqual([]);
    expect(declaredVolumeKeys({ volumes: [] })).toEqual([]);
    // A malformed block is not a volume list, and guessing one would register a volume that no
    // service mounts.
    expect(declaredVolumeKeys({ volumes: 'db-data' })).toEqual([]);
  });
});

describe('mountPathForVolume', () => {
  const document = composeDocumentOf(COMPOSE)!;

  it('reads the container path from both mount syntaxes', () => {
    expect(mountPathForVolume(document, 'orangehrm-db')).toBe('/var/lib/mysql');
    expect(mountPathForVolume(document, 'long-syntax')).toBe('/srv/long');
  });

  it('does not mistake a bind mount for a named volume', () => {
    expect(mountPathForVolume(document, '/host/path')).toBeNull();
    expect(mountPathForVolume(document, './relative')).toBeNull();
    expect(mountPathForVolume(document, 'unknown-key')).toBeNull();
  });

  it('ignores mounts it cannot read instead of reporting a partial path', () => {
    const malformed = {
      services: {
        broken: { volumes: [null, 42] },
        bind: { volumes: [{ type: 'bind', source: 'data', target: '/data' }] },
        elsewhere: { volumes: [{ type: 'volume', source: 'other', target: '/other' }] },
        noTarget: { volumes: ['data', { source: 'data', target: '' }] },
      },
    };

    expect(mountPathForVolume(malformed, 'data')).toBeNull();
  });

  it('answers null for a document with no services at all', () => {
    expect(mountPathForVolume({ volumes: { data: {} } }, 'data')).toBeNull();
  });
});
