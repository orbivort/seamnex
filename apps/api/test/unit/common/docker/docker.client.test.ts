import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { run, runOrThrow, spawnProcess } from '../../../../src/common/exec/exec';
import {
  demultiplex,
  DockerEngineClient,
  type ComposeProject,
} from '../../../../src/common/docker/docker.client';
import type { ImageTrustGuard } from '../../../../src/common/security/trusted-registries';

/**
 * `DockerEngineClient` is the only path from the control plane to the host kernel, and most of its
 * behaviour is in how it treats the daemon's answers: `304` is "already started", `404` on a delete
 * is success, `403` on a network attach is "already attached". Those mappings are asserted one by
 * one, because a mistake in either direction is either a job that fails on a no-op or a delete that
 * reports success while it did nothing.
 */
const h = vi.hoisted(() => {
  const options: unknown[] = [];
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
    stats: vi.fn(),
  });
  return {
    options,
    network: network(),
    container: container(),
    volume: { inspect: vi.fn(), remove: vi.fn() },
    ping: vi.fn(),
    createNetwork: vi.fn(),
    createVolume: vi.fn(),
    listVolumes: vi.fn(),
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
    constructor(options: unknown) {
      h.options.push(options);
    }
    ping = () => h.ping();
    createNetwork = (...args: unknown[]) => h.createNetwork(...args);
    createVolume = (...args: unknown[]) => h.createVolume(...args);
    listVolumes = (...args: unknown[]) => h.listVolumes(...args);
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

const runOrThrowMock = vi.mocked(runOrThrow);
const runMock = vi.mocked(run);
const spawnMock = vi.mocked(spawnProcess);

function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    SEAMNEX_ADAPTERS_MODE: 'real',
    SEAMNEX_DOCKER_HOST: 'unix:///var/run/docker.sock',
    SEAMNEX_DOCKER_TIMEOUT_MS: 30_000,
    ...overrides,
  } as unknown as AppConfig;
}

/**
 * NFR-4.16 — the guard the client refuses to work without.
 *
 * A permissive stub is enough for the pull/build/compose cases, which are about argv and error
 * mapping. The refusal itself has its own case (`refuses a pull the guard rejects`).
 */
function makeGuard(
  assertTrusted: (reference: string, operation: string) => Promise<void> = async () => undefined,
): ImageTrustGuard {
  return { assertTrusted: vi.fn(assertTrusted) };
}

function makeClient(
  overrides: Record<string, unknown> = {},
  guard: ImageTrustGuard = makeGuard(),
): DockerEngineClient {
  return new DockerEngineClient(makeConfig(overrides), guard);
}

/** A daemon error in the shape dockerode rejects with. */
function statusError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`engine said ${statusCode}`), { statusCode });
}

/**
 * The project has to exist on disk: `composeUp` re-reads every `image:` before starting anything
 * (NFR-4.16), so a fixture with imaginary paths would test the guard's failure path instead of the
 * argv it is meant to assert.
 */
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'seamnex-compose-'));
writeFileSync(
  join(PROJECT_DIR, 'compose.yaml'),
  'services:\n  app:\n    image: shop:1.2\n',
  'utf8',
);
writeFileSync(join(PROJECT_DIR, 'override.yaml'), 'services: {}\n', 'utf8');
writeFileSync(join(PROJECT_DIR, '.env'), 'APP_ENV=production\n', 'utf8');

const PROJECT: ComposeProject = {
  project: 'seamnex-shop',
  directory: PROJECT_DIR,
  files: [join(PROJECT_DIR, 'compose.yaml'), join(PROJECT_DIR, 'override.yaml')],
  envFiles: [join(PROJECT_DIR, '.env')],
};

beforeEach(() => {
  h.options.length = 0;
  // The build-endpoint cases assert on the *absence* of a `buildx` call, so history cannot leak in
  // from the case before it.
  runMock.mockReset();
  h.getNetwork.mockReturnValue(h.network);
  h.getContainer.mockReturnValue(h.container);
  h.getImage.mockReturnValue(h.image);
  h.getVolume.mockReturnValue(h.volume);
  h.network.inspect.mockResolvedValue({ Containers: {} });
  h.container.start.mockResolvedValue(undefined);
  h.container.stop.mockResolvedValue(undefined);
  h.container.restart.mockResolvedValue(undefined);
  h.container.remove.mockResolvedValue(undefined);
  h.network.connect.mockResolvedValue(undefined);
  h.network.disconnect.mockResolvedValue(undefined);
  h.network.remove.mockResolvedValue(undefined);
  h.volume.inspect.mockResolvedValue({ Name: 'v' });
  h.volume.remove.mockResolvedValue(undefined);
  h.createNetwork.mockResolvedValue(undefined);
  h.createVolume.mockResolvedValue(undefined);
  h.listVolumes.mockResolvedValue({ Volumes: [] });
  h.listContainers.mockResolvedValue([]);
  runOrThrowMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', truncated: false });
});

describe('connection setup', () => {
  it('uses the unix socket path when the host is a unix URL', () => {
    makeClient();
    expect(h.options[0]).toEqual({ socketPath: '/var/run/docker.sock', timeout: 30_000 });
  });

  it('parses a tcp host with an explicit port', () => {
    makeClient({ SEAMNEX_DOCKER_HOST: 'tcp://docker-proxy:2376' });
    expect(h.options[0]).toEqual({
      host: 'docker-proxy',
      port: 2376,
      protocol: 'http',
      timeout: 30_000,
    });
  });

  it('defaults the port to 2375 and the protocol to http', () => {
    makeClient({ SEAMNEX_DOCKER_HOST: 'docker-proxy' });
    expect(h.options[0]).toMatchObject({ host: 'docker-proxy', port: 2375, protocol: 'http' });
  });

  it('uses https when the URL says so', () => {
    makeClient({ SEAMNEX_DOCKER_HOST: 'https://docker.example.test' });
    expect(h.options[0]).toMatchObject({ protocol: 'https', port: 2375 });
  });
});

