/**
 * NFR-4.16 — one parser for "where does this image come from".
 *
 * The allow-list is only as good as the identity it is compared against, and three callers need that
 * identity: the compose/Dockerfile policy, the pre-flight and the pull/build guard. Parsing it three
 * times is how `redis:7-alpine` is "trusted" in one path (bare name) and "docker.io/library/redis"
 * in another. The rules below are Docker's own distribution reference rules, reduced to the part the
 * control depends on — registry, namespace, repository, tag and digest.
 *
 * A *trusted registry* is an entry of the form `registry` (`ghcr.io`) or `registry/namespace`
 * (`docker.io/library`). A registry-only entry covers every namespace on it; a namespace entry
 * covers exactly that namespace. Matching is exact and case-folded: a prefix match would let
 * `docker.io/library-evil` through `docker.io/library`.
 */

/** Docker Hub, spelled the way a reference without a registry is normalised to. */
export const DEFAULT_IMAGE_REGISTRY = 'docker.io';

/** Namespace Docker Hub assigns to a single-segment name (`redis` → `docker.io/library/redis`). */
export const IMPLICIT_IMAGE_NAMESPACE = 'library';

/**
 * A registry or registry/namespace entry. The port is part of the registry, so a private registry
 * with an explicit port is expressible; uppercase is refused because Docker normalises references to
 * lowercase and an allow-list entry that can never match is worse than a rejected one.
 *
 * Written as a character scan rather than a regular expression: the shape is `host[:port][/ns]` with
 * an overlapping character set on both sides of the port, which is exactly the pattern a backtracking
 * analyser cannot bound. An allow-list entry is short and operator-entered, so the cost of the loop
 * is irrelevant and the rule engine needs no exception.
 */
export function isTrustedRegistryEntry(entry: string): boolean {
  const parts = entry.split('/');
  const host = parts[0];
  const namespace = parts[1];
  // `registry` or `registry/namespace`, nothing deeper: `docker.io/library/redis` names an image,
  // which an allow-list of namespaces cannot express.
  if (host === undefined || parts.length > 2) return false;

  const colon = host.lastIndexOf(':');
  const name = colon === -1 ? host : host.slice(0, colon);
  const port = colon === -1 ? null : host.slice(colon + 1);

  if (!isRegistrySegment(name)) return false;
  if (port !== null && !isPort(port)) return false;
  if (namespace !== undefined && !isRegistrySegment(namespace)) return false;
  return true;
}

function isRegistrySegment(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const lower = code >= 97 && code <= 122;
    const digit = code >= 48 && code <= 57;
    // A segment may not start with a separator: `-foo` is not a host and `_` is not a namespace.
    if (index === 0) {
      if (!lower && !digit) return false;
      continue;
    }
    if (!lower && !digit && code !== 46 && code !== 95 && code !== 45) return false;
  }
  return true;
}

