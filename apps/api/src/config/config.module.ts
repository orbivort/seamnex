import { Global, Module } from '@nestjs/common';
import { loadConfig, type AppConfig } from './config';

export const APP_CONFIG = Symbol('seamnex.config');

/**
 * The configuration this process actually started with.
 *
 * `runRole` parses the environment once, with `SEAMNEX_ROLE` overridden for the role it was asked to
 * host, and hands the result to `createApplication`. The module factory used to call `loadConfig()`
 * a second time against the untouched `process.env`, so every provider that injected `APP_CONFIG`
 * saw `SEAMNEX_ROLE: 'api'` — the schema default — in eight of the nine roles. The metric label, the
 * Postgres `applicationName`, the readiness body and the audit `actorId` all named the wrong role.
 *
 * The holder keeps one parsed object per process: the role lifecycle publishes it before the
 * container exists, and the factory re-parses only when nothing was published (tests, scripts).
 */
let loaded: AppConfig | undefined;

/** Publishes the already-validated configuration. Called once, before the container is created. */
export function setLoadedConfig(config: AppConfig | undefined): void {
  loaded = config;
}

/**
 * The `APP_CONFIG` factory, exported so a test can observe that the published object is reused
 * rather than re-parsed.
 */
export function appConfigFactory(): AppConfig {
  return loaded ?? loadConfig();
}

/**
 * One parsed configuration object for the whole process graph. `loadConfig` throws on an invalid
 * environment, so an invalid deployment fails at boot rather than at the first request.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: appConfigFactory,
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
