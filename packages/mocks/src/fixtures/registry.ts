import { VERIFIED_FACT_KEYS, isWorkflowEligible, isWriteEligible } from '@seamnex/domain';
import type { RegistryEntry, VerifiedFactKey } from '@seamnex/domain';
import { CATALOG_BY_KEY } from './catalog';
import { INSTANCES } from './instances';

/**
 * Entries whose integration facts are still catalogue assumptions.
 *
 * FR-2.14 requires verification at onboarding, and AC-41 requires the registry to say which facts
 * were actually checked. Two products in the demo never went through it, so they carry no verified
 * facts and the console labels their values "catalog assumption" instead of stamping a verification
 * date over them — the surface AC-41 is about.
 */
const CATALOG_ASSUMED_ENTRIES = new Set(['D12-01', 'D13-01']);

/**
 * The registry is a projection of each instance's verified facts, so the eligibility flags are
 * derived from the granularity by the same domain helpers the API uses. `!== 'none'` used to treat
 * an account-wide credential as write-capable, which contradicted C-11 and the option text on the
 * catalog screen.
 */
export const REGISTRY: RegistryEntry[] = INSTANCES.flatMap((instance) => {
  const entry = CATALOG_BY_KEY[instance.entryKey];
  if (!entry) return [];
  const assumed = CATALOG_ASSUMED_ENTRIES.has(entry.key);
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
      sloSupported: entry.integration.sloSupported,
      verifiedFacts: assumed ? [] : ([...VERIFIED_FACT_KEYS] as VerifiedFactKey[]),
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
