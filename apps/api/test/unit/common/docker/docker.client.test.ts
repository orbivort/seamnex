import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { run, runOrThrow, spawnProcess } from '../../../../src/common/exec/exec';
import {
  demultiplex,
  DockerEngineClient,
  type ComposeProject,
} from '../../../../src/common/docker/docker.client';

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
  });
  return {
    options,
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
    constructor(options: unknown) {
      h.options.push(options);
    }
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

function makeClient(overrides: Record<string, unknown> = {}): DockerEngineClient {
  return new DockerEngineClient(makeConfig(overrides));
}

/** A daemon error in the shape dockerode rejects with. */
function statusError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`engine said ${statusCode}`), { statusCode });
}

const PROJECT: ComposeProject = {
  project: 'seamnex-shop',
  directory: '/srv/seamnex/instances/shop',
  files: ['/srv/seamnex/instances/shop/compose.yaml', '/srv/seamnex/instances/shop/override.yaml'],
  envFiles: ['/srv/seamnex/instances/shop/.env'],
};

beforeEach(() => {
  h.options.length = 0;
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
  h.volume.remove.mockResolvedValue(undefined);
  h.createNetwork.mockResolvedValue(undefined);
  h.createVolume.mockResolvedValue(undefined);
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
        '/srv/seamnex/instances/shop',
        '-f',
        '/srv/seamnex/instances/shop/compose.yaml',
        '-f',
        '/srv/seamnex/instances/shop/override.yaml',
        '--env-file',
        '/srv/seamnex/instances/shop/.env',
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
