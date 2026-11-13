/**
 * `pnpm catalog:project` — project `catalog/env/<KEY>.json` into `env_schema_var`.
 *
 * The development seed writes the declarations as *files*; `env_schema_var` is M03's table and is
 * written by `applySchemas` alone. Without this step a freshly seeded stack lists every product and
 * answers `[]` for `GET /catalog/:key/env-schema`, which the console renders as "0 variables" and
 * the deploy wizard as an empty environment — a projection gap that reads as an empty declaration.
 *
 * Deliberately a **bootstrap command, not a boot hook**:
 *   - the API loads nothing at boot (ADR-BE-21), and nine roles share one module graph, so an
 *     `OnModuleInit` would run this nine times against one database;
 *   - it needs no R1 session and no HTTP, so it cannot be modelled as `POST /catalog/reload` from
 *     inside the process;
 *   - it is idempotent by content hash, so `pnpm dev` can run it on every boot for free.
 *
 * Exit codes: `0` = projected, already current, or genuinely nothing declared; `1` = anything an
 * operator has to look at (absent tree while entries exist, an invalid file, a refused file, a
 * database or configuration error). Never `0` after projecting nothing when something was expected.
 */
import { NestFactory } from '@nestjs/core';
import type { Pool } from 'pg';
import { loadRootEnv } from '@seamnex/db';
import { StartupModule } from '../src/bootstrap/startup.module';
import {
  decideProjection,
  describeFailure,
  projectionReceipt,
} from '../src/bootstrap/catalog-projection';
import { APP_CONFIG } from '../src/config/config.module';
import type { AppConfig } from '../src/config/config';
import { PG_POOL } from '../src/database/database.module';
import {
  CATALOG_REPOSITORY,
  type CatalogRepositoryService,
} from '../src/modules/m22-catalog-repository/catalog-repo.contract';
import {
  RENDERER_SERVICE,
  type RendererService,
} from '../src/modules/m03-renderer/renderer.contract';

/**
 * The audit row says `system`, not `user`: no session exists, and `audit_event.actor_type` already
 * distinguishes the two. The id matches the `granted_by = 'seed'` rows the development seed writes,
 * so one search finds everything a bootstrap step of that run wrote.
 */
const ACTOR_ID = 'seed';
const ACTOR_TYPE = 'system';

function log(line: string): void {
  console.log(`[catalog] ${line}`);
}

async function project(): Promise<number> {
  loadRootEnv();

  const app = await NestFactory.createApplicationContext(StartupModule, {
    // A bootstrap step reports its own summary; Nest's startup banner would bury it.
    logger: false,
    abortOnError: false,
  });

  try {
    const config = app.get<AppConfig>(APP_CONFIG);
    const root = config.SEAMNEX_CATALOG_REPO_PATH;
    log(`root ${root}`);

    const repository = app.get<CatalogRepositoryService>(CATALOG_REPOSITORY);
    const renderer = app.get<RendererService>(RENDERER_SERVICE);
    const pool = app.get<Pool>(PG_POOL);

    /*
     * One count, read here rather than through M01: the only question is "is a tree expected?", and
     * a bootstrap script sits outside the module graph the boundary test governs. `applySchemas`
     * reads `catalog_entry` for the same reason — it must not apply a declaration for a product that
     * nothing has projected.
     */
    const projected = await pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM catalog_entry`,
    );

    const tree = await repository.load();
    const decision = decideProjection({
      root,
      tree,
      projectedEntries: projected.rows[0]?.total ?? 0,
    });

    for (const line of decision.lines) log(line);
    if (!decision.apply) return decision.code;

    const result = await renderer.applySchemas({
      schemas: tree.envSchemas,
      revision: tree.revision,
      actorId: ACTOR_ID,
      actorType: ACTOR_TYPE,
    });

    const receipt = projectionReceipt(result);
    for (const line of receipt.lines) log(line);
    return receipt.code;
  } finally {
    await app.close();
  }
}

void project().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // One actionable line, not a stack: every failure here is either "the tree is wrong" or "the
    // database is unreachable", and both are operator problems, not programming errors.
    console.error(`[catalog] ${describeFailure(error)}`);
    process.exitCode = 1;
  },
);
