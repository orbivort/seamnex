import type {
  ContainerStatus,
  DriftRecord,
  EnvValue,
  Instance,
  InstanceDetail,
  InstanceService,
  InstanceStatus,
  InstanceVolume,
  IntegrationCheck,
} from '@seamnex/domain';
import { plainStatusFor } from '@seamnex/domain';
import { CATALOG_BY_KEY, ENV_SCHEMAS } from './catalog';
import { at, daysAgo } from './context';
import { INSTANCE_OBSERVED_AT, INSTANCE_SEEDS, type InstanceSeed } from './instances-base';

const SOFIA = { id: 'usr-sofia', name: 'Sofia Almeida', email: 'sofia.almeida@seamnex.local' };

function contractSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** The schedule string ends with the IANA zone, e.g. `Daily 02:00 Europe/Berlin`. */
export function timezoneOf(schedule: string): string {
  const last = schedule.trim().split(/\s+/).at(-1) ?? '';
  return /^[A-Za-z]+\/[A-Za-z_]+$/.test(last) ? last : 'UTC';
}

function domainOwnerFor(seed: InstanceSeed) {
  const entry = CATALOG_BY_KEY[seed.entryKey];
  const name = entry?.owner.name ?? 'Sofia Almeida';
  return { id: `usr-${contractSlug(name)}`, name, email: `${contractSlug(name)}@seamnex.local` };
}

function buildServices(seed: InstanceSeed, version: string): InstanceService[] {
  const entry = CATALOG_BY_KEY[seed.entryKey];
  const product = contractSlug(entry?.product ?? 'product');
  const net = seed.id.replace('inst-', 'seamnex-inst-');
  const services: InstanceService[] = [
    {
      id: `${seed.id}-web`,
      serviceName: 'web',
      role: 'primary',
      imageRef: `${product}:${version}`,
      imageDigest: seed.imageDigest,
      internalUrl: `http://web.${net}:${entry?.httpPort ?? 8080}`,
    },
  ];
  if (entry?.dependencies.includes('database')) {
    // Tenant images, not the platform pin: the platform's own engine tags live in
    // docker/compose.dev.yml (PostgreSQL 18, Redis 7). A mixed fleet here is deliberate demo data.
    services.push({
      id: `${seed.id}-db`,
      serviceName: 'db',
      role: 'database',
      imageRef: entry.key === 'D06-01' ? 'mariadb:11.8' : 'postgres:17.2',
      imageDigest: 'sha256:4bd2ee81da6c0f37a9e15b2d84c0f6173a9e2d5b8c04f71e6a3d90b2c58f147a',
      internalUrl: `http://db.${net}:5432`,
    });
  }
  if (entry?.dependencies.includes('cache')) {
    services.push({
      id: `${seed.id}-redis`,
      serviceName: 'redis',
      role: 'cache',
      imageRef: 'redis:7.4.2',
      imageDigest: 'sha256:2f1a9c40d7b3e58a6c0f91d24b7e3a58c61d09f4a2b7e38c05d61a9f4b2e7c30',
      internalUrl: `http://redis.${net}:6379`,
    });
  }
  if (entry?.dependencies.includes('search')) {
    services.push({
      id: `${seed.id}-search`,
      serviceName: 'search',
      role: 'search',
      imageRef: 'elasticsearch:8.17.0',
      imageDigest: 'sha256:8c2b4d90f17a36e5c0b1d47f9a28e35c6b0d7f14a92c8e30b5d6a1c47f09e2b3',
      internalUrl: `http://search.${net}:9200`,
    });
  }
  if (entry?.dependencies.includes('worker')) {
    services.push({
      id: `${seed.id}-worker`,
      serviceName: 'worker',
      role: 'worker',
      imageRef: `${product}:${version}`,
      imageDigest: seed.imageDigest,
      internalUrl: `http://worker.${net}:8080`,
    });
  }
  return services;
}

function buildVolumes(seed: InstanceSeed): InstanceVolume[] {
  const entry = CATALOG_BY_KEY[seed.entryKey];
  return (entry?.volumes ?? []).map((volume, index) => ({
    id: `${seed.id}-vol-${index + 1}`,
    name: volume.name,
    mountPath: volume.mountPath,
    quotaMb: volume.quotaMb,
    usedMb: Math.round(volume.quotaMb * (seed.state === 'stopped' ? 0.3 : 0.42)),
  }));
}

