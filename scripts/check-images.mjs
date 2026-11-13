/**
 * Image-pin gate (deliverable 1.8, NFR-4.15).
 *
 * Every image the development stack runs must name a version that a registry actually serves, and
 * it must resolve to a tag that does not drift. This script does two things a reviewer cannot do by
 * reading a diff:
 *
 *   1. It collects every `image:` in `docker/compose.dev.yml` and every `FROM` in the Dockerfiles,
 *      so a new reference cannot be introduced without being checked.
 *   2. It asks the registry for each manifest. A missing tag is a hard failure, because it is the
 *      failure that only shows up as `manifest unknown` halfway through `compose up`.
 *
 * It also fails on a reference with no tag at all, and warns on a bare major (`n8n:1`, `redis:7`),
 * which silently floats across minors — reproducible in name only.
 *
 * An `image:` on a service that also declares `build:` names an image *this repository builds*, not
 * a registry reference. `seamnex-dev-api` has no tag by design, and asking a registry about it
 * reports a missing pin for a name that never leaves the machine. Those are listed as `LOCAL`:
 * neither a pass nor a failure.
 *
 * Requires Docker and registry access; it is deliberately not part of `pnpm test`, which must stay
 * runnable on a machine with no network. CI runs it in the `image` job, where both are guaranteed.
 *
 *   pnpm check:images
 *   node scripts/check-images.mjs --json
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(process.cwd());
const asJson = process.argv.includes('--json');

const COMPOSE_FILES = ['docker/compose.dev.yml'];
const DOCKERFILE_GLOBS = ['apps/api/Dockerfile'];

const IMAGE_LINE = /^\s*image:\s*['"]?([^'"\s#]+)['"]?/;
// A compose service is a two-space key; its properties are four-space keys. Both patterns are
// anchored to that indentation so an `image:` under anything else (an anchor body, a volume) cannot
// be mistaken for a service's own reference.
const SERVICE_LINE = /^ {2}([A-Za-z0-9._-]+):\s*$/;
const BUILD_LINE = /^ {4}build:/;
// `[ \t]` instead of `\s` on both sides of the literal: `\s*\s+` would let the two quantifiers
// split a long run of whitespace between them, which is quadratic on a line that never matches.
// The optional `--platform` group nests a `+` inside a `?`, which is why the rule still reports it;
// the outer quantifier never repeats, so the inner one cannot be re-entered and the match stays
// linear.
// eslint-disable-next-line security/detect-unsafe-regex -- see above: zero-or-one outer group.
const FROM_LINE = /^[ \t]*FROM[ \t]+(?:--platform=\S+[ \t]+)?([^\s#]+)/i;

/**
 * Every compose `image:` in a file, tagged with whether its own service declares `build:`.
 *
 * The flag has to be decided per service, and `build:` may appear after `image:` (`api` declares
 * them in that order), so the file is read once into service blocks rather than line by line.
 *
 * @returns {{ file: string, line: number, ref: string, builds: boolean }[]}
 */
function collectComposeImages(file) {
  const path = join(root, file);
  if (!existsSync(path)) return [];

  const out = [];
  let current = null;
  const flush = () => {
    if (current === null) return;
    for (const image of current.images) out.push({ ...image, builds: current.builds });
    current = null;
  };

  readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .forEach((text, index) => {
      if (SERVICE_LINE.test(text)) {
        flush();
        current = { images: [], builds: false };
        return;
      }
      if (current === null) return;
      if (BUILD_LINE.test(text)) current.builds = true;
      const match = IMAGE_LINE.exec(text);
      if (match?.[1] !== undefined) current.images.push({ file, line: index + 1, ref: match[1] });
    });
  flush();
  return out;
}

/** @returns {{ file: string, line: number, ref: string, local: boolean }[]} */
function collect() {
  const found = [];
  const compose = [];
  for (const file of COMPOSE_FILES) compose.push(...collectComposeImages(file));
  // `deploy-worker`, `status-sampler` and the rest reuse the image `api` builds without declaring a
  // build of their own, so "local" is a property of the *name*, not of the one service that builds
  // it. Any service that builds an image makes every reference to that name local.
  const builtHere = new Set(compose.filter((entry) => entry.builds).map((entry) => entry.ref));
  for (const entry of compose) {
    const { builds, ...reference } = entry;
    found.push({ ...reference, local: builds || builtHere.has(entry.ref) });
  }
  for (const file of DOCKERFILE_GLOBS) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .forEach((text, index) => {
        const match = FROM_LINE.exec(text);
        const ref = match?.[1];
        // `scratch` has no manifest, and a build argument is resolved at build time, not here.
        if (ref === undefined || ref === 'scratch' || ref.includes('$')) return;
        found.push({ file, line: index + 1, ref, local: false });
      });
  }
  return found;
}

/**
 * A reference is pinned when it names a tag or a digest. A digest is the strongest form; a tag is
 * acceptable in development (README "Known ceilings"); a bare major is a warning, not an error,
 * because it does resolve — it just resolves to something different next month.
 */
