import type { Capability } from './capabilities';

/**
 * ADR-BE-05: one matrix, two consumers.
 *
 * Every declared operation names the capability the PDP evaluates. The mapping lives here, next
 * to the capability list, so a route cannot be mounted without a decision key: `contract.ts`
 * resolves each operation through this table at module load and throws when one is missing
 * (`scripts/check-route-policy.ts` turns the same check into a CI gate).
 *
 * `auth.sign_in` and `auth.session.read` are reserved keys rather than capabilities: they describe
 * the two operations that establish or describe a session, which no role matrix can grant.
 */
export type ReservedPolicyKey = 'auth.sign_in' | 'auth.session.read';

export type PolicyKey = Capability | ReservedPolicyKey;

export const RESERVED_POLICY_KEYS: readonly ReservedPolicyKey[] = [
  'auth.sign_in',
  'auth.session.read',
];

export function isReservedPolicyKey(key: PolicyKey): key is ReservedPolicyKey {
  return (RESERVED_POLICY_KEYS as readonly string[]).includes(key);
}

/**
 * The only operations that may be reached without a session. The route-policy check asserts this
 * list is exactly the set of `anonymous` operations, so it cannot grow silently.
 */
export const ANONYMOUS_OPERATIONS: readonly string[] = ['POST /auth/session', 'GET /auth/session'];

/**
 * Resources a scoped grant may be resolved against. `self` covers a member acting on their own
 * entitlements; `request` covers operations that exist only to open an approval flow.
 */
export type ScopeRule = 'platform' | 'self' | 'domain' | 'instance' | 'request';

/** Which scope a capability is resolved against when the matrix says `scoped`. */
const SCOPE_RULES: Partial<Record<Capability, ScopeRule>> = {
  'catalog.browse': 'self',
  'catalog.read_metadata': 'self',
  'instance.configure': 'instance',
  'instance.env': 'instance',
  'instance.backup': 'instance',
  'instance.view_logs': 'instance',
  'identity.manage_users': 'domain',
  'identity.manage_groups': 'domain',
  'entitlement.grant': 'domain',
  'product.assign_roles': 'domain',
  'audit.view': 'domain',
  'capacity.view': 'domain',
  'metadata.manage': 'domain',
  'workflow.author': 'instance',
  'workflow.run': 'instance',
  'workflow.view_runs': 'instance',
  'workflow.credentials': 'instance',
  'workflow.approve': 'request',
  'breakglass.request': 'request',
  'breakglass.approve': 'self',
  'recovery.view': 'domain',
  'license.manage': 'instance',
  'patch.view': 'domain',
  'posture.view': 'domain',
  'portal.sign_in': 'self',
  'portal.launch': 'instance',
  'portal.view_status': 'self',
  'access.request': 'self',
};

export function scopeRuleFor(key: PolicyKey): ScopeRule {
  if (key === 'auth.session.read' || key === 'auth.sign_in') return 'self';
  return SCOPE_RULES[key] ?? 'platform';
}

/**
 * Machine clients hold capabilities, not roles. A scope grants exactly the keys listed here and
 * nothing else; the PDP treats an unknown scope as an empty capability set.
 */
export const SERVICE_SCOPES = {
  'registry.read': ['registry.view'],
  'audit.read': ['audit.view', 'audit.verify', 'audit.export'],
} as const satisfies Record<string, readonly Capability[]>;

export type ServiceScope = keyof typeof SERVICE_SCOPES;

export function isServiceScope(value: string): value is ServiceScope {
  return Object.hasOwn(SERVICE_SCOPES, value);
}

/**
 * `METHOD /path` → capability. Every operation in `API_OPERATIONS` must appear exactly once;
 * a missing entry fails route-policy validation before the server can listen.
 */
