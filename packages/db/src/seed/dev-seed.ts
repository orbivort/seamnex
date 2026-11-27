import type { PoolClient } from 'pg';
import { createPool } from '../client';
import { catalogRepoRoot } from '../catalog-root';
import { loadRootEnv } from '../env';
import {
  contentHashOf,
  parseCatalogDocument,
  planTreeProjection,
  projectionColumns,
  requireProjectableTree,
} from './catalog-tree';

/**
 * Deterministic development data: the identity mirror and the catalogue projection.
 *
 * Scope: the `idp_user` directory mirror, the `idp_group` tree those users are members of, the
 * `role_binding` grants that hang off them, and the entries the catalogue checkout already declares.
 *
 * The catalogue half used to *write* content: six documents and six declarations vendored under
 * `platform/`. They are deployable product content and now live in the catalogue repository, so this
 * seed projects what `<root>/catalog` holds and writes no file (ADR-BE-42 §9.3). Acquisition is
 * `pnpm catalog:sync --ref <tag>`, or a tag placed in the root by hand on an air-gapped host.
 *
 * Everything else — a catalogue beyond the checkout, environment profiles, instances, routes,
 * entitlements, deployment jobs and the audit chain — is owned by `POST /catalog/reload` (`m22`) and
 * by the deployment that creates them. Rows are inserted only into a database that holds no catalog
 * entries at all, so this file never becomes a second author of an operator's catalogue.
 *
 * It is idempotent, so `pnpm dev` can run it on every boot.
 */

/**
 * The development accounts, by username.
 *
 * Under the stub the platform subject is `stub:<username>`, which the seed can write directly.
 * Under Keycloak the subject is the provider's user id, and Keycloak generates it at import: a
 * seeded `role_binding` keyed on anything else dangles, the portal renders an empty launcher, and
 * that reads as a regression rather than as a migration. The ids are therefore *resolved* from the
 * provider's Admin API once per run — the same authority that will mint them — instead of guessed
 * or pinned in the realm (Keycloak ignores a client-supplied user id on create).
 */
const DEV_USERNAMES = [
  'dev-admin',
  'dev-auditor',
  'dev-owner',
  'dev-product',
  'dev-user',
  'dev-guest',
] as const;

type DevUsername = (typeof DEV_USERNAMES)[number];

let SUBJECT_IDS: ReadonlyMap<string, string> | undefined;

/** The subject a development sign-in produces under the configured provider. */
function subjectId(username: DevUsername): string {
  const resolved = SUBJECT_IDS?.get(username);
  if (resolved === undefined) {
    throw new Error(`the subject for ${username} was not resolved; call resolveSubjectIds() first`);
  }
  return resolved;
}

