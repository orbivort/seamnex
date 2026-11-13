import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@nestjs/common';
import type { AppConfig } from '../../../../src/config/config';
import type { DockerEngineClient } from '../../../../src/common/docker/docker.client';
import {
  bareHost,
  ensureInstanceJoined,
  internalOriginFor,
  joinTargetFor,
  localContainerId,
  publicOriginFor,
} from '../../../../src/modules/m24-sign-in-relay/relay-origin';

/**
 * Where the relay talks to a product, and how it gets there.
 *
 * Both halves fail silently when they are wrong: an address the container cannot resolve is
 * `product_unavailable`, and a `Host` that disagrees with `Origin` is a `422` on a correct password.
 * The join is the same shape — a failed attach is logged and the attempt falls back, never thrown.
 */

const config = {
  SEAMNEX_PRODUCT_URL_SCHEME: 'http',
  SEAMNEX_PRODUCT_URL_PORT: '8020',
  SEAMNEX_RELAY_CONTAINER: '',
} as unknown as AppConfig;

function logger(): Logger {
  return { warn: vi.fn(), log: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function docker(
  behaviour: 'ok' | 'fail' = 'ok',
  endpoints: { id: string; name: string }[] = [],
): DockerEngineClient {
  return {
    networkEndpoints: vi.fn(async () => endpoints),
    connectNetwork: vi.fn(async () => {
      if (behaviour === 'fail') throw new Error('no such container');
    }),
  } as unknown as DockerEngineClient;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('internalOriginFor', () => {
  it('builds the alias origin from the instance payload', () => {
    expect(internalOriginFor('openproject', { httpPort: 80 })).toBe('http://openproject:80');
  });

  it('answers null when the payload declares no usable port', () => {
    // A missing port is not "port 0": a URL with no port would reach the edge, not the product.
    expect(internalOriginFor('openproject', {})).toBeNull();
    expect(internalOriginFor('openproject', { httpPort: 0 })).toBeNull();
    expect(internalOriginFor('openproject', { httpPort: -1 })).toBeNull();
    expect(internalOriginFor('openproject', { httpPort: 80.5 })).toBeNull();
    expect(internalOriginFor('openproject', { httpPort: 'eighty' })).toBeNull();
  });
});

describe('publicOriginFor', () => {
  it('appends the configured public port to the bare host', () => {
    expect(publicOriginFor(config, 'openproject.localhost')).toBe(
      'http://openproject.localhost:8020',
    );
  });

  it('omits the separator when no public port is configured', () => {
    const noPort = { ...config, SEAMNEX_PRODUCT_URL_PORT: '' } as unknown as AppConfig;

    expect(publicOriginFor(noPort, 'openproject.localhost')).toBe('http://openproject.localhost');
  });

  it('strips the port the browser forwarded, so it is never doubled', () => {
    expect(publicOriginFor(config, 'openproject.localhost:8020')).toBe(
      'http://openproject.localhost:8020',
    );
  });
});

describe('bareHost', () => {
  it('drops a port and lowercases the rest', () => {
    expect(bareHost('OpenProject.Localhost:8020')).toBe('openproject.localhost');
    expect(bareHost('openproject.localhost')).toBe('openproject.localhost');
  });
});

describe('joinTargetFor and localContainerId', () => {
  it('prefers the configured container and falls back to this process', () => {
    vi.stubEnv('HOSTNAME', 'container-abc');
    const configured = { SEAMNEX_RELAY_CONTAINER: 'relay' } as unknown as AppConfig;

    expect(joinTargetFor(configured)).toBe('relay');
    expect(joinTargetFor(config)).toBe('container-abc');
    expect(localContainerId()).toBe('container-abc');
  });

  it('answers the empty string outside Docker', () => {
    vi.stubEnv('HOSTNAME', '');

    expect(localContainerId()).toBe('');
    expect(joinTargetFor(config)).toBe('');
  });
});

describe('ensureInstanceJoined', () => {
  it('attaches this container to the instance network once', async () => {
    vi.stubEnv('HOSTNAME', 'container-abc');
    const client = docker();
    const joined = new Map<string, number>();
    const log = logger();

    await ensureInstanceJoined(client, config, log, joined, 'openproject');
    await ensureInstanceJoined(client, config, log, joined, 'openproject');

    expect(client.connectNetwork).toHaveBeenCalledOnce();
    expect(client.connectNetwork).toHaveBeenCalledWith('seamnex-inst-openproject', 'container-abc');
    expect(joined.has('seamnex-inst-openproject')).toBe(true);
    // The second call is answered from the memo, so the launch hop does not pay an inspect.
    expect(client.networkEndpoints).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not re-attach a container Docker already lists on the network', async () => {
    vi.stubEnv('HOSTNAME', 'container-abc');
    // The Engine reports the full id and the container name; `HOSTNAME` is the short id.
    const client = docker('ok', [{ id: 'container-abc0123456789', name: 'seamnex-dev-relay-1' }]);
    const joined = new Map<string, number>();

    await ensureInstanceJoined(client, config, logger(), joined, 'openproject');

    expect(client.connectNetwork).not.toHaveBeenCalled();
    expect(joined.has('seamnex-inst-openproject')).toBe(true);
  });

  it('re-attaches after the memo expires, because membership dies with either container', async () => {
    vi.stubEnv('HOSTNAME', 'container-abc');
    // A network that no longer lists us is what a `compose up` or a reinstall leaves behind. The
    // memo cannot answer for it forever: an unbounded one turned this into "restart the relay".
    const client = docker('ok', [{ id: 'ffffffffffffffff', name: 'someone-else' }]);
    const joined = new Map<string, number>([['seamnex-inst-openproject', 0]]);

    await ensureInstanceJoined(client, config, logger(), joined, 'openproject');

    expect(client.connectNetwork).toHaveBeenCalledWith('seamnex-inst-openproject', 'container-abc');
  });

  it('does nothing when the process has no container identity to join with', async () => {
    vi.stubEnv('HOSTNAME', '');
    const client = docker();
    const joined = new Map<string, number>();

    await ensureInstanceJoined(client, config, logger(), joined, 'openproject');

    // A process outside Docker cannot join; the caller records `product_unavailable` instead.
    expect(client.connectNetwork).not.toHaveBeenCalled();
    expect(joined.size).toBe(0);
  });

  it('warns and keeps the network unjoined when Docker refuses the attach', async () => {
    vi.stubEnv('HOSTNAME', 'container-abc');
    const joined = new Map<string, number>();
    const log = logger();

    await ensureInstanceJoined(docker('fail'), config, log, joined, 'openproject');

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no such container'));
    // Not marked joined: the next attempt is allowed to retry the attach.
    expect(joined.size).toBe(0);
  });

  it('renders a non-Error refusal without throwing', async () => {
    vi.stubEnv('HOSTNAME', 'container-abc');
    const client = {
      networkEndpoints: vi.fn(async () => []),
      connectNetwork: vi.fn(async () => {
        throw 'network not found';
      }),
    } as unknown as DockerEngineClient;
    const log = logger();

    await expect(
      ensureInstanceJoined(client, config, log, new Map<string, number>(), 'openproject'),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('network not found'));
  });
});