export const POLICY_KEYS: Readonly<Record<string, PolicyKey>> = {
  // Portal and own session
  'GET /me': 'auth.session.read',
  'GET /me/entitlements': 'portal.view_entitlements',
  'GET /me/launcher': 'portal.view_entitlements',
  'POST /me/logout': 'auth.session.read',
  'GET /portal/status-banner': 'portal.view_status',
  'GET /portal/launch-targets/:instanceId': 'portal.launch',
  'POST /portal/launch-tickets/:instanceId': 'portal.launch',
  'POST /portal/launch-events/:instanceId': 'portal.launch',
  'GET /portal/requestable': 'access.request',
  'GET /portal/products/:slug': 'portal.view_entitlements',

  // Catalog
  'GET /catalog': 'catalog.browse',
  'POST /catalog/reload': 'metadata.manage',
  'GET /catalog/:key': 'catalog.read_metadata',
  'GET /catalog/:key/env-schema': 'catalog.read_metadata',
  'GET /catalog/:key/env-plan': 'catalog.read_metadata',
  'POST /catalog/:key/env-import': 'catalog.read_metadata',
  'GET /env-profiles': 'catalog.browse',
  'PATCH /catalog/:key/integration-metadata': 'metadata.manage',
  'GET /catalog/:key/scaffold': 'catalog.read_metadata',
  'POST /catalog/:key/scaffold/:draftId/confirm': 'metadata.manage',
  'POST /catalog/:key/prefetch': 'metadata.manage',

  // Instances
  'GET /instances': 'instance.view_logs',
  'GET /instances/:id': 'instance.view_logs',
  'GET /instances/:id/status': 'instance.view_logs',
  'GET /instances/:id/containers': 'instance.view_logs',
  'GET /instances/:id/env': 'instance.env',
  'PUT /instances/:id/env': 'instance.env',
  /*
   * The token lives in the same store, under the same ceiling and the same role matrix as a declared
   * secret variable: anyone who may write `instance.env` may already overwrite a database root
   * password there, so a dedicated capability would narrow nothing. The route itself is narrower —
   * one fixed name, only for an entry whose provisioning needs a bearer token.
   */
  'GET /instances/:id/admin-credential': 'instance.env',
  'PUT /instances/:id/admin-credential': 'instance.env',
  /*
   * Provisioning writes a product account for other people on this instance, which is the reach
   * `instance.env` already grants: anyone who may write a variable there can point the product at a
   * different database. It creates no access of its own — a mapping exists only for an entitled
   * subject — so a narrower capability would narrow nothing.
   */
  'POST /instances/:id/relay/provision': 'instance.env',
  'GET /instances/:id/drift': 'instance.configure',
  'GET /instances/:id/backups': 'instance.backup',
  'GET /instances/:id/containers/:cid/logs': 'instance.view_logs',
  'POST /instances/:id/backups': 'instance.backup',
  'PUT /instances/:id/backup-schedule': 'instance.backup',
  'POST /backups/:id/verify': 'instance.backup',
  'POST /backups/:id/restore': 'instance.backup',
  'GET /instances/:id/images': 'instance.view_logs',
  'GET /instances/:id/plan': 'instance.lifecycle',
  'POST /instances': 'instance.deploy',
  'POST /instances/:id/:action': 'instance.lifecycle',
  'POST /instances/preview': 'instance.deploy',
  'GET /instances/:id/triggers': 'workflow.credentials',
  'POST /instances/:id/triggers': 'workflow.credentials',
  'DELETE /instances/:id/triggers/:triggerId': 'workflow.credentials',
  'POST /instances/:id/credential-scopes': 'workflow.credentials',
  'DELETE /credential-scopes/:id': 'workflow.credentials',

  // Jobs
  'GET /jobs': 'instance.view_logs',
  'GET /jobs/:id': 'instance.view_logs',
  'GET /jobs/:id/logs': 'instance.view_logs',
  'GET /jobs/:id/stream': 'instance.view_logs',
  'POST /jobs/:id/cancel': 'instance.lifecycle',
  'POST /jobs/:id/retry': 'instance.lifecycle',

  // Workflows
  'GET /workflows': 'workflow.view_runs',
  'GET /workflows/:id': 'workflow.view_runs',
  'POST /workflows': 'workflow.author',
  'DELETE /workflows/:id': 'workflow.author',
  'POST /workflows/:id/:action': 'workflow.run',
  'PATCH /workflows/:id': 'workflow.author',
  'POST /workflows/import': 'workflow.author',
  'GET /workflows/:id/runs': 'workflow.view_runs',
  'GET /workflow-runs/:runId': 'workflow.view_runs',
  'POST /workflow-runs/:runId/replay': 'workflow.run',
  'GET /workflows/:id/export': 'workflow.view_runs',
  'POST /workflows/:id/nodes': 'workflow.author',
  'PATCH /workflows/:id/nodes/:nodeId': 'workflow.author',
  'DELETE /workflows/:id/nodes/:nodeId': 'workflow.author',
  'PUT /workflows/:id/nodes/:nodeId/mappings': 'workflow.author',
  /*
   * Reading the product's field list and the node's last sample are both authoring aids: they only
   * make sense next to the mapper, and the sample may carry production data.
   */
  'GET /workflows/:id/nodes/:nodeId/fields': 'workflow.author',
  'GET /workflows/:id/nodes/:nodeId/sample': 'workflow.author',
  'PUT /workflows/:id/trigger': 'workflow.author',
  'POST /workflow-approvals/:token/decision': 'workflow.approve',

  // Governance
  'GET /audit-events': 'audit.view',
  'GET /audit-events/:seq/proof': 'audit.verify',
  'POST /audit-events/export': 'audit.export',
  'POST /audit-events/verify': 'audit.verify',
  'GET /licenses': 'license.view',
  /**
   * The register is a release gate: reading it is `license.view`, changing the configuration it
   * certifies is `license.manage`. Sharing one key let an auditor (R2, read-only) enable
   * hosted-service mode.
   */
  'PUT /licenses/:instanceId/hosted-service': 'license.manage',
  'GET /patch-register': 'patch.view',
  'GET /posture': 'posture.view',
  /*
   * The register is read by all three parties to an elevation: the requester (R1), the auditor who
   * approves read-only grants (R2) and the domain owner who approves read-write grants (R3). No
   * single capability is shared by all three, so the read declares an any-of set below; the PDP
   * evaluates it as one decision and audits one refusal, not three.
   */
  'GET /break-glass-sessions': 'breakglass.request',
  'POST /break-glass-sessions': 'breakglass.request',
  'POST /break-glass-sessions/:id/reveal': 'breakglass.request',
  /*
   * The dynamic action segment cannot carry a per-action capability in a single key, so the route
   * admits the deciding roles and the handler enforces the action: `revoke`/`expire` need
   * `breakglass.revoke` (R1 only), `approve`/`reject` need `breakglass.approve` (R2/R3).
   */
  'POST /break-glass-sessions/:id/:action': 'breakglass.approve',
  'GET /capacity': 'capacity.view',
  'GET /capacity/forecast': 'capacity.view',

  // Administration
  'GET /admin/users': 'identity.view_users',
  'GET /admin/users/:id': 'identity.view_users',
  'GET /admin/users/:id/entitlements': 'identity.view_users',
  'POST /admin/users/:id/disable': 'identity.manage_users',
  'GET /admin/groups': 'identity.manage_groups',
  'PUT /admin/groups/:id/mapping': 'identity.manage_groups',
  'GET /admin/identity-sync': 'identity.manage_users',
  'POST /admin/identity-sync/run': 'identity.manage_users',
  'GET /admin/settings': 'settings.view',
  'PUT /admin/settings': 'settings.manage',
  'GET /admin/settings/alerts': 'settings.view',
  'PUT /admin/settings/alerts': 'alert.configure',
  'POST /admin/settings/alerts/:id/test': 'alert.configure',
  'GET /admin/access-requests': 'entitlement.grant',
  'POST /admin/access-requests': 'access.request',
  'POST /admin/access-requests/:id/:decision': 'entitlement.grant',
  'GET /admin/maintenance-windows': 'settings.view',
  'POST /admin/maintenance-windows': 'maintenance.configure',
  'PATCH /admin/maintenance-windows/:id': 'maintenance.configure',
  'DELETE /admin/maintenance-windows/:id': 'maintenance.configure',
  'GET /admin/policy-exceptions': 'exception.decide',
  'POST /admin/policy-exceptions/:id/:decision': 'exception.decide',
  'GET /admin/dsar': 'privacy.view',

  // Recovery
  'GET /recovery': 'recovery.view',
  'GET /platform/restore-status': 'recovery.view',
  'POST /recovery/backups': 'recovery.manage',
  'POST /recovery/restores': 'recovery.manage',
  'POST /restore-drills': 'recovery.manage',

  // Privacy
  'GET /privacy/requests': 'privacy.view',
  'POST /privacy/requests': 'privacy.manage',
  'POST /privacy/requests/:id/advance': 'privacy.manage',

  // Integration registry
  'GET /registry/instances': 'registry.view',
  'GET /registry/instances/:slug': 'registry.view',
  'GET /registry/stale': 'registry.view',
  'GET /registry/operations': 'registry.view',

  // Session surface (anonymous by declaration; the reserved keys never resolve through the matrix)
  'GET /auth/session': 'auth.session.read',
  'POST /auth/session': 'auth.sign_in',
};

