import type {
  CatalogEntry,
  ContainerStatus,
  EnvValue,
  Instance,
  InstanceDetail,
  InstanceStatus,
  InstanceVolume,
} from '@seamnex/domain';
import { at } from './context';
import { resolveEnv } from './env-plan';

const DIGEST = 'sha256:9d41c7b2e05a83f6b0e1c47a9d28f35c6b0d7e14a92b8f30c5d6a1c47f09e2a7';

function contractSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export type ProvisionInput = {
  entry: CatalogEntry;
  slug: string;
  profileKey: string;
  resources: { cpu: number; memoryMb: number; diskMb: number };
  ownerName: string;
  ownerId: string;
  envOverrides?: Record<string, string>;
};

export function provisionInstance(input: ProvisionInput): {
  instance: Instance;
  detail: InstanceDetail;
  containers: ContainerStatus[];
  status: InstanceStatus;
  envValues: EnvValue[];
} {
  const { entry, slug, profileKey, resources, ownerName, ownerId, envOverrides } = input;
  const now = at(0);
  const id = `inst-${slug}`;
  const volumes: InstanceVolume[] = entry.volumes.map((volume, index) => ({
    id: `${id}-vol-${index + 1}`,
    name: volume.name,
    mountPath: volume.mountPath,
    quotaMb: Math.round(volume.quotaMb * (resources.diskMb / entry.resources.diskMb)),
    usedMb: 0,
  }));

  const services = [
    {
      id: `${id}-web`,
      serviceName: 'web',
      role: 'primary' as const,
      imageRef: `${contractSlug(entry.product)}:${entry.packagingSource.match(/\d+\.\d+\.\d+/)?.[0] ?? '1.0.0'}`,
      imageDigest: DIGEST,
      internalUrl: `http://web.seamnex-inst-${slug}:${entry.httpPort}`,
    },
    ...(entry.dependencies.includes('database')
      ? [
          {
            id: `${id}-db`,
            serviceName: 'db',
            role: 'database' as const,
            imageRef: 'postgres:17.2',
            imageDigest: 'sha256:4bd2ee81da6c0f37a9e15b2d84c0f6173a9e2d5b8c04f71e6a3d90b2c58f147a',
            internalUrl: `http://db.seamnex-inst-${slug}:5432`,
          },
        ]
      : []),
  ];

  const instance: Instance = {
    id,
    slug,
    entryKey: entry.key,
    entryKeys: [entry.key, ...entry.sharedWith],
    domain: entry.domain,
    product: entry.product,
    description: entry.description,
    domainRoute: `${slug}.seamnex.local`,
    profileKey,
    state: 'deploying',
    desiredState: 'running',
    ready: false,
    statusSource: 'manual',
    observedAt: now,
    stateReason: null,
    owner: { id: ownerId, name: ownerName, email: `${contractSlug(ownerName)}@seamnex.local` },
    domainOwner: { id: `usr-${contractSlug(entry.owner.name)}`, name: entry.owner.name },
    createdAt: now,
    updatedAt: now,
    currentVersion: '1.0.0',
    availableVersion: null,
    imageDigest: DIGEST,
    source: {
      path: entry.packaging === 'none' ? 'scaffold' : entry.packaging,
      sourceUrl: entry.packagingSource,
      sourceRevision: 'HEAD',
      resolvedImageRef: `${contractSlug(entry.product)}:1.0.0@${DIGEST}`,
      policyVerdict: 'compliant',
      policyNotes: ['Resolved during the prototype deployment run.'],
      resolvedAt: now,
    },
    route: {
      host: `${slug}.seamnex.local`,
      pathPrefix: '/',
      publishModel: 'subdomain',
      tlsMode: 'acme',
      authMode: entry.guaranteeClass,
      published: false,
    },
    resources,
    usage: { cpuPercent: 0, memoryMb: 0, diskMb: 0 },
    maintenance: null,
    backup: {
      lastSuccessAt: null,
      lastVerifiedRestoreAt: null,
      schedule: 'Daily 02:00 Europe/Berlin',
      scheduleTimezone: 'Europe/Berlin',
      scheduleEnabled: true,
      verified: false,
    },
    eventModes: entry.integration.eventModes,
    licenseId: entry.licenseId,
    licenseRestricted: entry.key === 'D12-01',
    integrationVerified: false,
    metadataStale: false,
  };

  const containers: ContainerStatus[] = services.map((service) => ({
    containerId: `ctr-${service.id}`,
    service: service.serviceName,
    role: service.role,
    state: 'created',
    health: 'starting',
    restartCount: 0,
    startedAt: null,
    exitCode: null,
    exitReason: null,
    imageDigest: service.imageDigest,
    observedAt: now,
  }));

  const plan = resolveEnv(entry.key, profileKey, envOverrides);
  const envValues: EnvValue[] = plan.values.map((value) => ({
    name: value.name,
    purpose: value.purpose,
    type: value.type,
    secret: value.secret,
    value: value.value,
    masked: value.masked,
    source: value.source,
    overrideCeiling: value.overrideCeiling,
    appliedAt: now,
    requiresRecreate: value.requiresRecreate,
    drift: false,
  }));

  return {
    instance,
    detail: { ...instance, services, volumes, integrationChecks: [] },
    containers,
    status: {
      instanceId: id,
      state: 'deploying',
      plainStatus: 'unavailable',
      ready: false,
      reason: null,
      observedAt: now,
      source: 'manual',
      containersRunning: 0,
      containersTotal: containers.length,
      maintenance: null,
    },
    envValues,
  };
}
