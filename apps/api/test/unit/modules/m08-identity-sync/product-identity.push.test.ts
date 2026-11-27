import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import type {
  SecretMetadata,
  SecretsService,
} from '../../../../src/modules/m15-secrets/secrets.contract';

/**
 * FR-2.4 / S-8 — the adapter that writes a mapped product role into a product.
 *
 * Three things must hold for every path through it: no push happens unless an operator enabled
 * pushing, the credential is opened through M15 and never logged, and a failure is a *reason* for a
 * pending entitlement instead of an exception that would abort the cycle.
 */
const call = vi.hoisted(() => ({
  postProductJson: vi.fn(),
  run: vi.fn(),
}));

vi.mock('../../../../src/common/exec/http-call', () => ({
  postProductJson: call.postProductJson,
}));

// The adapter must hand the helper call to the shared exec wrapper, which is what bounds it in time.
vi.mock('../../../../src/common/exec/exec', () => ({ run: call.run }));

const { ProductIdentityPushService } =
  await import('../../../../src/modules/m08-identity-sync/product-identity.push');

const SECRET: SecretMetadata = {
  id: 'secret-1',
  scope: 'instance',
  ownerId: 'inst-crm',
  name: 'crm-admin-token',
  version: 1,
  masked: '••••••••',
};

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    SEAMNEX_IDENTITY_PUSH_ENABLED: true,
    SEAMNEX_IDENTITY_PUSH_TIMEOUT_MS: 5_000,
    ...overrides,
  } as AppConfig;
}

function secrets(overrides: Partial<SecretsService> = {}): SecretsService {
  return {
    find: vi.fn(async () => SECRET),
    open: vi.fn(async () => 'token-value'),
    ...overrides,
  } as unknown as SecretsService;
}

const INPUT = {
  instanceId: 'inst-crm',
  slug: 'crm',
  baseUrl: 'http://crm:8080/api',
  path: '/users/roles',
  roleField: 'role',
  secretName: 'crm-admin-token',
  subjectIdpId: 'sub-1',
  email: 'lena@example.test',
  productRole: 'Manager',
};

beforeEach(() => {
  call.postProductJson.mockReset();
  call.postProductJson.mockResolvedValue({ ok: true, detail: 'HTTP 201' });
});

describe('ProductIdentityPushService', () => {
  it('does nothing at all while pushing is switched off', async () => {
    const service = new ProductIdentityPushService(
      config({ SEAMNEX_IDENTITY_PUSH_ENABLED: false }),
      secrets(),
    );

    const outcome = await service.push(INPUT);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('SEAMNEX_IDENTITY_PUSH_ENABLED');
    // Nothing is read from the secret store and no container starts: a disabled platform is silent.
    expect(call.postProductJson).not.toHaveBeenCalled();
  });

  it('reports a missing credential instead of pushing unauthenticated', async () => {
    const service = new ProductIdentityPushService(
      config(),
      secrets({ find: vi.fn(async () => null) }),
    );

    const outcome = await service.push(INPUT);

    expect(outcome).toEqual({
      ok: false,
      detail: 'instance secret "crm-admin-token" is not stored, so the role was not pushed',
    });
    expect(call.postProductJson).not.toHaveBeenCalled();
  });

  it('reports a credential the root key cannot open', async () => {
    const service = new ProductIdentityPushService(
      config(),
      secrets({
        open: vi.fn(async () => {
          throw new Error('sealed box unreadable');
        }),
      }),
    );

    const outcome = await service.push(INPUT);

    expect(outcome).toEqual({
      ok: false,
      detail: 'instance secret "crm-admin-token" could not be opened',
    });
    // The thrown message is not echoed: it can name the key material that failed.
    expect(JSON.stringify(outcome)).not.toContain('sealed box');
    expect(call.postProductJson).not.toHaveBeenCalled();
  });

  it('pushes the mapping product role to the verified API origin on the instance network', async () => {
    const store = secrets();
    const service = new ProductIdentityPushService(config(), store);

    const outcome = await service.push(INPUT);

    expect(outcome).toEqual({ ok: true, detail: 'HTTP 201' });

    // The read is scoped to the instance, so a drifted secret name cannot reach another instance.
    expect(store.find).toHaveBeenCalledWith('instance', 'inst-crm', 'crm-admin-token');
    expect(store.open).toHaveBeenCalledWith('secret-1', 'identity role push', {
      scope: 'instance',
      ownerId: 'inst-crm',
    });

    expect(call.postProductJson).toHaveBeenCalledWith(
      expect.objectContaining({
        network: 'seamnex-inst-crm',
        host: 'crm',
        port: 8080,
        // The verified base carries `/api`; the declared path is below it.
        path: '/api/users/roles',
        bearerToken: 'token-value',
        timeoutMs: 5_000,
      }),
    );
    const payload = JSON.parse(
      call.postProductJson.mock.calls[0]?.[0].payload as string,
    ) as unknown;
    expect(payload).toEqual({ role: 'Manager', subject: 'sub-1', email: 'lena@example.test' });
  });

  it('falls back to the product service alias when no verified origin was recorded', async () => {
    const service = new ProductIdentityPushService(config(), secrets());

    await service.push({ ...INPUT, baseUrl: null });

    expect(call.postProductJson).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'crm', port: 80, path: '/users/roles' }),
    );
  });

  it('falls back to the alias when the recorded origin cannot be parsed', async () => {
    const service = new ProductIdentityPushService(config(), secrets());

    await service.push({ ...INPUT, baseUrl: 'not a url' });

    expect(call.postProductJson).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'crm', port: 80, path: '/users/roles' }),
    );
  });

  it('keeps a bare origin addressable on the default port', async () => {
    const service = new ProductIdentityPushService(config(), secrets());

    await service.push({ ...INPUT, baseUrl: 'http://crm' });

    expect(call.postProductJson).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'crm', port: 80, path: '/users/roles' }),
    );
  });

  it('delegates the helper call to the shared exec wrapper', async () => {
    call.run.mockResolvedValue({ code: 0, stdout: 'HTTP 200\n', stderr: '', truncated: false });
    const service = new ProductIdentityPushService(config(), secrets());

    await service.push(INPUT);
    const handed = call.postProductJson.mock.calls[0]?.[0] as {
      runCli: (
        file: string,
        args: string[],
        options: { timeoutMs: number; input: string },
      ) => Promise<unknown>;
    };
    await handed.runCli('docker', ['run', '--rm'], { timeoutMs: 10, input: 'x' });

    expect(call.run).toHaveBeenCalledWith('docker', ['run', '--rm'], { timeoutMs: 10, input: 'x' });
  });

  it('accepts an origin whose port is unusable and a path without a leading slash', async () => {
    const service = new ProductIdentityPushService(config(), secrets());

    await service.push({ ...INPUT, baseUrl: 'http://crm:0/api', path: 'users/roles' });

    // Port 0 names no service, so the platform falls back to the default and keeps the path.
    expect(call.postProductJson).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'crm', port: 80, path: '/api/users/roles' }),
    );
  });

  it('returns the refusal the product gave, so the entitlement can say why it is pending', async () => {
    call.postProductJson.mockResolvedValue({ ok: false, detail: 'HTTP 403' });
    const service = new ProductIdentityPushService(config(), secrets());

    const outcome = await service.push(INPUT);

    expect(outcome).toEqual({ ok: false, detail: 'HTTP 403' });
  });
});
