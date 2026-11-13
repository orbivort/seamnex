import { z } from 'zod';
import {
  CREDENTIAL_GRANULARITIES,
  DOMAIN_CLUSTERS,
  ENV_TYPES,
  GUARANTEE_CLASSES,
  OPERATION_MODES,
  PRODUCT_HTTP_METHODS,
  OVERRIDE_CEILINGS,
  PACKAGING_KINDS,
  SERVICE_ROLES,
} from '../enums';
import { EntryKeySchema, FieldErrorSchema, IdSchema, TimestampSchema } from './common';
import { EnvVarRuleSchema, ruleIssues } from '../env-rules';

/**
 * A discovered operation, plus the address it is called at.
 *
 * `path` is absolute from the **product origin**, never from `integration.apiBaseUrl`: the document's
 * base already carries a prefix (`/api/v1`, `/web/index.php/api/v2`), and joining the two produced
 * `/api/v1/api/v1/Contact`. Both fields are optional because an inventory may describe an operation
 * before anyone has measured its endpoint — the compiler and the broker both refuse an operation
 * without them, so "discovered but not callable" is a stated state rather than a guessed URL.
 */
export const OperationSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  mode: z.enum(OPERATION_MODES),
  description: z.string().min(1),
  path: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('/'), 'path must start with "/"')
    .optional(),
  method: z.enum(PRODUCT_HTTP_METHODS).optional(),
});

export const EventModeSchema = z.object({
  mode: z.enum(['webhook', 'schedule', 'poll', 'none']),
  label: z.string().min(1),
  minimumIntervalMinutes: z.number().int().positive().optional(),
});

/** FR-1.1 integration attributes, verified at onboarding (FR-2.14). */
export const IntegrationMetadataSchema = z.object({
  apiBaseUrl: z.string().min(1),
  authMethod: z.string().min(1),
  guaranteeClassVerified: z.enum(GUARANTEE_CLASSES),
  operationInventory: z.array(OperationSchema),
  eventModes: z.array(EventModeSchema),
  credentialGranularity: z.enum(CREDENTIAL_GRANULARITIES),
  sessionMaxMinutes: z.number().int().positive(),
  sloSupported: z.boolean(),
  verifiedBy: z.string().min(1),
  verifiedAt: TimestampSchema,
  nextReviewAt: TimestampSchema,
  stale: z.boolean(),
});

export const ResourceShapeSchema = z.object({
  cpu: z.number().positive(),
  memoryMb: z.number().int().positive(),
  diskMb: z.number().int().positive(),
});

export const VolumeSpecSchema = z.object({
  name: z.string().min(1),
  mountPath: z.string().min(1),
  quotaMb: z.number().int().positive(),
});

/**
 * Upstream release and advisory state (FR-2.12). `latestVersion` equal to
 * `currentVersion` means nothing is pending; `advisory` names an open security advisory.
 */
export const UpstreamStatusSchema = z.object({
  currentVersion: z.string().min(1),
  latestVersion: z.string().min(1),
  advisory: z.string().nullable(),
  releaseUrl: z.string().min(1),
  checkedAt: TimestampSchema,
});

export const CatalogEntrySchema = z.object({
  key: EntryKeySchema,
  domain: z.string().min(1),
  cluster: z.enum(DOMAIN_CLUSTERS),
  product: z.string().min(1),
  description: z.string().min(1),
  repoUrl: z.string().min(1),
  licenseId: z.string().min(1),
  licenseNote: z.string().optional(),
  stack: z.string().min(1),
  /** FR-1.5: every image reference is pinned; neither field may be a floating tag. */
  imageRef: z.string().min(1),
  imageDigest: z.string().min(1),
  upstream: UpstreamStatusSchema,
  guaranteeClass: z.enum(GUARANTEE_CLASSES),
  authMethod: z.string().min(1),
  packaging: z.enum(PACKAGING_KINDS),
  packagingSource: z.string().min(1),
  primaryInstanceId: IdSchema.nullable(),
  sharedWith: z.array(EntryKeySchema),
  httpPort: z.number().int().positive(),
  resources: ResourceShapeSchema,
  dependencies: z.array(z.enum(SERVICE_ROLES)),
  volumes: z.array(VolumeSpecSchema),
  integration: IntegrationMetadataSchema,
  owner: z.object({ name: z.string().min(1), team: z.string().min(1) }),
  notes: z.string().min(1),
  deviation: z.string().optional(),
  verifiedAt: TimestampSchema,
});

