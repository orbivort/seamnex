import { parse as parseYaml } from 'yaml';

/**
 * Named volumes, read from the document that was actually applied.
 *
 * Two consumers need the same answer from opposite directions: M05 registers what the daemon
 * created, and M16 decides whether a backup can be taken without silently dropping file data. Both
 * must agree with the *render set*, not with the catalog description, because the render set is the
 * file Compose ran. Keeping the walk here means a future normalisation cannot make the two disagree.
 *
 * Only top-level keys are returned: an anonymous volume (a bare container path) has no stable name
 * to archive or restore, so it is not something the platform can promise to capture.
 */

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A tolerant parse: an unreadable document answers `null` rather than throwing at a caller. */
export function composeDocumentOf(content: string): AnyRecord | null {
  try {
    const parsed: unknown = parseYaml(content);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

/** The named volumes the project declares, sorted so a diff does not depend on key order. */
export function declaredVolumeKeys(document: AnyRecord): string[] {
  return Object.keys(asRecord(document.volumes) ?? {}).sort();
}

/**
 * The container path a named volume is mounted at, from the first service that mounts it.
 *
 * Compose supports both forms and products use both: `db-data:/var/lib/mysql` and
 * `{type: volume, source: db-data, target: /var/lib/mysql}`. A bind mount's source starts with a
 * path separator and can never equal a volume key, so the short form needs no extra guard.
 */
export function mountPathForVolume(document: AnyRecord, key: string): string | null {
  for (const service of Object.values(asRecord(document.services) ?? {})) {
    for (const mount of asArray(asRecord(service)?.volumes)) {
      if (typeof mount === 'string') {
        const [source, target] = mount.split(':');
        // A source that starts with a path separator or `.` is a bind, not a key: it can never
        // equal a volume name, and matching it would report a host path as a container path.
        const isBind = source === undefined || source.startsWith('/') || source.startsWith('.');
        if (!isBind && source === key && target !== undefined && target.length > 0) return target;
        continue;
      }
      const record = asRecord(mount);
      if (record === null) continue;
      if (record.type !== undefined && record.type !== 'volume') continue;
      if (record.source !== key) continue;
      if (typeof record.target === 'string' && record.target.length > 0) return record.target;
    }
  }
  return null;
}
