import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config';
import { IdentityModule } from '../../../../src/common/identity/identity.module';
import { IDENTITY_PROVIDER } from '../../../../src/common/identity/identity-provider.contract';
import { IDENTITY_RESOLVER } from '../../../../src/common/identity/identity.resolver';
import { OidcIdentityProvider } from '../../../../src/common/identity/oidc/oidc-identity.provider';
import { StubIdentityProvider } from '../../../../src/common/identity/stub-identity.provider';
import { SessionIdentityResolver } from '../../../../src/common/identity/session-identity.resolver';

/**
 * One binding decides who the platform believes. The factory is the whole of that decision, so it
 * is called directly with both configurations rather than booting a container.
 */
type ProviderFactory = (
  config: AppConfig,
  directory: { snapshot: () => Promise<unknown> },
  admin: { setUserEnabled: (sub: string, enabled: boolean) => Promise<void> },
) => unknown;

function factory(): ProviderFactory {
  const providers = Reflect.getMetadata('providers', IdentityModule) as Array<{
    provide: symbol;
    useFactory?: ProviderFactory;
  }>;
  const provider = providers.find((candidate) => candidate.provide === IDENTITY_PROVIDER);
  if (provider?.useFactory === undefined) throw new Error('IDENTITY_PROVIDER factory is missing');
  return provider.useFactory;
}

const directory = { snapshot: vi.fn() };
const admin = { setUserEnabled: vi.fn() };

describe('IdentityModule', () => {
  it('binds the stub provider outside an OIDC deployment', () => {
    const provider = factory()({ AUTH_PROVIDER: 'stub' } as AppConfig, directory, admin);
    expect(provider).toBeInstanceOf(StubIdentityProvider);
  });

  it('binds the OIDC provider for an OIDC deployment', () => {
    const provider = factory()(
      {
        AUTH_PROVIDER: 'oidc',
        authIssuer: 'https://keycloak.test/realms/seamnex',
        authInternalBase: 'http://keycloak:8080',
        AUTH_DISCOVERY_CACHE_SECONDS: 300,
        AUTH_HTTP_TIMEOUT_MS: 5_000,
        AUTH_CLIENT_ID: 'seamnex-portal',
        AUTH_REDIRECT_PATHS: ['/auth/callback'],
        AUTH_SCOPES: 'openid profile email',
        SEAMNEX_ROLE: 'api',
      } as unknown as AppConfig,
      directory,
      admin,
    );

    expect(provider).toBeInstanceOf(OidcIdentityProvider);
    expect((provider as OidcIdentityProvider).name).toBe('oidc');
  });

  it('wires the directory reader and the admin write path into the OIDC provider', async () => {
    const provider = factory()(
      {
        AUTH_PROVIDER: 'oidc',
        authIssuer: 'https://keycloak.test/realms/seamnex',
        authInternalBase: 'http://keycloak:8080',
        AUTH_DISCOVERY_CACHE_SECONDS: 300,
        AUTH_HTTP_TIMEOUT_MS: 5_000,
        AUTH_CLIENT_ID: 'seamnex-portal',
        AUTH_REDIRECT_PATHS: ['/auth/callback'],
        AUTH_SCOPES: 'openid profile email',
        SEAMNEX_ROLE: 'api',
      } as unknown as AppConfig,
      directory,
      admin,
    ) as OidcIdentityProvider;

    const snapshot = { users: [], groups: [] };
    directory.snapshot.mockResolvedValue(snapshot);
    await expect(provider.directory()).resolves.toBe(snapshot);

    await provider.setUserEnabled('sub-1', false);
    expect(admin.setUserEnabled).toHaveBeenCalledWith('sub-1', false);
  });

  it('resolves the resolver to the session implementation', () => {
    const providers = Reflect.getMetadata('providers', IdentityModule) as Array<{
      provide: symbol;
      useExisting?: unknown;
    }>;
    const alias = providers.find((candidate) => candidate.provide === IDENTITY_RESOLVER);
    expect(alias?.useExisting).toBe(SessionIdentityResolver);
  });

  it('exports both tokens its consumers depend on', () => {
    const exports = Reflect.getMetadata('exports', IdentityModule) as unknown[];
    expect(exports).toContain(IDENTITY_RESOLVER);
    expect(exports).toContain(IDENTITY_PROVIDER);
  });

  it('is global, so a guarded controller in any module can resolve identity', () => {
    expect(Reflect.getMetadata('__module:global__', IdentityModule)).toBe(true);
  });
});
