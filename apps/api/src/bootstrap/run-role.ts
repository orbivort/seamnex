import { loadRootEnv } from '@seamnex/db/env';
import { createApplication } from './create-app';
import {
  ConfigError,
  ROLE_IDS,
  loadConfig,
  describeConfig,
  type AppConfig,
  type RoleId,
} from '../config/config';
import { createLogger } from '../common/logging/logger';
import { roleDefinition } from '../roles/registry';
import { startRoleWork } from '../roles/start-role-work';
import { setLoadedConfig } from '../config/config.module';
import { relayConfigurationWarnings } from '../modules/m24-sign-in-relay/relay-config';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The roles that own a piece of the relay: it serves the hop, runs the provisioning sweep, or is the
 * role an operator would otherwise inspect. Said once per process, never per request.
 */
const RELAY_ROLES: ReadonlySet<RoleId> = new Set<RoleId>(['relay', 'scheduler', 'auth-gateway']);

/**
 * One lifecycle for all nine entrypoints: parse configuration for *this* role, start the unit,
 * register signal handlers, drain, exit.
 *
 * Exit codes: 0 clean shutdown, 1 boot failure, 2 shutdown that could not drain in time.
 *
 * The whole body has to be able to *fail*, including configuration parsing. The first version
 * parsed the environment before the `try` and before the logger existed, so a bad `DATABASE_URL`
 * became an unhandled promise rejection with a raw stack trace and no exit code — the opposite of
 * "fail fast" (practice 2.6/2.11).
 */
export async function runRole(role: RoleId): Promise<void> {
  let config: AppConfig;
  try {
    /**
     * The repository-root `.env` is read before the environment is validated, so `pnpm dev:api`
     * and `pnpm start` behave like `pnpm dev` instead of failing on a `DATABASE_URL` that only the
     * dev orchestrator used to inject. Node's loader never overwrites an existing variable, so an
     * exported value — and a container's environment — stays authoritative, and a missing file is
     * not an error.
     */
    loadRootEnv();
    config = loadConfig({ ...process.env, SEAMNEX_ROLE: role });
  } catch (error) {
    // The logger cannot be built from a config that failed validation, so this is the one place
    // that reads the environment directly — with a validated level, and the issues, never the
    // values.
    const logger = createLogger({ level: bootLevel(), role });
    logger.fatal(
      {
        // `role` is already a base binding on this logger; repeating it duplicates the field.
        issues: error instanceof ConfigError ? error.issues : undefined,
        err: error instanceof Error ? error.message : String(error),
      },
      'invalid configuration; refusing to start',
    );
    exit(1);
  }

  /*
   * Publish the role-specific parse before the container exists. `ConfigModule`'s factory would
   * otherwise re-parse `process.env`, where `SEAMNEX_ROLE` is still unset and therefore defaults to
   * `api` — which is how every worker reported the wrong role in metrics, `applicationName` and
   * audit attribution.
   */
  setLoadedConfig(config);

  const definition = roleDefinition(role);
  const logger = createLogger({ level: config.LOG_LEVEL, role });

  logger.info(describeConfig(config), `role ${role} starting`);

  /*
   * ADR-BE-22: the relay has three switches, and a wrong combination looks like "no relay here" —
   * the launch still mints a ticket and the product simply asks for a password. Say it at boot, in
   * the roles that own the work, instead of leaving it to be discovered from a browser.
   */
  if (RELAY_ROLES.has(role)) {
    for (const warning of relayConfigurationWarnings(config)) {
      logger.warn({ role }, `relay configuration: ${warning}`);
    }
  }

  let close: (() => Promise<void>) | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string, code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested');

    // An unref'd guard: a drain that hangs is killed instead of holding the container open.
    const timer = setTimeout(() => {
      logger.error('shutdown timed out; exiting with code 2');
      exit(2);
    }, 20_000);
    timer.unref();

    try {
      await close?.();
      logger.info('shutdown complete');
      exit(code);
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'shutdown failed',
      );
      exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

  // Practice 2.14: a rejected promise that nothing awaits used to be Node's default dump. It is a
  // process-level failure, so it is logged and the process leaves with a non-zero code.
  process.on('unhandledRejection', (reason) => {
    logger.fatal(
      { err: reason instanceof Error ? reason.stack : String(reason) },
      'unhandled promise rejection',
    );
    exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error.stack ?? error.message }, 'uncaught exception');
    exit(1);
  });

  try {
    if (definition.kind === 'http') {
      const app = await createApplication(config, logger);
      await app.listen({ port: config.PORT, host: config.HOST });
      logger.info(
        { port: config.PORT, host: config.HOST },
        `listening on http://${config.HOST}:${config.PORT}/api/v1`,
      );
      close = async () => {
        await app.close();
      };
    } else {
      const work = await startRoleWork(config, definition, logger);
      close = work.close;
    }

    if (!definition.implemented) {
      logger.warn(
        { role, phase: definition.phase },
        `role.idle: ${role} boots for topology parity only; its capability arrives in Phase ${definition.phase}`,
      );
    }
  } catch (error) {
    logger.fatal(
      { err: error instanceof Error ? error.stack : String(error), role },
      'role failed to start',
    );
    await close?.().catch(() => undefined);
    exit(1);
  }
}

/**
 * `start:role` — the generic entrypoint a supervisor points at, with the role taken from the
 * environment. `loadConfig()` used to be called by the entrypoint itself to read `SEAMNEX_ROLE`, which
 * put configuration parsing back outside the lifecycle's guard: an invalid environment produced an
 * unhandled rejection instead of a fatal line and exit code 1.
 */
export async function runRoleFromEnvironment(): Promise<void> {
  const requested = process.env.SEAMNEX_ROLE ?? 'api';
  if (!ROLE_IDS.includes(requested as RoleId)) {
    const logger = createLogger({ level: bootLevel(), role: 'api' });
    logger.fatal(
      { requestedRole: requested, knownRoles: ROLE_IDS },
      'unknown SEAMNEX_ROLE; refusing to start',
    );
    exit(1);
  }
  await runRole(requested as RoleId);
}

function bootLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return LOG_LEVELS.includes(raw as LogLevel) ? (raw as LogLevel) : 'info';
}

/**
 * pino's default destination writes synchronously to fd 1, so an explicit exit cannot truncate the
 * last line. Relying on the event loop to drain was the bug: any handle that survives `close()` —
 * an unclosed queue, a subscriber — meant the process never left, and the 20 s guard had already
 * been cleared.
 */
function exit(code: number): never {
  // eslint-disable-next-line n/no-process-exit -- a service must leave with the documented code
  process.exit(code);
}
