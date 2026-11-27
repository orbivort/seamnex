import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Prometheus `file_sd` target files, one per instance (FR-2.6).
 *
 * Why files rather than a service-discovery endpoint: Prometheus already watches a directory, so the
 * control plane needs a directory it can write and Prometheus can read — no reload API to secure, no
 * second HTTP surface that must stay available while the API is degraded.
 *
 * The file name is the instance **id**, not the slug. A slug is a label and can be renamed; a target
 * file keyed by a mutable name would be orphaned by the rename, and pruning (which compares file
 * names with live ids) could no longer tell a stale file from a renamed one.
 */
export type TargetSpec = {
  instanceId: string;
  slug: string;
  entryKey: string;
  product: string;
  /** `host:port` of the API, as Prometheus reaches it. */
  address: string;
  /** The API path that renders this instance's series. */
  metricsPath: string;
};

export function targetFileName(instanceId: string): string {
  return `instance-${instanceId}.json`;
}

/** The document Prometheus reads. `__metrics_path__` is a reserved label, honoured per target. */
export function targetDocument(spec: TargetSpec): string {
  const document = [
    {
      targets: [spec.address],
      labels: {
        __metrics_path__: spec.metricsPath,
        job: 'seamnex-instance',
        instance_id: spec.instanceId,
        instance_slug: spec.slug,
        entry_key: spec.entryKey,
        product: spec.product,
      },
    },
  ];
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Writes the target atomically (temp file + rename) and returns whether the content changed.
 *
 * `false` is the common answer on a re-projection pass: rewriting 13 identical files every cycle
 * would make Prometheus re-read them for nothing.
 */
export async function writeTarget(
  directory: string,
  spec: TargetSpec,
): Promise<{ file: string; changed: boolean }> {
  await mkdir(directory, { recursive: true });
  const file = targetFileName(spec.instanceId);
  const path = join(directory, file);
  const content = targetDocument(spec);

  const existing = await readFile(path, 'utf8').catch(() => null);
  if (existing === content) return { file, changed: false };

  // Prometheus must never see a half-written file: `rename` within one filesystem is atomic.
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
  return { file, changed: true };
}

export async function removeTarget(directory: string, instanceId: string): Promise<boolean> {
  try {
    await rm(join(directory, targetFileName(instanceId)));
    return true;
  } catch {
    return false;
  }
}

/** Instance ids that currently have a published target — the input to pruning. */
export async function publishedTargetIds(directory: string): Promise<string[]> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  return entries
    .map((name) => /^instance-([0-9a-f-]{36})\.json$/i.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1] as string);
}

export async function targetWrittenAt(directory: string, instanceId: string): Promise<Date | null> {
  try {
    const info = await stat(join(directory, targetFileName(instanceId)));
    return info.mtime;
  } catch {
    return null;
  }
}

/** True when the file exists and parses as a target list — the "published" half of the report. */
export async function targetIsPublished(directory: string, instanceId: string): Promise<boolean> {
  try {
    const content = await readFile(join(directory, targetFileName(instanceId)), 'utf8');
    const parsed: unknown = JSON.parse(content);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}
