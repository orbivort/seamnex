import type {
  CatalogEntry,
  CredentialGranularity,
  DomainCluster,
  GuaranteeClass,
  OperationMode,
  PackagingKind,
  ServiceRole,
} from '@seamnex/domain';
import { at, daysAgo } from './context';

export type OperationSeed = {
  id: string;
  label: string;
  mode: OperationMode;
  description: string;
};

export type EventSeed = {
  mode: 'webhook' | 'schedule' | 'poll' | 'none';
  label: string;
  minimumIntervalMinutes?: number;
};

export type EntrySeed = {
  key: string;
  domain: string;
  cluster: DomainCluster;
  product: string;
  description: string;
  repoUrl: string;
  licenseId: string;
  licenseNote?: string;
  /**
   * Fully-qualified image reference. Omit only for a single-segment name: the fallback derivation
   * below cannot know a registry or an organisation, so a product published as `<org>/<name>`
   * (EspoCRM, Mautic, Zammad, …) must state its reference here.
   */
  imageRef?: string;
  /**
   * Upstream version actually observed. Omit to use the fixture heuristic (every fourth entry
   * pends a patch release); state it when the real release has been read, so a pinned entry never
   * claims a pending version that does not exist.
   */
  latestVersion?: string;
  stack: string;
  guaranteeClass: GuaranteeClass;
  authMethod: string;
  packaging: PackagingKind;
  packagingSource: string;
  primaryInstanceId: string | null;
  sharedWith: string[];
  httpPort: number;
  resources: { cpu: number; memoryMb: number; diskMb: number };
  dependencies: ServiceRole[];
  volumes: { name: string; mountPath: string; quotaMb: number }[];
  operations: OperationSeed[];
  events: EventSeed[];
  credentialGranularity: CredentialGranularity;
  sessionMaxMinutes: number;
  sloSupported: boolean;
  owner: { name: string; team: string };
  notes: string;
  deviation?: string;
  verifiedDaysAgo: number;
  reviewDaysFromNow: number;
  stale?: boolean;
};

const DEFAULT_VOLUMES = [
  { name: 'app-data', mountPath: '/var/www/html/data', quotaMb: 20_480 },
  { name: 'db-data', mountPath: '/var/lib/mysql', quotaMb: 20_480 },
];

/** Deterministic 32-byte digest so fixtures never contain randomness. */
function digestFor(value: string): string {
  let hash = 0x811c9dc5;
  let hex = '';
  for (let index = 0; index < 64; index += 1) {
    hash = (hash ^ (value.charCodeAt(index % value.length) + index * 31)) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hex += ((hash >>> 24) & 0xff).toString(16).padStart(2, '0');
  }
  return `sha256:${hex}`;
}

/** Reads the pinned version out of the packaging source, e.g. `@ v9.2.4`. */
function versionOf(source: string): string {
  return /@\s*v?([0-9][\w.-]*)/.exec(source)?.[1] ?? '1.0.0';
}

function bumpPatch(version: string): string {
  const parts = version.split('.');
  const last = Number(parts[parts.length - 1]);
  if (!Number.isFinite(last)) return version;
  parts[parts.length - 1] = String(last + 1);
  return parts.join('.');
}

export function buildEntry(seed: EntrySeed): CatalogEntry {
  const verifiedAt = daysAgo(seed.verifiedDaysAgo);
  // ADR-BE-20: the domain ordinal is the first two digits of a composed key (`D05-01`) or every
  // digit of a legacy one (`D5`); concatenating the composed digits would read domain 05 as 501.
  const ordinal = Number(seed.key.includes('-') ? seed.key.slice(1, 3) : seed.key.slice(1)) || 0;
  const currentVersion = versionOf(seed.packagingSource);
  const base: CatalogEntry = {
    key: seed.key,
    domain: seed.domain,
    cluster: seed.cluster,
    product: seed.product,
    description: seed.description,
    repoUrl: seed.repoUrl,
    licenseId: seed.licenseId,
    stack: seed.stack,
    imageRef:
      seed.imageRef ??
      `${seed.product.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${currentVersion}`,
    imageDigest: digestFor(`${seed.key}:${seed.product}`),
    upstream: {
      currentVersion,
      // Every fourth entry has a pending upstream release; every fifth has an advisory.
      latestVersion:
        seed.latestVersion ?? (ordinal % 4 === 1 ? bumpPatch(currentVersion) : currentVersion),
      advisory:
        ordinal % 5 === 0 ? `GHSA-${(ordinal * 13).toString(16).padStart(4, '0')}-2f7c-9a11` : null,
      releaseUrl: `${seed.repoUrl}/releases`,
      checkedAt: verifiedAt,
    },
    guaranteeClass: seed.guaranteeClass,
    authMethod: seed.authMethod,
    packaging: seed.packaging,
    packagingSource: seed.packagingSource,
    primaryInstanceId: seed.primaryInstanceId,
    sharedWith: seed.sharedWith,
    httpPort: seed.httpPort,
    resources: seed.resources,
    dependencies: seed.dependencies,
    volumes: seed.volumes,
    integration: {
      apiBaseUrl: `https://${seed.primaryInstanceId ? seed.primaryInstanceId.replace('inst-', '') : 'pending'}.seamnex.local/api`,
      authMethod: seed.authMethod,
      guaranteeClassVerified: seed.guaranteeClass,
      operationInventory: seed.operations,
      eventModes: seed.events,
      credentialGranularity: seed.credentialGranularity,
      sessionMaxMinutes: seed.sessionMaxMinutes,
      sloSupported: seed.sloSupported,
      verifiedBy: seed.owner.name,
      verifiedAt,
      nextReviewAt: at(seed.reviewDaysFromNow * 24 * 60),
      stale: seed.stale ?? false,
    },
    owner: seed.owner,
    notes: seed.notes,
    ...(seed.deviation === undefined ? {} : { deviation: seed.deviation }),
    ...(seed.licenseNote === undefined ? {} : { licenseNote: seed.licenseNote }),
    verifiedAt,
  };
  return base;
}

export const DEFAULT_VOLUME_SET = DEFAULT_VOLUMES;
