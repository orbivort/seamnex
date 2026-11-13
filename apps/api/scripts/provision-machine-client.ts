/**
 * Provisions a machine client (deliverable 3.4).
 *
 *   pnpm provision:client registry-ingest registry.read
 *   pnpm provision:client audit-export audit.read
 *
 * The token is printed once and written under `temp/machine-clients/` (never to the repository).
 * The database stores only its SHA-256 hash, so a leaked dump cannot impersonate the client.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@seamnex/db';
import { isServiceScope, SERVICE_SCOPES } from '@seamnex/domain';

const [name, scope] = process.argv.slice(2);

if (name === undefined || scope === undefined) {
  throw new Error('usage: provision-machine-client <name> <registry.read|audit.read>');
}
if (!isServiceScope(scope)) {
  throw new Error(
    `unknown scope ${scope}; expected one of ${Object.keys(SERVICE_SCOPES).join(', ')}`,
  );
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error('DATABASE_URL is required');
}

const token = `seamnex_${randomBytes(32).toString('base64url')}`;
const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

const pool = createPool({ connectionString, applicationName: 'seamnex-provision-client' });
try {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO machine_client (name, token_hash, scope)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET token_hash = EXCLUDED.token_hash, scope = EXCLUDED.scope, enabled = true
     RETURNING id`,
    [name, tokenHash, scope],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('machine_client insert returned no row');

  const here = dirname(fileURLToPath(import.meta.url));
  const directory = resolve(here, '..', '..', '..', 'temp', 'machine-clients');
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `${name}.token`);
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });

  console.log(`machine client ${name} (${id}) provisioned with scope ${scope}`);
  console.log(`token written to ${path} — it is shown once and cannot be recovered`);
} finally {
  await pool.end();
}
