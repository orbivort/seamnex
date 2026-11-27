/**
 * FR-1.35 — the platform recovery set as one record, written by the runner and read by the Recovery
 * screen.
 *
 * The manifest used to be a literal list of `includes` strings: it named an identity-provider
 * database, an ACME store and a catalogue clone the runner never uploaded. Making the claim *and*
 * the evidence one object is the whole point of this module — an artefact is `included` only once an
 * object key, a byte count and a content digest exist for it, so a set that captured nothing cannot
 * describe itself as complete.
 *
 * Two classes of artefact, because FR-1.35 asks for material the platform does not always own:
 *
 *   - **captured**: the platform writes the file, uploads it, and the manifest carries its digest.
 *   - **referenced**: an operator-owned artefact (an external ingress's TLS store, the escrowed
 *     secret-store root key). The manifest records the owner and the location; `included` stays
 *     false forever, because nothing was captured.
 */

export const PLATFORM_ARTEFACT_KINDS = [
  'platform_database',
  'idp_database',
  'idp_realm',
  'edge_routes',
  'audit_anchor',
  'catalog_repo',
  'edge_static_and_tls',
  'secret_root_key',
] as const;

export type PlatformArtefactKind = (typeof PLATFORM_ARTEFACT_KINDS)[number];

/** The kinds the platform captures itself; the rest are recorded references. */
export type CapturedArtefactKind = Exclude<
  PlatformArtefactKind,
  'edge_static_and_tls' | 'secret_root_key'
>;

/**
 * The scratch file each captured artefact is written to. The upload stage resolves the file from
 * the kind rather than from a path recorded in the manifest: a manifest that named a filesystem
 * location would be describing the host that took the backup, not the set.
 */
const CAPTURED_FILES: Record<CapturedArtefactKind, string> = {
  platform_database: 'platform.dump',
  idp_database: 'idp.dump',
  idp_realm: 'realm.json',
  edge_routes: 'edge-routes.tar.gz',
  audit_anchor: 'audit-anchor.json',
  catalog_repo: 'catalog.tar.gz',
};

const LABELS: Record<PlatformArtefactKind, { label: string; detail: string }> = {
  platform_database: {
    label: 'Platform database',
    detail: 'Entitlements, audit log, job history, workflow definitions and keys.',
  },
  idp_database: {
    label: 'Identity-provider database',
    detail: "The identity provider's own database: users, credentials and realm data.",
  },
  idp_realm: {
    label: 'Identity-provider realm export',
    detail: 'Realm configuration, clients and scopes, as the admin export returns them.',
  },
  edge_routes: {
    label: 'Edge route configuration',
    detail: 'The dynamic routers and middlewares the platform generates.',
  },
  audit_anchor: {
    label: 'Audit anchor',
    detail: 'Daily anchors plus the chain head, so restored audit records stay verifiable.',
  },
  catalog_repo: {
    label: 'Catalogue repository (fallback copy)',
    detail: 'A copy of the working tree; the repository stays authoritative (DD-14).',
  },
  edge_static_and_tls: {
    label: 'Edge static configuration and TLS material',
    detail: 'Owned by the operator: an external ingress, an ACME store or an internal CA.',
  },
  secret_root_key: {
    label: 'Secret-store root key',
    detail: 'Escrowed by the operator. Never inside the set, so a leaked archive opens nothing.',
  },
};

export type PlatformArtefact = {
  readonly kind: PlatformArtefactKind;
  readonly label: string;
  readonly detail: string;
  /** True only when the upload stage stored the object; `objectKey` and `digest` are then set. */
  readonly included: boolean;
  readonly objectKey: string | null;
  readonly bytes: number | null;
  readonly digest: string | null;
  /** A recorded operator location for a referenced artefact; null for a captured one. */
  readonly location: string | null;
  /** When the platform wrote the file. Null until the capture stage reached the artefact. */
  readonly capturedAt: string | null;
};

export type PlatformManifest = {
  readonly version: 2;
  /** Derived from the artefacts, never written by hand. */
  readonly includes: readonly string[];
  readonly artefacts: readonly PlatformArtefact[];
  readonly encryption: { readonly recipient: string; readonly identityId: string };
  /** The non-secret identifier of the escrowed root key, so a restore can check the right one. */
  readonly rootKeyId: string | null;
  readonly capturedAt: string;
};

/** The scratch file name for a captured artefact; null for a referenced one. */
export function artefactFile(kind: PlatformArtefactKind): string | null {
  return kind in CAPTURED_FILES ? CAPTURED_FILES[kind as CapturedArtefactKind] : null;
}

/** An artefact the platform intends to capture: recorded before the file exists, never after. */
export function plannedArtefact(
  kind: PlatformArtefactKind,
  capturedAt: string | null = null,
): PlatformArtefact {
  return {
    kind,
    ...LABELS[kind],
    included: false,
    objectKey: null,
    bytes: null,
    digest: null,
    location: null,
    capturedAt,
  };
}

/** An operator-owned artefact: named with its owner and location, and never claimed as included. */
export function referenceArtefact(
  kind: PlatformArtefactKind,
  location: string | null,
  capturedAt: string | null = null,
): PlatformArtefact {
  return { ...plannedArtefact(kind, capturedAt), location: location === '' ? null : location };
}

