/**
 * Licence gate.
 *
 * The project is `GPL-3.0-only` (ADR-BE-19). Nothing else in the build reads that value: neither
 * `tsc`, nor Vite, nor Vitest will fail because a manifest says something different from the README,
 * which is why the identifier was able to live in fifteen places at once. A partial edit produces a
 * work whose licence contradicts itself — a scanner reports one thing, a downstream legal review
 * reads another — and no test notices.
 *
 * The version is pinned rather than "or later", so a leftover `GPL-3.0-or-later` is a substantive
 * regression, not a formatting slip: it re-grants the GPL-3.0 §14 option the project withheld on
 * purpose.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * The one identifier every declaration carries.
 *
 * `-only` is not decoration: the bare `GPL-3.0` token is ambiguous in SPDX, and `-or-later` grants a
 * permission this project deliberately does not grant.
 */
const IDENTIFIER = 'GPL-3.0-only';

/**
 * Phrasings that only appear in a stale declaration.
 *
 * A bare search for `GPL-3.0-or-later` would be wrong: `THIRD-PARTY-NOTICES.md` §7 names it on
 * purpose, to say that such a dependency may be combined with this work by taking its v3 option.
 * What must not survive is the *declaration* of the project's own licence, and these are the shapes
 * the old declarations actually used.
 */
const STALE = [
  'version 3 or later',
  'v3.0 or later',
  'licensed under GPL-3.0-or-later',
  'GPL--3.0--or--later',
];

/** The documents a reader consults before a manifest. */
const DOCUMENTS = ['README.md', 'CONTRIBUTING.md', 'THIRD-PARTY-NOTICES.md'];

const root = resolve(process.cwd());
const problems = [];

/** Root manifest first, then every workspace package that declares one. */
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

// 1. Every manifest carries the same identifier. `undefined` is reported distinctly from a wrong
//    value, because a manifest that lost the field is the failure a `JSON.parse` round-trip causes.
for (const path of manifests) {
  const { license } = JSON.parse(readFileSync(path, 'utf8'));
  if (license !== IDENTIFIER) {
    const found = license === undefined ? 'missing' : `"${license}"`;
    problems.push(`${relative(root, path)}: license is ${found}, expected "${IDENTIFIER}"`);
  }
}

// 2. The prose says the same thing, and none of it still offers a later version.
for (const name of DOCUMENTS) {
  const text = readFileSync(resolve(root, name), 'utf8');
  if (!text.includes(IDENTIFIER)) {
    problems.push(`${name}: never names ${IDENTIFIER}, so it cannot be the licence it describes`);
  }
  text.split(/\r?\n/).forEach((line, index) => {
    for (const phrase of STALE) {
      if (line.includes(phrase)) {
        problems.push(
          `${name}:${index + 1}: "${phrase}" declares a version this project does not grant`,
        );
      }
    }
  });
}

// 3. The licence text is v3 and not something a future release dropped in. The FSF appendix inside
//    it mentions "any later version" as boilerplate, which is why this asserts the heading rather
//    than the absence of that phrase.
const licencePath = resolve(root, 'LICENSE');
if (!existsSync(licencePath)) {
  problems.push('LICENSE: missing; the identifier in every manifest points at nothing');
} else {
  const licenceText = readFileSync(licencePath, 'utf8');
  if (!/GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/.test(licenceText)) {
    problems.push('LICENSE: does not carry the GPL version 3 (29 June 2007) heading');
  }
}

// 4. The one artefact that conveys object code: the image must declare the licence and carry it.
const dockerfile = readFileSync(resolve(root, 'apps', 'api', 'Dockerfile'), 'utf8');
if (!dockerfile.includes(`org.opencontainers.image.licenses="${IDENTIFIER}"`)) {
  problems.push(`apps/api/Dockerfile: no org.opencontainers.image.licenses="${IDENTIFIER}" label`);
}
if (!/COPY[^\n]*\bLICENSE\b/.test(dockerfile)) {
  problems.push('apps/api/Dockerfile: does not copy LICENSE into the image (GPL-3.0 §4/§6)');
}

// 5. And the other one: the release tarballs, which are a checkout's `dist/` plus nothing else
//    unless the packaging step says otherwise.
const release = readFileSync(resolve(root, '.github', 'workflows', 'release.yml'), 'utf8');
if (!release.includes('LICENSE THIRD-PARTY-NOTICES.md')) {
  problems.push('.github/workflows/release.yml: the release tarball omits LICENSE or the notices');
}

// 6. No inbound grant exists, because no outside code is accepted (§CONTRIBUTING "Licensing"). That
//    policy is prose, and prose is deleted in a one-line diff that no test notices; a tree that
//    silently starts merging outside patches would carry rights the outbound GPL does not convey.
//    Both halves are asserted: the policy is stated, and no CLA document is left lying around
//    implying one is in force.
const contributing = readFileSync(resolve(root, 'CONTRIBUTING.md'), 'utf8');
if (!contributing.includes('External code contributions are not accepted at present.')) {
  problems.push(
    'CONTRIBUTING.md: no longer states that external code contributions are not accepted',
  );
}
for (const name of ['CLA.md', 'CORPORATE-CLA.md']) {
  if (existsSync(resolve(root, name))) {
    problems.push(
      `${name}: a CLA is present, but the contribution policy requires none; ` +
        'restore it with the policy and this gate in one commit',
    );
  }
}

if (problems.length > 0) {
  console.error(
    `The licence is ${IDENTIFIER} in every manifest, document and distributed artefact.`,
  );
  console.error('Found:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nChange every site in one commit, or none: a half-edited declaration contradicts itself.',
  );
  process.exitCode = 1;
} else {
  console.log(
    `licence check passed: ${manifests.length} manifests, ${DOCUMENTS.length} documents and both ` +
      `distributed artefacts carry "${IDENTIFIER}"; no inbound grant is required.`,
  );
}
