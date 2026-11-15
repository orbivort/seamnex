import { describe, expect, it } from 'vitest';
import {
  artefactFile,
  createPlatformManifest,
  deriveIncludes,
  describeArtefact,
  plannedArtefact,
  readPlatformManifest,
  referenceArtefact,
  storedArtefact,
} from '../../../../src/modules/m16-backup-restore/platform-manifest';

/**
 * FR-1.35: the manifest is the claim *and* the evidence. These tests own the two properties that
 * make it trustworthy — `included` cannot be true without a stored object, and a manifest that
 * cannot be read produces no claims at all — plus the strings the Recovery screen renders.
 */

const ENCRYPTION = { recipient: 'age1recipient', identityId: 'escrowed' };
const CAPTURED_AT = '2026-11-15T10:02:00.000Z';

function manifestWith(...artefacts: ReturnType<typeof plannedArtefact>[]) {
  return createPlatformManifest({
    artefacts,
    encryption: ENCRYPTION,
    rootKeyId: 'root-key-id',
    capturedAt: CAPTURED_AT,
  });
}

describe('artefact kinds', () => {
  it('maps every captured kind to the scratch file the upload stage reads', () => {
    expect(artefactFile('platform_database')).toBe('platform.dump');
    expect(artefactFile('idp_database')).toBe('idp.dump');
    expect(artefactFile('idp_realm')).toBe('realm.json');
    expect(artefactFile('edge_routes')).toBe('edge-routes.tar.gz');
    expect(artefactFile('audit_anchor')).toBe('audit-anchor.json');
    expect(artefactFile('catalog_repo')).toBe('catalog.tar.gz');
  });

  it('gives a referenced artefact no file, because nothing was captured', () => {
    expect(artefactFile('edge_static_and_tls')).toBeNull();
    expect(artefactFile('secret_root_key')).toBeNull();
  });

  it('records a planned artefact as captured-but-not-included', () => {
    const artefact = plannedArtefact('idp_database', CAPTURED_AT);

    expect(artefact).toMatchObject({
      kind: 'idp_database',
      label: 'Identity-provider database',
      included: false,
      objectKey: null,
      bytes: null,
      digest: null,
      location: null,
      capturedAt: CAPTURED_AT,
    });
  });
});

describe('storing an artefact', () => {
  it('is the only way an artefact becomes included', () => {
    const stored = storedArtefact(plannedArtefact('platform_database', CAPTURED_AT), {
      objectKey: 'bkp-1/platform.dump.age',
      bytes: 2048,
      digest: 'a'.repeat(64),
    });

    expect(stored).toMatchObject({
      included: true,
      objectKey: 'bkp-1/platform.dump.age',
      bytes: 2048,
      digest: 'a'.repeat(64),
    });
  });

  it('refuses a stored artefact with no object behind it', () => {
    expect(() =>
      storedArtefact(plannedArtefact('platform_database', CAPTURED_AT), {
        objectKey: '',
        bytes: 10,
        digest: 'a'.repeat(64),
      }),
    ).toThrow(/without an object key/);
  });

  it('refuses a stored artefact that has no bytes', () => {
    expect(() =>
      storedArtefact(plannedArtefact('idp_database', CAPTURED_AT), {
        objectKey: 'bkp-1/idp.dump.age',
        bytes: 0,
        digest: 'a'.repeat(64),
      }),
    ).toThrow(/no bytes/);
  });

  it('keeps a reference out of the includes list, whatever its location', () => {
    const reference = referenceArtefact('edge_static_and_tls', 'vault://edge/tls', CAPTURED_AT);

    expect(deriveIncludes([reference])).toEqual([]);
    expect(manifestWith(reference).includes).toEqual([]);
  });

  it('derives includes from the stored artefacts only', () => {
    const artefacts = [
      storedArtefact(plannedArtefact('platform_database', CAPTURED_AT), {
        objectKey: 'bkp-1/platform.dump.age',
        bytes: 10,
        digest: 'a'.repeat(64),
      }),
      plannedArtefact('idp_database', CAPTURED_AT),
      referenceArtefact('secret_root_key', 'vault://root-key', CAPTURED_AT),
    ];

    expect(manifestWith(...artefacts).includes).toEqual(['platform_database']);
  });

  it('does not list an included artefact that lost its object key', () => {
    // `included` and an object key can disagree only in a hand-built entry; the derivation still
    // refuses to name a kind it cannot point at.
    const claim = { ...plannedArtefact('platform_database', CAPTURED_AT), included: true };

    expect(deriveIncludes([claim])).toEqual([]);
  });
});

