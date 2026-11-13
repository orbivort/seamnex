import type { z } from 'zod';
import type {
  EnvImportResult,
  EnvPlan,
  EnvProfile,
  EnvSchemaFile,
  EnvSchemaVar,
  EnvUpdateResponseSchema,
  EnvValue,
  ReloadEnvironmentResult,
} from '@seamnex/domain';
import type { ComposePolicyResult } from '../../common/compose/compose-policy';

export type EnvUpdateResponse = z.infer<typeof EnvUpdateResponseSchema>;

export const RENDERER_SERVICE = Symbol('seamnex.m03.renderer');

/** Owns `env_schema_var`, `env_schema_revision`, `env_profile`, `env_profile_value`, `instance_env_value`, `render_set`. */
export interface RendererService {
  schema(entryKey: string): Promise<EnvSchemaVar[]>;
  profiles(): Promise<EnvProfile[]>;
  plan(input: {
    entryKey: string;
    profileKey?: string;
    overrides: Record<string, string>;
  }): Promise<EnvPlan>;
  importEnv(
    input: { entryKey: string; source: 'dotenv' | 'compose'; content: string },
    actorId: string,
  ): Promise<EnvImportResult>;
  instanceEnv(instanceId: string): Promise<EnvValue[]>;
  updateInstanceEnv(
    instanceId: string,
    values: Record<string, string>,
    actorId: string,
  ): Promise<EnvUpdateResponse>;
  /**
   * AD-09: `catalog/env/<KEY>.json` is the declaration; this projects it into `env_schema_var`.
   *
   * Files that would invalidate a running instance are refused whole and reported — never applied
   * partially, because a projection that half-matches its file is drift an operator cannot see.
   */
  applySchemas(input: {
    schemas: readonly EnvSchemaFile[];
    revision: string;
    actorId: string;
    /**
     * Who the audit row says did this. An operator reload is a `user`; the bootstrap projector is
     * `system`, because no session exists and `audit_event.actor_type` already distinguishes the two
     * (migration 0006). Defaulted at the call site so a caller that does not care keeps `user`.
     */
    actorType?: 'user' | 'service' | 'system';
  }): Promise<ReloadEnvironmentResult>;

  /** 4A.4 — an immutable render set, deduplicated on `(instance_id, content_hash)`. */
  render(input: RenderInput): Promise<RenderSet>;
  /** The render set currently applied to an instance, or null before the first deploy. */
  applied(instanceId: string): Promise<RenderSet | null>;
  /** Re-materialises a stored render set on disk (rollback, restore, a fresh host). */
  load(renderSetId: string): Promise<RenderSet>;
}

export type RenderRoute = {
  readonly host: string;
  readonly pathPrefix: string | null;
  readonly publishModel: 'subdomain' | 'subpath';
  readonly tlsMode: 'acme' | 'internal';
  readonly authMode: 'native' | 'fa_header' | 'fa_delegated' | 'fa_gate';
};

export type RenderResources = {
  readonly cpuMilli: number;
  readonly memoryMb: number;
  readonly diskMb: number;
};

export type RenderInput = {
  readonly instanceId: string;
  readonly entryKey: string;
  readonly slug: string;
  readonly action: string;
  readonly profileKey: string;
  readonly source: RenderedSource;
  readonly route: RenderRoute;
  readonly resources: RenderResources;
  /** TCP port the product serves inside its container (catalog `httpPort`). */
  readonly httpPort: number;
  /** Declared labels for dashboards and inventory; never a secret. */
  readonly labels?: Readonly<Record<string, string>>;
};

/** The subset of a resolved source the renderer needs; keeps M03 independent of M02's internals. */
export type RenderedSource = {
  readonly path: 'compose' | 'dockerfile' | 'scaffold';
  readonly directory: string;
  readonly composeFile: string | null;
  readonly dockerfilePath: string | null;
  readonly imageRef: string | null;
  readonly policy: ComposePolicyResult;
};

export type RenderedFile = {
  readonly path: string;
  readonly sha256: string;
  readonly content: string;
};

export type RenderSet = {
  readonly id: string;
  readonly instanceId: string;
  readonly contentHash: string;
  readonly directory: string;
  readonly files: readonly RenderedFile[];
  /** Compose project name; also the Docker label the executor filters on. */
  readonly composeProject: string;
  readonly imageRefs: readonly string[];
  /** Invariant 9: must be 0. Recorded in the manifest so the pre-apply assertion has data. */
  readonly publishedPorts: number;
};

export const RENDER_SET_SERVICE = Symbol('seamnex.m03.render-set');
