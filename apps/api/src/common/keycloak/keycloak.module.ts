import { Module } from '@nestjs/common';
import { KeycloakAdminClient } from './keycloak-admin.client';
import { KeycloakDirectoryReader } from './keycloak-directory.reader';

/**
 * The platform's own Keycloak credentials, shared by everything that speaks the Admin API:
 * per-instance client provisioning (M07), the restore gate's realm export (M16) and the identity
 * mirror (M08, through the identity provider).
 *
 * It lives in `common` rather than in one of those modules because none of them owns it: a client
 * registered by the deployment path and a user listed by the sync must be the same realm, seen
 * through the same credential. Nest instantiates a module once, so every importer shares one token
 * cache instead of each holding its own.
 */
@Module({
  providers: [KeycloakAdminClient, KeycloakDirectoryReader],
  exports: [KeycloakAdminClient, KeycloakDirectoryReader],
})
export class KeycloakModule {}