/** Promotes a captured artefact once its object was stored. The only way `included` becomes true. */
export function storedArtefact(
  artefact: PlatformArtefact,
  stored: { objectKey: string; bytes: number; digest: string },
): PlatformArtefact {
  if (stored.objectKey.length === 0) {
    throw new Error(`artefact ${artefact.kind} was stored without an object key`);
  }
  // Zero bytes is a capture that wrote nothing: the dump or archive never produced content, and
  // marking it `included` would advertise an artefact a restore cannot use.
  if (stored.bytes <= 0) {
    throw new Error(`artefact ${artefact.kind} was stored with no bytes`);
  }
  return {
    ...artefact,
    included: true,
    objectKey: stored.objectKey,
    bytes: stored.bytes,
    digest: stored.digest,
  };
}

/** A manifest whose `includes` cannot disagree with what was actually stored. */
export function createPlatformManifest(input: {
  artefacts: readonly PlatformArtefact[];
  encryption: { recipient: string; identityId: string };
  rootKeyId: string | null;
  capturedAt: string;
}): PlatformManifest {
  return {
    version: 2,
    includes: deriveIncludes(input.artefacts),
    artefacts: input.artefacts,
    encryption: input.encryption,
    rootKeyId: input.rootKeyId,
    capturedAt: input.capturedAt,
  };
}

/** The artefact kinds with a stored object. A kind is listed only when an object exists. */
export function deriveIncludes(artefacts: readonly PlatformArtefact[]): string[] {
  return artefacts
    .filter((artefact) => artefact.included && (artefact.objectKey ?? '').length > 0)
    .map((artefact) => artefact.kind);
}

/**
 * The manifest as read from `backup.manifest`. Strict on purpose: a legacy v1 manifest, a malformed
 * entry or an entry claiming `included` without an object key all yield null, which the projection
 * renders as "nothing proven". A reader that repaired a broken claim would reproduce the defect this
 * module exists to remove.
 */
export function readPlatformManifest(value: unknown): PlatformManifest | null {
  if (!isRecord(value) || value.version !== 2) return null;
  if (!Array.isArray(value.artefacts)) return null;
  if (!isRecord(value.encryption)) return null;

  const recipient = value.encryption.recipient;
  const identityId = value.encryption.identityId;
  if (typeof recipient !== 'string' || typeof identityId !== 'string') return null;
  if (typeof value.capturedAt !== 'string') return null;

  const artefacts: PlatformArtefact[] = [];
  for (const raw of value.artefacts) {
    const artefact = readArtefact(raw);
    if (artefact === null) return null;
    artefacts.push(artefact);
  }

  return {
    version: 2,
    includes: deriveIncludes(artefacts),
    artefacts,
    encryption: { recipient, identityId },
    rootKeyId: typeof value.rootKeyId === 'string' ? value.rootKeyId : null,
    capturedAt: value.capturedAt,
  };
}

/**
 * The sentence the Recovery screen shows for one artefact. Stored here so the writer, the projection
 * and the tests describe a set the same way.
 *
 * `rootKeyId` is passed only by the projection: naming the key is what turns "the root key is
 * escrowed somewhere" into an instruction an operator can follow. It is a hash prefix, not a secret.
 */
export function describeArtefact(
  artefact: PlatformArtefact,
  context: { readonly rootKeyId?: string | null } = {},
): string {
  if (artefact.included) {
    const size = artefact.bytes === null ? '' : ` · ${formatBytes(artefact.bytes)}`;
    const when =
      artefact.capturedAt === null ? '' : ` · captured ${formatStamp(artefact.capturedAt)}`;
    return `${artefact.detail}${size}${when}`;
  }
  // Only the root key has an identifier worth naming; an "id" on the TLS reference would just repeat
  // its location.
  const keyId =
    artefact.kind === 'secret_root_key' && typeof context.rootKeyId === 'string'
      ? `, key id ${context.rootKeyId}`
      : '';
  if (artefact.location !== null) {
    return `${artefact.detail} Recorded location: ${artefact.location}${keyId}`;
  }
  return `${artefact.detail} Not captured${keyId === '' ? '.' : ` (location not recorded${keyId}).`}`;
}

function readArtefact(raw: unknown): PlatformArtefact | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (typeof kind !== 'string' || !isArtefactKind(kind)) return null;

  const label =
    typeof raw.label === 'string' && raw.label.length > 0 ? raw.label : LABELS[kind].label;
  const detail =
    typeof raw.detail === 'string' && raw.detail.length > 0 ? raw.detail : LABELS[kind].detail;
  const objectKey =
    typeof raw.objectKey === 'string' && raw.objectKey.length > 0 ? raw.objectKey : null;
  const bytes =
    typeof raw.bytes === 'number' && Number.isFinite(raw.bytes) && raw.bytes >= 0
      ? raw.bytes
      : null;

  return {
    kind,
    label,
    detail,
    // `included` is only true when an object exists: a stored object key is what makes the claim.
    included: raw.included === true && objectKey !== null,
    objectKey,
    bytes,
    digest: typeof raw.digest === 'string' && raw.digest.length > 0 ? raw.digest : null,
    location: typeof raw.location === 'string' && raw.location.length > 0 ? raw.location : null,
    capturedAt:
      typeof raw.capturedAt === 'string' && raw.capturedAt.length > 0 ? raw.capturedAt : null,
  };
}

function isArtefactKind(value: string): value is PlatformArtefactKind {
  return (PLATFORM_ARTEFACT_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  // The ladder carries its own label, so the unit is never an index into a list that could be
  // out of range: TB is the last rung, and nothing divides past it.
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (const next of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

function formatStamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