export const EnvSchemaVarSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().min(1),
  type: z.enum(ENV_TYPES),
  required: z.boolean(),
  defaultValue: z.string().nullable(),
  constraint: z.string().nullable(),
  conditional: z.string().nullable(),
  secret: z.boolean(),
  overrideCeiling: z.enum(OVERRIDE_CEILINGS),
  options: z.array(z.string()).optional(),
  /**
   * The enforceable half of `constraint`. Optional, so a declaration written before rules existed
   * still loads; when present it is enforced by `checkEnvValue` wherever a value resolves.
   */
  rule: EnvVarRuleSchema.optional(),
  /**
   * Repository revision that declared this variable, `null` for rows written before the schema was
   * projected from `catalog/env/`. Served so the entry screen can say *where* a declaration came
   * from instead of only *what* it says.
   */
  revision: z.string().nullable().optional(),
});

/** The only repository format this build accepts; a future v2 can be read side by side. */
export const ENV_SCHEMA_FORMAT = 'env-schema/v1';

/**
 * One `catalog/env/<KEY>.json`. The loader validates the file with this schema before anything is
 * written, so the authoring rules below are enforced at the boundary that humans edit — not only
 * when a value is finally resolved at deploy time.
 *
 * Rules that exist because their absence has already cost a deployment:
 *   - `secret` and `type: 'secret'` are the same statement, spelled twice; disagreement is a bug.
 *   - a secret may not carry a default: a credential in Git is the failure the secret store exists
 *     to prevent.
 *   - an `enum` must list its options, or the wizard renders an empty `<Select>` (which is exactly
 *     what `ESPOCRM_CONFIG_AUTHENTICATION_METHOD` did while the options lived only inside a
 *     `constraint` string).
 *   - a required variable capped at `none` can never be supplied by anybody, so the entry could
 *     never deploy; that is an authoring error, not a runtime one.
 *   - a `rule` must be correct before it is enforced: an inverted length range, an uncompilable
 *     pattern or a rule on a boolean is refused at load, where a human is still editing the file.
 */
export const EnvSchemaFileSchema = z
  .object({
    format: z.literal(ENV_SCHEMA_FORMAT),
    entryKey: EntryKeySchema,
    /** The image this schema was written against; a mismatch is a review warning, not a load error. */
    appliesTo: z.object({ imageRef: z.string().min(1) }).optional(),
    variables: z.array(EnvSchemaVarSchema),
  })
  .superRefine((file, ctx) => {
    const seen = new Map<string, number>();

    file.variables.forEach((variable, index) => {
      const at = ['variables', index] as const;

      if (!/^[A-Z][A-Z0-9_]*$/.test(variable.name)) {
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'name'],
          message: 'Use upper-case letters, digits and underscores, starting with a letter.',
        });
      }

      const first = seen.get(variable.name);
      if (first !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'name'],
          message: `Duplicate declaration; first declared at variables.${first}.`,
        });
      } else {
        seen.set(variable.name, index);
      }

      if (variable.secret !== (variable.type === 'secret')) {
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'secret'],
          message: '`secret` must be true exactly when `type` is "secret".',
        });
      }

      if (variable.secret && variable.defaultValue !== null) {
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'defaultValue'],
          message: 'A secret may not carry a default value; the value belongs in the secret store.',
        });
      }

      if (variable.type === 'enum') {
        if (variable.options === undefined || variable.options.length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'options'],
            message: 'An enum must list its options, or the wizard has nothing to choose from.',
          });
        } else if (
          variable.defaultValue !== null &&
          !variable.options.includes(variable.defaultValue)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'defaultValue'],
            message: 'The default is not one of the declared options.',
          });
        }
      }

      // Locked is fine when the catalog itself supplies the value (`ESPOCRM_DATABASE_HOST`); it is
      // unsatisfiable when nobody may set it and there is no default to fall back on.
      if (
        variable.overrideCeiling === 'none' &&
        variable.required &&
        variable.defaultValue === null
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [...at, 'overrideCeiling'],
          message:
            'Required, capped at "none" and no default: no profile or instance may supply it, so nothing could deploy.',
        });
      }

      // The rule is enforced from the moment the file is projected, so a mistake in the rule itself
      // is refused here rather than as a 422 on somebody's deployment twenty minutes later.
      if (variable.rule !== undefined) {
        ruleIssues(variable).forEach((message) => {
          ctx.addIssue({ code: 'custom', path: [...at, 'rule'], message });
        });
      }
    });
  });