function buildInstance(seed: InstanceSeed): Instance {
  const entry = CATALOG_BY_KEY[seed.entryKey];
  const host = `${seed.slug}.seamnex.local`;
  return {
    id: seed.id,
    slug: seed.slug,
    entryKey: seed.entryKey,
    entryKeys: seed.entryKeys,
    domain: entry?.domain ?? 'Unknown domain',
    product: entry?.product ?? 'Unknown product',
    description: entry?.description ?? '',
    domainRoute: host,
    profileKey: seed.profileKey,
    state: seed.state,
    desiredState: seed.desiredState,
    ready: seed.ready,
    statusSource: 'poll',
    observedAt: INSTANCE_OBSERVED_AT,
    stateReason: seed.stateReason,
    owner: SOFIA,
    domainOwner: domainOwnerFor(seed),
    createdAt: daysAgo(seed.createdDaysAgo),
    updatedAt: at(-180),
    currentVersion: seed.currentVersion,
    availableVersion: seed.availableVersion,
    imageDigest: seed.imageDigest,
    source: {
      ...seed.source,
      resolvedImageRef: `${contractSlug(entry?.product ?? 'product')}:${seed.currentVersion}@${seed.imageDigest}`,
      resolvedAt: daysAgo(seed.createdDaysAgo),
    },
    route: {
      host,
      pathPrefix: '/',
      publishModel: 'subdomain',
      tlsMode: 'acme',
      authMode: entry?.guaranteeClass ?? 'fa_gate',
      published: seed.published,
    },
    resources: seed.resources,
    usage: seed.usage,
    maintenance: null,
    backup: {
      lastSuccessAt:
        seed.backup.lastSuccessHoursAgo === null ? null : at(-seed.backup.lastSuccessHoursAgo * 60),
      lastVerifiedRestoreAt:
        seed.backup.lastVerifiedRestoreDaysAgo === null
          ? null
          : daysAgo(seed.backup.lastVerifiedRestoreDaysAgo),
      schedule: seed.backup.schedule,
      scheduleTimezone: timezoneOf(seed.backup.schedule),
      scheduleEnabled: true,
      verified: seed.backup.lastVerifiedRestoreDaysAgo !== null,
    },
    eventModes: entry?.integration.eventModes ?? [],
    licenseId: entry?.licenseId ?? 'UNKNOWN',
    licenseRestricted: seed.licenseRestricted,
    integrationVerified: seed.state !== 'degraded',
    metadataStale: seed.metadataStale,
  };
}

function buildContainers(seed: InstanceSeed, services: InstanceService[]): ContainerStatus[] {
  return services.map((service) => {
    if (seed.state === 'stopped') {
      return {
        containerId: `ctr-${service.id}`,
        service: service.serviceName,
        role: service.role,
        state: 'exited',
        health: 'none',
        restartCount: 0,
        startedAt: at(-52 * 60),
        exitCode: 0,
        exitReason: 'Stopped by operator (intentional)',
        imageDigest: service.imageDigest,
        observedAt: INSTANCE_OBSERVED_AT,
      };
    }
    const unhealthy = seed.state === 'degraded' && service.role === 'primary';
    return {
      containerId: `ctr-${service.id}`,
      service: service.serviceName,
      role: service.role,
      state: 'running',
      health: unhealthy ? 'unhealthy' : 'healthy',
      restartCount: unhealthy ? 2 : 0,
      startedAt: at(-(unhealthy ? 38 : 74)),
      exitCode: null,
      exitReason: unhealthy ? 'Last restart: readiness probe failed' : null,
      imageDigest: service.imageDigest,
      observedAt: INSTANCE_OBSERVED_AT,
    };
  });
}

function buildEnv(seed: InstanceSeed): EnvValue[] {
  const vars = ENV_SCHEMAS[seed.entryKey] ?? [];
  return vars.map((variable) => {
    const isSecret = variable.secret;
    const override = seed.id === 'inst-documents' && variable.name === 'PAPERLESS_OCR_LANGUAGE';
    const value = isSecret
      ? '••••••••'
      : override
        ? 'deu'
        : (variable.defaultValue ??
          (variable.name === 'ADMIN_EMAIL' ? 'portal-admin@seamnex.local' : null));
    return {
      name: variable.name,
      purpose: variable.purpose,
      type: variable.type,
      secret: isSecret,
      value,
      masked: isSecret,
      source: isSecret
        ? 'secret'
        : override
          ? 'instance'
          : variable.defaultValue
            ? 'default'
            : 'profile',
      overrideCeiling: variable.overrideCeiling,
      appliedAt: at(-(seed.createdDaysAgo * 24 * 60)),
      requiresRecreate: [
        'SMTP_HOST',
        'DB_PASSWORD',
        'NEXTCLOUD_TRUSTED_DOMAINS',
        'WP_HOME',
      ].includes(variable.name),
      drift: override,
    };
  });
}

