import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import {
  AccessRequestSchema,
  CatalogEntrySchema,
  CatalogReloadResultSchema,
  EnvImportResultSchema,
  EnvPlanSchema,
  EnvProfileDeleteResponseSchema,
  EnvProfileSchema,
  EnvSchemaVarSchema,
  JobAcceptedSchema,
  ScaffoldConfirmationSchema,
  ScaffoldDraftSchema,
  type CredentialGranularity,
  type EventMode,
  type GuaranteeClass,
  type Operation,
} from '@seamnex/domain';
import { request } from '../http';
import { queryKeys } from '../query-keys';

const CatalogListSchema = z.array(CatalogEntrySchema);
const EnvSchemaListSchema = z.array(EnvSchemaVarSchema);
const EnvProfileListSchema = z.array(EnvProfileSchema);

export type CatalogFilters = {
  q?: string;
  cluster?: string;
  packaging?: string;
};

/**
 * FR-2.14/FR-2.15: the facts a verification may record.
 *
 * An omitted field means "leave the recorded fact alone" — it never resets the value to the catalogue
 * document. The server refuses an object with no fact in it at all.
 */
export type IntegrationMetadataVerification = {
  credentialGranularity?: CredentialGranularity;
  sessionMaxMinutes?: number;
  apiBaseUrl?: string;
  authMethod?: string;
  guaranteeClass?: GuaranteeClass;
  operationInventory?: Operation[];
  eventModes?: EventMode[];
  sloSupported?: boolean;
};

export function useCatalog(filters: CatalogFilters = {}) {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.cluster) params.set('cluster', filters.cluster);
  if (filters.packaging) params.set('packaging', filters.packaging);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';

  return useQuery({
    queryKey: [...queryKeys.catalog, filters] as const,
    queryFn: ({ signal }) => request(`/catalog${suffix}`, { schema: CatalogListSchema, signal }),
    // Search and packaging filters each produce a new key; the previous page stays on screen
    // while the next one loads instead of collapsing to a skeleton per keystroke.
    placeholderData: keepPreviousData,
  });
}

/** Resolved environment preview: default → profile → instance → secret, ceilings enforced. */
export function useEnvPlan(
  key: string,
  profileKey: string,
  overrides: Record<string, string>,
  enabled = true,
) {
  const params = new URLSearchParams({ profile: profileKey });
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== '') params.set(`env.${name}`, value);
  }
  return useQuery({
    queryKey: queryKeys.envPlan(key, profileKey, overrides),
    queryFn: ({ signal }) =>
      request(`/catalog/${key}/env-plan?${params.toString()}`, { schema: EnvPlanSchema, signal }),
    enabled: enabled && key.length > 0,
  });
}

export function useCatalogEntry(key: string) {
  return useQuery({
    queryKey: queryKeys.catalogEntry(key),
    queryFn: ({ signal }) => request(`/catalog/${key}`, { schema: CatalogEntrySchema, signal }),
    enabled: key.length > 0,
  });
}

export function useEnvSchema(key: string) {
  return useQuery({
    queryKey: queryKeys.envSchema(key),
    queryFn: ({ signal }) =>
      request(`/catalog/${key}/env-schema`, { schema: EnvSchemaListSchema, signal }),
    enabled: key.length > 0,
  });
}

export function useEnvProfiles() {
  return useQuery({
    queryKey: queryKeys.envProfiles,
    queryFn: ({ signal }) => request('/env-profiles', { schema: EnvProfileListSchema, signal }),
  });
}

/**
 * FR-1.26 / AC-51 — the profile writes R1 owns.
 *
 * The profile is what the wizard selects and what an instance pins itself to, so a write invalidates
 * both the list and every resolved plan under `catalog`: a stale plan would keep showing the value
 * the save just replaced.
 */
function useEnvProfileWrite<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.envProfiles });
      void client.invalidateQueries({ queryKey: queryKeys.catalog });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
      void client.invalidateQueries({ queryKey: queryKeys.instances });
    },
  });
}

export function useCreateEnvProfile() {
  return useEnvProfileWrite(
    (body: { key: string; name: string; target: 'production' | 'staging' }) =>
      request('/env-profiles', { schema: EnvProfileSchema, method: 'POST', body }),
  );
}

export function usePatchEnvProfile() {
  return useEnvProfileWrite(
    (input: { key: string; name?: string; target?: 'production' | 'staging' }) =>
      request(`/env-profiles/${input.key}`, {
        schema: EnvProfileSchema,
        method: 'PATCH',
        body: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.target === undefined ? {} : { target: input.target }),
        },
      }),
  );
}

export type EnvProfileValueWrite = {
  varName: string;
  value?: string | null;
  secretRef?: string | null;
};

