/**
 * Image-pin gate (deliverable 1.8, NFR-4.15).
 *
 * `docker/images.json` is the authority for every image this repository starts. This script proves
 * four things a reviewer cannot see in a diff, and only the last of them needs the network:
 *
 *   1. every registry `image:` in `docker/compose.dev.yml` is named by the manifest, and every
 *      `devStack` entry is still used by a service;
 *   2. the scanner default in `.env.example` and in the compose environment is the manifest's;
 *   3. `apps/api/src/common/docker/images.generated.ts` is what `pnpm images:generate` would write,
 *      and every repository in the manifest has a row in `THIRD-PARTY-NOTICES.md`;
 *   4. every reference resolves to a published manifest — the original job, and the reason this
 *      script asks a registry rather than a file.
 *
 * `--offline` stops after (3). That half needs neither a daemon nor egress, so it belongs beside
 * `pnpm lint`; the online half is deliberately not part of `pnpm test`, which must stay runnable on
 * a machine with no route. An `image:` on a service that also declares `build:` names an image *this
 * repository builds*, not a registry reference; those are counted as local, never resolved.
 *
 *   pnpm check:images
 *   pnpm check:images:offline
 *   node scripts/check-images.mjs --json
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  GENERATED_MODULE,
  MANIFEST_FILE,
  loadImageManifest,
  manifestReferences,
  renderModule,
  repositoryOf,
} from './image-manifest.mjs';

const run = promisify(execFile);
const root = resolve(process.cwd());
const asJson = process.argv.includes('--json');
const offlineOnly = process.argv.includes('--offline');

const COMPOSE_FILE = 'docker/compose.dev.yml';
const DOCKERFILE_GLOBS = ['apps/api/Dockerfile'];
const ENV_EXAMPLE = '.env.example';
const NOTICES = 'THIRD-PARTY-NOTICES.md';

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

/** @returns {{ file: string, line: number, ref: string, local: boolean, kind: 'compose' | 'dockerfile' }[]} */
function collect() {
  const found = [];
  const compose = collectComposeImages(COMPOSE_FILE);
  // `deploy-worker`, `status-sampler` and the rest reuse the image `api` builds without declaring a
  // build of their own, so "local" is a property of the *name*, not of the one service that builds
  // it. Any service that builds an image makes every reference to that name local.
  const builtHere = new Set(compose.filter((entry) => entry.builds).map((entry) => entry.ref));
  for (const entry of compose) {
    const { builds, ...reference } = entry;
    found.push({
      ...reference,
      local: builds || builtHere.has(entry.ref),
      kind: 'compose',
    });
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
        found.push({ file, line: index + 1, ref, local: false, kind: 'dockerfile' });
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

function fileText(path) {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The checks that need no daemon and no route.
 *
 * A failure here is always a disagreement about *which* reference runs, so each message names the
 * file that has to move. The manifest is the one place none of them may contradict.
 */
function offlineProblems(manifest, composeRefs) {
  const problems = [];
  const named = new Set(manifestReferences(manifest).map((entry) => entry.reference));

  for (const entry of composeRefs) {
    if (!named.has(entry.ref)) {
      problems.push(
        `${entry.file}:${entry.line} names ${entry.ref}, which ${MANIFEST_FILE} does not list`,
      );
    }
  }

  const composeNamed = new Set(composeRefs.map((entry) => entry.ref));
  for (const reference of manifest.devStack) {
    if (!composeNamed.has(reference)) {
      problems.push(
        `${MANIFEST_FILE} lists ${reference} under devStack, but no compose service names it`,
      );
    }
  }

  const scanner = manifest.controlPlane.trivy;
  if (scanner === undefined) {
    problems.push(`${MANIFEST_FILE} must name the scanner under controlPlane.trivy`);
  } else {
    const fromExample = /^SEAMNEX_SCANNER_IMAGE=(.+)$/m.exec(fileText(ENV_EXAMPLE) ?? '')?.[1];
    if (fromExample?.trim() !== scanner) {
      problems.push(
        `${ENV_EXAMPLE}: SEAMNEX_SCANNER_IMAGE must be ${scanner} ` +
          `(found ${fromExample?.trim() ?? 'no line'})`,
      );
    }
    const fromCompose = /SEAMNEX_SCANNER_IMAGE:\s*\$\{SEAMNEX_SCANNER_IMAGE:-([^}]+)\}/.exec(
      fileText(COMPOSE_FILE) ?? '',
    )?.[1];
    if (fromCompose?.trim() !== scanner) {
      problems.push(
        `${COMPOSE_FILE}: the SEAMNEX_SCANNER_IMAGE default must be ${scanner} ` +
          `(found ${fromCompose?.trim() ?? 'no default'})`,
      );
    }
  }

  const generated = fileText(GENERATED_MODULE);
  if (generated !== renderModule(manifest.controlPlane)) {
    problems.push(
      `${GENERATED_MODULE} does not match ${MANIFEST_FILE}; run \`pnpm images:generate\``,
    );
  }

  const notices = fileText(NOTICES) ?? '';
  const repositories = [
    ...new Set(manifestReferences(manifest).map((entry) => repositoryOf(entry.reference))),
  ];
  for (const repository of repositories) {
    // The table lists a repository in backticks; a bare substring would match prose as well.
    if (!notices.includes(`\`${repository}\``)) {
      problems.push(`${NOTICES} has no row for \`${repository}\``);
    }
  }

  return problems;
}

const references = collect();
const composeRefs = references.filter((entry) => entry.kind === 'compose' && !entry.local);
const dockerfileRefs = references.filter((entry) => entry.kind === 'dockerfile');
const localCount = references.filter((entry) => entry.local).length;

let manifest;
try {
  manifest = loadImageManifest(root);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const problems = offlineProblems(manifest, composeRefs);
if (problems.length > 0) {
  console.error(`\n${problems.length} image-pin problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`The authority is ${MANIFEST_FILE}; \`pnpm images:generate\` rewrites the module.`);
  process.exit(1);
}

if (offlineOnly) {
  console.log(
    `${MANIFEST_FILE} agrees with ${COMPOSE_FILE}, ${ENV_EXAMPLE}, ${GENERATED_MODULE} and ` +
      `${NOTICES}; ${localCount} reference(s) built locally and not checked.`,
  );
  process.exit(0);
}

/**
 * The one online pass: the manifest's references plus the Dockerfile bases, which are out of its
 * scope because `FROM` is resolved before the build context is read.
 */
const targets = [
  ...manifestReferences(manifest).map((entry) => ({
    ref: entry.reference,
    where: entry.name === null ? MANIFEST_FILE : `${MANIFEST_FILE} ${entry.name}`,
  })),
  ...dockerfileRefs.map((entry) => ({ ref: entry.ref, where: `${entry.file}:${entry.line}` })),
];

const results = [];

for (const target of targets) {
  const pin = inspectPin(target.ref);
  const result = { ...target, status: 'ok', warning: pin.warning, detail: '' };
  if (!pin.pinned) {
    result.status = 'missing';
    result.detail = pin.warning ?? 'unpinned';
    results.push(result);
    continue;
  }
  try {
    const resolved = await resolveManifest(target.ref);
    result.detail =
      resolved.platforms > 0 ? `${resolved.kind}, ${resolved.platforms} platforms` : resolved.kind;
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
      result.status === 'ok'
        ? result.warning === null
          ? 'ok  '
          : 'WARN'
        : result.status === 'missing'
          ? 'FAIL'
          : 'SKIP';
    const detail = result.warning === null ? result.detail : `${result.detail} — ${result.warning}`;
    console.log(`  ${label} ${result.ref.padEnd(52)} ${result.where.padEnd(28)} ${detail}`);
  }
}

const missing = results.filter((result) => result.status === 'missing');
const unreachable = results.filter((result) => result.status === 'unreachable');
const warnings = results.filter((result) => result.status === 'ok' && result.warning !== null);

if (missing.length > 0) {
  console.error(
    `\n${missing.length} image reference(s) do not resolve. A pin must name a published tag:`,
  );
  for (const failure of missing)
    console.error(`  - ${failure.ref} (${failure.where}) — ${failure.detail}`);
  console.error('Check the tag with `docker manifest inspect <ref>`, then update the reference.');
  process.exitCode = 1;
} else if (unreachable.length > 0) {
  // Not a verdict about the pins: this process has no route to the registry. The Docker daemon may
  // still pull fine (it can hold a proxy the CLI does not), so say so instead of crying failure.
  console.error(
    `\n${unreachable.length} reference(s) could not be checked — registry unreachable:`,
  );
  for (const unknown of unreachable) console.error(`  - ${unknown.ref} (${unknown.where})`);
  console.error(`Run \`docker compose -f ${COMPOSE_FILE} pull\` for the daemon-side answer.`);
  process.exitCode = 2;
} else {
  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} warning(s): a reference is valid but not fully pinned.`);
  }
  console.log(
    `\nall ${results.length} registry reference(s) resolve to a published version` +
      (localCount > 0 ? `; ${localCount} built locally and not checked.` : '.'),
  );
}
