import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../app.module';
import type { AppConfig } from '../config/config';
import type { Logger } from '../common/logging/logger';
import { createLogger } from '../common/logging/logger';
import { pinoAdapter } from '../common/logging/nest-logger';
import type { RoleDefinition } from './role';
import { JobWorker } from '../jobs/job.worker';
import { SchedulerService } from '../jobs/scheduler.service';
import { SyncWorkerService } from '../modules/m08-identity-sync/sync-worker.service';
import { SamplerService } from '../modules/m06-status-health/sampler.service';
import { FORWARD_AUTH_SERVICE } from '../modules/m11-forward-auth/forward-auth.contract';
import { SIGN_IN_RELAY } from '../modules/m24-sign-in-relay/relay.contract';
import { WORKFLOW_EGRESS_SERVICE } from '../modules/m25-workflow-egress/egress.contract';
import { createForwardAuthApp, FORWARD_AUTH_PORT } from '../bootstrap/create-forward-auth-app';
import { createRelayApp } from '../bootstrap/create-relay-app';
import { createBrokerProxyApp } from '../bootstrap/create-broker-proxy-app';

export type RoleWork = { readonly close: () => Promise<void> };

/**
 * Non-HTTP roles share one module graph but start only the work they own. An idle role starts
 * nothing and says so: it exists in Phase 1 to prove the topology, and a fake worker would hide a
 * missing capability instead of exposing it.
 *
 * It does build the container, which means the pool, the Redis client and the queue exist. That is
 * deliberate — a role that could not reach a datastore must fail loudly at boot rather than look
 * healthy — but it is why the queue is closed through a lifecycle hook.
 */
export async function startRoleWork(
  config: AppConfig,
  definition: RoleDefinition,
  processLogger?: Logger,
): Promise<RoleWork> {
  const logger =
    processLogger ?? createLogger({ level: config.LOG_LEVEL, role: config.SEAMNEX_ROLE });

  const app: INestApplicationContext = await NestFactory.createApplicationContext(AppModule, {
    // The role lifecycle owns the exit code and the fatal log (see `run-role.ts`).
    abortOnError: false,
    logger: pinoAdapter(logger),
  });

  /*
   * Each stopper may be asynchronous. The forward-auth listener is the reason this is not
   * `(() => void)[]`: `gateway.close()` resolves only once in-flight decisions have drained, and
   * the first version fired it and returned, so `run-role`'s guarded `exit()` truncated them.
   */
  const stoppers: (() => Promise<void> | void)[] = [];

  if (definition.id === 'deploy-worker') {
    app.get(JobWorker).start();
  }

  if (definition.id === 'scheduler') {
    const scheduler = app.get(SchedulerService);
    scheduler.start();
    stoppers.push(() => scheduler.stop());
  }

  if (definition.id === 'sync-worker') {
    const sync = app.get(SyncWorkerService);
    sync.start();
    stoppers.push(() => sync.stop());
  }

  if (definition.id === 'status-sampler') {
    const sampler = app.get(SamplerService);
    sampler.start();
    stoppers.push(() => sampler.stop());
  }

  if (definition.id === 'auth-gateway') {
    const gateway = createForwardAuthApp(app.get(FORWARD_AUTH_SERVICE), config);
    await gateway.listen({ port: FORWARD_AUTH_PORT, host: config.HOST });
    stoppers.push(() => gateway.close());
    logger.info({ port: FORWARD_AUTH_PORT }, 'forward-auth listener started');
  }

  /*
   * ADR-BE-22. The relay role serves the same launch path with the sign-in step in it; the edge
   * chooses between the two by pointing `SEAMNEX_BOOTSTRAP_URL` at one of them. It is a separate
   * process because it holds credentials and makes outbound calls, and neither belongs on the
   * forward-auth hot path — the gateway answers every gated request.
   */
  /*
   * AD-10. The broker is the only role that calls a product on a workflow's behalf, and the only
   * one n8n can reach: the compiled nodes address this listener, so a workflow definition carries no
   * product host and no product credential.
   */
  if (definition.id === 'broker-proxy') {
    const broker = createBrokerProxyApp(app.get(WORKFLOW_EGRESS_SERVICE), config);
    await broker.listen({ port: config.SEAMNEX_BROKER_PORT, host: config.HOST });
    stoppers.push(() => broker.close());
    logger.info({ port: config.SEAMNEX_BROKER_PORT }, 'broker listener started');
  }

  if (definition.id === 'relay') {
    const relay = createRelayApp(app.get(FORWARD_AUTH_SERVICE), app.get(SIGN_IN_RELAY), config);
    await relay.listen({ port: config.SEAMNEX_RELAY_PORT, host: config.HOST });
    stoppers.push(() => relay.close());
    logger.info({ port: config.SEAMNEX_RELAY_PORT }, 'sign-in relay listener started');
  }

  return {
    close: async () => {
      for (const stop of stoppers) await stop();
      // Closing the context runs `onApplicationShutdown` on every provider and then shuts down the
      // pool and the Redis client.
      await app.close();
    },
  };
}
