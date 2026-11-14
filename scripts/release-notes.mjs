/**
 * Writes the release body for one version, when `CHANGELOG.md` has a section for it.
 *
 * The changelog is the human document: `scripts/bump-version.mjs` turns `## [Unreleased]` into
 * `## [X.Y.Z] - <date>` behind review, and the release publishes that section instead of a list of
 * commits. When there is no section — the first release, or a tag cut before the `release-prepare`
 * pull request merged — nothing is written and the caller keeps `gh release create --generate-notes`.
 *
 *   node scripts/release-notes.mjs 1.2.3 [--no-footer]
 *
 * Both outcomes exit 0: "no section for this version" is a documented release path, not a failure.
 * With `GITHUB_OUTPUT` set the resolved source is appended there as `source=changelog|commits`.
 * Only Node built-ins are used — the release jobs run this before anything is installed.
 *
 * A published section is followed by a generated footer: download verification, the licence and the
 * full-changelog link. Those are facts the pipeline already owns — the checksums it wrote, the
 * identifier in `package.json` that `check:license` gates, and the tag the release is cut from — so
 * restating them in every section would be a copy that can disagree. Nothing else is generated: the
 * summary, the migration steps and the limits of the release are judgement and stay authored in
 * `CHANGELOG.md`. `--no-footer` publishes the section exactly as written.
 *
 * Deliberately absent: a version/date line (the release page states both, and a retried run would
 * contradict the timestamp it shows) and an asset table (GitHub renders that from the uploaded files).
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

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

/** The GitHub slug the links are built from. Absent on a developer checkout. */
function repositorySlug() {
  return (process.env.GITHUB_REPOSITORY ?? '').trim();
}

/**
 * The tag this release follows, for the compare link. `--exclude` because the tag being released may
 * already be fetched when this runs (a retried run does exactly that), and `--match` so a tag that is
 * not a version is never offered as a release boundary. An empty string means "no previous tag": the
 * first release, or a checkout with no tags — both are answered without inventing one.
 */
function previousTag(version) {
  try {
    return execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `--exclude=v${version}`, 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return '';
  }
}

/** The identifier from the root manifest — the value `pnpm check:license` is the gate for. */
function licenceIdentifier(root) {
  try {
    return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).license ?? '';
  } catch {
    return '';
  }
}

/**
 * The footer, in the order a reader needs it: how to check what they downloaded, what they may do
 * with it, and where the rest of the changes are. A section is omitted when its input is unknown, so
 * this never prints a link it cannot substantiate — a checkout without `GITHUB_REPOSITORY` publishes
 * verification and licence, and no compare link.
 */
function renderFooter({ root, version }) {
  const sections = [];

  sections.push(
    [
      '## Verify the download',
      '',
      '```bash',
      'sha256sum --ignore-missing -c SHA256SUMS.txt',
      '```',
      '',
      'On macOS: `shasum -a 256 --ignore-missing -c SHA256SUMS.txt`. Each archive carries its bundle,',
      '`LICENSE` and `THIRD-PARTY-NOTICES.md`; an archive missing either is not a release asset —',
      'download it again.',
    ].join('\n'),
  );

  const licence = licenceIdentifier(root);
  if (licence !== '') {
    sections.push(
      [
        '## Licence',
        '',
        `\`${licence}\` — the full text is in \`LICENSE\` inside each archive, and the corresponding`,
        `source for this release is the tag \`v${version}\`.`,
      ].join('\n'),
    );
  }

  const repository = repositorySlug();
  if (repository !== '') {
    const previous = previousTag(version);
    const url =
      previous === ''
        ? `https://github.com/${repository}/commits/v${version}`
        : `https://github.com/${repository}/compare/${previous}...v${version}`;
    sections.push(
      [
        '## Full changelog',
        '',
        previous === ''
          ? `Initial release — no previous tag to compare against. [\`v${version}\` commits](${url})`
          : `[\`${previous}...v${version}\`](${url})`,
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
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
  const argv = process.argv.slice(2);
  const [argument, ...extra] = argv.filter((item) => !item.startsWith('--'));
  const flags = argv.filter((item) => item.startsWith('--'));
  const unknown = flags.filter((flag) => flag !== '--no-footer');
  const version = (argument ?? '').replace(/^v/, '');

  if (argument === undefined || extra.length > 0 || unknown.length > 0) {
    console.error(
      'release-notes: usage: node scripts/release-notes.mjs <version> [--no-footer]' +
        (unknown.length > 0 ? ` (unknown flag "${unknown[0]}")` : ''),
    );
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

  // The footer is separated by a rule so a reader can see where the reviewed section ends. The blank
  // line before it is what keeps `---` a thematic break rather than a setext heading.
  const footer = flags.includes('--no-footer') ? '' : renderFooter({ root, version });
  const body = footer === '' ? section : `${section}\n\n---\n\n${footer}`;

  writeFileSync(bodyPath, `${body}\n`, 'utf8');
  console.log(
    footer === ''
      ? `release-notes: wrote the section for ${version} as written.`
      : `release-notes: wrote the section for ${version} plus the generated footer.`,
  );
  record('changelog', version);
}

main();