function isPort(value: string): boolean {
  if (value.length === 0 || value.length > 5) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

export type ImageReference = {
  /** Exactly what the caller supplied, so a message can quote it. */
  readonly original: string;
  /** `docker.io` when the reference names no registry. */
  readonly registry: string;
  /** First path segment below the registry; `library` for a single-segment Docker Hub name. */
  readonly namespace: string;
  /** Path below the registry, without tag or digest (`library/redis`). */
  readonly repository: string;
  readonly tag: string | null;
  readonly digest: string | null;
};

export class ImageReferenceError extends Error {
  readonly reference: string;

  constructor(reference: string, reason: string) {
    super(`"${reference}" is not a valid container image reference: ${reason}`);
    this.name = 'ImageReferenceError';
    this.reference = reference;
  }
}

const DIGEST_PATTERN = /^[a-z0-9]+:[0-9a-f]{32,}$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The parse, or `null` when the value is not a reference at all (blank, spaces, uppercase). */
export function tryParseImageReference(raw: string): ImageReference | null {
  const original = raw;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Whitespace inside a reference is a typo, never a name; a shell would have split it anyway.
  if (/\s/.test(trimmed)) return null;
  if (trimmed !== trimmed.toLowerCase()) return null;

  let digest: string | null = null;
  let name = trimmed;
  const at = name.indexOf('@');
  if (at >= 0) {
    digest = name.slice(at + 1);
    name = name.slice(0, at);
    if (!DIGEST_PATTERN.test(digest)) return null;
  }

  let tag: string | null = null;
  const lastSlash = name.lastIndexOf('/');
  const lastColon = name.lastIndexOf(':');
  if (lastColon > lastSlash) {
    tag = name.slice(lastColon + 1);
    name = name.slice(0, lastColon);
    if (!TAG_PATTERN.test(tag)) return null;
  }

  const segments = name.split('/');
  if (segments.some((segment) => segment.length === 0)) return null;

  const first = segments[0] ?? '';
  // Docker's rule: the first segment is a registry when it looks like a host, not a namespace.
  const namesRegistry =
    segments.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const registry = namesRegistry ? first : DEFAULT_IMAGE_REGISTRY;
  const below = namesRegistry ? segments.slice(1) : segments;
  if (below.length === 0) return null;

  /**
   * `library` is Docker Hub's namespace for a bare name, not a rule every registry follows:
   * `ghcr.io/seamnex` has no namespace below the registry, and reporting one would make the image
   * unnameable by the allow-list entry that is supposed to cover it (`ghcr.io/seamnex`). So the
   * implicit namespace applies only when the reference names no registry at all.
   */
  const namespace =
    namesRegistry || below.length > 1
      ? (below[0] ?? IMPLICIT_IMAGE_NAMESPACE)
      : IMPLICIT_IMAGE_NAMESPACE;

  return {
    original,
    registry,
    namespace,
    // How Docker would spell it: a bare name is a repository inside `library`.
    repository:
      namesRegistry || below.length > 1
        ? below.join('/')
        : `${IMPLICIT_IMAGE_NAMESPACE}/${below[0] ?? ''}`,
    tag,
    digest,
  };
}

/** Throws rather than returning an untrusted verdict: a caller holding garbage has a bug upstream. */
export function parseImageReference(raw: string): ImageReference {
  const parsed = tryParseImageReference(raw);
  if (parsed === null) {
    throw new ImageReferenceError(raw, 'expected [registry/]namespace/repository[:tag][@digest]');
  }
  return parsed;
}

/** The identity the allow-list stores and compares: `docker.io/library`, `ghcr.io/seamnex`. */
export function registryNamespaceOf(raw: string): string {
  const parsed = parseImageReference(raw);
  return `${parsed.registry}/${parsed.namespace}`;
}

/** Canonical form of an operator-entered allow-list entry, or `null` when it is not one. */
export function normaliseRegistryEntry(entry: string): string | null {
  const trimmed = entry.trim().toLowerCase().replace(/\/+$/, '');
  if (!isTrustedRegistryEntry(trimmed)) return null;
  // A reference-shaped entry (`docker.io/library/redis`) is refused rather than silently truncated:
  // the operator meant a specific image, and an allow-list of namespaces cannot express that.
  return trimmed;
}

export function isTrustedRegistryNamespace(
  namespace: string,
  allowlist: readonly string[],
): boolean {
  const wanted = namespace.trim().toLowerCase();
  for (const raw of allowlist) {
    const entry = normaliseRegistryEntry(raw);
    if (entry === null) continue;
    if (entry === wanted) return true;
    // A registry-only entry (`ghcr.io`) trusts every namespace beneath it.
    if (!entry.includes('/') && wanted.startsWith(`${entry}/`)) return true;
  }
  return false;
}

export function isTrustedImageReference(raw: string, allowlist: readonly string[]): boolean {
  const parsed = tryParseImageReference(raw);
  if (parsed === null) return false;
  return isTrustedRegistryNamespace(`${parsed.registry}/${parsed.namespace}`, allowlist);
}

/**
 * The refusal NFR-4.16 asks for: it names the missing namespace and the exact remedy, so the same
 * sentence can be shown by the API, the pre-flight blocker and the console without drifting.
 */
export function untrustedRegistryMessage(raw: string): string {
  const parsed = tryParseImageReference(raw);
  if (parsed === null) {
    // Telling an operator to allow-list a string the parser cannot read would be worse than
    // useless: nothing could ever match it, so the reference itself is the thing to correct.
    return `Image "${raw}" is not a valid image reference, so its registry cannot be verified. Use the form registry/namespace/name:tag.`;
  }
  const namespace = `${parsed.registry}/${parsed.namespace}`;
  return `Image "${raw}" comes from "${namespace}", which is not on the trusted-registry allow-list. Add "${namespace}" to the allow-list and retry.`;
}
