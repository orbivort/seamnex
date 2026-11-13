import type { RoleId } from '../config/config';

export type RoleKind = 'http' | 'worker' | 'scheduler' | 'stateless';

export type RoleDefinition = {
  readonly id: RoleId;
  readonly kind: RoleKind;
  /** False in Phase 1 for roles that exist only to prove the topology. */
  readonly implemented: boolean;
  /** The phase that gives an idle role its capability. */
  readonly phase: string;
  readonly description: string;
};