export function useReplaceEnvProfileValues() {
  return useEnvProfileWrite((input: { key: string; values: EnvProfileValueWrite[] }) =>
    request(`/env-profiles/${input.key}/values`, {
      schema: EnvProfileSchema,
      method: 'PUT',
      body: { values: input.values },
    }),
  );
}

export function useDeleteEnvProfile() {
  return useEnvProfileWrite((key: string) =>
    request(`/env-profiles/${key}`, { schema: EnvProfileDeleteResponseSchema, method: 'DELETE' }),
  );
}

/**
 * FR-1.26: a role that may not write profiles still needs a way to ask for the change.
 *
 * The request lands in the governance queue as an access request, so a domain owner's refusal is a
 * recorded decision rather than a dead button. The hook is separate from the write hooks on purpose:
 * `profile.request` and `profile.manage` are different capabilities, and the console shows whichever
 * one the role holds.
 */
export function useRequestProfileChange() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string; justification: string }) =>
      request(`/env-profiles/${input.key}/requests`, {
        schema: AccessRequestSchema,
        method: 'POST',
        body: { justification: input.justification },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.accessRequests });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/**
 * FR-1.26 / AC-51 — the declared variables of many entries at once.
 *
 * The profile editor has to answer "who declares this variable, and what ceiling applies?" for every
 * value on the screen. The schema is served per entry, so this fans out over the catalog — with the
 * same `envSchema(entry)` key the entry screen uses, which means the requests are shared rather than
 * repeated when an operator opens an entry afterwards.
 */
export function useEnvSchemas(keys: readonly string[]) {
  return useQueries({
    queries: keys.map((key) => ({
      queryKey: queryKeys.envSchema(key),
      queryFn: () => request(`/catalog/${key}/env-schema`, { schema: EnvSchemaListSchema }),
      enabled: key.length > 0,
      // A failed schema is left as a failed query: the screen says the declaration is unavailable
      // instead of pretending the entry declares nothing.
      retry: false,
      staleTime: 60_000,
    })),
  });
}

export function useScaffoldDraft(key: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.scaffold(key),
    queryFn: ({ signal }) =>
      request(`/catalog/${key}/scaffold`, { schema: ScaffoldDraftSchema, signal }),
    enabled: enabled && key.length > 0,
    retry: false,
  });
}

export function useVerifyIntegrationMetadata(key: string) {
  const client = useQueryClient();
  return useMutation({
    // FR-2.14: every fact onboarding is supposed to verify, not only the two that were convenient to
    // store. The schema refuses an empty body — a review with no evidence would restart the clock.
    mutationFn: (body: IntegrationMetadataVerification) =>
      request(`/catalog/${key}/integration-metadata`, {
        schema: CatalogEntrySchema,
        method: 'PATCH',
        body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.catalogEntry(key) });
      void client.invalidateQueries({ queryKey: queryKeys.catalog });
      void client.invalidateQueries({ queryKey: queryKeys.posture });
      void client.invalidateQueries({ queryKey: queryKeys.registry });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/** FR-1.18 / DD-07: re-read the declarative source and report the reconciliation delta. */
export function useReloadCatalog() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request('/catalog/reload', { schema: CatalogReloadResultSchema, method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.catalog });
      void client.invalidateQueries({ queryKey: queryKeys.posture });
      void client.invalidateQueries({ queryKey: queryKeys.registry });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/** FR-1.30: map a pasted `.env` or Compose environment into the declared schema. */
export function useEnvImport(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { source: 'dotenv' | 'compose'; content: string }) =>
      request(`/catalog/${key}/env-import`, {
        schema: EnvImportResultSchema,
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

/**
 * CL-18: warm the image cache before a deployment window. NFR-2.4 measures apply, not download,
 * so the pull is a job an operator can start early rather than part of the deploy.
 */
export function usePrefetchEntry(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request(`/catalog/${key}/prefetch`, { schema: JobAcceptedSchema, method: 'POST' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

/**
 * FR-1.22: a generated draft stays a draft until the operator confirms it. Without this
 * mutation the scaffold tab was review-only and the requirement could not be demonstrated.
 */
export function useConfirmScaffold(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) =>
      request(`/catalog/${key}/scaffold/${draftId}/confirm`, {
        schema: ScaffoldConfirmationSchema,
        method: 'POST',
      }),
    onSuccess: (confirmed) => {
      // The confirmed draft carries the approver, so write it straight into the cache:
      // refetching would return the pre-confirmation fixture.
      client.setQueryData(queryKeys.scaffold(key), confirmed);
      void client.invalidateQueries({ queryKey: queryKeys.catalogEntry(key) });
      void client.invalidateQueries({ queryKey: queryKeys.catalog });
      void client.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}
