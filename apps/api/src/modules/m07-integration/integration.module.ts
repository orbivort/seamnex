import { Module } from '@nestjs/common';
import { DockerModule } from '../../common/docker/docker.module';
import { KeycloakModule } from '../../common/keycloak/keycloak.module';
import { SecretsModule } from '../m15-secrets/secrets.module';
import { RendererModule } from '../m03-renderer/renderer.module';
import { INTEGRATION_SERVICE } from './integration.contract';
import { PostgresIntegrationService } from './integration.service';
import { SsoProbe } from './sso.probe';
import { TraefikRouteWriter } from './traefik.writer';

/**
 * M07 - identity clients, edge routes and integration checks (4D.1, 4D.2, 4D.5).
 *
 * The Traefik writer is exported so the restore gate projects through the same writer: two writers
 * would mean two file formats for one provider.
 */
@Module({
  // The admin client is provided by `KeycloakModule` and re-exported here, so the deployment path
  // and the identity mirror share one credential and one token cache.
  //
  // `RendererModule` is here for the one value this module has to *apply*, not merely store: the
  // product's copy of the OIDC client secret is an `instance_env_value` row, and that table belongs to
  // M03. Reaching it through its contract keeps the validation and the audit on the same write path as
  // every other environment change.
  imports: [DockerModule, KeycloakModule, SecretsModule, RendererModule],
  providers: [
    TraefikRouteWriter,
    SsoProbe,
    { provide: INTEGRATION_SERVICE, useClass: PostgresIntegrationService },
  ],
  // `KeycloakModule` is re-exported as a module: a provider supplied by an imported module cannot
  // be exported by name, and M16 (backup/restore) still needs the admin client through this import.
  exports: [INTEGRATION_SERVICE, TraefikRouteWriter, KeycloakModule],
})
export class IntegrationModule {}