export type EnvSchemaFile = z.infer<typeof EnvSchemaFileSchema>;

/** The resolved environment plan used by the deployment wizard. */
export const EnvPlanValueSchema = EnvSchemaVarSchema.extend({
  value: z.string().nullable(),
  source: z.enum(['default', 'profile', 'instance', 'secret']),
  masked: z.boolean(),
  error: z.string().nullish(),
  requiresRecreate: z.boolean().default(false),
});

/** Resolved environment for a catalog entry, profile and optional instance overrides. */
export const EnvPlanSchema = z.object({
  entryKey: EntryKeySchema,
  profileKey: z.string().min(1),
  values: z.array(EnvPlanValueSchema),
  fieldErrors: z.array(FieldErrorSchema),
  requiresRecreate: z.boolean(),
  resolvedAt: TimestampSchema,
});

export const DiagnosticsCheckSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  state: z.enum(['pass', 'warn', 'fail']),
  detail: z.string().min(1),
  remediation: z.string().nullish(),
});

export const ScaffoldDraftSchema = z.object({
  entryKey: EntryKeySchema,
  draftId: IdSchema,
  createdAt: TimestampSchema,
  approvedBy: z.string().nullable(),
  files: z.array(
    z.object({
      path: z.string().min(1),
      language: z.string().min(1),
      content: z.string().min(1),
    }),
  ),
  diagnostics: z.array(DiagnosticsCheckSchema),
});

/** FR-1.22: the operator confirms the generated draft; the entry becomes deployable. */
export const ScaffoldConfirmationSchema = ScaffoldDraftSchema.extend({
  approvedBy: z.string().min(1),
  createdAt: TimestampSchema,
});

export const EnvProfileSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  target: z.enum(['production', 'staging']),
  updatedBy: z.string().min(1),
  updatedAt: TimestampSchema,
  values: z.array(
    z.object({
      varName: z.string().min(1),
      value: z.string().nullable(),
      secretRef: z.string().nullable(),
    }),
  ),
});

/** FR-1.30: import an existing `.env` or Compose environment into the declared schema. */
export const EnvImportRequestSchema = z.object({
  source: z.enum(['dotenv', 'compose']),
  content: z.string().min(1),
});

export const EnvImportMapSchema = z.object({
  name: z.string().min(1),
  /** Imported value. `null` when the variable is secret and must be entered by hand. */
  value: z.string().nullable(),
  secret: z.boolean(),
  accepted: z.boolean(),
  reason: z.string().nullable(),
});

export const EnvImportResultSchema = z.object({
  entryKey: EntryKeySchema,
  source: z.enum(['dotenv', 'compose']),
  parsed: z.number().int().nonnegative(),
  mapped: z.array(EnvImportMapSchema),
  unmapped: z.array(z.string().min(1)),
  fieldErrors: z.array(FieldErrorSchema),
  importedAt: TimestampSchema,
});