function inspectPin(ref) {
  if (ref.includes('@sha256:')) return { pinned: true, warning: null };
  const lastSegment = ref.split('/').pop() ?? ref;
  const tag = lastSegment.includes(':') ? lastSegment.slice(lastSegment.indexOf(':') + 1) : null;
  if (tag === null) return { pinned: false, warning: 'no tag' };
  if (tag === 'latest') return { pinned: false, warning: 'floating latest' };
  if (/^v?\d+$/.test(tag))
    return { pinned: true, warning: `major-only tag :${tag} floats across minors` };
  return { pinned: true, warning: null };
}

/**
 * A registry answer and a network failure are not the same verdict, and conflating them is how a
 * gate loses its authority: a blocked proxy would report every valid pin as missing. The registry's
 * own wording decides, because there is no error code to read.
 */
function classify(error) {
  const text = String(error.stderr ?? error.message ?? '');
  if (/manifest unknown|not found|no such manifest|pull access denied|name unknown/i.test(text)) {
    return 'missing';
  }
  if (
    /timeout|deadline|connection|no such host|dial tcp|refused|x509|tls|EOF|proxy|network/i.test(
      text,
    )
  ) {
    return 'unreachable';
  }
  // A registry error we do not recognise is reported as a miss: it needs a human either way, and
  // the message travels with it.
  return 'missing';
}

/** Asks the registry for the manifest. Throws with the registry's own message on a miss. */
async function resolveManifest(ref) {
  const { stdout } = await run('docker', ['manifest', 'inspect', ref], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  let manifest;
  try {
    manifest = JSON.parse(stdout);
  } catch {
    return { kind: 'unknown', platforms: 0 };
  }
  if (Array.isArray(manifest.manifests)) {
    return { kind: 'manifest list', platforms: manifest.manifests.length };
  }
  return { kind: 'single manifest', platforms: 0 };
}

const results = [];
const references = collect();

for (const entry of references) {
  if (entry.local) {
    results.push({
      ...entry,
      status: 'local',
      warning: null,
      detail: 'built from this repository, no registry manifest',
    });
    continue;
  }
  const pin = inspectPin(entry.ref);
  const result = {
    ...entry,
    status: 'ok',
    warning: pin.warning,
    detail: '',
  };
  if (!pin.pinned) {
    result.status = 'missing';
    result.detail = pin.warning ?? 'unpinned';
    results.push(result);
    continue;
  }
  try {
    const manifest = await resolveManifest(entry.ref);
    result.detail =
      manifest.platforms > 0 ? `${manifest.kind}, ${manifest.platforms} platforms` : manifest.kind;
  } catch (error) {
    result.status = classify(error);
    result.detail =
      String(error.stderr ?? error.message)
        .split(/\r?\n/)
        .filter(Boolean)[0] ?? 'unknown error';
  }
  results.push(result);
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log(`image references checked: ${results.length}`);
  for (const result of results) {
    const label =
      result.status === 'local'
        ? 'LOCAL'
        : result.status === 'ok'
          ? result.warning === null
            ? 'ok  '
            : 'WARN'
          : result.status === 'missing'
            ? 'FAIL'
            : 'SKIP';
    const where = `${result.file}:${result.line}`;
    const detail = result.warning === null ? result.detail : `${result.detail} — ${result.warning}`;
    console.log(`  ${label} ${result.ref.padEnd(52)} ${where.padEnd(28)} ${detail}`);
  }
}

const missing = results.filter((result) => result.status === 'missing');
const unreachable = results.filter((result) => result.status === 'unreachable');
const warnings = results.filter((result) => result.status === 'ok' && result.warning !== null);
const local = results.filter((result) => result.status === 'local');

if (missing.length > 0) {
  console.error(
    `\n${missing.length} image reference(s) do not resolve. A pin must name a published tag:`,
  );
  for (const failure of missing)
    console.error(`  - ${failure.ref} (${failure.file}:${failure.line}) — ${failure.detail}`);
  console.error('Check the tag with `docker manifest inspect <ref>`, then update the reference.');
  process.exitCode = 1;
} else if (unreachable.length > 0) {
  // Not a verdict about the pins: this process has no route to the registry. The Docker daemon may
  // still pull fine (it can hold a proxy the CLI does not), so say so instead of crying failure.
  console.error(
    `\n${unreachable.length} reference(s) could not be checked — registry unreachable:`,
  );
  for (const unknown of unreachable)
    console.error(`  - ${unknown.ref} (${unknown.file}:${unknown.line})`);
  console.error('Run `docker compose -f docker/compose.dev.yml pull` for the daemon-side answer.');
  process.exitCode = 2;
} else {
  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} warning(s): a reference is valid but not fully pinned.`);
  }
  const registryCount = results.length - local.length;
  console.log(
    `\nall ${registryCount} registry reference(s) resolve to a published version` +
      (local.length > 0 ? `; ${local.length} built locally and not checked.` : '.'),
  );
}
