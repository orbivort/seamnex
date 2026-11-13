import type { FieldMapping, Workflow } from '@seamnex/domain';

/**
 * The formatting rules shared by the two read paths of module M13.
 *
 * `PostgresWorkflowService` (the collection and single-resource GET) and
 * `WorkflowAuthoringService.load()` (the value every authoring mutation returns) must produce the
 * same representation. Keeping the transformations here is what stops them drifting: they already
 * had — one returned `"<name>."` for a missing description, the other `''`, and both echoed the
 * opaque identity id back as the owner's name.
 */

/**
 * A stored `''` is "no description". The column is nullable and the create path used to write an
 * empty string, which then failed the `min(1)` rule of `WorkflowSchema` on every later read — one
 * such row made `GET /workflows` answer `500` for the whole page.
 */
export function normaliseDescription(description: string | null): string | null {
  if (description === null) return null;
  return description.trim().length === 0 ? null : description;
}

/** `ir_hash` is a bare hex digest in the column; the contract carries the algorithm (`sha256:`). */
export function formatIrHash(stored: string | null): string {
  if (stored === null || stored.length === 0) return 'sha256:none';
  return stored.startsWith('sha256:') ? stored : `sha256:${stored}`;
}

/**
 * The display name of the owner, in order of authority: the synced mirror, the mirror's username,
 * and only then the opaque identity id. The last resort is not a name the platform invented — it is
 * the identifier it actually holds — and it happens when the mirror has no row yet.
 */
export function ownerName(
  displayName: string | null | undefined,
  username: string | null | undefined,
  idpId: string,
): string {
  return displayName ?? username ?? idpId;
}

/** A definition with no trigger in its IR cannot run on its own; "manual" is the safe reading. */
export function manualTrigger(): Workflow['trigger'] {
  return { type: 'manual', label: 'Manual', config: 'Started by an operator.', timezone: null };
}

/**
 * The mappings that decide a node's fields.
 *
 * `setMappings` files a non-trigger node's mappings on its **inbound edge** — a mapping describes a
 * source→target pair, so it belongs to the edge — and `compile` reads them from there. Both read
 * paths returned `ir.nodes` verbatim, so the canvas said "No field mapping yet" for a node whose
 * request carried two fields, and an author re-entering them would have overwritten what they could
 * not see.
 */
export function mappingsFor(
  ir: { edges?: readonly { target: string; mappings: FieldMapping[] }[] | undefined },
  node: { id: string; mappings: FieldMapping[] },
): FieldMapping[] {
  const inbound = (ir.edges ?? []).find((edge) => edge.target === node.id);
  return inbound === undefined ? node.mappings : inbound.mappings;
}