/**
 * A file that exists but could not be projected. Surfaced instead of swallowed: a rejected file is
 * not a deleted one, and reporting it is the only way the operator can tell the difference.
 */
export const ReloadInvalidArtefactSchema = z.object({
  path: z.string().min(1),
  scope: z.enum(['entry', 'environment']),
  /**
   * The identity the artefact would have projected: the filename stem when the document could not be
   * parsed, and the declared `key` when it parsed but was refused for another reason (a composed key
   * whose filename disagrees with it, ADR-BE-20 phase 1). That distinction matters because this value
   * is what protects an identity from removal in `removeMissing` — reporting the stem of a refused
   * `D1.json` that declares `D01-01` would delete the row the file was trying to declare.
   *
   * Deliberately **not** `EntryKeySchema`: a rejected file may be called anything at all
   * (`notes.json`, `D1.json.bak`), and reporting a stray file must not itself fail the contract.
   */
  key: z.string().min(1).nullable(),
  reason: z.string().min(1),
});

export type ReloadInvalidArtefact = z.infer<typeof ReloadInvalidArtefactSchema>;

/** Environment-schema reconciliation, reported separately from entries on purpose. */
export const ReloadEnvironmentResultSchema = z.object({
  added: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** Files that were skipped whole because applying them would break a running instance. */
  refused: z.array(
    z.object({
      key: EntryKeySchema,
      name: z.string().min(1).nullable(),
      reason: z.string().min(1),
    }),
  ),
  /** Per-entry counts, so the receipt can name what moved without listing every variable. */
  applied: z.array(
    z.object({
      key: EntryKeySchema,
      added: z.number().int().nonnegative(),
      changed: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
    }),
  ),
});

export type ReloadEnvironmentResult = z.infer<typeof ReloadEnvironmentResultSchema>;

/** FR-1.18 / DD-07: a repository reload reconciles the projection and reports the delta. */
export const CatalogReloadResultSchema = z.object({
  reloadedAt: TimestampSchema,
  revision: z.string().min(1),
  entries: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  reconciled: z.array(
    z.object({
      key: EntryKeySchema,
      change: z.enum(['unchanged', 'added', 'updated', 'removed']),
      detail: z.string().min(1),
    }),
  ),
  /** Optional so a stored or mocked result from before env schemas moved into the repository parses. */
  environment: ReloadEnvironmentResultSchema.optional(),
  invalid: z.array(ReloadInvalidArtefactSchema).optional(),
  /**
   * ADR-BE-20 phase 1: every legacy key the tree still declares, reported rather than refused.
   *
   * Optional for the same reason `environment` is — a stored or mocked result from before the field
   * existed must still parse. Emitted as `[]` when the tree is composed-only, so a receipt always
   * answers "is this tree mid-migration?" without a second call.
   */
  deprecated: z.array(EntryKeySchema).optional(),
});

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type UpstreamStatus = z.infer<typeof UpstreamStatusSchema>;
export type EnvImportResult = z.infer<typeof EnvImportResultSchema>;
export type CatalogReloadResult = z.infer<typeof CatalogReloadResultSchema>;
export type IntegrationMetadata = z.infer<typeof IntegrationMetadataSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type EnvSchemaVar = z.infer<typeof EnvSchemaVarSchema>;
export type EnvPlanValue = z.infer<typeof EnvPlanValueSchema>;
export type EnvPlan = z.infer<typeof EnvPlanSchema>;
export type EnvProfile = z.infer<typeof EnvProfileSchema>;
export type DiagnosticsCheck = z.infer<typeof DiagnosticsCheckSchema>;
export type ScaffoldDraft = z.infer<typeof ScaffoldDraftSchema>;
export type ScaffoldConfirmation = z.infer<typeof ScaffoldConfirmationSchema>;
