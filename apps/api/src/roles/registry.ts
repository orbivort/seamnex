import type { RoleId } from '../config/config';
import type { RoleDefinition } from './role';

/**
 * The platform process roles (design §4.3). One image, one module graph, one entrypoint per role.
 *
 * Roles marked `implemented: false` are honest about it: they boot, register and emit
 * `role.idle` with the phase that will implement them. They do not answer fake health for
 * capabilities they do not have.
 */
export const ROLES: readonly RoleDefinition[] = [
  {
    id: 'api',
    kind: 'http',
    implemented: true,
    phase: '1',
    description:
      'REST surface, OpenAPI document, health and metrics, BFF (Phase 2) and PDP (Phase 3)',
  },
  {
    id: 'deploy-worker',
    kind: 'worker',
    implemented: true,
    phase: '1 (synthetic jobs), 4A (real execution)',
    description: 'Consumes job lanes, runs steps, appends logs, publishes progress',
  },
  {
    id: 'scheduler',
    kind: 'scheduler',
    implemented: true,
    phase: '1 (anchor, outbox, reaper)',
    description:
      'Repeatable platform work: audit anchor, outbox dispatch, idempotency and partition upkeep',
  },
  {
    id: 'sync-worker',
    kind: 'worker',
    implemented: true,
    phase: '3',
    description:
      'Mirrors the identity directory, records per-class propagation and terminates disabled sessions',
  },
  {
    id: 'status-sampler',
    kind: 'worker',
    implemented: true,
    phase: '4B',
    description: 'Samples containers and HTTP readiness, derives instance state',
  },
  {
    id: 'backup-runner',
    kind: 'worker',
    implemented: true,
    phase: '4C (pipelines registered in the job worker)',
    description: 'Runs instance and platform-state backup and restore jobs',
  },
  {
    id: 'auth-gateway',
    kind: 'stateless',
    implemented: true,
    phase: '4D',
    description: 'Forward-auth decisions for product routes',
  },
  {
    id: 'broker-proxy',
    kind: 'stateless',
    implemented: true,
    phase: '4E',
    description: 'Injects operation-scoped credentials on workflow egress',
  },
  {
    id: 'trigger-ingress',
    kind: 'stateless',
    implemented: true,
    phase: '4E',
    description: 'Verifies inbound webhooks, dedupes deliveries, forwards to n8n',
  },
  {
    id: 'relay',
    kind: 'stateless',
    implemented: true,
    phase: '4D (ADR-BE-22)',
    // Never "single sign-on": it submits the product's own form with a platform-held credential.
    description: 'Answers the launch bootstrap and relays a per-user product sign-in',
  },
];

export function roleDefinition(id: RoleId): RoleDefinition {
  const definition = ROLES.find((role) => role.id === id);
  if (definition === undefined) throw new Error(`Unknown role: ${id}`);
  return definition;
}

export function idleRoles(): readonly RoleId[] {
  return ROLES.filter((role) => !role.implemented).map((role) => role.id);
}
