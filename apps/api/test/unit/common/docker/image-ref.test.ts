import { describe, expect, it } from 'vitest';
import {
  imageRepositoryOf,
  imageTagOf,
  productVersionOf,
} from '../../../../src/common/docker/image-ref';

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

/**
 * A render set is a list ordered by the compose file, and index 0 is the first service, not the
 * product. D07-01 renders `["mariadb:11.4", "seamnex/orangehrm:5.9"]`: recording index 0 wrote the
 * database's tag and the instance screen read "current version 11.4 — available 5.9".
 */
describe('productVersionOf', () => {
  it('reads the product image, not the sidecar listed first', () => {
    expect(
      productVersionOf(['mariadb:11.4', 'seamnex/orangehrm:5.9'], 'seamnex/orangehrm:5.9'),
    ).toBe('5.9');
  });

  it('matches by repository, so a locally built tag still attributes to the product', () => {
    expect(
      productVersionOf(['mariadb:11.4', 'seamnex/orangehrm:built-1'], 'seamnex/orangehrm'),
    ).toBe('built-1');
  });

  it('refuses to guess when the declared image is not in the set', () => {
    // Guessing is what picked the sidecar; keeping the previously known version is the safe answer.
    expect(productVersionOf(['mariadb:11.4', 'other/app:2'], 'seamnex/orangehrm:5.9')).toBeNull();
  });

  it('answers only when there is nothing to disambiguate against', () => {
    expect(productVersionOf(['seamnex/orangehrm:5.9'], null)).toBe('5.9');
    expect(productVersionOf(['a:1', 'b:2'], null)).toBeNull();
    expect(productVersionOf([], 'seamnex/orangehrm:5.9')).toBeNull();
  });
});

describe('imageRepositoryOf', () => {
  it('drops the tag and the digest, and keeps a registry port', () => {
    expect(imageRepositoryOf('ghcr.io/seamnex/crm:1.2@sha256:0f1e2d')).toBe('ghcr.io/seamnex/crm');
    expect(imageRepositoryOf('localhost:5000/app:2.0.0')).toBe('localhost:5000/app');
    expect(imageRepositoryOf('erpnext/erpnext')).toBe('erpnext/erpnext');
  });
});