describe('reading a manifest', () => {
  it('reads back a v2 manifest and re-derives the includes it stores', () => {
    const stored = storedArtefact(plannedArtefact('idp_realm', CAPTURED_AT), {
      objectKey: 'bkp-1/realm.json.age',
      bytes: 512,
      digest: 'b'.repeat(64),
    });
    const written = manifestWith(stored, referenceArtefact('secret_root_key', 'vault://key'));

    const read = readPlatformManifest(JSON.parse(JSON.stringify(written)));

    expect(read).not.toBeNull();
    expect(read?.includes).toEqual(['idp_realm']);
    expect(read?.rootKeyId).toBe('root-key-id');
    expect(read?.encryption).toEqual(ENCRYPTION);
    expect(read?.artefacts.map((artefact) => artefact.kind)).toEqual([
      'idp_realm',
      'secret_root_key',
    ]);
  });

  it('ignores an includes list that disagrees with the artefacts', () => {
    const stored = storedArtefact(plannedArtefact('platform_database', CAPTURED_AT), {
      objectKey: 'bkp-1/platform.dump.age',
      bytes: 10,
      digest: 'a'.repeat(64),
    });
    const tampered = {
      ...manifestWith(stored),
      includes: ['platform_database', 'edge_static_and_tls'],
    };

    expect(readPlatformManifest(tampered)?.includes).toEqual(['platform_database']);
  });

  it('refuses a legacy v1 manifest instead of inventing claims from it', () => {
    expect(
      readPlatformManifest({
        version: 1,
        includes: ['platform_database', 'realm', 'traefik', 'acme'],
      }),
    ).toBeNull();
  });

  it('refuses a manifest whose artefacts are not entries', () => {
    const manifest = manifestWith(plannedArtefact('platform_database', CAPTURED_AT));

    expect(readPlatformManifest({ ...manifest, artefacts: ['platform_database'] })).toBeNull();
    expect(
      readPlatformManifest({
        ...manifest,
        artefacts: [{ ...plannedArtefact('platform_database', CAPTURED_AT), kind: 'mystery' }],
      }),
    ).toBeNull();
  });

  it('cannot pass an entry that claims included without an object key', () => {
    const manifest = manifestWith(plannedArtefact('platform_database', CAPTURED_AT));
    const claim = {
      ...manifest,
      artefacts: [{ ...plannedArtefact('platform_database', CAPTURED_AT), included: true }],
    };

    const read = readPlatformManifest(claim);

    expect(read?.artefacts[0]?.included).toBe(false);
    expect(read?.includes).toEqual([]);
  });

  it('reports a missing capture time as unreadable rather than dating the set to now', () => {
    const manifest = manifestWith(plannedArtefact('platform_database', CAPTURED_AT));

    expect(readPlatformManifest({ ...manifest, capturedAt: undefined })).toBeNull();
    expect(readPlatformManifest(null)).toBeNull();
    expect(readPlatformManifest({})).toBeNull();
  });

  it('refuses a manifest whose artefact list is not a list', () => {
    const manifest = manifestWith(plannedArtefact('platform_database', CAPTURED_AT));

    expect(readPlatformManifest({ ...manifest, artefacts: 'platform_database' })).toBeNull();
  });

  it('refuses a manifest whose encryption block is absent or not two strings', () => {
    const manifest = manifestWith(plannedArtefact('platform_database', CAPTURED_AT));

    expect(readPlatformManifest({ ...manifest, encryption: null })).toBeNull();
    expect(
      readPlatformManifest({ ...manifest, encryption: { recipient: 7, identityId: 'escrowed' } }),
    ).toBeNull();
    expect(
      readPlatformManifest({ ...manifest, encryption: { recipient: 'age1x', identityId: null } }),
    ).toBeNull();
  });

  it('reports no root key when the identifier is not a string', () => {
    const manifest = manifestWith(plannedArtefact('platform_database', CAPTURED_AT));

    expect(readPlatformManifest({ ...manifest, rootKeyId: 7 })?.rootKeyId).toBeNull();
  });

  it('restores the built-in label and detail an entry cannot override with an empty string', () => {
    const manifest = manifestWith(plannedArtefact('platform_database', CAPTURED_AT));
    const stripped = {
      ...manifest,
      artefacts: [{ ...plannedArtefact('platform_database', CAPTURED_AT), label: '', detail: '' }],
    };

    const read = readPlatformManifest(stripped)?.artefacts[0];

    expect(read?.label).toBe('Platform database');
    expect(read?.detail).toBe(
      'Entitlements, audit log, job history, workflow definitions and keys.',
    );
  });
});

