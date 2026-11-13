import { parseAllDocuments, stringify } from 'yaml';

/**
 * 4A.3 — the compose policy.
 *
 * A customer's compose file is the most dangerous artefact the platform accepts: it can reach the
 * host, join any network, mount any path and publish any port. The policy is therefore a **blocking
 * list evaluated before the file is ever applied**, plus one normalisation:
 *
 *   - `network_mode: host`, `privileged: true`, host-path bind mounts, external networks and
 *     unpinned images are refused;
 *   - `ports:` is rewritten to `expose:` in the platform-owned copy. The instance never publishes a
 *     port; Traefik reaches it over the platform network, and invariant 9 ("zero published ports")
 *     is asserted again immediately before apply.
 *
 * A rule can be waived, but only by an *approved, unexpired* `policy_exception` row, and the result
 * is recorded as `unsafe_approved` (NFR-4.15, AC-33). The original file is never modified: the
 * normalised document is a separate render artefact, and the patch diff is recorded with it.
 */

export const COMPOSE_RULES = [
  'network_mode_host',
  'privileged',
  'host_path_mount',
  'external_network',
  'unpinned_image',
] as const;

export type ComposeRule = (typeof COMPOSE_RULES)[number];

export type ComposeViolation = {
  readonly rule: ComposeRule;
  readonly service: string | null;
  readonly detail: string;
};

export type ComposePatchEntry = {
  readonly path: string;
  readonly from: unknown;
  readonly to: unknown;
};

export type ComposePolicyResult = {
  readonly verdict: 'allowed' | 'blocked' | 'unsafe_approved';
  readonly violations: readonly ComposeViolation[];
  /** Violations that are covered by an approved exception. */
  readonly waived: readonly ComposeRule[];
  /** The platform-owned copy: published ports removed, exposure declared. */
  readonly document: Record<string, unknown>;
  readonly patch: readonly ComposePatchEntry[];
  /** Invariant 9: must be 0 before apply. */
  readonly publishedPorts: number;
  readonly services: readonly string[];
};

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

/**
 * Evaluates a compose document. `waivedRules` comes from approved, unexpired exceptions; a waived
 * rule still appears in `violations` (the evidence must not disappear) and downgrades the verdict
 * to `unsafe_approved`.
 */
export function evaluateCompose(
  document: AnyRecord,
  waivedRules: ReadonlySet<ComposeRule> = new Set(),
): ComposePolicyResult {
  const violations: ComposeViolation[] = [];
  const patch: ComposePatchEntry[] = [];
  const services = asRecord(document.services) ?? {};
  let publishedPorts = 0;

  for (const [name, raw] of Object.entries(services)) {
    const declared = asRecord(raw);
    if (declared === null) continue;
    // `container_name` is a host-wide name: two instances of the same product would collide, and a
    // rollback could not start the previous definition while the new one holds the name. The
    // platform names containers through the compose project instead, so the key is dropped and the
    // removal is recorded like any other normalisation.
    const { container_name: containerName, ...service } = declared;
    if (containerName !== undefined) {
      patch.push({ path: `services.${name}.container_name`, from: containerName, to: null });
    }

    if (service.network_mode === 'host') {
      violations.push({
        rule: 'network_mode_host',
        service: name,
        detail: `service ${name} uses host networking, which bypasses the platform network.`,
      });
    }
    if (service.privileged === true) {
      violations.push({
        rule: 'privileged',
        service: name,
        detail: `service ${name} requests privileged mode.`,
      });
    }

    for (const mount of asArray(service.volumes)) {
      if (isHostPathMount(mount)) {
        violations.push({
          rule: 'host_path_mount',
          service: name,
          detail: `service ${name} binds a host path (${describeMount(mount)}).`,
        });
      }
    }

    for (const network of asArray(service.networks)) {
      const name_ = typeof network === 'string' ? network : null;
      if (name_ !== null) {
        const declared = asRecord(asRecord(document.networks)?.[name_]);
        if (declared?.external === true) {
          violations.push({
            rule: 'external_network',
            service: name,
            detail: `service ${name} joins external network ${name_}.`,
          });
        }
      }
    }

    const image = typeof service.image === 'string' ? service.image : null;
    if (image === null && service.build === undefined) {
      violations.push({
        rule: 'unpinned_image',
        service: name,
        detail: `service ${name} declares neither an image nor a build context.`,
      });
    }
    if (image !== null && !isPinned(image)) {
      violations.push({
        rule: 'unpinned_image',
        service: name,
        detail: `service ${name} uses ${image}, which is not digest- or version-pinned.`,
      });
    }

    const normalised = normalisePorts(service, name, patch);
    if (normalised.published > 0) publishedPorts += normalised.published;
    // Always written back: `container_name` was removed above even when the service publishes no
    // port, and a conditional assignment here silently kept the removed key in the document.
    services[name] = normalised.service;
  }

  // Top-level external networks with no service attached are still a policy violation: the file is
  // a definition someone may extend later, and an external network in it is intent, not debris.
  for (const [name, raw] of Object.entries(asRecord(document.networks) ?? {})) {
    if (
      asRecord(raw)?.external === true &&
      !violations.some((item) => item.rule === 'external_network')
    ) {
      violations.push({
        rule: 'external_network',
        service: null,
        detail: `network ${name} is declared external.`,
      });
    }
  }

  const waived = [...new Set(violations.map((item) => item.rule))].filter((rule) =>
    waivedRules.has(rule),
  );
  const blocking = violations.filter((item) => !waivedRules.has(item.rule));

  return {
    verdict: blocking.length > 0 ? 'blocked' : waived.length > 0 ? 'unsafe_approved' : 'allowed',
    violations,
    waived,
    document: { ...document, services },
    patch,
    publishedPorts,
    services: Object.keys(services),
  };
}

