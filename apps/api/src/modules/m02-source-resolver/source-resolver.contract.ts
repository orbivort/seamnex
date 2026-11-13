import type { ScaffoldConfirmation, ScaffoldDraft } from '@seamnex/domain';
import type { ComposePolicyResult, ComposeRule } from '../../common/compose/compose-policy';

export const SOURCE_RESOLVER_SERVICE = Symbol('seamnex.m02.source-resolver');

/**
 * Owns `source_resolution`, `source_file`, `compose_policy` and `scaffold_artefact`.
 *
 * The precedence is fixed (4A.2): a Compose file if the tree has one, otherwise a Dockerfile,
 * otherwise an approved scaffold. It is *not* "whatever the entry's packaging says" — a repository
 * can contain both, and the Compose path is the one the platform can apply without building.
 */
export type SourcePath = 'compose' | 'dockerfile' | 'scaffold';

export type ResolveInput = {
  readonly instanceId: string;
  readonly entryKey: string;
  /** Branch, tag or commit; omitted means the default branch head. */
  readonly revision?: string;
  /** Structured progress for the job log: one line per decision, not one per file. */
  readonly onProgress?: (line: string) => Promise<void>;
};

export type ResolvedSourceFile = {
  readonly path: string;
  readonly sha256: string;
  readonly content: string;
};

export type ResolvedSource = {
  readonly resolutionId: string;
  readonly path: SourcePath;
  readonly sourceUrl: string | null;
  readonly revision: string;
  /** Working tree the renderer reads from (inside the instance data directory). */
  readonly directory: string;
  readonly composeFile: string | null;
  readonly dockerfilePath: string | null;
  /** Pinned reference the catalog declares, or the tag a Dockerfile build will produce. */
  readonly imageRef: string | null;
  readonly imageDigest: string | null;
  readonly policy: ComposePolicyResult;
  /** Retained byte-for-byte (FR-1.19); also written to `source_file`. */
  readonly files: readonly ResolvedSourceFile[];
};

export interface SourceResolverService {
  resolve(input: ResolveInput): Promise<ResolvedSource>;
  /** FR-1.22: writes the approved draft into the catalogue working tree and records the commit. */
  confirmScaffold(
    entryKey: string,
    draftId: string,
    actorId: string,
  ): Promise<ScaffoldConfirmation>;
  /** The draft the entry screen renders before a commit exists; `approvedBy` is null until confirmed. */
  scaffold(entryKey: string): Promise<ScaffoldDraft>;
  /** The policy alone, for a dry run and for the compose-policy test. */
  evaluate(composeContent: string, waived: readonly ComposeRule[]): ComposePolicyResult;
}