async function resolveSubjectIds(): Promise<void> {
  if (process.env.AUTH_PROVIDER !== 'oidc') {
    SUBJECT_IDS = new Map(DEV_USERNAMES.map((username) => [username, `stub:${username}`]));
    return;
  }

  // The same two settings the API reads (`SEAMNEX_KEYCLOAK_ADMIN_URL` is the host-reachable admin
  // base; `SEAMNEX_KEYCLOAK_REALM` the realm). The bare names are the pre-Seamnex spelling and stay
  // as a fallback so an existing `.env` keeps working.
  const url =
    process.env.SEAMNEX_KEYCLOAK_ADMIN_URL ??
    process.env.KEYCLOAK_PUBLIC_URL ??
    'http://localhost:8082';
  const realm = process.env.SEAMNEX_KEYCLOAK_REALM ?? process.env.KEYCLOAK_REALM ?? 'seamnex';
  const adminUser = process.env.KEYCLOAK_ADMIN ?? 'admin';
  const adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';

  try {
    const tokenResponse = await fetch(`${url}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: adminUser,
        password: adminPassword,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok)
      throw new Error(`the bootstrap admin credential was refused (${tokenResponse.status})`);
    const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: string };
    if (typeof accessToken !== 'string')
      throw new Error('the token endpoint returned no access_token');

    const resolved = new Map<string, string>();
    for (const username of DEV_USERNAMES) {
      const response = await fetch(
        `${url}/admin/realms/${realm}/users?username=${encodeURIComponent(username)}&exact=true`,
        {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error(`reading ${username} answered ${response.status}`);
      const users = (await response.json()) as { id?: string }[];
      const id = users.find((user) => typeof user.id === 'string')?.id;
      if (id === undefined)
        throw new Error(`${username} is not in realm ${realm}; run pnpm kc:admin`);
      resolved.set(username, id);
    }
    SUBJECT_IDS = resolved;
  } catch (error) {
    // Falling back keeps a laptop without Keycloak seeding identically to the stub mode. The
    // warning is the point: a stack that says `oidc` and seeds `stub:` subjects will show an empty
    // portal, and silence would make that look like a product bug.
    console.warn(
      `could not resolve Keycloak subject ids (${String(error instanceof Error ? error.message : error)}); ` +
        'seeding stub subjects — sign-in against Keycloak will not match these bindings',
    );
    SUBJECT_IDS = new Map(DEV_USERNAMES.map((username) => [username, `stub:${username}`]));
  }
}

type DevRole = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

/**
 * The scope a seeded grant can resolve to.
 *
 * `platform` carries no id (the schema requires `NULL`); `domain` carries the domain key, which is
 * a catalogue string rather than a foreign key, so it is stable regardless of what the catalogue
 * projection currently holds.
 */
type DevScope = { type: 'platform'; id: null } | { type: 'domain'; id: string };

type DevSubject = {
  username: DevUsername;
  role: DevRole;
  /**
   * `null` when the role is instance-scoped.
   *
   * `R4` (product administrator) and `R6` (product guest) grant authority over one instance. The
   * seed creates no instances, so there is no row to scope such a grant to: writing one anyway
   * would leave a `role_binding.scope_id` that matches nothing and a grant the launcher can never
   * resolve. Those two roles are granted where their referent is created (on deployment); the
   * accounts themselves are still mirrored here so the directory and the group memberships stay
   * complete.
   */
  scope: DevScope | null;
  groups: readonly string[];
  mfa: boolean;
};

const DEV_SUBJECTS: readonly DevSubject[] = [
  {
    username: 'dev-admin',
    role: 'R1',
    scope: { type: 'platform', id: null },
    groups: ['/seamnex-admins'],
    mfa: true,
  },
  {
    username: 'dev-auditor',
    role: 'R2',
    scope: { type: 'platform', id: null },
    groups: ['/seamnex-auditors'],
    mfa: true,
  },
  {
    username: 'dev-owner',
    role: 'R3',
    /**
     * A **domain**, not a cluster. The PDP and FR-5.9 compare `role_binding.scope_id` with
     * `catalog_entry.domain`, whose values are the specific domains (`CRM & Sales Pipeline`);
     * "Revenue & Customer" is the cluster that groups D1-D4, so a binding to it resolved to no
     * product at all and the seeded domain owner could not author or read anything.
     */
    scope: { type: 'domain', id: 'CRM & Sales Pipeline' },
    groups: ['/seamnex-domain-owners', '/seamnex-domains/revenue-customer'],
    mfa: false,
  },
  {
    username: 'dev-product',
    role: 'R4',
    scope: null,
    groups: ['/seamnex-product-admins', '/seamnex-instances/core-crm'],
    mfa: false,
  },
  {
    username: 'dev-user',
    role: 'R5',
    scope: { type: 'platform', id: null },
    groups: ['/seamnex-users'],
    mfa: false,
  },
  {
    username: 'dev-guest',
    role: 'R6',
    scope: null,
    groups: ['/seamnex-guests', '/seamnex-instances/finance-suite'],
    mfa: false,
  },
];

/** The row id of a mirrored group: a slug derived from its path, so it is stable across runs. */
function groupId(path: string): string {
  return path.replace(/^\//, '').replace(/\//g, '-');
}

/**
 * Mirrors one group path, creating its ancestors first.
 *
 * `idp_group.parent_id` is a real foreign key and the console renders a nested group by walking
 * it, so a path like `/seamnex-domains/revenue-customer` is only coherent once `/seamnex-domains` exists.
 * The `done` set keeps a shared ancestor from being written once per child.
 */
async function seedGroupPath(client: PoolClient, path: string, done: Set<string>): Promise<void> {
  if (done.has(path)) return;
  const boundary = path.lastIndexOf('/');
  const parentPath = boundary > 0 ? path.slice(0, boundary) : null;
  if (parentPath !== null) await seedGroupPath(client, parentPath, done);

  // `idp_id` is derived from the path, so a row found under this key already owns this path; only
  // the parent link and the timestamp are refreshed, and re-parenting a hand-edited row cannot
  // collide with `idp_group_path_unique`.
  await client.query(
    `INSERT INTO idp_group (idp_id, path, parent_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (idp_id) DO UPDATE
       SET parent_id = EXCLUDED.parent_id, updated_at = now()`,
    [groupId(path), path, parentPath === null ? null : groupId(parentPath)],
  );
  done.add(path);
}

/**
 * Projects the catalogue checkout. It writes no file.
 *
 * Three outcomes, and each one is a decision rather than a shrug:
 *
 *   - **No checkout** — exit 0 with a sentence naming `catalog:sync`. A host that has never fetched
 *     a tag is a supported state (air-gapped installs place one by hand), and `pnpm dev` must still
 *     boot; failing here would make an empty catalogue look like a broken seed.
 *   - **A checkout that declares nothing** — fail. Silently projecting nothing is indistinguishable
 *     from a database nobody seeded, and that confusion once shipped a stack serving zero products.
 *   - **Documents** — insert what is parseable and report the rest per file. Rows are inserted only
 *     into an empty projection: an operator's catalogue is authoritative, and a seed that "topped
 *     up" would be a second author of the same rows.
 */
async function projectCatalog(client: PoolClient): Promise<void> {
  const root = catalogRepoRoot(process.env.SEAMNEX_CATALOG_REPO_PATH);
  const existing = await client.query<{ total: number }>(
    `SELECT count(*)::int AS total FROM catalog_entry`,
  );
  const total = existing.rows[0]?.total ?? 0;
  if (total > 0) {
    console.log(`catalog not projected: ${total} entries are already projected`);
    return;
  }

  const projection = planTreeProjection({ root });
  if (projection.kind === 'absent') {
    console.log(
      `catalog not projected: no checkout at ${root}. ` +
        'Run `pnpm catalog:sync --ref <tag>` (or place a catalogue tag there) and reload.',
    );
    return;
  }
  // Throws for a checkout that exists and declares nothing (AC-8).
  requireProjectableTree(projection);

  for (const item of projection.invalid) {
    console.warn(`catalog: ${item.path} skipped — ${item.reason}`);
  }

  let inserted = 0;
  for (const item of projection.documents) {
    const document = parseCatalogDocument(item.text, item.path);
    const columns = projectionColumns(document);
    const result = await client.query(
      `INSERT INTO catalog_entry (key, domain, product, cluster, packaging, guarantee_class, repo_url, license_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [
        columns.key,
        columns.domain,
        columns.product,
        columns.cluster,
        columns.packaging,
        columns.guaranteeClass,
        columns.repoUrl,
        columns.licenseId,
        JSON.stringify(document),
      ],
    );
    // `ON CONFLICT DO NOTHING` makes `rowCount` the number of rows this statement actually added.
    inserted += result.rowCount ?? 0;
    /*
     * A per-file `content-<16 hex>` label, which is the documented fallback for a tree with no `.git`
     * (`docs/operations/catalog-repo-format.md`). A fetched checkout *does* have one, so the first
     * reload reports these rows as updated — true, because they were seeded from a file rather than
     * read from that revision.
     */
    const contentHash = contentHashOf(item.text);
    await client.query(
      `INSERT INTO catalog_entry_revision (entry_key, git_sha, content_hash, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (entry_key, git_sha) DO NOTHING`,
      [columns.key, `content-${contentHash.slice(0, 16)}`, contentHash, JSON.stringify(document)],
    );
  }

  /*
   * Report the projection, not the writes, because there are no writes any more: "0 entries" has to
   * be visibly different from "0 documents".
   */
  console.log(
    `catalog: ${projection.documents.length} entries declared in ${root}, ${inserted} rows inserted into ` +
      `catalog_entry${projection.invalid.length === 0 ? '' : `, ${projection.invalid.length} file(s) skipped`}`,
  );
  /*
   * The declarations are files at this point, not rows: `env_schema_var` is M03's and is written by
   * `applySchemas` alone. Naming the next step here is what turns "the console shows 0" into a
   * self-explaining log, and `pnpm dev` runs it immediately after this process.
   */
  if (projection.declarations > 0) {
    console.log(
      'catalog declarations are not projected yet — run `pnpm catalog:project` (pnpm dev does this)',
    );
  }
}

async function main(): Promise<number> {
  loadRootEnv();
  // Before the transaction: the subject ids decide which rows the seed writes, and a provider call
  // inside an open transaction would hold it open for the length of an HTTP round trip.
  await resolveSubjectIds();

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    console.error('DATABASE_URL is required to seed development data.');
    return 1;
  }

  const pool = createPool({ connectionString, max: 2, applicationName: 'seamnex-seed' });

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      /*
       * Switching providers re-keys the same people: the stub's subject is `stub:<username>`, the
       * provider's is a UUID it generated. The old rows are development data, and leaving them
       * behind is not harmless — `idp_user_username_unique` would refuse the provider's row for the
       * same username, so the mirror would report an error per user on every cycle and the portal
       * would greet a UUID. Only the seed removes them: it is the only thing that knows both
       * spellings are the same person.
       *
       * Grants and entitlements keyed on a retired subject id are removed with it, otherwise the
       * remaining user records would reference a principal that no longer exists.
       */
      if (process.env.AUTH_PROVIDER === 'oidc') {
        await client.query(`DELETE FROM entitlement WHERE subject_idp_id LIKE 'stub:%'`);
        await client.query(`DELETE FROM role_binding WHERE subject_idp_id LIKE 'stub:%'`);
        await client.query(`DELETE FROM idp_user WHERE idp_id LIKE 'stub:%'`);
      }

      const seededGroups = new Set<string>();

      for (const subject of DEV_SUBJECTS) {
        const sub = subjectId(subject.username);

        await client.query(
          `INSERT INTO idp_user (idp_id, username, email, display_name, enabled, mfa_enrolled)
           VALUES ($1, $2, $3, $4, true, $5)
           ON CONFLICT (idp_id) DO UPDATE
             SET username = EXCLUDED.username,
                 email = EXCLUDED.email,
                 display_name = EXCLUDED.display_name,
                 mfa_enrolled = EXCLUDED.mfa_enrolled`,
          [
            sub,
            subject.username,
            `${subject.username}@seamnex.local`,
            subject.username,
            subject.mfa,
          ],
        );

        for (const path of subject.groups) {
          await seedGroupPath(client, path, seededGroups);
          /*
           * The membership mirror. Without this row the console's user list could not name the
           * groups a seeded account belongs to, even though the group tree above was seeded for
           * exactly that purpose; the first sync cycle reconciles it from the provider anyway.
           */
          await client.query(
            `INSERT INTO idp_group_member (group_idp_id, subject_idp_id)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [groupId(path), sub],
          );
        }

        // Instance-scoped roles have no referent in a user-only seed; see `DevSubject.scope`.
        if (subject.scope === null) continue;

        /*
         * A development grant may move scope between releases: R3 was seeded against the cluster
         * "Revenue & Customer", which matches no `catalog_entry.domain`, so the operator held no
         * authority at all. Keeping the old row would also keep a grant that resolves to nothing;
         * this block is the only place that knows the two spellings are the same person. Only the
         * six development subjects are touched, and only for the scope shape being reconciled.
         */
        await client.query(
          `DELETE FROM role_binding
            WHERE subject_idp_id = $1 AND role = $2 AND scope_type = $3
              AND scope_id IS DISTINCT FROM $4`,
          [sub, subject.role, subject.scope.type, subject.scope.id],
        );

        // A platform grant has a NULL scope_id, and NULL never conflicts in a unique index, so
        // `ON CONFLICT` would add a duplicate binding on every seed run. The NOT EXISTS guard makes
        // the row idempotent for both shapes.
        await client.query(
          `INSERT INTO role_binding (subject_idp_id, role, scope_type, scope_id, granted_by)
           SELECT $1, $2, $3, $4, 'seed'
            WHERE NOT EXISTS (
              SELECT 1 FROM role_binding
               WHERE subject_idp_id = $1 AND role = $2 AND scope_type = $3
                 AND scope_id IS NOT DISTINCT FROM $4)`,
          [sub, subject.role, subject.scope.type, subject.scope.id],
        );
      }

      await projectCatalog(client);

      await client.query('COMMIT');
      console.log(`development identity data seeded (${DEV_SUBJECTS.length} users)`);
      return 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await pool.end();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
