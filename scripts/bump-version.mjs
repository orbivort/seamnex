/**
 * Writes one version into every manifest, the contract constant and the changelog.
 *
 * This is the only writer of that number. `release-prepare.yml` runs it behind a reviewable pull
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

/** The heading holding the entries that are not released yet, in Keep a Changelog's bracketed form. */
const UNRELEASED = '## [Unreleased]';

/**
 * SemVer core plus an optional pre-release: the shape `release.yml` accepts, so a version this script
 * writes can always be tagged. The nested repetition trips
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

/** Numeric identifiers compare as numbers, alphanumeric ones as strings, and numbers sort first. */
function compareIdentifiers(left, right) {
  const numeric = /^\d+$/;
  if (numeric.test(left) && numeric.test(right)) return Number(left) - Number(right);
  if (numeric.test(left)) return -1;
  if (numeric.test(right)) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * SemVer 2.0.0 precedence, enough to order two release versions. Build metadata cannot reach this —
 * `VERSION` rejects `+...` — and a pre-release sorts below the release it precedes, which is what
 * makes `0.2.0-rc.1` a legal step after `0.1.0` and an illegal one after `0.2.0`.
 */
function compareVersions(left, right) {
  const split = (version) => {
    const [core, ...pre] = version.split('-');
    return {
      core: core.split('.').map(Number),
      pre: pre.length === 0 ? [] : pre.join('-').split('.'),
    };
  };
  const a = split(left);
  const b = split(right);

  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;

  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    if (a.pre[index] === undefined) return -1;
    if (b.pre[index] === undefined) return 1;
    const order = compareIdentifiers(a.pre[index], b.pre[index]);
    if (order !== 0) return order;
  }

  return 0;
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
 * Keeps the link definitions that make `## [1.2.3]` and `## [Unreleased]` links rather than literal
 * text. The repository URL is read from the existing `[Unreleased]` definition, so `CHANGELOG.md`
 * stays the one place it is stated; a file without that line is returned unchanged rather than given
 * a URL this script guessed.
 */
function planLinks(text, { version, previous, eol }) {
  const lines = text.split(/\r?\n/);
  const prefix = '[Unreleased]: ';
  const index = lines.findIndex((line) => line.startsWith(prefix));
  if (index === -1) return text;

  const base = /^(https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)/.exec(
    lines[index].slice(prefix.length),
  )?.[1];
  if (base === undefined) return text;

  // The first release has no previous tag to compare against, so it links to the tag itself.
  const released =
    previous === undefined || previous === PLACEHOLDER
      ? `[${version}]: ${base}/releases/tag/v${version}`
      : `[${version}]: ${base}/compare/v${previous}...v${version}`;

  lines.splice(index, 1, `[Unreleased]: ${base}/compare/v${version}...HEAD`, released);
  return lines.join(eol);
}

/**
 * The released section keeps the entries that were under `Unreleased`, and a fresh empty
 * `Unreleased` stays on top so the next entry has somewhere to go. That is the Keep a Changelog
 * convention this file declares in its header.
 */
function planChangelog(text, version, date, previous) {
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

  return {
    next: planLinks(next, { version, previous, eol }),
    heading: `## [${version}] - ${date}`,
  };
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
  } else if (VERSION.test(version) && previous !== undefined && previous !== PLACEHOLDER) {
    // A published tag is never reused, so a version that sorts below the released one can only be a
    // typo or a stale branch: the next release is the next greater version, never an earlier one.
    if (compareVersions(version, previous) < 0) {
      problems.push(
        `"${version}" sorts below the released "${previous}"; a release only moves forward`,
      );
    }
  }

  const contractPath = resolve(root, CONTRACT);
  const contract = readFileSync(contractPath, 'utf8');
  const constantPattern = /(export const CONTRACT_DOCUMENT_VERSION = ')([^']*)(';)/;
  const constant = constantPattern.exec(contract);
  if (constant === null) {
    problems.push(`${CONTRACT}: CONTRACT_DOCUMENT_VERSION is not a single-quoted string literal`);
  }

  const changelogPath = resolve(root, 'CHANGELOG.md');
  const planned = planChangelog(readFileSync(changelogPath, 'utf8'), version, date, previous);
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