describe('describing an artefact', () => {
  it('names the size and capture time of a stored artefact', () => {
    const stored = storedArtefact(plannedArtefact('platform_database', CAPTURED_AT), {
      objectKey: 'bkp-1/platform.dump.age',
      bytes: 2 * 1024 ** 2,
      digest: 'a'.repeat(64),
    });

    const detail = describeArtefact(stored);

    expect(detail).toContain('2.0 MB');
    expect(detail).toContain('captured 2026-11-15 10:02 UTC');
  });

  it('records the location of an operator-owned artefact', () => {
    expect(describeArtefact(referenceArtefact('edge_static_and_tls', 'vault://edge/tls'))).toBe(
      'Owned by the operator: an external ingress, an ACME store or an internal CA. Recorded location: vault://edge/tls',
    );
  });

  it('says plainly when an artefact was neither captured nor located', () => {
    expect(describeArtefact(plannedArtefact('catalog_repo'))).toBe(
      'A copy of the working tree; the repository stays authoritative (DD-14). Not captured.',
    );
    expect(describeArtefact(referenceArtefact('secret_root_key', ''))).toContain('Not captured.');
  });

  it('names the escrowed key id so an operator can fetch the right key', () => {
    const keyId = 'abababababababab';

    expect(
      describeArtefact(referenceArtefact('secret_root_key', 'vault://platform/root-key'), {
        rootKeyId: keyId,
      }),
    ).toMatch(new RegExp(`Recorded location: vault://platform/root-key, key id ${keyId}$`));
    expect(
      describeArtefact(referenceArtefact('secret_root_key', ''), { rootKeyId: keyId }),
    ).toMatch(new RegExp(`location not recorded, key id ${keyId}`));
  });

  it('never attaches a key id to another artefact', () => {
    expect(
      describeArtefact(referenceArtefact('edge_static_and_tls', 'vault://edge/tls'), {
        rootKeyId: 'abababababababab',
      }),
    ).not.toContain('key id');
  });

  it('describes an included artefact that recorded neither size nor capture time', () => {
    const included = {
      ...plannedArtefact('platform_database'),
      included: true,
      objectKey: 'bkp-1/platform.dump.age',
    };

    expect(describeArtefact(included)).toBe(
      'Entitlements, audit log, job history, workflow definitions and keys.',
    );
  });

  it('writes a size below a kilobyte in bytes', () => {
    const stored = storedArtefact(plannedArtefact('idp_database', CAPTURED_AT), {
      objectKey: 'bkp-1/idp.dump.age',
      bytes: 999,
      digest: 'a'.repeat(64),
    });

    expect(describeArtefact(stored)).toContain('999 B');
  });

  it('rounds a size of ten units or more instead of showing a decimal', () => {
    const stored = storedArtefact(plannedArtefact('idp_database', CAPTURED_AT), {
      objectKey: 'bkp-1/idp.dump.age',
      bytes: 10 * 1024,
      digest: 'a'.repeat(64),
    });

    expect(describeArtefact(stored)).toContain('10 KB');
  });

  it('stops the unit ladder at terabytes', () => {
    const stored = storedArtefact(plannedArtefact('catalog_repo', CAPTURED_AT), {
      objectKey: 'bkp-1/catalog.tar.gz.age',
      bytes: 1024 ** 5,
      digest: 'a'.repeat(64),
    });

    expect(describeArtefact(stored)).toContain('1024 TB');
  });

  it('prints an unparsable capture time verbatim instead of throwing', () => {
    const stored = storedArtefact(plannedArtefact('idp_realm', 'not-a-date'), {
      objectKey: 'bkp-1/realm.json.age',
      bytes: 512,
      digest: 'a'.repeat(64),
    });

    expect(describeArtefact(stored)).toContain('captured not-a-date');
  });
});
