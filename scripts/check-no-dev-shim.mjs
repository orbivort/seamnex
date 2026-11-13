/**
 * ADR-BE-06 removal gate (Phase 3, deliverable 3.8).
 *
 * The development identity shim must not come back. A grep is a crude control, but it is the one
 * that survives a tired reviewer: the header name and the environment flag may not appear anywhere
 * in shipped source, configuration or the dev stack.
 *
 * Scope: apps, packages, docker, platform, .env.example and the root scripts. Documentation keeps
 * the historical record and is deliberately not scanned — an ADR that describes the removal would
 * otherwise fail the check that enforces it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.cwd());
const roots = ['apps', 'packages', 'docker', 'platform', 'scripts'];
const files = ['package.json', '.env.example', 'docker-compose.yml'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage', '.git']);
const SKIP_FILES = new Set([relative(root, resolve(root, 'scripts/check-no-dev-shim.mjs'))]);
const FORBIDDEN = [/\bX-Dev-Subject\b/i, /\bALLOW_DEV_IDENTITY\b/];

const hits = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|js|mjs|cjs|json|ya?ml|sql|env|example)$/.test(entry.name)) continue;
    const rel = relative(root, path);
    if (SKIP_FILES.has(rel)) continue;
    let source;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (FORBIDDEN.some((pattern) => pattern.test(source))) hits.push(rel);
  }
}

for (const dir of roots) {
  const path = resolve(root, dir);
  try {
    if (statSync(path).isDirectory()) walk(path);
  } catch {
    // A directory that does not exist yet is not a violation.
  }
}
for (const file of files) {
  try {
    const path = resolve(root, file);
    const source = readFileSync(path, 'utf8');
    if (FORBIDDEN.some((pattern) => pattern.test(source))) hits.push(file);
  } catch {
    // Missing optional file.
  }
}

if (hits.length > 0) {
  console.error('The development identity shim was removed in Phase 3 (ADR-BE-06).');
  console.error('Found forbidden header/flag references in:');
  for (const hit of [...new Set(hits)].sort()) console.error(`  - ${hit}`);
  process.exit(1);
}

console.log(
  'no-dev-shim check passed: no X-Dev-Subject or ALLOW_DEV_IDENTITY outside documentation.',
);
