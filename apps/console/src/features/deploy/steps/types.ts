/**
 * The wizard's two cross-module contracts live here rather than beside one of the steps: the page
 * state type is used by the hook, every step and the review step, so any step importing a sibling
 * to reach it would couple two components that never render each other.
 */
export type WizardValues = {
  slug: string;
  profileKey: string;
  env: Record<string, string>;
  resources: { cpu: number; memoryMb: number; diskMb: number };
};

export type PreflightCheck = {
  label: string;
  ok: boolean;
  detail: string;
  /**
   * The check's input has not arrived yet. Distinct from a failure: a preview or a capacity read
   * still in flight was painted red, so a slow API read looked like a refused deployment.
   */
  pending?: boolean;
  /** What the operator can do about a check that is not passing, rendered beside it. */
  action?: { label: string; onClick: () => void };
};
