#!/usr/bin/env node
/**
 * Fails when the first-load JavaScript of a built app exceeds its gzip budget.
 *
 * A budget is the only guard that survives a design system growing one primitive at a time: the
 * review found a 464 KB entry chunk with no gate that would notice the next 50 KB. This mirrors
 * the other `check-*.mjs` scripts — no dependency, a clear message, and a non-zero exit code.
 *
 * Usage:
 *   node scripts/check-bundle-budget.mjs --app console [--budget 250] [--dir dist-demo]
 *
 * The budget is measured on the assets `index.html` actually references (the entry plus whatever
 * it modulepreloads), because that is what a first visit downloads before it can interact.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);

function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value === undefined ? fallback : value;
}

const app = flag('app', 'console');
/**
 * Measured baseline (2026-11-05, re-measured for review §13.5): 266.8 KB gz for the console
 * (React 127.0, shared `src-*.js` 84.9, entry 19.6, TanStack Query 18.6, router 13.2, labels 3.2,
 * runtime 0.4) and 253.4 KB for the portal. Chunk scaffolding moves the console total by under
 * 1 KB between builds, so read it as 266.8 ± 0.5.
 *
 * The 84.9 KB shared chunk is *not* a `@seamnex/domain` chunk, although it was recorded as one here
 * before: `zod` plus the domain contract and its 14 schema modules are 42.8 KB of it, and the
 * other half is the rest of the entry's static graph (tailwind-merge via `cn()`, boot-path UI
 * primitives, the Radix dialog stack, the shell's sign-in surface). All of it is reachable from
 * the entry before first paint, so splitting it would add a modulepreload link and no saving —
 * see `docs/review/react-19-best-practices-review.md` §13.5 before raising this number.
 *
 * The budget is the ceiling, not a target: raising it is a deliberate decision that should come
 * with a note in the review.
 */
const budgetKb = Number(flag('budget', '300'));
// The production build writes `dist`; the demo build writes `dist-demo`, so the two can never
// overwrite each other's cached output (see `turbo.json`). Measure either by name.
const outputDir = flag('dir', 'dist');
const dist = resolve('apps', app, outputDir);

let html;
try {
  html = readFileSync(join(dist, 'index.html'), 'utf8');
} catch {
  console.error(`No build output at ${dist}. Run "pnpm --filter @seamnex/${app} build" first.`);
  process.exit(2);
}

if (/sourceMappingURL=|\.js\.map/.test(html)) {
  console.error(
    'index.html references a source map. A production build must use `sourcemap: "hidden"`.',
  );
  process.exit(1);
}

const assets = [
  ...new Set([...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((match) => match[1])),
];

if (assets.length === 0) {
  console.error('index.html references no JavaScript assets.');
  process.exit(2);
}

let total = 0;
for (const name of assets) {
  const bytes = readFileSync(join(dist, 'assets', name));
  const gzipped = gzipSync(bytes).length;
  total += gzipped;
  console.log(`  ${(gzipped / 1024).toFixed(1).padStart(7)} KB gz  ${name}`);
}

const totalKb = total / 1024;
console.log(`\n${app}: ${totalKb.toFixed(1)} KB gz on first load (budget ${budgetKb} KB)`);

if (totalKb > budgetKb) {
  console.error(
    `Over budget by ${(totalKb - budgetKb).toFixed(1)} KB. Split a route, drop a dependency, or raise the budget deliberately.`,
  );
  process.exit(1);
}
