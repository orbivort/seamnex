import { Global, Module } from '@nestjs/common';
import { AccessControlModule } from '../../modules/m09-access-control/access-control.module';
import { PortalBffModule } from '../../modules/m10-portal-bff/portal-bff.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { KeycloakAdminClient } from '../keycloak/keycloak-admin.client';
import { KeycloakDirectoryReader } from '../keycloak/keycloak-directory.reader';
import { KeycloakModule } from '../keycloak/keycloak.module';
import { IDENTITY_PROVIDER, type IdentityProvider } from './identity-provider.contract';
import { IDENTITY_RESOLVER } from './identity.resolver';
import { OidcIdentityProvider } from './oidc/oidc-identity.provider';
import { SessionIdentityResolver } from './session-identity.resolver';
import { StubIdentityProvider } from './stub-identity.provider';

/**
 * One binding decides who the platform believes.
 *
 * `stub` is the development affordance: the browser chooses the authorization code, so it proves
 * nothing, and the config schema refuses it outside development (ADR-BE-13). `oidc` is Keycloak:
 * the code is redeemed server-side at the token endpoint and the ID token is verified against the
 * realm's published keys (ADR-BE-14). The session surface above this seam is identical for both,
 * which is why the swap is a binding and not a rewrite.
 */
@Global()
@Module({
  imports: [AccessControlModule, PortalBffModule, KeycloakModule],
  providers: [
    SessionIdentityResolver,
    { provide: IDENTITY_RESOLVER, useExisting: SessionIdentityResolver },
    {
      provide: IDENTITY_PROVIDER,
      inject: [APP_CONFIG, KeycloakDirectoryReader, KeycloakAdminClient],
      useFactory: (
        config: AppConfig,
        directory: KeycloakDirectoryReader,
        admin: KeycloakAdminClient,
      ): IdentityProvider => {
        if (config.AUTH_PROVIDER === 'oidc') {
          return new OidcIdentityProvider({
            config,
            directory: () => directory.snapshot(),
            // The mirror is rebuilt from the realm, so `disable` must be written to the realm.
            admin: { setUserEnabled: (sub, enabled) => admin.setUserEnabled(sub, enabled) },
          });
        }
        return new StubIdentityProvider(config);
      },
    },
  ],
  exports: [IDENTITY_RESOLVER, IDENTITY_PROVIDER],
})
export class IdentityModule {}