function buildDrift(seed: InstanceSeed): DriftRecord[] {
  if (seed.id !== 'inst-documents') return [];
  return [
    {
      id: 'drift-d8-1',
      varName: 'PAPERLESS_OCR_LANGUAGE',
      declared: 'deu+eng',
      observed: 'deu',
      kind: 'mismatch',
      detectedAt: at(-310),
      resolvedAt: null,
    },
    {
      id: 'drift-d8-2',
      varName: 'PAPERLESS_ADMIN_USER',
      declared: null,
      observed: 'paperless-admin',
      kind: 'undeclared',
      detectedAt: at(-310),
      resolvedAt: null,
    },
  ];
}

function buildChecks(seed: InstanceSeed): IntegrationCheck[] {
  const checkedAt = INSTANCE_OBSERVED_AT;
  const degraded = seed.state === 'degraded';
  const stopped = seed.state === 'stopped';
  const gateOnly = CATALOG_BY_KEY[seed.entryKey]?.guaranteeClass === 'fa_gate';
  return [
    {
      check: 'http',
      label: 'Application HTTP readiness',
      ok: !degraded && !stopped,
      detail: degraded
        ? 'HTTP 503 from the login route after 3 attempts.'
        : stopped
          ? 'Instance stopped by operator.'
          : 'HTTP 200 within 420 ms.',
      checkedAt,
    },
    {
      check: 'sso_login',
      label: 'Single sign-on test login',
      ok: !degraded,
      detail: degraded
        ? 'Test login aborted: the application is not ready.'
        : gateOnly
          ? 'Proxy gate verified; the product credential is provisioned outside the platform.'
          : 'Test user authenticated through the realm; no product password created.',
      checkedAt,
    },
    {
      check: 'dns',
      label: 'Route and DNS resolution',
      ok: !stopped,
      detail: stopped
        ? 'Route unpublished while the instance is stopped.'
        : `A record resolves to the edge for ${seed.slug}.seamnex.local.`,
      checkedAt,
    },
    {
      check: 'backup_registered',
      label: 'Backup job registration',
      ok: true,
      detail: `Registered: ${seed.backup.schedule}.`,
      checkedAt,
    },
    {
      check: 'webhook_registered',
      label: 'Trigger endpoint registration',
      ok: !stopped,
      detail: stopped
        ? 'Skipped: instance is stopped; the trigger is disabled.'
        : 'Inbound token issued; HMAC secret stored in the secret store.',
      checkedAt,
    },
  ];
}

export const INSTANCES: Instance[] = INSTANCE_SEEDS.map(buildInstance);

export const INSTANCE_BY_ID: Record<string, Instance> = Object.fromEntries(
  INSTANCES.map((instance) => [instance.id, instance]),
);

export const SERVICES: Record<string, InstanceService[]> = Object.fromEntries(
  INSTANCE_SEEDS.map((seed) => [seed.id, buildServices(seed, seed.currentVersion)]),
);

export const VOLUMES: Record<string, InstanceVolume[]> = Object.fromEntries(
  INSTANCE_SEEDS.map((seed) => [seed.id, buildVolumes(seed)]),
);

export const CONTAINERS: Record<string, ContainerStatus[]> = Object.fromEntries(
  INSTANCE_SEEDS.map((seed) => [seed.id, buildContainers(seed, SERVICES[seed.id] ?? [])]),
);

export const ENV_VALUES: Record<string, EnvValue[]> = Object.fromEntries(
  INSTANCE_SEEDS.map((seed) => [seed.id, buildEnv(seed)]),
);

export const DRIFT: Record<string, DriftRecord[]> = Object.fromEntries(
  INSTANCE_SEEDS.map((seed) => [seed.id, buildDrift(seed)]),
);

export const INTEGRATION_CHECKS: Record<string, IntegrationCheck[]> = Object.fromEntries(
  INSTANCE_SEEDS.map((seed) => [seed.id, buildChecks(seed)]),
);

export const INSTANCE_DETAILS: Record<string, InstanceDetail> = Object.fromEntries(
  INSTANCES.map((instance) => [
    instance.id,
    {
      ...instance,
      services: SERVICES[instance.id] ?? [],
      volumes: VOLUMES[instance.id] ?? [],
      integrationChecks: INTEGRATION_CHECKS[instance.id] ?? [],
    },
  ]),
);

export const INSTANCE_STATUSES: Record<string, InstanceStatus> = Object.fromEntries(
  INSTANCES.map((instance) => {
    const containers = CONTAINERS[instance.id] ?? [];
    return [
      instance.id,
      {
        instanceId: instance.id,
        state: instance.state,
        plainStatus: plainStatusFor(instance.state, instance.ready),
        ready: instance.ready,
        reason: instance.stateReason,
        observedAt: instance.observedAt,
        source: instance.statusSource,
        containersRunning: containers.filter((container) => container.state === 'running').length,
        containersTotal: containers.length,
        maintenance: instance.maintenance,
      },
    ];
  }),
);
