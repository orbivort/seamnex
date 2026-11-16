import { describe, expect, it } from 'vitest';
import { imageTagOf } from '../../../../src/common/docker/image-ref';

/**
 * FR-1.7 / AC-06 — "which version is deployed" is read from the image reference, once.
 *
 * The instance read model and the lifecycle that asserts a confirmed upgrade target both ask this
 * question. Two copies of the rule is how the detail screen and the upgrade dialog end up
 * disagreeing about what is running, so the rule is a function and this is its contract.
 */
describe('imageTagOf', () => {
  it('reads the tag of a tagged reference', () => {
    expect(imageTagOf('ghcr.io/seamnex/crm:7.4.1')).toBe('7.4.1');
    expect(imageTagOf('crm:latest')).toBe('latest');
  });

  it('keeps the tag when the reference is also digest-pinned', () => {
    // `repo:1.2@sha256:…` names both; the tag is the answer to "which version", the digest to
    // "which bytes".
    expect(imageTagOf('ghcr.io/seamnex/crm:1.2@sha256:0f1e2d')).toBe('1.2');
  });

  it('returns null for a digest-pinned reference, which names no version', () => {
    expect(imageTagOf('ghcr.io/seamnex/crm@sha256:0f1e2d')).toBeNull();
  });

  it('does not mistake a registry port for a tag', () => {
    // `localhost:5000/app` has a colon, but it sits before the last slash; reading `5000/app` as a
    // version would put a hostname in the release column.
    expect(imageTagOf('localhost:5000/app')).toBeNull();
    expect(imageTagOf('localhost:5000/app:2.0.0')).toBe('2.0.0');
  });

  it('returns null for a bare repository name and for an empty tag', () => {
    expect(imageTagOf('erpnext/erpnext')).toBeNull();
    expect(imageTagOf('erpnext/erpnext:')).toBeNull();
  });

  it('returns null when there is no reference at all', () => {
    expect(imageTagOf(null)).toBeNull();
    expect(imageTagOf(undefined)).toBeNull();
    expect(imageTagOf('')).toBeNull();
  });
});