describe('guard', () => {
  it('refuses every call when the docker adapter is switched off', async () => {
    const client = makeClient({ SEAMNEX_ADAPTERS_MODE: 'disabled' });
    await expect(client.ping()).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    await expect(client.containers(['seamnex.instance=shop'])).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
    });
  });

  it('refuses when DOCKER_HOST is empty', async () => {
    const client = makeClient({ SEAMNEX_DOCKER_HOST: '' });
    await expect(client.ping()).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
  });
});

describe('ping', () => {
  it('resolves when the daemon answers', async () => {
    h.ping.mockResolvedValue(undefined);
    await expect(makeClient().ping()).resolves.toBeUndefined();
    expect(h.ping).toHaveBeenCalledOnce();
  });

  it('translates a daemon failure into ADAPTER_UNAVAILABLE with remediation', async () => {
    h.ping.mockRejectedValue(new Error('socket hang up'));

    const failure = await makeClient()
      .ping()
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('socket hang up'),
      remediation: expect.stringContaining('DOCKER_HOST'),
    });
  });

  it('stringifies a non-Error failure', async () => {
    h.ping.mockRejectedValue('ECONNREFUSED');
    await expect(makeClient().ping()).rejects.toMatchObject({
      detail: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('proves availability by pinging', async () => {
    h.ping.mockResolvedValue(undefined);
    await expect(makeClient().assertAvailable()).resolves.toBeUndefined();
    expect(h.ping).toHaveBeenCalledOnce();
  });
});

describe('networks', () => {
  it('does not create a network that already exists', async () => {
    h.network.inspect.mockResolvedValue({ Id: 'net-1' });
    await makeClient().ensureNetwork('seamnex-shop');
    expect(h.createNetwork).not.toHaveBeenCalled();
  });

  it('creates a missing network with the managed label and the caller labels', async () => {
    h.network.inspect.mockRejectedValue(statusError(404));
    await makeClient().ensureNetwork('seamnex-shop', { 'seamnex.instance': 'shop' });

    expect(h.createNetwork).toHaveBeenCalledWith({
      Name: 'seamnex-shop',
      Driver: 'bridge',
      Labels: { 'seamnex.managed': 'true', 'seamnex.instance': 'shop' },
      CheckDuplicate: true,
    });
  });

  it('attaches a container with its aliases', async () => {
    await makeClient().connectNetwork('seamnex-shop', 'container-1', ['keycloak']);

    expect(h.network.connect).toHaveBeenCalledWith({
      Container: 'container-1',
      EndpointConfig: { Aliases: ['keycloak'] },
    });
    expect(h.network.inspect).not.toHaveBeenCalled();
  });

  it('omits EndpointConfig when there is no alias', async () => {
    await makeClient().connectNetwork('seamnex-shop', 'container-1');
    expect(h.network.connect).toHaveBeenCalledWith({ Container: 'container-1' });
  });

  it('treats 403 as already attached and does nothing more', async () => {
    h.network.connect.mockRejectedValue(statusError(403));
    await makeClient().connectNetwork('seamnex-shop', 'container-1');
    expect(h.network.inspect).not.toHaveBeenCalled();
  });

  it('re-creates an attachment that is missing the requested alias', async () => {
    // Docker cannot add an alias to an existing attachment, and without it the product cannot
    // resolve its identity provider.
    h.network.connect.mockRejectedValueOnce(statusError(403)).mockResolvedValueOnce(undefined);
    h.network.inspect.mockResolvedValue({ Containers: { 'container-1': { Name: 'container-1' } } });

    await makeClient().connectNetwork('seamnex-shop', 'container-1', ['keycloak']);

    expect(h.network.disconnect).toHaveBeenCalledWith({ Container: 'container-1', Force: true });
    expect(h.network.connect).toHaveBeenCalledTimes(2);
  });

  it('gives up when the attachment is not in the network after all', async () => {
    h.network.connect.mockRejectedValue(statusError(403));
    h.network.inspect.mockResolvedValue({ Containers: {} });

    await makeClient().connectNetwork('seamnex-shop', 'container-1', ['keycloak']);

    expect(h.network.disconnect).not.toHaveBeenCalled();
  });

  it('propagates an attach failure that is not a conflict', async () => {
    h.network.connect.mockRejectedValue(statusError(500));
    await expect(makeClient().connectNetwork('seamnex-shop', 'container-1')).rejects.toThrow(
      'engine said 500',
    );
  });

  it('disconnects with force', async () => {
    await makeClient().disconnectNetwork('seamnex-shop', 'container-1');
    expect(h.network.disconnect).toHaveBeenCalledWith({ Container: 'container-1', Force: true });
  });

  it('lists the containers attached to a network, naming them by id slice when unnamed', async () => {
    h.network.inspect.mockResolvedValue({
      Containers: {
        abcdef1234567890: { Name: 'edge' },
        ffffffffffffffff: {},
      },
    });

    await expect(makeClient().networkEndpoints('seamnex-shop')).resolves.toEqual([
      { id: 'abcdef1234567890', name: 'edge' },
      { id: 'ffffffffffffffff', name: 'ffffffffffff' },
    ]);
  });

  it('reports no endpoints for a network that is already gone', async () => {
    h.network.inspect.mockRejectedValue(statusError(404));
    await expect(makeClient().networkEndpoints('seamnex-shop')).resolves.toEqual([]);
  });

  it('propagates an inspection failure that is not a 404', async () => {
    h.network.inspect.mockRejectedValue(statusError(500));
    await expect(makeClient().networkEndpoints('seamnex-shop')).rejects.toThrow('engine said 500');
  });

  it('does not treat a stringly-typed status as "already gone"', async () => {
    // A proxy can answer with a string code; it must not be mistaken for a 404.
    h.network.remove.mockRejectedValueOnce({ statusCode: '404' });
    await expect(makeClient().removeNetwork('seamnex-shop')).rejects.toMatchObject({
      statusCode: '404',
    });
  });

  it('swallows a 404 on remove and propagates an active-endpoint failure', async () => {
    const client = makeClient();
    h.network.remove.mockRejectedValueOnce(statusError(404));
    await expect(client.removeNetwork('seamnex-shop')).resolves.toBeUndefined();

    h.network.remove.mockRejectedValueOnce(statusError(403));
    await expect(client.removeNetwork('seamnex-shop')).rejects.toThrow('engine said 403');
  });
});

describe('volumes', () => {
  it('creates a volume with the managed label', async () => {
    await makeClient().ensureVolume('seamnex-shop-data', { 'seamnex.instance': 'shop' });
    expect(h.createVolume).toHaveBeenCalledWith({
      Name: 'seamnex-shop-data',
      Labels: { 'seamnex.managed': 'true', 'seamnex.instance': 'shop' },
    });
  });

  it('accepts 409 and 500 as already created, but not 400', async () => {
    const client = makeClient();
    h.createVolume.mockRejectedValueOnce(statusError(409));
    await expect(client.ensureVolume('v')).resolves.toBeUndefined();

    h.createVolume.mockRejectedValueOnce(statusError(500));
    await expect(client.ensureVolume('v')).resolves.toBeUndefined();

    h.createVolume.mockRejectedValueOnce(statusError(400));
    await expect(client.ensureVolume('v')).rejects.toThrow('engine said 400');
  });

  it('removes a volume and treats 404 as success', async () => {
    const client = makeClient();
    await expect(client.removeVolume('v')).resolves.toBeUndefined();

    h.volume.remove.mockRejectedValueOnce(statusError(404));
    await expect(client.removeVolume('v')).resolves.toBeUndefined();

    h.volume.remove.mockRejectedValueOnce(statusError(500));
    await expect(client.removeVolume('v')).rejects.toThrow('engine said 500');
  });

  it('lists the volumes of one project by its compose labels', async () => {
    h.listVolumes.mockResolvedValueOnce({
      Volumes: [
        {
          Name: 'seamnex-orangehrm_orangehrm-db',
          Mountpoint: '/var/lib/docker/volumes/seamnex-orangehrm_orangehrm-db/_data',
          Labels: {
            'com.docker.compose.project': 'seamnex-orangehrm',
            'com.docker.compose.volume': 'orangehrm-db',
          },
        },
        { Name: 'anonymous', Mountpoint: undefined },
      ],
    });

    await expect(
      makeClient().volumes(['com.docker.compose.project=seamnex-orangehrm']),
    ).resolves.toEqual([
      {
        name: 'seamnex-orangehrm_orangehrm-db',
        mountpoint: '/var/lib/docker/volumes/seamnex-orangehrm_orangehrm-db/_data',
        labels: {
          'com.docker.compose.project': 'seamnex-orangehrm',
          'com.docker.compose.volume': 'orangehrm-db',
        },
      },
      // A volume without labels or a mountpoint is still a volume: the caller decides what to do.
      { name: 'anonymous', mountpoint: '', labels: {} },
    ]);
    expect(h.listVolumes).toHaveBeenCalledWith({
      filters: { label: ['com.docker.compose.project=seamnex-orangehrm'] },
    });
  });

  it('answers whether a volume still exists, and only a 404 means no', async () => {
    const client = makeClient();

    await expect(client.volumeExists('v')).resolves.toBe(true);

    h.volume.inspect.mockRejectedValueOnce(statusError(404));
    await expect(client.volumeExists('v')).resolves.toBe(false);

    // A transport failure must not be read as "no volume": that is a backup claiming an empty set.
    h.volume.inspect.mockRejectedValueOnce(statusError(500));
    await expect(client.volumeExists('v')).rejects.toThrow('engine said 500');
  });

  it('measures a volume through a read-only du helper', async () => {
    runOrThrowMock.mockResolvedValueOnce({
      code: 0,
      stdout: '2048\t/src\n',
      stderr: '',
      truncated: false,
    });

    await expect(makeClient().volumeUsageMb('seamnex-shop_data')).resolves.toBe(2_048);
    expect(runOrThrowMock).toHaveBeenCalledWith(
      'docker',
      ['run', '--rm', '-v', 'seamnex-shop_data:/src:ro', 'alpine:3.20', 'du', '-sm', '/src'],
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it('reports an unreadable du line as zero rather than NaN', async () => {
    await expect(makeClient().volumeUsageMb('v')).resolves.toBe(0);
  });
});

describe('containers', () => {
  it('maps the daemon listing onto the summary shape', async () => {
    h.listContainers.mockResolvedValue([
      {
        Id: 'aaaaaaaaaaaaaaaa',
        Names: ['/seamnex-shop-app-1'],
        Image: 'shop:1.2',
        State: 'running',
        Status: 'Up 3 minutes',
        Labels: { 'com.docker.compose.service': 'app' },
      },
      {
        Id: 'bbbbbbbbbbbbbbbb',
        Names: [],
        Image: 'redis:7.2',
        State: 'exited',
        Status: 'Exited (0)',
      },
    ]);

    const result = await makeClient().containers(['seamnex.instance=shop'], false);

    expect(h.listContainers).toHaveBeenCalledWith({
      all: false,
      filters: { label: ['seamnex.instance=shop'] },
    });
    expect(result).toEqual([
      {
        id: 'aaaaaaaaaaaaaaaa',
        name: '/seamnex-shop-app-1',
        service: 'app',
        image: 'shop:1.2',
        state: 'running',
        status: 'Up 3 minutes',
        labels: { 'com.docker.compose.service': 'app' },
      },
      {
        id: 'bbbbbbbbbbbbbbbb',
        name: 'bbbbbbbbbbbb',
        service: 'redis:7.2',
        image: 'redis:7.2',
        state: 'exited',
        status: 'Exited (0)',
        labels: {},
      },
    ]);
  });

  it('defaults to listing stopped containers too', async () => {
    await makeClient().containers(['seamnex.instance=shop']);
    expect(h.listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['seamnex.instance=shop'] },
    });
  });

  it('inspects a container', async () => {
    h.container.inspect.mockResolvedValue({ Id: 'c1' });
    await expect(makeClient().inspect('c1')).resolves.toEqual({ Id: 'c1' });
  });

  it('demultiplexes the log stream', async () => {
    const frame = (text: string): Buffer => {
      const body = Buffer.from(text, 'utf8');
      const header = Buffer.alloc(8);
      header.writeUInt32BE(body.length, 4);
      return Buffer.concat([header, body]);
    };
    h.container.logs.mockResolvedValue(Buffer.concat([frame('line one\n'), frame('line two\n')]));

    await expect(makeClient().logs('c1', 50)).resolves.toBe('line one\nline two\n');
    expect(h.container.logs).toHaveBeenCalledWith({
      stdout: true,
      stderr: true,
      tail: 50,
      timestamps: false,
    });
  });

  it('starts a container and accepts 304 as already started', async () => {
    const client = makeClient();
    await expect(client.start('c1')).resolves.toBeUndefined();

    h.container.start.mockRejectedValueOnce(statusError(304));
    await expect(client.start('c1')).resolves.toBeUndefined();

    h.container.start.mockRejectedValueOnce(statusError(500));
    await expect(client.start('c1')).rejects.toThrow('engine said 500');
  });

  it('stops with the requested grace when it fits the transport budget', async () => {
    await makeClient().stop('c1', 20);
    expect(h.container.stop).toHaveBeenCalledWith({ t: 20 });
  });

  it('clamps the grace below the Docker request budget', async () => {
    const client = makeClient({ SEAMNEX_DOCKER_TIMEOUT_MS: 15_000 });
    await client.stop('c1', 30);
    // 15 s budget minus the 5 s reserve.
    expect(h.container.stop).toHaveBeenCalledWith({ t: 10 });
  });

  it('never clamps the grace below one second', async () => {
    const client = makeClient({ SEAMNEX_DOCKER_TIMEOUT_MS: 2_000 });
    await client.stop('c1', 30);
    expect(h.container.stop).toHaveBeenCalledWith({ t: 1 });
  });

  it('accepts 304 and 409 as not running, and propagates anything else', async () => {
    const client = makeClient();
    h.container.stop.mockRejectedValueOnce(statusError(304));
    await expect(client.stop('c1')).resolves.toBeUndefined();

    h.container.stop.mockRejectedValueOnce(statusError(409));
    await expect(client.stop('c1')).resolves.toBeUndefined();

    h.container.stop.mockRejectedValueOnce(statusError(500));
    await expect(client.stop('c1')).rejects.toThrow('engine said 500');
  });

  it('restarts with the clamped grace', async () => {
    await makeClient().restart('c1', 5);
    expect(h.container.restart).toHaveBeenCalledWith({ t: 5 });
  });

  it('removes a container, treating 404 as already gone', async () => {
    const client = makeClient();
    await client.removeContainer('c1', false);
    expect(h.container.remove).toHaveBeenCalledWith({ force: false, v: false });

    h.container.remove.mockRejectedValueOnce(statusError(404));
    await expect(client.removeContainer('c1')).resolves.toBeUndefined();

    h.container.remove.mockRejectedValueOnce(statusError(409));
    await expect(client.removeContainer('c1')).rejects.toThrow('engine said 409');
  });
});

describe('images', () => {
  it('pulls, streams progress lines and returns the resolved identity', async () => {
    const onProgress = vi.fn(async () => undefined);
    h.pull.mockImplementation((_ref: string, callback: (error: null, stream: unknown) => void) => {
      callback(null, { on: () => undefined });
    });
    h.followProgress.mockImplementation((_stream, done: (error: Error | null) => void, onEvent) => {
      onEvent({ status: 'Pulling', id: 'layer-1' });
      onEvent({ status: 'Done' });
      onEvent({});
      done(null);
    });
    h.image.inspect.mockResolvedValue({ Id: 'sha256:1', RepoDigests: ['shop@sha256:abc'] });

    const identity = await makeClient().pull('shop:1.2', onProgress);

    expect(identity).toEqual({ ref: 'shop:1.2', digest: 'sha256:abc', id: 'sha256:1' });
  });

  /**
   * A filtered network is a transport problem, not a product one: `SEAMNEX_REGISTRY_MIRROR` reaches
   * BuildKit only, so the Engine's own pull had no mirror at all and a deployment sat in the digest
   * check for hours. These cases fix the three properties that make the prefix approach safe — the
   * guard still judges the canonical reference, the pin still decides, and a dead mirror costs one
   * attempt rather than the deployment.
   */
  it('pulls through a configured mirror and retags onto the canonical reference', async () => {
    const guard = makeGuard();
    h.pull.mockImplementation((_ref: string, callback: (error: null, stream: unknown) => void) => {
      callback(null, {});
    });
    h.followProgress.mockImplementation((_stream, done: (error: Error | null) => void) => {
      done(null);
    });
    h.image.inspect.mockResolvedValue({
      Id: 'sha256:1',
      RepoDigests: ['mirror.test/shop@sha256:abc'],
    });
    runMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', truncated: false });
    runOrThrowMock.mockClear();

    const identity = await makeClient(
      { pullMirrors: ['mirror.test'], SEAMNEX_PULL_TIMEOUT_MS: 5_000 },
      guard,
    ).pull('shop:1.2');

    expect(h.pull).toHaveBeenCalledWith('mirror.test/shop:1.2', expect.any(Function));
    expect(runOrThrowMock).toHaveBeenCalledWith(
      'docker',
      ['tag', 'mirror.test/shop:1.2', 'shop:1.2'],
      expect.anything(),
    );
    // The mirror name is transport, not identity: `docker images` should show what will be started.
    expect(runMock).toHaveBeenCalledWith(
      'docker',
      ['rmi', 'mirror.test/shop:1.2'],
      expect.anything(),
    );
    expect(identity).toEqual({ ref: 'shop:1.2', digest: 'sha256:abc', id: 'sha256:1' });
    // NFR-4.16 is about content, not transport: the allow-list saw the reference, never the prefix.
    expect(guard.assertTrusted).toHaveBeenCalledWith('shop:1.2', 'pull');
  });

  it('tries the next mirror, then the registry, and says so in the job log', async () => {
    const lines: string[] = [];
    h.pull
      .mockImplementationOnce((_ref: string, callback: (error: Error) => void) => {
        callback(new Error('mirror a refused'));
      })
      .mockImplementationOnce((_ref: string, callback: (error: null, stream: unknown) => void) => {
        callback(null, {});
      });
    h.followProgress.mockImplementation((_stream, done: (error: Error | null) => void) => {
      done(null);
    });
    h.image.inspect.mockResolvedValue({ Id: 'sha256:1', RepoDigests: ['shop@sha256:abc'] });

    await makeClient({ pullMirrors: ['a.test', 'b.test'], SEAMNEX_PULL_TIMEOUT_MS: 5_000 }).pull(
      'shop:1.2',
      async (line) => {
        lines.push(line);
      },
    );

    expect(h.pull.mock.calls.map((call) => String(call[0]))).toEqual([
      'a.test/shop:1.2',
      'b.test/shop:1.2',
    ]);
    expect(lines.some((line) => line.includes('a.test/shop:1.2 did not complete'))).toBe(true);
  });

  it('refuses a mirror that serves a different digest and falls through to the registry', async () => {
    const pinned = `sha256:${'0'.repeat(64)}`;
    const other = `sha256:${'1'.repeat(64)}`;
    h.pull.mockImplementation((_ref: string, callback: (error: null, stream: unknown) => void) => {
      callback(null, {});
    });
    h.followProgress.mockImplementation((_stream, done: (error: Error | null) => void) => {
      done(null);
    });
    // identity + repoDigest per attempt: the mirror answers with other content, the registry with the pin.
    h.image.inspect
      .mockResolvedValueOnce({ Id: 'sha256:mirror', RepoDigests: [`mirror.test/shop@${other}`] })
      .mockResolvedValueOnce({ Id: 'sha256:mirror', RepoDigests: [`mirror.test/shop@${other}`] })
      .mockResolvedValue({ Id: 'sha256:1', RepoDigests: [`shop@${pinned}`] });
    runMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', truncated: false });

    const identity = await makeClient({
      pullMirrors: ['mirror.test'],
      SEAMNEX_PULL_TIMEOUT_MS: 5_000,
    }).pull('shop:1.2', undefined, { expectedDigest: pinned });

    expect(h.pull.mock.calls.map((call) => String(call[0]))).toEqual([
      'mirror.test/shop:1.2',
      'shop:1.2',
    ]);
    expect(identity.digest).toBe(pinned);
  });

  it('fails the pin when the registry itself serves something else', async () => {
    h.pull.mockImplementation((_ref: string, callback: (error: null, stream: unknown) => void) => {
      callback(null, {});
    });
    h.followProgress.mockImplementation((_stream, done: (error: Error | null) => void) => {
      done(null);
    });
    h.image.inspect.mockResolvedValue({
      Id: 'sha256:1',
      RepoDigests: [`shop@sha256:${'1'.repeat(64)}`],
    });

    await expect(
      makeClient({ SEAMNEX_PULL_TIMEOUT_MS: 5_000 }).pull('shop:1.2', undefined, {
        expectedDigest: `sha256:${'0'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'IMAGE_DIGEST_MISMATCH' });
  });

  it('abandons an attempt that outlives SEAMNEX_PULL_TIMEOUT_MS instead of waiting', async () => {
    // Never answers — the shape of the D06-01 pull, where the daemon kept emitting progress lines.
    h.pull.mockImplementation(() => undefined);

    await expect(makeClient({ SEAMNEX_PULL_TIMEOUT_MS: 25 }).pull('shop:1.2')).rejects.toThrow(
      /did not finish within/,
    );
  });

  it('does not prefix a digest reference, which cannot be retagged', async () => {
    const digest = `sha256:${'0'.repeat(64)}`;
    h.pull.mockImplementation((_ref: string, callback: (error: null, stream: unknown) => void) => {
      callback(null, {});
    });
    h.followProgress.mockImplementation((_stream, done: (error: Error | null) => void) => {
      done(null);
    });
    h.image.inspect.mockResolvedValue({ Id: 'sha256:1', RepoDigests: [`shop@${digest}`] });

    await makeClient({ pullMirrors: ['mirror.test'], SEAMNEX_PULL_TIMEOUT_MS: 5_000 }).pull(
      `shop@${digest}`,
    );

    expect(h.pull.mock.calls.map((call) => String(call[0]))).toEqual([`shop@${digest}`]);
  });

  it('forwards progress without waiting for the sink', async () => {
    const onProgress = vi.fn(async () => {
      throw new Error('sink failed');
    });
    h.pull.mockImplementation((_ref: string, callback: (error: null, stream: unknown) => void) => {
      callback(null, {});
    });
    h.followProgress.mockImplementation((_stream, done: (error: Error | null) => void, onEvent) => {
      onEvent({ status: 'Pulling' });
      done(null);
    });
    h.image.inspect.mockResolvedValue({ Id: 'sha256:1', RepoDigests: [] });

    // A failing log sink must not fail the pull.
    await expect(makeClient().pull('shop:1.2', onProgress)).resolves.toMatchObject({
      digest: 'sha256:1',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(onProgress).toHaveBeenCalledWith('shop:1.2: Pulling');
  });

  it('rejects when the daemon refuses the pull', async () => {
    h.pull.mockImplementation((_ref: string, callback: (error: Error) => void) => {
      callback(new Error('no such image'));
    });

    await expect(makeClient().pull('missing:1')).rejects.toThrow('no such image');
  });

  /**
   * NFR-4.16 — the hard guard. Pre-flight can be bypassed by anything that queues a job, so the pull
   * itself refuses a reference the allow-list does not carry, before the daemon is asked.
   */
  it('refuses a pull the allow-list rejects, without reaching the daemon', async () => {
    const guard = makeGuard(async () => {
      throw new Error('docker.io/bitnami is not a trusted registry namespace');
    });

    await expect(makeClient({}, guard).pull('bitnami/postgresql:16.4')).rejects.toThrow(
      'not a trusted registry namespace',
    );
    expect(h.pull).not.toHaveBeenCalled();
  });

  it('refuses to pull when no guard is wired, rather than running unguarded', async () => {
    const unguarded = new DockerEngineClient(makeConfig());

    await expect(unguarded.pull('shop:1.2')).rejects.toThrow('trusted-registry guard is not wired');
    expect(h.pull).not.toHaveBeenCalled();
  });

  it('rejects when the progress stream reports an error', async () => {
    h.pull.mockImplementation((_ref: string, callback: (error: null, stream: unknown) => void) => {
      callback(null, {});
    });
    h.followProgress.mockImplementation((_stream, done: (error: Error) => void) => {
      done(new Error('layer failed'));
    });

    await expect(makeClient().pull('shop:1.2')).rejects.toThrow('layer failed');
  });

  it('falls back to the image id when there is no repo digest', async () => {
    h.image.inspect.mockResolvedValue({
      Id: 'sha256:9',
      RepoDigests: ['shop@sha256:other', 'other-id'],
    });
    await expect(makeClient().imageIdentity('shop:1')).resolves.toEqual({
      ref: 'shop:1',
      digest: 'sha256:other',
      id: 'sha256:9',
    });

    h.image.inspect.mockResolvedValue({ Id: 'sha256:9' });
    await expect(makeClient().imageIdentity('shop:1')).resolves.toMatchObject({
      digest: 'sha256:9',
    });
  });

  it('reports no repository digest instead of the image id, so a pin cannot pass on a local build', async () => {
    h.image.inspect.mockResolvedValue({ Id: 'sha256:9', RepoDigests: ['shop@sha256:other'] });
    await expect(makeClient().repoDigest('shop:1')).resolves.toBe('sha256:other');

    h.image.inspect.mockResolvedValue({ Id: 'sha256:9', RepoDigests: [] });
    await expect(makeClient().repoDigest('shop:1')).resolves.toBeNull();

    h.image.inspect.mockResolvedValue({ Id: 'sha256:9' });
    await expect(makeClient().repoDigest('shop:1')).resolves.toBeNull();
  });

  it('reports the config id a local build has, and null when the tag is gone', async () => {
    h.image.inspect.mockResolvedValue({ Id: 'sha256:9', RepoDigests: [] });
    await expect(makeClient().imageId('shop:1')).resolves.toBe('sha256:9');

    h.image.inspect.mockRejectedValue(new Error('no such image'));
    await expect(makeClient().imageId('shop:1')).resolves.toBeNull();
  });

  it('reports whether an image is present, swallowing the same failure that disables it', async () => {
    h.image.inspect.mockResolvedValue({ Id: 'x' });
    await expect(makeClient().imageExists('shop:1')).resolves.toBe(true);

    h.image.inspect.mockRejectedValue(statusError(404));
    await expect(makeClient().imageExists('shop:1')).resolves.toBe(false);

    // Even a disabled adapter reads as "absent" here.
    await expect(
      makeClient({ SEAMNEX_ADAPTERS_MODE: 'disabled' }).imageExists('shop:1'),
    ).resolves.toBe(false);
  });
});

describe('compose CLI', () => {
  it('brings the project up with pinned name, directory, files and env files', async () => {
    const onLine = vi.fn(async () => undefined);
    runOrThrowMock.mockResolvedValue({
      code: 0,
      stdout: 'one\n\ntwo\n',
      stderr: '',
      truncated: false,
    });

    await makeClient().composeUp(PROJECT, onLine);

    expect(runOrThrowMock).toHaveBeenCalledWith(
      'docker',
      [
        'compose',
        '--project-name',
        'seamnex-shop',
        '--project-directory',
        PROJECT.directory,
        '-f',
        PROJECT.files[0],
        '-f',
        PROJECT.files[1],
        '--env-file',
        PROJECT.envFiles[0],
        'up',
        '-d',
        '--remove-orphans',
        '--quiet-pull',
      ],
      {
        env: { DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CLI_HINTS: 'false' },
        timeoutMs: 600_000,
      },
    );
    expect(onLine).toHaveBeenCalledTimes(2);
  });

  it('runs up without an output sink', async () => {
    await expect(makeClient().composeUp(PROJECT)).resolves.toBeUndefined();
  });

  it('builds with its own timeout so a changed Dockerfile is never skipped', async () => {
    const onLine = vi.fn(async () => undefined);
    runOrThrowMock.mockResolvedValue({ code: 0, stdout: 'built\n', stderr: '', truncated: false });

    await makeClient().composeBuild(PROJECT, onLine);

    expect(runOrThrowMock).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['build']),
      expect.objectContaining({ timeoutMs: 900_000 }),
    );
    expect(onLine).toHaveBeenCalledWith('built');
  });

  /**
   * `.env` → `--build-arg` for both build shapes.
   *
   * A product Dockerfile the platform does not own fetches from whatever archive it names, and on a
   * filtered host that fetch *is* the stage: the first D07-01 build spent its budget in `apt-get`
   * against `deb.debian.org`. The mirrors travel as arguments the Dockerfile declares, so both shapes
   * must carry them; nothing configured must add nothing, because a stray argument in CI is noise.
   */
  describe('package mirrors', () => {
    const MIRRORS = {
      APK_MIRROR: 'https://mirror.example.com/alpine',
      APT_MIRROR: 'https://mirror.example.com/debian',
      NPM_REGISTRY: 'https://registry.example.com',
    };
    const EXPECTED = [
      '--build-arg',
      'APK_MIRROR=https://mirror.example.com/alpine',
      '--build-arg',
      'APT_MIRROR=https://mirror.example.com/debian',
      '--build-arg',
      'NPM_REGISTRY=https://registry.example.com',
    ];

    /** The argv of the last CLI call, which is the one the mirror arguments have to be on. */
    function lastArgs(): string[] {
      return runOrThrowMock.mock.calls.at(-1)?.[1] as string[];
    }

    it('forwards every configured mirror to a compose build', async () => {
      runOrThrowMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', truncated: false });

      await makeClient(MIRRORS).composeBuild(PROJECT);

      const args = lastArgs();
      expect(args).toEqual(expect.arrayContaining(EXPECTED));
      // After the subcommand: Compose reads an argument before `build` as a global flag and exits 1.
      expect(args.indexOf('--build-arg')).toBeGreaterThan(args.indexOf('build'));
    });

    it('forwards them to a buildx build', async () => {
      await makeClient(MIRRORS).build({
        context: '/srv/ctx',
        dockerfile: '/srv/ctx/Dockerfile',
        tag: 'seamnex/shop:1',
      });

      // Before the context, which has to stay the last argument.
      expect(lastArgs()).toEqual([
        'buildx',
        'build',
        '--load',
        '-t',
        'seamnex/shop:1',
        '-f',
        '/srv/ctx/Dockerfile',
        ...EXPECTED,
        '/srv/ctx',
      ]);
    });

    it('adds nothing when no mirror is configured', async () => {
      runOrThrowMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', truncated: false });

      await makeClient().composeBuild(PROJECT);

      expect(lastArgs()).not.toContain('--build-arg');
    });
  });

  /**
   * ADR-BE-40 §7 — the build endpoint.
   *
   * The socket proxy cannot carry a build session, so a configured `SEAMNEX_BUILDKIT_ADDR` has to
   * reach both build shapes: `docker compose build` (through the environment, because Compose has no
   * `--builder` flag) and `docker buildx build` (same variable). The builder is registered once, and
   * a lost registration race is not a failure.
   */
  describe('build endpoint', () => {
    const absent = { code: 1, stdout: '', stderr: 'no builder', truncated: false };
    const ok = { code: 0, stdout: '', stderr: '', truncated: false };

    it('leaves the daemon builder alone when no endpoint is configured', async () => {
      runOrThrowMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', truncated: false });

      await makeClient().composeBuild(PROJECT);

      expect(runMock).not.toHaveBeenCalled();
      const options = runOrThrowMock.mock.calls.at(-1)?.[2] as { env: Record<string, string> };
      expect(options.env.BUILDX_BUILDER).toBeUndefined();
    });

    it('registers the remote builder, then builds through it', async () => {
      runMock.mockResolvedValueOnce(absent).mockResolvedValueOnce(ok);
      runOrThrowMock.mockResolvedValue({
        code: 0,
        stdout: 'built\n',
        stderr: '',
        truncated: false,
      });

      await makeClient({ SEAMNEX_BUILDKIT_ADDR: 'tcp://buildkit:1234' }).composeBuild(PROJECT);

      expect(runMock).toHaveBeenCalledWith(
        'docker',
        ['buildx', 'inspect', 'seamnex-buildkit'],
        expect.objectContaining({ timeoutMs: 60_000 }),
      );
      expect(runMock).toHaveBeenCalledWith(
        'docker',
        [
          'buildx',
          'create',
          '--name',
          'seamnex-buildkit',
          '--driver',
          'remote',
          'tcp://buildkit:1234',
        ],
        expect.objectContaining({
          env: expect.objectContaining({ DOCKER_HOST: 'unix:///var/run/docker.sock' }),
        }),
      );
      const options = runOrThrowMock.mock.calls.at(-1)?.[2] as { env: Record<string, string> };
      expect(options.env.BUILDX_BUILDER).toBe('seamnex-buildkit');
    });

    it('does not register a builder that is already there', async () => {
      runMock.mockResolvedValue(ok);
      runOrThrowMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', truncated: false });

      await makeClient({ SEAMNEX_BUILDKIT_ADDR: 'tcp://buildkit:1234' }).composeBuild(PROJECT);

      expect(runMock.mock.calls.map((call) => call[1])).toEqual([
        ['buildx', 'inspect', 'seamnex-buildkit'],
      ]);
    });

    it('accepts a builder another worker registered first', async () => {
      runMock.mockResolvedValueOnce(absent).mockResolvedValueOnce(absent).mockResolvedValueOnce(ok);
      runOrThrowMock.mockResolvedValue({ code: 0, stdout: '', stderr: '', truncated: false });

      await expect(
        makeClient({ SEAMNEX_BUILDKIT_ADDR: 'tcp://buildkit:1234' }).composeBuild(PROJECT),
      ).resolves.toBeUndefined();
    });

    it('refuses to build when the endpoint cannot be registered', async () => {
      runMock.mockResolvedValue(absent);

      const client = makeClient({ SEAMNEX_BUILDKIT_ADDR: 'tcp://buildkit:1234' });
      await expect(client.composeBuild(PROJECT)).rejects.toMatchObject({
        code: 'ADAPTER_UNAVAILABLE',
        detail: expect.stringContaining('tcp://buildkit:1234'),
      });
      expect(runOrThrowMock).not.toHaveBeenCalled();
    });
  });

  it('removes volumes only when asked', async () => {
    await makeClient().composeDown(PROJECT, true);
    expect(runOrThrowMock).toHaveBeenLastCalledWith(
      'docker',
      expect.arrayContaining(['down', '--remove-orphans', '--volumes']),
      expect.objectContaining({ timeoutMs: 300_000 }),
    );

    await makeClient().composeDown(PROJECT, false);
    expect(runOrThrowMock.mock.calls.at(-1)?.[1]).not.toContain('--volumes');
  });

  it('parses the ps JSON stream and skips lines it cannot read', async () => {
    runOrThrowMock.mockResolvedValue({
      code: 0,
      stdout: [
        JSON.stringify({
          ID: 'c1',
          Name: 'app-1',
          Service: 'app',
          Image: 'shop:1',
          State: 'running',
          Status: 'Up',
        }),
        'not json',
        '',
        '{}',
      ].join('\n'),
      stderr: '',
      truncated: false,
    });

    const result = await makeClient().composePs(PROJECT);

    expect(result).toEqual([
      {
        id: 'c1',
        name: 'app-1',
        service: 'app',
        image: 'shop:1',
        state: 'running',
        status: 'Up',
        labels: {},
      },
      { id: '', name: '', service: '', image: '', state: '', status: '', labels: {} },
    ]);
  });

  it('builds a tagged image with labels through buildx', async () => {
    await makeClient().build({
      context: '/srv/ctx',
      dockerfile: '/srv/ctx/Dockerfile',
      tag: 'seamnex/shop:1',
      labels: { 'seamnex.instance': 'shop' },
    });

    expect(runOrThrowMock).toHaveBeenCalledWith(
      'docker',
      [
        'buildx',
        'build',
        '--load',
        '-t',
        'seamnex/shop:1',
        '-f',
        '/srv/ctx/Dockerfile',
        '--label',
        'seamnex.instance=shop',
        '/srv/ctx',
      ],
      expect.objectContaining({ timeoutMs: 900_000 }),
    );
  });

  it('builds without labels', async () => {
    await makeClient().build({ context: '/c', dockerfile: '/c/Dockerfile', tag: 't:1' });
    expect(runOrThrowMock.mock.calls[0]?.[1]).not.toContain('--label');
  });

  it('saves and loads images through the CLI', async () => {
    const client = makeClient();
    await client.saveImage('seamnex/shop:1', '/backup/image.tar');
    expect(runOrThrowMock).toHaveBeenLastCalledWith(
      'docker',
      ['save', '-o', '/backup/image.tar', 'seamnex/shop:1'],
      expect.objectContaining({ timeoutMs: 600_000 }),
    );

    await client.loadImage('/backup/image.tar');
    expect(runOrThrowMock).toHaveBeenLastCalledWith(
      'docker',
      ['load', '-i', '/backup/image.tar'],
      expect.objectContaining({ timeoutMs: 600_000 }),
    );
  });

  it('spawns a streaming pipeline with the docker environment', () => {
    spawnMock.mockReturnValue({ pid: 1 } as never);
    const child = makeClient().spawn('docker', ['exec', 'c1', 'pg_dump'], 5_000);

    expect(child).toEqual({ pid: 1 });
    expect(spawnMock).toHaveBeenCalledWith('docker', ['exec', 'c1', 'pg_dump'], {
      env: { DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CLI_HINTS: 'false' },
      timeoutMs: 5_000,
    });
  });

  it('runs a one-off CLI command', async () => {
    runMock.mockResolvedValue({ code: 0, stdout: 'ok', stderr: '', truncated: false });
    await makeClient().runCli('docker', ['version'], 1_000);

    expect(runMock).toHaveBeenCalledWith('docker', ['version'], {
      env: { DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_CLI_HINTS: 'false' },
      timeoutMs: 1_000,
    });
  });
});

describe('demultiplex', () => {
  function frame(text: string, stream = 1): Buffer {
    const body = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt32BE(stream, 0);
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  }

  it('strips the frame headers Docker writes for a non-TTY container', () => {
    expect(demultiplex(Buffer.concat([frame('out\n', 1), frame('err\n', 2)]))).toBe('out\nerr\n');
  });

  it('returns plain text unchanged for a TTY container', () => {
    // Shorter than a frame header: nothing can be read as a length prefix.
    expect(demultiplex(Buffer.from('hi\n'))).toBe('hi\n');
  });

  it('stops at a zero-length frame instead of looping', () => {
    const empty = Buffer.alloc(8);
    expect(demultiplex(Buffer.concat([frame('before'), empty, frame('after')]))).toBe('before');
  });

  it('truncates the last frame at the end of the buffer', () => {
    const body = Buffer.from('partial', 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt32BE(100, 4);
    expect(demultiplex(Buffer.concat([header, body]))).toBe('partial');
  });

  it('returns an empty string for an empty buffer', () => {
    expect(demultiplex(Buffer.alloc(0))).toBe('');
  });
});

describe('volumes without a listing', () => {
  it('reports no volumes when the daemon omits the array', async () => {
    // `Volumes` is optional in the Engine's response; reading `.map` on it would crash a backup.
    h.listVolumes.mockResolvedValueOnce({});

    await expect(
      makeClient().volumes(['com.docker.compose.project=seamnex-shop']),
    ).resolves.toEqual([]);
  });
});

describe('stats', () => {
  it('answers null when the daemon omits cpu counters', async () => {
    // A container that has just started has no delta; `null` is "not measured", not "idle".
    h.container.stats.mockResolvedValueOnce({});

    await expect(makeClient().stats('c1')).resolves.toBeNull();
  });

  it('answers null when the daemon omits memory counters', async () => {
    h.container.stats.mockResolvedValueOnce({ cpu_stats: { cpu_usage: { total_usage: 1 } } });

    await expect(makeClient().stats('c1')).resolves.toBeNull();
  });

  it('answers null when the daemon returns no payload at all', async () => {
    h.container.stats.mockResolvedValueOnce(undefined);

    await expect(makeClient().stats('c1')).resolves.toBeNull();
  });

  it('computes the same snapshot docker stats reports', async () => {
    h.container.stats.mockResolvedValueOnce({
      cpu_stats: {
        cpu_usage: { total_usage: 2_000_000 },
        system_cpu_usage: 10_000_000,
        online_cpus: 2,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 1_000_000 },
        system_cpu_usage: 8_000_000,
      },
      memory_stats: {
        usage: 300 * 1024 * 1024,
        stats: { inactive_file: 50 * 1024 * 1024 },
      },
    });

    // cpu: 1e6 / 2e6 * 2 cpus * 1000; memory: working set, not the cgroup total.
    await expect(makeClient().stats('c1')).resolves.toEqual({ cpuMilli: 1_000, memoryMb: 250 });
    expect(h.container.stats).toHaveBeenCalledWith({ stream: false });
  });

  it('falls back to the per-cpu count and the legacy inactive counter', async () => {
    h.container.stats.mockResolvedValueOnce({
      cpu_stats: {
        cpu_usage: { total_usage: 500, percpu_usage: [1, 2, 3] },
      },
      memory_stats: {
        usage: 10 * 1024 * 1024,
        stats: { total_inactive_file: 2 * 1024 * 1024 },
      },
    });

    // No previous sample means no system delta, so CPU reads 0 rather than a fabricated ratio.
    await expect(makeClient().stats('c1')).resolves.toEqual({ cpuMilli: 0, memoryMb: 8 });
  });

  it('treats absent counters as zero and assumes one cpu', async () => {
    h.container.stats.mockResolvedValueOnce({
      cpu_stats: { system_cpu_usage: 1_000_000 },
      precpu_stats: { system_cpu_usage: 0 },
      memory_stats: {},
    });

    await expect(makeClient().stats('c1')).resolves.toEqual({ cpuMilli: 0, memoryMb: 0 });
  });

  it('reads a previous sample that carries no system counter', async () => {
    h.container.stats.mockResolvedValueOnce({
      cpu_stats: { cpu_usage: { total_usage: 2_000 }, system_cpu_usage: 5_000 },
      precpu_stats: { cpu_usage: { total_usage: 1_000 } },
      memory_stats: { usage: 0, stats: { inactive_file: 0 } },
    });

    await expect(makeClient().stats('c1')).resolves.toEqual({ cpuMilli: 200, memoryMb: 0 });
  });
});
