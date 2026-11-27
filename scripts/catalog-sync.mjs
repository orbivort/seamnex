#!/usr/bin/env node
/**
 * `pnpm catalog:sync --ref <tag>` — the command-line peer of the console's "Sync from source".
 *
 * It is a **client** of `POST /catalog/sync`, not a second implementation. Acquisition has to be the
 * server operation: the same request writes `catalog_commit`, swaps the tree and reconciles the
 * projection, and a CLI that did any of that itself could leave the projection describing a tree the
 * API is not serving. Scripted installs and the console therefore share one path, one set of
 * refusals and one audit row (ADR-BE-42 §10.6).
 *
 * Credentials: there is no device flow in this release, so the command reads a bearer token the
 * operator already holds. Without one it prints the console action rather than guessing — a script
 * that invented its own way to write the catalogue would be the second implementation this avoids.
 *
 * Usage:
 *   SEAMNEX_API_TOKEN=<r1 token> pnpm catalog:sync --ref catalog-2026.11.0
 *   SEAMNEX_API_URL=http://127.0.0.1:8080/api/v1   # override the published port/base
 */
import { parseArgs } from 'node:util';

const USAGE = `Usage: pnpm catalog:sync --ref <tag-or-commit>

  --ref <ref>       Tag or commit to fetch. Optional: omitting it sends no ref and the server applies
                    SEAMNEX_CATALOG_SOURCE_REF, which must be set or the request is refused.
  --help            This text.

Environment:
  SEAMNEX_API_URL    API base, default http://127.0.0.1:8080/api/v1
  SEAMNEX_API_TOKEN  Bearer token of an account holding metadata.manage. Required.
`;

function fail(message) {
  console.error(`catalog:sync: ${message}`);
  process.exitCode = 1;
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      ref: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  }));
} catch (error) {
  fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  process.exit(1);
}

if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}

const token = (process.env.SEAMNEX_API_TOKEN ?? '').trim();
if (token.length === 0) {
  fail(
    'SEAMNEX_API_TOKEN is not set, so this command has no way to authenticate.\n' +
      '  Set a bearer token for an account holding metadata.manage, or use the console:\n' +
      '  Catalog → "Sync from source" (the server applies the same rules and the same audit row).',
  );
} else {
  await sync(token, values.ref);
}

async function sync(bearer, ref) {
  const base = (process.env.SEAMNEX_API_URL ?? 'http://127.0.0.1:8080/api/v1').replace(/\/+$/, '');
  const body = ref === undefined ? {} : { ref };

  let response;
  try {
    response = await fetch(`${base}/catalog/sync`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(330_000),
    });
  } catch (error) {
    fail(
      `could not reach ${base}: ${error instanceof Error ? error.message : String(error)}\n` +
        '  Is the API running? `pnpm dev` publishes it on 127.0.0.1:8080.',
    );
    return;
  }

  const payload = await readJson(response);

  if (!response.ok) {
    // The refusal codes are named so a script can branch on them; the detail carries the git tail.
    const code =
      typeof payload?.code === 'string' ? payload.code : `HTTP ${String(response.status)}`;
    fail(`${code}\n  ${String(payload?.detail ?? response.statusText)}`);
    if (typeof payload?.remediation === 'string') console.error(`  ${payload.remediation}`);
    return;
  }

  const source = payload?.source;
  console.log(`catalog synced at revision ${String(payload?.revision)}`);
  if (source !== undefined) {
    console.log(
      `  source ${String(source.url)} at ${String(source.ref)}, commit ${String(source.commit)}`,
    );
  }
  console.log(
    `  ${String(payload?.entries)} entries reconciled: ${String(payload?.added)} added, ` +
      `${String(payload?.changed)} changed, ${String(payload?.removed)} removed`,
  );
  const pending = payload?.staged?.pending;
  if (Array.isArray(pending) && pending.length > 0) {
    // A mixed tree is a reported state, never a success with a footnote (ADR-BE-42 §10.2 rule 8).
    console.error(`  the tree is mixed: ${pending.join(', ')} still hold previous content`);
    console.error('  re-run at the same ref to repair it');
    process.exitCode = 1;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
