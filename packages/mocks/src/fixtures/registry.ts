import type { RegistryEntry } from '@seamnex/domain';
import { isWorkflowEligible, isWriteEligible } from '@seamnex/domain';
import { CATALOG_BY_KEY } from './catalog';
import { INSTANCES } from './instances';

/**
 * The registry is a projection of each instance's verified facts, so the eligibility flags are
 * derived from the granularity by the same domain helpers the API uses. `!== 'none'` used to treat
 * an account-wide credential as write-capable, which contradicted C-11 and the option text on the
 * catalog screen.
 */
export const REGISTRY: RegistryEntry[] = INSTANCES.flatMap((instance) => {
  const entry = CATALOG_BY_KEY[instance.entryKey];
  if (!entry) return [];
  return [
    {
      instanceId: instance.id,
      entryKey: instance.entryKey,
      product: instance.product,
      slug: instance.slug,
      route: `https://${instance.domainRoute}/`,
      version: instance.currentVersion,
      apiBaseUrl: entry.integration.apiBaseUrl,
      authMethod: entry.integration.authMethod,
      guaranteeClass: entry.guaranteeClass,
      operations: entry.integration.operationInventory,
      eventModes: entry.integration.eventModes,
      credentialGranularity: entry.integration.credentialGranularity,
      writeEligible: isWriteEligible(entry.integration.credentialGranularity),
      workflowEligible: isWorkflowEligible(entry.integration.credentialGranularity),
      owner: entry.owner.name,
      verifiedAt: entry.integration.verifiedAt,
      nextReviewAt: entry.integration.nextReviewAt,
      stale: entry.integration.stale,
    },
  ];
});

export const REGISTRY_BY_SLUG: Record<string, RegistryEntry> = Object.fromEntries(
  REGISTRY.map((entry) => [entry.slug, entry]),
);
