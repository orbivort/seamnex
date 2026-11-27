import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_REGISTRY,
  IMPLICIT_IMAGE_NAMESPACE,
  ImageReferenceError,
  isTrustedImageReference,
  isTrustedRegistryEntry,
  isTrustedRegistryNamespace,
  normaliseRegistryEntry,
  parseImageReference,
  registryNamespaceOf,
  tryParseImageReference,
  untrustedRegistryMessage,
} from '../../src/image-registry';

/**
 * NFR-4.16 — the parser every enforcement point shares.
 *
 * The control is only as good as the identity it compares, and the three failure modes that matter
 * are all normalisation: a bare name that is "trusted" in one path, a port that turns into a pat,
 * and a namespace that prefix-matches its neighbour. Each is asserted here, because the API, the
 * pre-flight and the pull guard all read this one function.
 */
describe('parseImageReference', () => {
  it('treats a single-segment name as Docker Hub library', () => {
    const parsed = parseImageReference('redis:7.2.5');

    expect(parsed).toEqual({
      original: 'redis:7.2.5',
      registry: DEFAULT_IMAGE_REGISTRY,
      namespace: IMPLICIT_IMAGE_NAMESPACE,
      repository: 'library/redis',
      tag: '7.2.5',
      digest: null,
    });
  });

  it('keeps an explicit registry and namespace', () => {
    const parsed = parseImageReference('ghcr.io/seamnex/console:1.4.0');

    expect(parsed.registry).toBe('ghcr.io');
    expect(parsed.namespace).toBe('seamnex');
    expect(parsed.repository).toBe('seamnex/console');
    expect(parsed.tag).toBe('1.4.0');
  });

  it('treats a first segment containing a dot as a registry', () => {
    expect(parseImageReference('registry.example.test/espocrm:9.2.1').registry).toBe(
      'registry.example.test',
    );
  });

  it('treats a first segment carrying a port as a registry, port included', () => {
    const parsed = parseImageReference('registry.example.test:5000/team/app:1.0.0');

    expect(parsed.registry).toBe('registry.example.test:5000');
    expect(parsed.namespace).toBe('team');
  });

  it('treats localhost as a registry even without a dot', () => {
    const parsed = parseImageReference('localhost/metabase:v0.50.1');

    expect(parsed.registry).toBe('localhost');
    // No `library` below another registry: the single path segment is both namespace and repository.
    expect(parsed.namespace).toBe('metabase');
    expect(parsed.repository).toBe('metabase');
  });

  it('keeps the allow-list identity of a registry-only reference matching its namespace entry', () => {
    // `ghcr.io/seamnex` is a shipped namespace entry; an image directly under it has to resolve to
    // the same identity, or the entry would never cover the platform's own image.
    expect(registryNamespaceOf('ghcr.io/seamnex:1.4.0')).toBe('ghcr.io/seamnex');
    expect(isTrustedImageReference('ghcr.io/seamnex:1.4.0', ['ghcr.io/seamnex'])).toBe(true);
  });

  it('strips the digest and keeps the tag beside it', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const parsed = parseImageReference(`docker.io/library/redis:7.2.5@${digest}`);

    expect(parsed.tag).toBe('7.2.5');
    expect(parsed.digest).toBe(digest);
    expect(parsed.repository).toBe('library/redis');
  });

  it('returns null for anything that is not a reference', () => {
    for (const value of [
      '',
      '   ',
      'has space',
      'Uppercase/app:1',
      'app@sha256:abc',
      'app:',
      '/app',
    ]) {
      expect(tryParseImageReference(value), value).toBeNull();
    }
  });

  it('throws a named error with the offending reference for a caller holding garbage', () => {
    expect(() => parseImageReference('')).toThrow(ImageReferenceError);
    try {
      parseImageReference('Bad Ref');
      expect.unreachable('parseImageReference accepted a reference with a space');
    } catch (error) {
      expect(error).toBeInstanceOf(ImageReferenceError);
      expect((error as ImageReferenceError).reference).toBe('Bad Ref');
    }
  });

  it('names the registry and namespace the allow-list compares', () => {
    expect(registryNamespaceOf('redis:7')).toBe('docker.io/library');
    expect(registryNamespaceOf('docker.io/bitnami/redis:7')).toBe('docker.io/bitnami');
  });
});

describe('allow-list entries', () => {
  it('accepts a registry or a registry/namespace', () => {
    for (const entry of ['ghcr.io', 'docker.io/library', 'registry.example.test:5000/team']) {
      expect(isTrustedRegistryEntry(entry), entry).toBe(true);
    }
  });

  it('refuses a reference-shaped entry, deeper paths and uppercase', () => {
    for (const entry of [
      'docker.io/library/redis',
      'ghcr.io/a/b',
      '',
      'GHCR.io',
      'ghcr.io/-team',
      'ghcr.io:',
      'ghcr.io:port',
      '-ghcr.io',
    ]) {
      expect(isTrustedRegistryEntry(entry), entry).toBe(false);
    }
  });

  it('normalises case and a trailing slash, and refuses what it cannot normalise', () => {
    expect(normaliseRegistryEntry('  GHCR.IO/Seamnex/ ')).toBe('ghcr.io/seamnex');
    expect(normaliseRegistryEntry('ghcr.io/a/b')).toBeNull();
  });
});

describe('trust matching', () => {
  it('covers every namespace beneath a registry-only entry', () => {
    expect(isTrustedRegistryNamespace('ghcr.io/seamnex', ['ghcr.io'])).toBe(true);
    expect(isTrustedRegistryNamespace('docker.io/library', ['docker.io'])).toBe(true);
  });

  it('does not prefix-match a neighbouring namespace', () => {
    // The whole point of the exact rule: `docker.io/library-evil` is not `docker.io/library`.
    expect(isTrustedRegistryNamespace('docker.io/library-evil', ['docker.io/library'])).toBe(false);
    expect(isTrustedRegistryNamespace('ghcr.io/seamnex-evil', ['ghcr.io/seamnex'])).toBe(false);
  });

  it('ignores entries the parser cannot read rather than widening the list', () => {
    expect(isTrustedRegistryNamespace('ghcr.io/seamnex', ['not a registry', ''])).toBe(false);
  });

  it('answers an image reference by its namespace', () => {
    expect(isTrustedImageReference('redis:7.2.5', ['docker.io/library'])).toBe(true);
    expect(isTrustedImageReference('bitnami/redis:7.2.5', ['docker.io/library'])).toBe(false);
    // An unparsable reference is not trusted, and is not treated as an exception either.
    expect(isTrustedImageReference('Bad Ref', ['docker.io'])).toBe(false);
  });

  it('states the missing namespace and the remedy in one sentence', () => {
    const message = untrustedRegistryMessage('bitnami/postgresql:16.4');

    expect(message).toContain('docker.io/bitnami');
    expect(message).toContain('Add "docker.io/bitnami" to the allow-list');
  });

  it('names the malformed reference rather than offering to allow-list it', () => {
    const message = untrustedRegistryMessage('Bad Ref');

    expect(message).toContain('"Bad Ref"');
    expect(message).toContain('is not a valid image reference');
    // An allow-list entry for a string the parser cannot read would match nothing, so advising one
    // would send the operator down a dead end.
    expect(message).not.toContain('Add "Bad Ref"');
  });
});
