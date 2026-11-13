#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Migration guard (deliverable 1.9). Fails CI on:
 *   - an `.up.sql` without its `.down.sql` (exit criterion 2 needs a real rollback);
 *   - a numbering gap or a duplicate prefix;
 *   - a non-snake-case name, or a file that does not start with a four-digit prefix.
 *
 * It deliberately does not parse SQL: the database is the authority on validity, and
 * `packages/db/test/integration/migrations.test.ts` applies the files for real.
 */

const dir = process.argv[2] ?? fileURLToPath(new URL('../packages/db/migrations', import.meta.url));
const pattern = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

const files = readdirSync(dir).filter((file) => file.endsWith('.sql'));
const seen = new Map();
const problems = [];

for (const file of files) {
  const match = pattern.exec(file);
  if (match === null) {
    problems.push(`${file}: expected NNNN_snake_case.(up|down).sql`);
    continue;
  }
  const [, number, name, direction] = match;
  const id = `${number}_${name}`;
  const entry = seen.get(id) ?? { up: false, down: false };
  entry[direction] = true;
  seen.set(id, entry);
}

const ids = [...seen.keys()].sort();
ids.forEach((id, index) => {
  const expected = String(index + 1).padStart(4, '0');
  if (!id.startsWith(`${expected}_`)) {
    problems.push(`${id}: numbering gap — expected prefix ${expected}_`);
  }
  const entry = seen.get(id);
  if (!entry.up) problems.push(`${id}: missing .up.sql`);
  if (!entry.down) problems.push(`${id}: missing .down.sql`);
});

// A file that only exists as `.down.sql` would never be seen above; catch it explicitly.
for (const file of files) {
  const match = pattern.exec(file);
  if (match === null) continue;
  const [, number, name] = match;
  const id = `${number}_${name}`;
  if (!seen.has(id)) problems.push(`${file}: unreachable migration file`);
}

if (problems.length > 0) {
  console.error(`Migration check failed (${join(dir)}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`Migration check passed: ${ids.length} paired migrations.`);
}
