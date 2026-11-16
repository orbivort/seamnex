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
