/**
 * The version an image reference names, or null when it names none.
 *
 * A digest-pinned reference (`image@sha256:…`) has no tag, and a bare repository name
 * (`erpnext/erpnext`) has none either; both return null so a caller keeps the version it already
 * knows instead of inventing `erpnext`.
 *
 * It lives here because two modules read it for the same reason — the instance read model and the
 * lifecycle that asserts a confirmed upgrade target — and two copies of this rule is how the two
 * screens end up disagreeing about what is deployed.
 */
export function imageTagOf(reference: string | null | undefined): string | null {
  if (typeof reference !== 'string' || reference.length === 0) return null;
  const digestAt = reference.indexOf('@');
  const withoutDigest = digestAt === -1 ? reference : reference.slice(0, digestAt);
  const separator = withoutDigest.lastIndexOf(':');
  // A port in the registry host (`localhost:5000/app`) is not a tag: the colon sits before the last
  // slash. Comparing the two positions is the whole test.
  if (separator <= withoutDigest.lastIndexOf('/')) return null;
  const tag = withoutDigest.slice(separator + 1);
  return tag.length === 0 ? null : tag;
}

/** The repository a reference names, with any tag and digest removed. */
export function imageRepositoryOf(reference: string): string {
  const withoutDigest = reference.split('@')[0] ?? '';
  const separator = withoutDigest.lastIndexOf(':');
  return separator <= withoutDigest.lastIndexOf('/')
    ? withoutDigest
    : withoutDigest.slice(0, separator);
}

/**
 * The version of the *product's* image, not of whichever image the render set lists first.
 *
 * A render set is a list ordered by the compose file, which says nothing about which image is the
 * product: D07-01 renders `["mariadb:11.4", "seamnex/orangehrm:5.9"]`, so recording `imageRefs[0]`
 * wrote the sidecar's tag and the instance screen read "current version 11.4 — available 5.9", i.e. a
 * downgrade on offer. The product is the reference that shares a repository with the entry's declared
 * image; a declared image that matches nothing yields `null` (keep the known version) rather than a
 * guess, because the guess is exactly what went wrong.
 */
export function productVersionOf(
  references: readonly string[],
  productImage: string | null | undefined,
): string | null {
  if (references.length === 0) return null;
  if (typeof productImage === 'string' && productImage.length > 0) {
    const repository = imageRepositoryOf(productImage);
    const match = references.find((reference) => imageRepositoryOf(reference) === repository);
    return match === undefined ? null : imageTagOf(match);
  }
  // No declaration to match against: only a single-image entry has an unambiguous answer.
  return references.length === 1 ? imageTagOf(references[0]) : null;
}