/**
 * Operations a role may reach with **any** of several capabilities.
 *
 * `POLICY_KEYS` binds an operation to exactly one key, which is the right default: it makes a route
 * unable to exist without a decision. It cannot express "any party to this workflow may read it",
 * and the elevation register is exactly that — R1 requests, R2/R3 approve, and none of them shares
 * a capability with the others. Listing `GET /break-glass-sessions` here is the smallest way to say
 * so without inventing a capability the requirements matrix does not grant.
 *
 * The PDP still takes **one** decision: the first key that allows wins, and a refusal is audited
 * once. MFA matters more than the list, so a step-up refusal on any key is returned as such.
 */
export const ANY_OF_POLICY_KEYS: Readonly<Record<string, readonly PolicyKey[]>> = {
  'GET /break-glass-sessions': ['breakglass.request', 'breakglass.approve', 'breakglass.revoke'],
  /*
   * One route, two authorities: an approver decides a request and a platform administrator ends a
   * live grant. Gating both on `breakglass.approve` denied R1 — the only role holding
   * `breakglass.revoke` — while admitting R2/R3 to a capability they do not hold. The route now
   * admits either, and the handler refuses the action the caller's role cannot take.
   */
  'POST /break-glass-sessions/:id/:action': ['breakglass.approve', 'breakglass.revoke'],
};

