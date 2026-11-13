import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { DockerEngineClient } from '../../../../src/common/docker/docker.client';

/**
 * The daemon's status mapping decides whether a job treats an answer as a no-op or as a failure.
 * The main suite pins the well-formed codes; these pin the answers that carry no usable code at
 * all — a transport error, a non-object rejection, a stringly-typed status from a proxy — which
 * must all read as a failure, never as "already gone" or "already stopped".
 */
const h = vi.hoisted(() => {
  const network = () => ({
    inspect: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    remove: vi.fn(),
  });
  const container = () => ({
    inspect: vi.fn(),
    logs: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    remove: vi.fn(),
  });
  return {
    network: network(),
    container: container(),
    volume: { remove: vi.fn() },
    ping: vi.fn(),
    createNetwork: vi.fn(),
    createVolume: vi.fn(),
    listContainers: vi.fn(),
    getNetwork: vi.fn(),
    getContainer: vi.fn(),
    getVolume: vi.fn(),
    getImage: vi.fn(),
    image: { inspect: vi.fn() },
    pull: vi.fn(),
    followProgress: vi.fn(),
  };
});

vi.mock('dockerode', () => ({
  default: class Docker {
    readonly modem = {
      followProgress: (...args: unknown[]) => h.followProgress(...args),
    };
    ping = () => h.ping();
    createNetwork = (...args: unknown[]) => h.createNetwork(...args);
    createVolume = (...args: unknown[]) => h.createVolume(...args);
    listContainers = (...args: unknown[]) => h.listContainers(...args);
    getNetwork = (...args: unknown[]) => h.getNetwork(...args);
    getContainer = (...args: unknown[]) => h.getContainer(...args);
    getVolume = (...args: unknown[]) => h.getVolume(...args);
    getImage = (...args: unknown[]) => h.getImage(...args);
    pull = (...args: unknown[]) => h.pull(...args);
  },
}));

vi.mock('../../../../src/common/exec/exec', () => ({
  run: vi.fn(),
  runOrThrow: vi.fn(),
  spawnProcess: vi.fn(),
}));

function makeClient(overrides: Record<string, unknown> = {}): DockerEngineClient {
  const config = {
    SEAMNEX_ADAPTERS_MODE: 'real',
    SEAMNEX_DOCKER_HOST: 'unix:///var/run/docker.sock',
    SEAMNEX_DOCKER_TIMEOUT_MS: 30_000,
    ...overrides,
  } as unknown as AppConfig;
  return new DockerEngineClient(config);
}

beforeEach(() => {
  h.getNetwork.mockReturnValue(h.network);
  h.getContainer.mockReturnValue(h.container);
  h.getImage.mockReturnValue(h.image);
  h.getVolume.mockReturnValue(h.volume);
  h.network.remove.mockResolvedValue(undefined);
  h.volume.remove.mockResolvedValue(undefined);
  h.container.stop.mockResolvedValue(undefined);
  h.container.remove.mockResolvedValue(undefined);
});

describe('status mapping for answers that carry no usable code', () => {
  it('propagates a transport failure on a volume delete instead of reporting success', async () => {
    // No `statusCode` at all: a socket that died mid-request is not "already removed", and a
    // swallowed failure here would leave a volume behind on the rollback path.
    const failure = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    h.volume.remove.mockRejectedValueOnce(failure);

    await expect(makeClient().removeVolume('seamnex-shop-data')).rejects.toThrow('socket hang up');
  });

  it('treats a non-object rejection as a failure', async () => {
    h.container.remove.mockRejectedValueOnce('ECONNRESET');

    await expect(makeClient().removeContainer('c1')).rejects.toBe('ECONNRESET');
  });

  it('does not read a stringly-typed 304 as an already-stopped container', async () => {
    // A proxy can answer with a string code; accepting it would silence a real engine error.
    h.container.stop.mockRejectedValueOnce({ statusCode: '304' });

    await expect(makeClient().stop('c1', 5)).rejects.toMatchObject({ statusCode: '304' });
  });

  it('does not read a missing status as an already-started container', async () => {
    h.container.start.mockRejectedValueOnce(new Error('cannot connect to the Docker daemon'));

    await expect(makeClient().start('c1')).rejects.toThrow('cannot connect to the Docker daemon');
  });
});

describe('an inspect answer without a Containers map', () => {
  it('lists no endpoints for a network the daemon describes without attachments', async () => {
    // A daemon that returns `{}` has no endpoints; reading `.Containers.Keys` would crash the
    // delete path instead of detaching nothing.
    h.network.inspect.mockResolvedValue({ Name: 'seamnex-shop' });

    await expect(makeClient().networkEndpoints('seamnex-shop')).resolves.toEqual([]);
  });

  it('gives up on the alias re-attach when the attachment cannot be located', async () => {
    h.network.connect.mockRejectedValueOnce(
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
    );
    h.network.inspect.mockResolvedValue({ Name: 'seamnex-shop' });

    await makeClient().connectNetwork('seamnex-shop', 'container-1', ['keycloak']);

    expect(h.network.disconnect).not.toHaveBeenCalled();
    expect(h.network.connect).toHaveBeenCalledOnce();
  });
});
