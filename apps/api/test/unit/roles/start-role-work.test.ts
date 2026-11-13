import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config';
import type { RoleDefinition } from '../../../src/roles/role';

/**
 * One module graph, one role per process. What differs per role is which work is started and — the
 * defect this file exists for — that each stopper is awaited: the forward-auth listener resolves
 * `close()` only once in-flight decisions have drained, and firing it without awaiting truncated
 * them at shutdown.
 */
const gatewayListen = vi.fn().mockResolvedValue(undefined);
const gatewayClose = vi.fn().mockResolvedValue(undefined);
const createForwardAuthApp = vi.fn(() => ({ listen: gatewayListen, close: gatewayClose }));

const relayListen = vi.fn().mockResolvedValue(undefined);
const relayClose = vi.fn().mockResolvedValue(undefined);
const createRelayApp = vi.fn(() => ({ listen: relayListen, close: relayClose }));

const brokerListen = vi.fn().mockResolvedValue(undefined);
const brokerClose = vi.fn().mockResolvedValue(undefined);
const createBrokerProxyApp = vi.fn(() => ({ listen: brokerListen, close: brokerClose }));

const appClose = vi.fn().mockResolvedValue(undefined);
const appGet = vi.fn();
const createApplicationContext = vi.fn(async (_module: unknown, _options: { logger: unknown }) => ({
  get: appGet,
  close: appClose,
}));

vi.mock('@nestjs/core', () => ({ NestFactory: { createApplicationContext } }));
vi.mock('../../../src/bootstrap/create-forward-auth-app', () => ({
  createForwardAuthApp,
  FORWARD_AUTH_PORT: 4_189,
}));
vi.mock('../../../src/bootstrap/create-relay-app', () => ({ createRelayApp }));
vi.mock('../../../src/bootstrap/create-broker-proxy-app', () => ({ createBrokerProxyApp }));
vi.mock('../../../src/app.module', () => ({ AppModule: class AppModule {} }));

const { startRoleWork } = await import('../../../src/roles/start-role-work');
const { JobWorker } = await import('../../../src/jobs/job.worker');
const { SchedulerService } = await import('../../../src/jobs/scheduler.service');
const { SyncWorkerService } =
  await import('../../../src/modules/m08-identity-sync/sync-worker.service');
const { SamplerService } = await import('../../../src/modules/m06-status-health/sampler.service');
const { FORWARD_AUTH_SERVICE } =
  await import('../../../src/modules/m11-forward-auth/forward-auth.contract');
const { SIGN_IN_RELAY } = await import('../../../src/modules/m24-sign-in-relay/relay.contract');
const { WORKFLOW_EGRESS_SERVICE } =
  await import('../../../src/modules/m25-workflow-egress/egress.contract');

const CONFIG = {
  LOG_LEVEL: 'info',
  SEAMNEX_ROLE: 'api',
  HOST: '0.0.0.0',
  SEAMNEX_RELAY_PORT: 8_191,
  SEAMNEX_BROKER_PORT: 8_192,
} as unknown as AppConfig;

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function role(id: RoleDefinition['id']): RoleDefinition {
  return { id, kind: 'worker', implemented: true, phase: '1', description: 'test' };
}

const jobWorker = { start: vi.fn() };
const scheduler = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
const sync = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
const sampler = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
const forwardAuth = { decide: vi.fn() };
const signInRelay = { attempt: vi.fn(), invalidate: vi.fn() };
const workflowEgress = { forward: vi.fn(), discoverFields: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  appGet.mockImplementation((token: unknown) => {
    if (token === JobWorker) return jobWorker;
    if (token === SchedulerService) return scheduler;
    if (token === SyncWorkerService) return sync;
    if (token === SamplerService) return sampler;
    if (token === FORWARD_AUTH_SERVICE) return forwardAuth;
    if (token === SIGN_IN_RELAY) return signInRelay;
    if (token === WORKFLOW_EGRESS_SERVICE) return workflowEgress;
    throw new Error(`unexpected provider ${String(token)}`);
  });
});