/**
 * Derives the resource a decision is about from the matched path and its parameters. The route
 * table passes this to the PDP; without a resolvable instance or domain the scope rules deny.
 */
export type PolicyResource = {
  type: 'platform' | 'self' | 'instance' | 'domain' | 'user' | 'catalog' | 'workflow' | 'request';
  id: string;
};

export function resourceForRequest(path: string, params: Record<string, string>): PolicyResource {
  const id =
    params.id ?? params.instanceId ?? params.key ?? params.slug ?? params.runId ?? params.seq ?? '';
  if (path.includes('instanceId')) return { type: 'instance', id };
  if (path.startsWith('/instances') || path.startsWith('/backups')) return { type: 'instance', id };
  if (path.startsWith('/jobs')) return { type: 'instance', id };
  if (path.startsWith('/admin/users')) return { type: 'user', id };
  if (path.startsWith('/catalog')) return { type: 'catalog', id };
  if (path.startsWith('/workflows') || path.startsWith('/workflow-runs'))
    return { type: 'workflow', id };
  if (path.startsWith('/me')) return { type: 'self', id: '' };
  if (path.startsWith('/break-glass-sessions') || path.startsWith('/admin/access-requests')) {
    return { type: 'request', id };
  }
  return { type: 'platform', id };
}
