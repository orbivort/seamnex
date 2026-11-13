/**
 * Writes the release body for one version, when `CHANGELOG.md` has a section for it.
 *
 * The changelog is the human document: `scripts/bump-version.mjs` turns `## [Unreleased]` into
 * `## [X.Y.Z] - <date>` behind review, and the release publishes that section instead of a list of
 * commits. When there is no section — the first release, or a tag cut before the `version-bump`
 * pull request merged — nothing is written and the caller keeps `gh release create --generate-notes`.
 *
 *   node scripts/release-notes.mjs 1.2.3
 *
 * Both outcomes exit 0: "no section for this version" is a documented release path, not a failure.
 * With `GITHUB_OUTPUT` set the resolved source is appended there as `source=changelog|commits`.
 * Only Node built-ins are used — the release jobs run this before anything is installed.
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * SemVer core plus a pre-release: the only shape a release tag takes. Splitting rather than matching
 * keeps `security/detect-unsafe-regex` satisfied without an exception — it cannot tell this bounded
 * shape from a backtracking one, and a structural check needs no rule disabled.
 */
function isVersion(value) {
  const dash = value.indexOf('-');
  const core = dash === -1 ? value : value.slice(0, dash);
  const pre = dash === -1 ? '' : value.slice(dash + 1);
  const parts = core.split('.');

  return (
    parts.length === 3 &&
    parts.every((part) => /^\d+$/.test(part)) &&
    (dash === -1 || /^[0-9A-Za-z.-]+$/.test(pre))
  );
}

/** The file `gh release create --notes-file` reads, and the one this script owns. */
const BODY = 'release-notes.md';

/**
 * `## 1.2.3` must not match `## 1.2.30`, so the character after the version has to bound it.
 * Headings written without brackets are accepted because `CHANGELOG.md` declares Keep a Changelog
 * while `bump-version.mjs` writes the bracketed form; reading both keeps a hand-written section
 * publishable.
 */
function isBracketed(line, version) {
  return line.startsWith(`## [${version}]`);
}

function isPlain(line, version) {
  const prefix = `## ${version}`;
  if (!line.startsWith(prefix)) return false;
  const next = line.charAt(prefix.length);
  return next === '' || next === ' ' || next === '-';
}

/** A reference definition such as `[1.2.3]: https://…/tag/v1.2.3`, which ends the last section. */
const LINK_DEFINITION = /^\[[^\]]+\]:\s/;

/**
 * The section body: everything under the heading up to the next `## ` heading or the link
 * definitions at the foot of the file, or `null` when no heading matches. Blank lines at either edge
 * are dropped so the published body does not open with four empty lines.
 */
function findSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => isBracketed(line, version) || isPlain(line, version));
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## ') || LINK_DEFINITION.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

/**
 * Appending rather than writing the whole `GITHUB_OUTPUT`: the file is shared by every step in the
 * job, and truncating it would drop another step's outputs.
 */
function record(source, version) {
  if (source === 'changelog') {
    console.log(`release-notes: publishing the CHANGELOG.md section for ${version}.`);
  } else {
    console.log(
      `::notice::CHANGELOG.md has no section for ${version}; the body will be generated from commits.`,
    );
  }

  const output = process.env.GITHUB_OUTPUT ?? '';
  if (output !== '') appendFileSync(output, `source=${source}\n`, 'utf8');
}

function main() {
  const [argument, ...extra] = process.argv.slice(2);
  const version = (argument ?? '').replace(/^v/, '');

  if (argument === undefined || extra.length > 0) {
    console.error('release-notes: usage: node scripts/release-notes.mjs <version>');
    process.exitCode = 1;
    return;
  }
  if (!isVersion(version)) {
    console.error(`release-notes: "${argument}" is not a version (expected X.Y.Z or X.Y.Z-<pre>)`);
    process.exitCode = 1;
    return;
  }

  const root = resolve(process.cwd());
  const bodyPath = resolve(root, BODY);

  // A body left behind by an earlier attempt in the same checkout would be published for a version
  // it does not belong to, so the decision always starts from no file at all.
  if (existsSync(bodyPath)) rmSync(bodyPath);

  const section = existsSync(resolve(root, 'CHANGELOG.md'))
    ? findSection(readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8'), version)
    : null;

  if (section === null || section === '') {
    record('commits', version);
    return;
  }

  writeFileSync(bodyPath, `${section}\n`, 'utf8');
  record('changelog', version);
}

main();