describe('startRoleWork', () => {
  it('builds the container with the role logger and starts a deploy worker', async () => {
    const work = await startRoleWork(CONFIG, role('deploy-worker'), logger as never);
    await work.close();

    expect(createApplicationContext).toHaveBeenCalledOnce();
    expect(jobWorker.start).toHaveBeenCalledOnce();
    expect(appClose).toHaveBeenCalledOnce();
    // A worker owns no stopper of its own: the queue is drained by the application lifecycle hook.
    expect(scheduler.stop).not.toHaveBeenCalled();
  });

  it('starts the scheduler and stops it before the container closes', async () => {
    const work = await startRoleWork(CONFIG, role('scheduler'), logger as never);

    expect(scheduler.start).toHaveBeenCalledOnce();
    expect(appClose).not.toHaveBeenCalled();

    await work.close();

    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(appClose).toHaveBeenCalledOnce();
  });

  it('starts and stops the identity sync worker', async () => {
    const work = await startRoleWork(CONFIG, role('sync-worker'), logger as never);
    expect(sync.start).toHaveBeenCalledOnce();
    await work.close();
    expect(sync.stop).toHaveBeenCalledOnce();
  });

  it('starts and stops the status sampler', async () => {
    const work = await startRoleWork(CONFIG, role('status-sampler'), logger as never);
    expect(sampler.start).toHaveBeenCalledOnce();
    await work.close();
    expect(sampler.stop).toHaveBeenCalledOnce();
  });

  it('serves forward-auth decisions on the declared port and drains before closing', async () => {
    const work = await startRoleWork(CONFIG, role('auth-gateway'), logger as never);

    expect(createForwardAuthApp).toHaveBeenCalledWith(forwardAuth, CONFIG);
    expect(gatewayListen).toHaveBeenCalledWith({ port: 4_189, host: '0.0.0.0' });
    expect(logger.info).toHaveBeenCalled();

    await work.close();
    expect(gatewayClose).toHaveBeenCalledOnce();
  });

  it('serves the launch relay on its own port and drains before closing', async () => {
    const work = await startRoleWork(CONFIG, role('relay'), logger as never);

    expect(createRelayApp).toHaveBeenCalledWith(forwardAuth, signInRelay, CONFIG);
    expect(relayListen).toHaveBeenCalledWith({ port: 8_191, host: '0.0.0.0' });

    await work.close();
    expect(relayClose).toHaveBeenCalledOnce();
    expect(gatewayClose).not.toHaveBeenCalled();
  });

  /*
   * AD-10. The broker is the only listener n8n can reach, and it is handed the egress service rather
   * than the container: a workflow call must not be able to resolve any other provider.
   */
  it('serves the workflow broker on its own port and drains before closing', async () => {
    const work = await startRoleWork(CONFIG, role('broker-proxy'), logger as never);

    expect(createBrokerProxyApp).toHaveBeenCalledWith(workflowEgress, CONFIG);
    expect(brokerListen).toHaveBeenCalledWith({ port: 8_192, host: '0.0.0.0' });
    expect(logger.info).toHaveBeenCalled();

    await work.close();
    expect(brokerClose).toHaveBeenCalledOnce();
    expect(gatewayClose).not.toHaveBeenCalled();
    expect(relayClose).not.toHaveBeenCalled();
  });

  it('starts nothing for a role that owns no work and still builds the container', async () => {
    const work = await startRoleWork(CONFIG, role('api'), logger as never);
    await work.close();

    expect(appGet).not.toHaveBeenCalled();
    expect(appClose).toHaveBeenCalledOnce();
  });

  it('creates a logger when the caller supplies none', async () => {
    await startRoleWork(CONFIG, role('api'));
    const options = createApplicationContext.mock.calls.at(-1)?.[1] as { logger: unknown };
    expect(options.logger).toBeDefined();
  });

  it('awaits an asynchronous stopper so in-flight work is not truncated', async () => {
    let drained = false;
    scheduler.stop.mockImplementation(async () => {
      await Promise.resolve();
      drained = true;
    });

    const work = await startRoleWork(CONFIG, role('scheduler'), logger as never);
    await work.close();

    expect(drained).toBe(true);
    expect(appClose).toHaveBeenCalledOnce();
  });
});
