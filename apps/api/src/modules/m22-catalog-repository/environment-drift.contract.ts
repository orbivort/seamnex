/**
 * FR-1.29 / NFR-3.6 — the environment-drift producer.
 *
 * The endpoint, the `DriftRecord` schema and the console panel shipped before anything wrote a
 * per-variable row, so the panel could only ever answer "no drift". `drift_record` belongs to M22
 * (ADR-BE-03 + `module-boundaries.json`), so the producer lives here and is reached through this
 * token rather than exported as a class: the scheduler is platform machinery, not a module, and a
 * token is what keeps the edge visible.
 */

export const ENVIRONMENT_DRIFT = Symbol('seamnex.m22.environment-drift');

/**
 * Which side moved, decided from evidence rather than asserted.
 *
 * `repo_ahead` — the declaration changed after the running container was applied, so the runtime is
 * behind the repository and can be repaired from it. `runtime_ahead` — the declaration still matches
 * what was applied and the container differs, so something changed the runtime outside the platform.
 * `unknown` — there is no applied baseline, or the file is missing, and the evidence cannot decide.
 */
export type DriftDirection = 'repo_ahead' | 'runtime_ahead' | 'unknown';

/** One drifted variable. Never carries a secret value (see `detail.declared` for secrets). */
export type DriftFinding = {
  readonly instanceId: string;
  readonly varName: string;
  readonly kind: 'missing' | 'undeclared' | 'mismatch';
  readonly direction: DriftDirection;
};

export type DriftScanResult = {
  /**
   * False when the containers could not be asked (daemon unreachable, no containers). Nothing was
   * written and nothing was resolved: an unobservable instance is not a drifted or a clean one.
   */
  readonly observed: boolean;
  /** Every finding this pass observed, whether the row is new or was refreshed. */
  readonly detected: readonly DriftFinding[];
  /** Variable names whose open row this pass created (what an audit should report as new). */
  readonly created: readonly string[];
  /** Open rows closed because the variable no longer drifts. */
  readonly resolved: number;
};

export interface EnvironmentDriftService {
  /** Observe one instance's containers, then write, refresh and resolve its environment drift rows. */
  scan(instanceId: string): Promise<DriftScanResult>;
  /** Instances that have been applied and are not stopped, deleting or mid-transition. */
  scannable(): Promise<string[]>;
  /** Instances carrying the sticky `instanceParamDrift` flag. */
  definitionDrift(): Promise<string[]>;
  /** Variable names with an open environment drift row — the env screen's per-variable badge. */
  openVarNames(instanceId: string): Promise<ReadonlySet<string>>;
  /**
   * Re-commit `instances/<slug>/instance.yaml` from the recorded projection and clear the sticky
   * `instanceParamDrift` flag. Returns null when the instance is not carrying definition drift.
   */
  reconcileDefinition(
    instanceId: string,
    actorId: string,
  ): Promise<{ path: string; contentHash: string } | null>;
}
