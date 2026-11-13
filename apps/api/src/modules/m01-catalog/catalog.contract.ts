import type { CatalogEntry, CatalogReloadResult, CredentialGranularity } from '@seamnex/domain';
import type { CatalogWorkingTree } from '../m22-catalog-repository/catalog-repo.contract';

export const CATALOG_SERVICE = Symbol('seamnex.m01.catalog');

/** FR-2.14: the verified facts an operator may correct on the catalog screen. */
export type IntegrationMetadataPatch = {
  credentialGranularity?: CredentialGranularity;
  sessionMaxMinutes?: number;
};

/** Owns catalog_entry, catalog_entry_revision, deployment_definition, integration_metadata. */
export interface CatalogService {
  list(filter: { q?: string; cluster?: string; packaging?: string }): Promise<CatalogEntry[]>;
  entry(key: string): Promise<CatalogEntry>;
  /**
   * Reads the working tree and writes the projection. Reports a real added/changed/removed delta.
   *
   * The tree may be handed in when the caller already read it — `POST /catalog/reload` reconciles
   * entries and environment schemas from one read, so the two halves cannot disagree about which
   * revision they applied.
   */
  reload(input: { actorId: string; tree?: CatalogWorkingTree }): Promise<CatalogReloadResult>;
  /**
   * Records a verified review (FR-2.14). Writes the entry document *and* the per-instance
   * `integration_metadata` rows that invariant 4, the credential broker and the registry read.
   */
  patchIntegrationMetadata(
    key: string,
    patch: IntegrationMetadataPatch,
    actorId: string,
  ): Promise<CatalogEntry>;
}
