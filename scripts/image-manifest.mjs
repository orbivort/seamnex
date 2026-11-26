/**
 * The platform image manifest, and the module generated from it.
 *
 * `docker/images.json` is the authority for every image this repository starts: `controlPlane` holds
 * the ones the API and the scripts pull themselves, `devStack` the ones `docker/compose.dev.yml`
 * names. `scripts/generate-images.mjs` writes the TypeScript module; `scripts/check-images.mjs`
 * proves the compose file, the two scanner defaults, the generated module and the notices table all
 * agree with it.
 *
 * Two scopes, because two consumers cannot read the same thing: the API needs a value at build time,
 * the compose file can only interpolate a variable the shell or `--env-file` supplied. Neither can
 * read a JSON file — which is why the file is the *check-side* authority and the generated module is
 * the code-side one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_FILE = 'docker/images.json';
export const GENERATED_MODULE = 'apps/api/src/common/docker/images.generated.ts';

/**
 * A reference is `repo[:tag][@sha256:<64 hex>]`, lower-case, no whitespace: what a registry can be
 * asked about. The three parts are validated separately rather than in one pattern, so the check
 * stays linear and a registry port (`localhost:5000/app`) is not mistaken for a tag.
 */
const NAME = /^[a-z0-9][a-z0-9._:/-]*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** A `controlPlane` key becomes `<KEY>_IMAGE`, so it has to be one identifier segment. */
const EXPORT_KEY = /^[a-z][a-z0-9]*$/;

/**
 * Load and validate the manifest, or throw with a message that names the file and the rule.
 *
 * A malformed manifest is a packaging error: there is no sensible default to fall back to, and a
 * silent fallback is how a scan runs a different binary than the one that was reviewed.
 */
export function loadImageManifest(root) {
  const path = join(root, MANIFEST_FILE);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${MANIFEST_FILE} could not be read (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }

  if (parsed.version !== 1) {
    throw new Error(
      `${MANIFEST_FILE}: "version" must be 1, found ${JSON.stringify(parsed.version)}`,
    );
  }
  const controlPlane = parsed.controlPlane;
  if (controlPlane === null || typeof controlPlane !== 'object' || Array.isArray(controlPlane)) {
    throw new Error(`${MANIFEST_FILE}: "controlPlane" must be an object of name → reference`);
  }
  for (const [name, reference] of Object.entries(controlPlane)) {
    if (!EXPORT_KEY.test(name)) {
      throw new Error(
        `${MANIFEST_FILE}: controlPlane key "${name}" is not lower-case alphanumeric; it becomes ` +
          'an export name, so `busybox` is valid and `busy-box` is not',
      );
    }
    assertReference(reference, `controlPlane.${name}`);
  }

  const devStack = parsed.devStack;
  if (!Array.isArray(devStack)) {
    throw new Error(`${MANIFEST_FILE}: "devStack" must be an array of references`);
  }
  devStack.forEach((reference, index) => assertReference(reference, `devStack[${index}]`));

  const controlPlaneValues = Object.values(controlPlane);
  const seen = new Set();
  for (const reference of [...controlPlaneValues, ...devStack]) {
    // One reference, one entry: a duplicate is two places to bump and the drift this file prevents.
    if (seen.has(reference)) {
      throw new Error(`${MANIFEST_FILE}: "${reference}" is listed twice`);
    }
    seen.add(reference);
  }

  return { version: 1, controlPlane, devStack };
}

function assertReference(reference, where) {
  if (parseReference(reference) === null) {
    throw new Error(
      `${MANIFEST_FILE}: ${where} is not a pinned reference in the form repository:tag@sha256:… ` +
        `(found ${JSON.stringify(reference)})`,
    );
  }
}

/**
 * `{ repository, tag, digest }`, or null when the value is not a reference or names neither a tag
 * nor a digest. A bare repository is refused: it resolves to something different next month.
 */
function parseReference(reference) {
  if (typeof reference !== 'string' || reference.length === 0) return null;

  const at = reference.indexOf('@');
  const head = at === -1 ? reference : reference.slice(0, at);
  const digest = at === -1 ? null : reference.slice(at + 1);
  if (digest !== null && !DIGEST.test(digest)) return null;

  // A colon before the last slash is a registry port (`localhost:5000/app`), not a tag.
  const lastSlash = head.lastIndexOf('/');
  const lastColon = head.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;
  const repository = hasTag ? head.slice(0, lastColon) : head;
  const tag = hasTag ? head.slice(lastColon + 1) : null;

  if (!NAME.test(repository)) return null;
  if (tag !== null && !TAG.test(tag)) return null;
  if (tag === null && digest === null) return null;
  return { repository, tag, digest };
}

/**
 * The TypeScript module, byte for byte.
 *
 * Named exports rather than one object: a call site reads `BUSYBOX_IMAGE`, and an unknown name is a
 * type error rather than an `undefined` handed to `docker run`. The layout is what Prettier produces
 * for these line lengths, so `pnpm format:check` stays green without running Prettier here.
 */
export function renderModule(controlPlane) {
  const header = [
    '/**',
    ' * Generated from `docker/images.json` — do not edit by hand.',
    ' *',
    ' * `pnpm images:generate` writes this file and `pnpm check:images:offline` fails when it disagrees',
    ' * with the manifest. The API imports it instead of a literal so one file decides which binary',
    ' * runs, and the compose stack is checked against that same file.',
    ' */',
  ].join('\n');

  const exports = Object.keys(controlPlane)
    .sort()
    .map((name) => {
      const exportName = `${name.toUpperCase()}_IMAGE`;
      const statement = `export const ${exportName} = '${controlPlane[name]}';`;
      // Prettier breaks the assignment when the whole statement exceeds the 100-column width.
      return statement.length > 100
        ? `export const ${exportName} =\n  '${controlPlane[name]}';`
        : statement;
    });

  return `${header}\n\n${exports.join('\n\n')}\n`;
}

/** Every reference the manifest names, tagged with the scope that consumes it. */
export function manifestReferences(manifest) {
  return [
    ...Object.keys(manifest.controlPlane).map((name) => ({
      name,
      scope: 'controlPlane',
      reference: manifest.controlPlane[name],
    })),
    ...manifest.devStack.map((reference) => ({ name: null, scope: 'devStack', reference })),
  ];
}

/** The repository a reference names, with tag and digest removed; what the notices table lists. */
export function repositoryOf(reference) {
  const withoutDigest = reference.split('@')[0] ?? '';
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}
