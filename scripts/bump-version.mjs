/**
 * Writes one version into every manifest, the contract constant and the changelog.
 *
 * This is the only writer of that number. `version-bump.yml` runs it behind a reviewable pull
 * request, and a maintainer runs the same command when preparing the release by hand:
 *
 *   node scripts/bump-version.mjs 0.2.0 [--date YYYY-MM-DD]
 *
 * Everything is validated before anything is written, so a rejected input leaves the working tree
 * untouched. `pnpm check:version` is the reader that proves the result is consistent; the workflow
 * runs it straight afterwards and refuses to open a pull request if it fails.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/** The value meaning "nothing has been released from this checkout yet". */
const PLACEHOLDER = '0.0.0';

/** The heading holding the entries that are not released yet. */
const UNRELEASED = '## Unreleased';

/**
 * SemVer core plus an optional pre-release: the shape `release.yml` and `release-dispatch.yml`
 * accept, so a version this script writes can always be tagged. The nested repetition trips
 * `security/detect-unsafe-regex`, which is re-enabled immediately below the declaration: the input
 * is one short argument, not a document.
 */
/* eslint-disable security/detect-unsafe-regex */
const VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
/* eslint-enable security/detect-unsafe-regex */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The manifest path in the contract package, whose constant feeds `docs/openapi.json`. */
const CONTRACT = 'packages/domain/src/contract.ts';

const root = resolve(process.cwd());

/**
 * `--date` is stated explicitly rather than defaulted inside the formatting, so the value written
 * into the changelog is the value the caller asked for and can be reproduced from the log.
 */
function parseArguments(argv) {
  const dateFlag = argv.indexOf('--date');
  const dateValue = dateFlag === -1 ? undefined : argv[dateFlag + 1];
  const positional = argv.filter(
    (argument, index) => !argument.startsWith('--') && !(dateFlag !== -1 && index === dateFlag + 1),
  );

  return { requested: positional[0], extra: positional.slice(1), date: dateValue };
}

/** `Date.parse` accepts `2026-02-31` and rolls it over; a changelog date may not do that. */
function isCalendarDate(value) {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Every manifest the gate reads: the root plus one per workspace project. */
function discoverManifests() {
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

  return manifests;
}

/**
 * The released section keeps the entries that were under `Unreleased`, and a fresh empty
 * `Unreleased` stays on top so the next entry has somewhere to go. That is the Keep a Changelog
 * convention this file declares in its header.
 */
function planChangelog(text, version, date) {
  // The working copy decides the line ending, not this script: a Windows checkout that git converted
  // to CRLF must not come back rewritten from top to bottom.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const headings = lines.flatMap((line, index) => (line === UNRELEASED ? [index] : []));

  if (headings.length !== 1) {
    return {
      problem: `CHANGELOG.md has ${headings.length} "${UNRELEASED}" headings; exactly one is expected`,
    };
  }

  const [start] = headings;
  const following = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const end = following === -1 ? lines.length : following;

  const body = lines.slice(start + 1, end);
  while (body.length > 0 && body[0].trim() === '') body.shift();
  while (body.length > 0 && body.at(-1).trim() === '') body.pop();

  if (body.length === 0) {
    return { problem: `the "${UNRELEASED}" section is empty; write its entries before bumping` };
  }

  const block = [UNRELEASED, '', `## [${version}] - ${date}`, '', ...body, ''];
  const next = [...lines.slice(0, start), ...block, ...lines.slice(end)].join(eol);

  return { next, heading: `## [${version}] - ${date}` };
}

function main() {
  const { requested, extra, date: requestedDate } = parseArguments(process.argv.slice(2));
  const problems = [];

  if (requested === undefined) {
    problems.push(
      'a version is required; usage: node scripts/bump-version.mjs <version> [--date YYYY-MM-DD]',
    );
  }
  if (extra.length > 0) {
    problems.push(
      `unexpected argument "${extra[0]}"; usage: node scripts/bump-version.mjs <version> [--date YYYY-MM-DD]`,
    );
  }

  const version = requested === undefined ? '' : requested.replace(/^v/, '');
  const date = requestedDate ?? process.env.RELEASE_DATE ?? new Date().toISOString().slice(0, 10);

  if (requested !== undefined && !VERSION.test(version)) {
    problems.push(`"${requested}" is not a version (expected X.Y.Z or X.Y.Z-<pre>)`);
  }
  if (version === PLACEHOLDER) {
    problems.push(`${PLACEHOLDER} is the placeholder this script exists to replace`);
  }
  if (!isCalendarDate(date)) {
    problems.push(`"${date}" is not a calendar date (expected YYYY-MM-DD)`);
  }

  const manifests = discoverManifests().map((path) => ({
    path,
    manifest: JSON.parse(readFileSync(path, 'utf8')),
  }));

  const currentVersions = new Set(manifests.map(({ manifest }) => manifest.version));
  if (currentVersions.size > 1) {
    problems.push(
      `the manifests disagree (${[...currentVersions].join(', ')}); run \`pnpm check:version\` and fix that first`,
    );
  }
  const previous = [...currentVersions][0];
  if (currentVersions.size === 1 && previous === version) {
    problems.push(`the manifests already carry "${version}"`);
  }

  const contractPath = resolve(root, CONTRACT);
  const contract = readFileSync(contractPath, 'utf8');
  const constantPattern = /(export const CONTRACT_DOCUMENT_VERSION = ')([^']*)(';)/;
  const constant = constantPattern.exec(contract);
  if (constant === null) {
    problems.push(`${CONTRACT}: CONTRACT_DOCUMENT_VERSION is not a single-quoted string literal`);
  }

  const changelogPath = resolve(root, 'CHANGELOG.md');
  const planned = planChangelog(readFileSync(changelogPath, 'utf8'), version, date);
  if (planned.problem !== undefined) problems.push(planned.problem);

  if (problems.length > 0) {
    console.error('bump-version: nothing was written.');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log(`bump-version: ${version} (dated ${date})`);

  for (const { path, manifest } of manifests) {
    manifest.version = version;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`  ${relative(root, path).padEnd(40)} version ${previous} -> ${version}`);
  }

  writeFileSync(
    contractPath,
    contract.replace(
      constantPattern,
      (_match, before, _old, after) => `${before}${version}${after}`,
    ),
    'utf8',
  );
  console.log(`  ${CONTRACT.padEnd(40)} CONTRACT_DOCUMENT_VERSION ${previous} -> ${version}`);

  writeFileSync(changelogPath, planned.next, 'utf8');
  console.log(`  ${'CHANGELOG.md'.padEnd(40)} "${UNRELEASED}" -> "${planned.heading}"`);

  console.log('Next: pnpm --filter @seamnex/api openapi:generate && pnpm check:version');
}

main();
