/**
 * FR-1.5 — a pin that nothing compares is decoration.
 *
 * Two questions wear the same shape, so the caller must say which one it is asking:
 *
 *   - `registry` — is the image the daemon resolves this tag to the one the catalogue recorded? This
 *     is the rule for an entry that pulls. Nothing compared it before: `docker compose up` resolves
 *     the tag in `image:` and starts whatever the registry serves.
 *   - `local` — is the tag still the image this run's build produced? This is the rule for an entry
 *     whose definition declares `build:`: identity comes from the build, not from a registry, so the
 *     evidence is the image id and the failure modes are "the build produced nothing" and "something
 *     retagged it", neither of which a pull can satisfy.
 *
 * The distinction is not cosmetic. A local image has no repository digest at all, so asking the
 * registry question of it always fails; asking the local question of a pulled image always fails too.
 * One function, two modes, and the caller cannot accidentally ask the wrong one.
 */
export type DigestPinVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string; readonly remediation: string };

export type DigestPinMode = 'registry' | 'local';

export type DigestPinInput = {
  readonly mode: DigestPinMode;
  /** The reference the definition will start, exactly as the compose file spells it. */
  readonly reference: string;
  /**
   * Registry mode: `catalog_entry.imageDigest`, `null` when the entry pins none.
   * Local mode: the id this run's build produced, `null` when the build produced nothing.
   */
  readonly expected: string | null | undefined;
  /**
   * Registry mode: the daemon's repository digest, `null` when it holds none.
   * Local mode: the id the tag resolves to now, `null` when the tag is absent.
   */
  readonly observed: string | null;
};

/** An id or a digest is `sha256:` and 64 hex digits; anything else is a value nobody can compare. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function digestPinVerdict(input: DigestPinInput): DigestPinVerdict {
  return input.mode === 'local' ? localVerdict(input) : registryVerdict(input);
}

function localVerdict(input: DigestPinInput): DigestPinVerdict {
  const built = normalise(input.expected);
  if (built === null) {
    return {
      ok: false,
      detail:
        `The definition builds ${input.reference} locally, but this run's build produced no image ` +
        'under that tag.',
      remediation:
        'Read the build log above; the deployment stops rather than start something it did not build. ' +
        'A tree that declares build: must also declare the image: tag it is tagged with.',
    };
  }

  const observed = normalise(input.observed);
  if (observed === null) {
    return {
      ok: false,
      detail:
        `${input.reference} is not present on this host, though this run built ${built}. The definition ` +
        'forbids pulling, so an absent tag means the image was removed or never landed.',
      remediation:
        'Inspect the local image store (docker image ls) and the build log, then redeploy. Nothing was started.',
    };
  }

  if (observed !== built) {
    return {
      ok: false,
      detail:
        `${input.reference} resolves to ${observed}, but this run's build produced ${built}. Something ` +
        'retagged or replaced the image between the build and the start.',
      remediation:
        'Do not start it: inspect the tag, remove the foreign image, and redeploy so the build owns the ' +
        'tag again. Nothing was started.',
    };
  }

  return { ok: true };
}

function registryVerdict(input: DigestPinInput): DigestPinVerdict {
  const expected = normalise(input.expected);
  // An entry that pins no digest has nothing to check: this is the shape of a platform-built image,
  // whose tag is derived from the revision and whose build happened in this run.
  if (expected === null) return { ok: true };

  if (!DIGEST.test(expected)) {
    return {
      ok: false,
      detail:
        `The catalogue pins ${input.reference} to "${expected}", which is not a sha256 digest, ` +
        'so the pin cannot be checked against what would run.',
      remediation:
        'Record the sha256 digest of the image the entry deploys, then retry. Nothing was started.',
    };
  }

  const observed = normalise(input.observed);
  if (observed === null) {
    return {
      ok: false,
      detail:
        `${input.reference} holds no repository digest on this host, so the digest the catalogue pins ` +
        `(${expected}) cannot be compared with what would run. A locally built image has no ` +
        'repository digest until it is published.',
      remediation:
        'Publish the pinned build under the reference the entry names, or declare build: on the service ' +
        'so the platform builds and pins it locally. Nothing was started.',
    };
  }

  if (observed !== expected) {
    return {
      ok: false,
      detail: `The catalogue pins ${input.reference} to ${expected}, but the daemon resolves it to ${observed}.`,
      remediation:
        'Review what the tag now points at. If it is the release you want, record the new digest in ' +
        'the catalogue entry in the same commit as the version bump; otherwise publish the pinned ' +
        'build under the reference the entry names. Nothing was started.',
    };
  }

  return { ok: true };
}

/** Digests are lower-case hex; a pin pasted from a registry UI is not always. */
function normalise(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}
