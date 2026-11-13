import { Injectable, Logger } from '@nestjs/common';
import type { LogStream } from '@seamnex/db';

/**
 * ADR-BE-12 D7 — job work is a registry of stages, not a chain of `if`s.
 *
 * The worker knows how to run a job; it does not know what a `deploy` or a `restore` *is*. Each
 * owning module registers the stage list for the kinds it owns, at boot. Two consequences that
 * matter:
 *   - adding a kind is one `register` call, so the worker stays flat;
 *   - a kind nobody registered fails loudly instead of finishing successfully having done nothing
 *     (the failure mode a synthetic step list had).
 *
 * Stage names double as `job_step` names, so the SSE stream and the step table keep their meaning.
 */

export type PipelineStageName =
  | 'resolve'
  | 'policy'
  | 'render'
  | 'plan'
  | 'apply'
  | 'verify'
  | 'integrate'
  | 'record'
  | 'backup'
  | 'restore'
  | 'prune';

export type PipelineContext = {
  readonly jobId: string;
  readonly instanceId: string;
  readonly actorId: string;
  /** The job kind, or `payload.action` when the kind is a generic lifecycle action. */
  readonly action: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly log: (stream: LogStream, line: string) => Promise<void>;
  readonly cancelled: () => Promise<boolean>;
};

export type PipelineStage = {
  readonly name: PipelineStageName;
  /** `job_step.name`; stable, because a client may key on it. */
  readonly step: string;
  run(context: PipelineContext): Promise<void>;
};

export type JobKind = string;

/**
 * Runs when any stage of a kind throws, before the job is recorded as failed.
 *
 * Without it a failed deployment left the instance in the state of the stage that broke
 * (`verifying`, `deploying`, …), which `lifecycleAvailability` treats as busy: the console then
 * offered no action at all and the only way out was a manual database write. The handler belongs
 * to the module that owns the table, so the worker keeps its single responsibility.
 */
export type PipelineFailureHandler = (context: PipelineContext, cause?: unknown) => Promise<void>;

export const PIPELINE_REGISTRY = Symbol('seamnex.jobs.pipeline-registry');

@Injectable()
export class PipelineRegistry {
  private readonly logger = new Logger('pipeline-registry');
  private readonly kinds = new Map<JobKind, readonly PipelineStage[]>();
  private readonly failures = new Map<JobKind, PipelineFailureHandler>();

  register(kind: JobKind, stages: readonly PipelineStage[]): void {
    const existing = this.kinds.get(kind);
    if (existing !== undefined) {
      throw new Error(
        `job kind ${kind} is registered twice (${stageNames(existing)} / ${stageNames(stages)})`,
      );
    }
    this.kinds.set(kind, stages);
    this.logger.debug(`registered pipeline for ${kind}: ${stageNames(stages)}`);
  }

  registerFailure(kind: JobKind, handler: PipelineFailureHandler): void {
    this.failures.set(kind, handler);
  }

  failureHandler(kind: JobKind): PipelineFailureHandler | undefined {
    return this.failures.get(kind);
  }

  /** Overwrites, for a module that registers a fallback and then specialises it. */
  replace(kind: JobKind, stages: readonly PipelineStage[]): void {
    this.kinds.set(kind, stages);
  }

  stages(kind: JobKind): readonly PipelineStage[] | undefined {
    return this.kinds.get(kind);
  }

  stepsFor(kind: JobKind): readonly string[] {
    return (this.kinds.get(kind) ?? []).map((stage) => stage.step);
  }

  registered(): JobKind[] {
    return [...this.kinds.keys()].sort();
  }
}

function stageNames(stages: readonly PipelineStage[]): string {
  return stages.map((stage) => stage.name).join(' → ');
}
