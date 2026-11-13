import { Module } from '@nestjs/common';
import { DockerModule } from '../../common/docker/docker.module';
import { IntegrationModule } from '../m07-integration/integration.module';
import { RendererModule } from '../m03-renderer/renderer.module';
import { SecretsModule } from '../m15-secrets/secrets.module';
import { ADMIN_CREDENTIAL_SERVICE, PRODUCT_ACCOUNT_SERVICE, SIGN_IN_RELAY } from './relay.contract';
import { PostgresProductAccountService } from './product-account.service';
import { PostgresAdminCredentialService } from './admin-credential.service';
import { ProductApiClient } from './product-api.client';
import { OrangeHrmApiClient } from './adapters/orangehrm-api';
import { ProductApiAdapters } from './provisioning-adapters';
import { RelaySignInService } from './relay.service';
import { RelayProvisionTrigger } from './relay-provision.trigger';

/**
 * M24 — the sign-in relay (ADR-BE-22).
 *
 * It owns one table (`product_account`), which is why it is a module rather than a corner of M11:
 * the forward-auth gateway is deliberately table-free and looks up only the route and the
 * entitlement on its hot path. Adding a credential mapping there would have made an authentication
 * decision and a credential lifecycle the same object.
 *
 * M15 and M17 are cross-cutting (manifest `crossCutting`), so the secret store and the audit chain
 * are imported as interfaces, never as tables.
 */
@Module({
  imports: [DockerModule, SecretsModule, IntegrationModule, RendererModule],
  providers: [
    ProductApiClient,
    OrangeHrmApiClient,
    ProductApiAdapters,
    { provide: SIGN_IN_RELAY, useClass: RelaySignInService },
    { provide: PRODUCT_ACCOUNT_SERVICE, useClass: PostgresProductAccountService },
    { provide: ADMIN_CREDENTIAL_SERVICE, useClass: PostgresAdminCredentialService },
    // The deployment that needs a mapping asks for it, instead of waiting for the next sweep.
    RelayProvisionTrigger,
  ],
  exports: [SIGN_IN_RELAY, PRODUCT_ACCOUNT_SERVICE, ADMIN_CREDENTIAL_SERVICE],
})
export class RelayModule {}
