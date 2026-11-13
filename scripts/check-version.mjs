/**
 * Version gate.
 *
 * A release is a git tag. The number inside the repository is a copy of the last released version
 * — `0.0.0` until the first bump — written only by `scripts/bump-version.mjs` and only behind the
 * pull request `.github/workflows/version-bump.yml` opens.
 *
 * That copy has four ways to go wrong, and none of them is visible in a diff once it is committed:
 * one manifest that disagrees with the rest, a `docs/openapi.json` that advertises its own number,
 * a release tag whose commit carries a different one, and a `CHANGELOG.md` with no section for the
 * version being released — which is where the release body is read from. All four are asserted here.
 *
 * The tag half runs only where there is something to compare: `release.yml` and
 * `release-dispatch.yml` pass the version they resolved as `SEAMNEX_BUILD_VERSION`, and the image is
 * built with the same value, so a release cannot publish an artefact whose own health endpoint
 * reports a different version than its tag.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/** The one value meaning "nothing has been released from this checkout yet". */
const PLACEHOLDER = '0.0.0';

/** SemVer core plus an optional pre-release, which is the only tag shape the release workflows publish. */
// eslint-disable-next-line security/detect-unsafe-regex -- a release tag is short and bounded by the ref name, and this is the canonical SemVer core shape.
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

const root = resolve(process.cwd());
const problems = [];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// 1. Every manifest carries the same number. The root is included: a number that appears in only
//    some manifests is exactly the drift this gate exists for.
const manifests = [resolve(root, 'package.json')];

for (const group of ['apps', 'packages']) {
  const base = resolve(root, group);
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = resolve(base, entry.name, 'package.json');
    if (existsSync(path)) manifests.push(path);
  }
}

const declared = new Map();

for (const path of manifests) {
  const { version } = readJson(path);
  const paths = declared.get(version) ?? [];
  paths.push(relative(root, path));
  declared.set(version, paths);
}

if (declared.size > 1) {
  problems.push(
    `the manifests disagree: ${[...declared]
      .map(([version, paths]) => `"${version}" in ${paths.join(', ')}`)
      .join('; ')}`,
  );
}

/** The one number they agree on, or `null` when they do not agree at all. */
const shared = declared.size === 1 ? [...declared.keys()][0] : null;

if (shared !== null && shared !== PLACEHOLDER && !VERSION.test(shared)) {
  problems.push(`the manifests carry "${shared}", which is neither "${PLACEHOLDER}" nor a version`);
}

// 2. The committed document says the same thing, because the served document is asserted to be
//    byte-identical to it.
const openapi = readJson(resolve(root, 'docs', 'openapi.json'));
if (shared !== null && openapi.info?.version !== shared) {
  problems.push(
    `docs/openapi.json: info.version is "${openapi.info?.version}", expected "${shared}"`,
  );
}

// 3. And it gets that value from the constant, not from a literal someone will forget to update —
//    which also means the constant is part of the copy the bump has to move.
const contractPath = resolve(root, 'packages', 'domain', 'src', 'contract.ts');
const contract = readFileSync(contractPath, 'utf8');
if (!/version:\s*CONTRACT_DOCUMENT_VERSION\b/.test(contract)) {
  problems.push(
    'packages/domain/src/contract.ts: info.version must reference CONTRACT_DOCUMENT_VERSION, not a literal',
  );
}

const constantPattern = /export const CONTRACT_DOCUMENT_VERSION = '([^']*)';/;
const constant = constantPattern.exec(contract)?.[1];
if (constant === undefined) {
  problems.push(
    'packages/domain/src/contract.ts: CONTRACT_DOCUMENT_VERSION must be a single-quoted string literal',
  );
} else if (shared !== null && constant !== shared) {
  problems.push(
    `packages/domain/src/contract.ts: CONTRACT_DOCUMENT_VERSION is "${constant}", expected "${shared}"`,
  );
}

// 4. When a release runs this, the identity it injects, the tag it was cut from and the copy in the
//    repository are one version.
const injected = (process.env.SEAMNEX_BUILD_VERSION ?? '').trim();
const refType = (process.env.GITHUB_REF_TYPE ?? '').trim();
const refName = (process.env.GITHUB_REF_NAME ?? '').trim();

if (injected.length > 0 && !VERSION.test(injected)) {
  problems.push(
    `SEAMNEX_BUILD_VERSION "${injected}" is not a version (expected X.Y.Z or X.Y.Z-<pre>)`,
  );
}

// The placeholder stays legal on a release: a maintainer may tag a commit that was never bumped,
// in which case the tag is the only statement of the version and there is nothing to compare.
if (injected.length > 0 && shared !== null && shared !== PLACEHOLDER && shared !== injected) {
  problems.push(`the manifests carry "${shared}" but this release is "${injected}"`);
}

if (refType === 'tag') {
  // eslint-disable-next-line security/detect-unsafe-regex -- same bounded tag shape as `release.yml`, which rejects anything else before this runs.
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(refName)) {
    problems.push(`tag "${refName}" is not a version tag (expected vX.Y.Z or vX.Y.Z-<pre>)`);
  } else if (injected.length > 0 && injected !== refName.replace(/^v/, '')) {
    problems.push(
      `SEAMNEX_BUILD_VERSION "${injected}" does not match the tag "${refName}" it is releasing`,
    );
  } else if (shared !== null && shared !== PLACEHOLDER && shared !== refName.replace(/^v/, '')) {
    problems.push(`the manifests carry "${shared}" but the tag being released is "${refName}"`);
  }
}

// 5. The changelog carries it too, because it is where the release body comes from:
//    `scripts/release-notes.mjs` publishes the `## [X.Y.Z]` section and falls back to generated notes
//    only when there is none. Nothing else reads the document during a release, so a bumped tree
//    without that heading would publish notes that contradict its own changelog.
const changelogPath = resolve(root, 'CHANGELOG.md');

// The placeholder tree is exempt for the same reason the manifests are (see the tag rule above): a
// tag may name a version no bump ever wrote, and then the changelog cannot have the heading either.
if (shared !== null && shared !== PLACEHOLDER) {
  if (!existsSync(changelogPath)) {
    problems.push('CHANGELOG.md is missing; the release body is read from its version section');
  } else if (!readFileSync(changelogPath, 'utf8').includes(`## [${shared}]`)) {
    problems.push(
      `CHANGELOG.md has no "## [${shared}]" section; run \`node scripts/bump-version.mjs ${shared}\` first`,
    );
  }
}

if (problems.length > 0) {
  console.error('The version is the git tag; the manifests, docs/openapi.json,');
  console.error('CONTRACT_DOCUMENT_VERSION and CHANGELOG.md carry one copy of the last released');
  console.error('version.');
  console.error('Found:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nSee CONTRIBUTING.md §"Releases" for the versioning rule.');
  process.exitCode = 1;
} else {
  const described =
    shared === PLACEHOLDER ? `the unreleased placeholder "${PLACEHOLDER}"` : `"${shared}"`;
  console.log(
    `version check passed: ${manifests.length} manifests, docs/openapi.json and CONTRACT_DOCUMENT_VERSION carry ${described}` +
      (refType === 'tag' ? `; tag ${refName} agrees.` : '.'),
  );
}