/**
 * Parses YAML into a document object. Multi-document files are refused: the platform applies one
 * project per instance, and silently taking the first document hides the rest.
 */
export function parseCompose(content: string): AnyRecord {
  const documents = parseAllDocuments(content);
  if (documents.length !== 1) {
    throw new Error(`a compose file must contain exactly one document (found ${documents.length})`);
  }
  const document = documents[0];
  if (document?.errors !== undefined && document.errors.length > 0) {
    throw new Error(
      `compose YAML is invalid: ${document.errors.map((error) => error.message).join('; ')}`,
    );
  }
  const record = asRecord(document?.toJS({ maxAliasCount: 100 }));
  if (record === null) throw new Error('a compose file must be a mapping at the top level');
  if (asRecord(record.services) === null) throw new Error('a compose file must declare `services`');
  return record;
}

/** Serialises the platform-owned copy. The caller writes it into the render set directory. */
export function stringifyCompose(document: AnyRecord): string {
  return stringify(document, { lineWidth: 0 });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPinned(image: string): boolean {
  if (image.includes('@sha256:')) return true;
  const withoutRegistry = image.split('/').pop() ?? image;
  const tag = withoutRegistry.includes(':') ? (withoutRegistry.split(':').pop() ?? '') : '';
  return tag.length > 0 && tag !== 'latest';
}

function isHostPathMount(mount: unknown): boolean {
  if (typeof mount === 'string') {
    const [source] = mount.split(':');
    if (source === undefined) return false;
    return source.startsWith('/') || source.startsWith('.') || source.startsWith('~');
  }
  const record = asRecord(mount);
  if (record === null) return false;
  if (record.type === 'bind') return true;
  const source = typeof record.source === 'string' ? record.source : '';
  return source.startsWith('/') || source.startsWith('.') || source.startsWith('~');
}

function describeMount(mount: unknown): string {
  if (typeof mount === 'string') return mount;
  const record = asRecord(mount);
  return typeof record?.source === 'string' ? record.source : 'unknown source';
}

/**
 * Rewrites `ports` into `expose`. Every published form collapses to its container port:
 * `8080:80`, `127.0.0.1:8080:80`, `80` and `80/tcp` all mean "the container listens on 80".
 */
function normalisePorts(
  service: AnyRecord,
  serviceName: string,
  patch: ComposePatchEntry[],
): { service: AnyRecord; published: number } {
  const ports = asArray(service.ports);
  if (ports.length === 0) return { service, published: 0 };

  const exposed = new Set<string>(
    asArray(service.expose)
      .map((entry) =>
        typeof entry === 'string' ? entry : typeof entry === 'number' ? String(entry) : null,
      )
      .filter((entry): entry is string => entry !== null),
  );
  let published = 0;

  for (const entry of ports) {
    const containerPort = containerPortOf(entry);
    if (containerPort === null) continue;
    published += 1;
    exposed.add(containerPort);
  }

  const { ports: _removed, ...rest } = service;
  const expose = [...exposed].sort();
  // One recorded patch per normalised field: the original array and its replacement, so an
  // operator can see exactly what the platform changed before applying.
  patch.push({ path: `services.${serviceName}.ports`, from: ports, to: null });
  patch.push({ path: `services.${serviceName}.expose`, from: service.expose ?? null, to: expose });
  return { service: { ...rest, expose }, published };
}

function containerPortOf(entry: unknown): string | null {
  if (typeof entry === 'number') return String(entry);
  if (typeof entry === 'string') {
    const stripped = entry.replace(/\/(tcp|udp)$/, '');
    const parts = stripped.split(':');
    const container = parts[parts.length - 1]?.trim() ?? '';
    const protocol = entry.endsWith('/udp') ? '/udp' : '';
    return container.length > 0 ? `${container}${protocol}` : null;
  }
  const record = asRecord(entry);
  if (record === null) return null;
  const target = record.target;
  if (typeof target === 'number') return String(target);
  if (typeof target === 'string') return target;
  return null;
}
