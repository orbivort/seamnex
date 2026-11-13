#!/usr/bin/env node
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

/**
 * `pnpm clean` — remove everything the build and the tools generate, and nothing else.
 *
 * Written as a Node script rather than `rimraf`/`del-cli` globs for two reasons. A glob list
 * (`rm -rf apps/*\/dist`) needs a shell, and the shell differs: `rm -rf` does not exist on Windows
 * and PowerShell's `Remove-Item` does not exist on POSIX. Node's `rmSync` is the same call on
 * every supported platform, and it retries on Windows, where a file just released by a watcher
 * (Vite, tsx) is briefly still locked and a plain delete fails with EBUSY.
 *
 * The walk is deliberately name-based and pruned: it stops at a match instead of enumerating
 * below it, so `dist` with ten thousand files costs one `rmSync` rather than ten thousand stats.
 * `node_modules` is entered only to drop the tool caches inside it — removing the tree itself is
 * `--node-modules`, because that forces a full `pnpm install`.
 *
 * `temp/` is never touched. It is not build output: `scripts/lib/runtime-dirs.mjs` creates it for
 * bind mounts that hold instance definitions, backups and the age identity. Deleting it would lose
 * operator data that no rebuild can reproduce. Files git *tracks* stay as well, even where the
 * `.gitignore` calls them generated (`docs/openapi.json`): git, not this script, owns those.
 */
const root = dirname(import.meta.dirname);

/**
 * Directories identified by name alone: build output, test reports and the Turbo cache. Matched at
 * any depth, which covers both the root and every workspace package. This is the same set
 * `.gitignore` and `.dockerignore` call output, so the two files cannot promise to keep a directory
 * that `pnpm clean` then leaves behind: `dist-demo` (the demo build, written next to `dist`) and
 * `.vitest` (Vitest 5's blob reports, attachments and json/junit artifacts) were the two missing.
 */
const ARTIFACT_DIRS = new Set([
  'dist',
  'dist-demo',
  'build',
  '.turbo',
  'coverage',
  '.vitest',
  'playwright-report',
  'test-results',
]);

/**
 * Never descended into. `temp` holds runtime state (see the header comment); the rest is either
 * version control, editor state or an agent workspace. The workspace list is `.gitignore`'s, for
 * the same reason it ignores them: a `dist`-shaped directory inside one of them is the tool's own
 * data, not this project's output, and deleting it would lose state no rebuild reproduces.
 */
const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.vscode',
  '.idea',
  '.history',
  'temp',
  '.codex',
  '.claude',
  '.cursor',
  '.windsurf',
  '.continue',
  '.gemini',
  '.roo',
  '.kiro',
  '.openhands',
  '.specstory',
  '.codebuddy',
  '.trae',
  '.qoder',
]);

/** Caches that live *inside* `node_modules` and would survive `pnpm install` otherwise. */
const NODE_MODULE_CACHES = ['.cache', '.vite', '.turbo', '.tmp'];

/** Files that are generated rather than authored, matched on name at any depth. */
const GENERATED_FILES = [/\.tsbuildinfo$/, /\.log$/i, /^\.eslintcache$/, /^\.stylelintcache$/];

const HELP = `Usage:
  pnpm clean                    remove build output, caches and generated files
  pnpm clean:dry                list what would be removed, delete nothing
  pnpm clean:all                also delete node_modules (run "pnpm install" afterwards)

Removes build output (dist, dist-demo, build, .turbo), test reports (coverage, .vitest,
playwright-report, test-results), tool caches, *.tsbuildinfo and *.log files in every
workspace package.

Options:
  --dry-run        list what would be removed without deleting anything
  --node-modules   also delete all node_modules directories
  --help, -h       show this message

Bare "pnpm clean --<flag>" is claimed by pnpm's own option parser; use
"pnpm run clean --<flag>" to pass a flag through.

temp/ is preserved: it holds instance state, backups and the age identity, not build output.`;

const options = { dryRun: false, nodeModules: false };

for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') options.dryRun = true;
  else if (arg === '--node-modules') options.nodeModules = true;
  else if (arg === '--help' || arg === '-h') {
    console.log(HELP);
    process.exit(0);
  } else {
    // A typo must not silently turn into a narrower clean than the caller asked for.
    console.error(`[clean] unknown option: ${arg}\n`);
    console.error(HELP);
    process.exit(1);
  }
}

/** @type {string[]} Relative paths removed (or that would be removed, with --dry-run). */
const removed = [];
/** @type {string[]} Paths that could not be removed, with the reason. */
const failures = [];

/**
 * Delete one path, refusing anything that resolves outside the repository.
 *
 * The guard is not decorative: a symlinked package directory or a `--dry-run` typo would
 * otherwise reach a path the caller never named, and `rmSync` with `recursive` does not ask.
 *
 * @param {string} path Absolute path to remove.
 */
function remove(path) {
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    failures.push(`${path}: outside the repository root, refusing to remove`);
    return;
  }
  // Absent is the normal case for most cache names; a clean that reports them would be noise.
  if (!existsSync(path)) return;
  if (options.dryRun) {
    removed.push(rel);
    return;
  }
  try {
    // `maxRetries`/`retryDelay` make a Windows EBUSY (file still open in a dev server) retry
    // instead of aborting the whole clean.
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    removed.push(rel);
  } catch (error) {
    failures.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Drop the tool caches inside a `node_modules` directory without enumerating the packages.
 *
 * @param {string} nodeModules Absolute path to a `node_modules` directory.
 */
function removeModuleCaches(nodeModules) {
  for (const cache of NODE_MODULE_CACHES) {
    remove(join(nodeModules, cache));
  }
}

/**
 * @param {string} directory Absolute path to walk.
 */
function walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // A directory that vanished mid-walk (or cannot be read) is not a clean failure.
    return;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        if (options.nodeModules) remove(path);
        else removeModuleCaches(path);
        continue;
      }
      if (SKIP_DIRS.has(entry.name)) continue;
      if (ARTIFACT_DIRS.has(entry.name)) {
        remove(path);
        continue;
      }
      walk(path);
      continue;
    }

    // Only regular files: a symlink is someone's link, not output this script produced.
    if (!entry.isFile()) continue;
    if (GENERATED_FILES.some((pattern) => pattern.test(entry.name))) remove(path);
  }
}

walk(root);

if (removed.length > 0) {
  const heading = options.dryRun ? 'would remove' : 'removed';
  console.log(`[clean] ${heading} ${removed.length} path${removed.length === 1 ? '' : 's'}:`);
  for (const path of removed.sort()) console.log(`[clean]   - ${path}`);
} else {
  console.log('[clean] nothing to remove, the working tree has no build output.');
}

if (options.nodeModules) {
  const state = options.dryRun ? 'would be removed' : 'was removed';
  console.log(`[clean] node_modules ${state}; run "pnpm install" before the next command.`);
}

if (failures.length > 0) {
  console.error(`[clean] could not remove ${failures.length} path(s):`);
  for (const failure of failures) console.error(`[clean]   - ${failure}`);
  console.error('[clean] close dev servers holding those files, then re-run "pnpm clean".');
  process.exitCode = 1;
}
