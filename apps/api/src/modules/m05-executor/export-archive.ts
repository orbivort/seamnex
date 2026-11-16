import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ExecResult } from '../../common/exec/exec';
import {
  connectionEnvFrom,
  dumpCommand,
  dumpExtension,
  engineOf,
} from '../../common/engine/database';
import { ensureDir, isFile, removeTree, sha256File, writeFileAtomic } from '../../common/fs/files';
import { dockerMountSource } from '../../common/docker/mount';
import { instanceNetwork } from '../../common/docker/naming';
import { AppError } from '../../common/problem/app-error';
import {
  archiveFileName,
  exportsDirectory,
  newExportId,
  writeExportRecord,
  type ExportInclude,
  type ExportManifest,
  type ExportRecord,
} from './instance-exports';

/**
 * FR-1.13 / AC-20 — the capture behind the `export` lifecycle action.
 *
 * The rule this file exists to keep: **the archive holds what it says it holds.** Every item is
 * written by a helper container or copied from the applied set, the manifest lists each file with a
 * digest, and `includes` is computed from what was actually written. A capture that cannot include
 * the database is refused by the caller before this runs, rather than producing a file whose name
 * promises more than its contents.
 *
 * Layout (the archive root):
 *
 *     manifest.json          every file with its SHA-256 and size
 *     README.txt             how to use the archive without this platform
 *     instance/env.json      resolved values; secret values are named, never included
 *     render/                the applied compose files and platform.env
 *     database/<svc>.sql     plain-SQL dump per database service
 *     volumes/<vol>.tar.gz   one archive per registered data volume
 *
 * The dump is plain SQL, not the custom format the backup runner uses: a backup is restored by this
 * platform, an export is loaded by whoever receives it.
 */

export type ExportDocker = {
  runCli(file: string, args: readonly string[], timeoutMs?: number): Promise<ExecResult>;
  volumeExists(name: string): Promise<boolean>;
};

export type ExportEnvRow = {
  readonly var_name: string;
  readonly value_enc: Buffer | null;
  readonly source: string;
  readonly secret_ref: string | null;
};

export type ExportSubject = {
  readonly instance: {
    readonly id: string;
    readonly slug: string;
    readonly entryKey: string;
    readonly state: string;
  };
  readonly renderSet: {
    readonly id: string;
    readonly contentHash: string;
    readonly directory: string;
    /** False when the newest render set never ran; the archive says so rather than implying it did. */
    readonly applied: boolean;
  } | null;
  readonly services: readonly { readonly service: string; readonly imageRef: string }[];
  readonly volumes: readonly string[];
  readonly envRows: readonly ExportEnvRow[];
};

export type ExportOptions = {
  readonly dataDir: string;
  /** `SEAMNEX_DOCKER_PATH_MAP`: a helper mounts the *host* path, not this process's path. */
  readonly pathMap: string;
  readonly docker: ExportDocker;
  readonly log?: (stream: 'stdout' | 'system' | 'stderr', line: string) => Promise<void>;
  readonly now?: () => Date;
};

export type ExportArtefact = {
  readonly exportId: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly includes: readonly ExportInclude[];
  readonly excluded: readonly { readonly item: string; readonly reason: string }[];
};

const HELPER_IMAGE = 'alpine:3.20';
const HELPER_TIMEOUT_MS = 900_000;
const ARCHIVE_TIMEOUT_MS = 3_600_000;
/** Docker volume and compose service names both live inside this grammar; anything else is renamed. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export async function writeExportArchive(
  options: ExportOptions,
  subject: ExportSubject,
): Promise<ExportArtefact> {
  const now = options.now?.() ?? new Date();
  const exportId = newExportId(now);
  const directory = exportsDirectory(options.dataDir, subject.instance.id);
  const stage = join(directory, `.staging-${exportId}`);
  ensureDir(stage);

  const log = async (
    line: string,
    stream: 'stdout' | 'system' | 'stderr' = 'stdout',
  ): Promise<void> => {
    await options.log?.(stream, line);
  };

  const files: { path: string; sha256: string; bytes: number }[] = [];
  const includes: ExportInclude[] = [];
  const excluded: { item: string; reason: string }[] = [];

  const record = (relative: string, absolute: string): void => {
    files.push({ path: relative, sha256: '', bytes: statSync(absolute).size });
  };

  try {
    // ---- database ------------------------------------------------------------------------------
    const databases = await dumpDatabases(options, subject, stage, exportId, log, record);
    if (databases > 0) includes.push('database');

    // ---- volumes -------------------------------------------------------------------------------
    const volumes = await archiveVolumes(options, subject, stage, log, record, excluded);
    if (volumes > 0) includes.push('volumes');

    // ---- definition ----------------------------------------------------------------------------
    if (subject.renderSet !== null && existsSync(subject.renderSet.directory)) {
      const target = join(stage, 'render');
      cpSync(subject.renderSet.directory, target, { recursive: true });
      for (const relative of listFiles(target))
        record(`render/${relative}`, join(target, relative));
      includes.push('definition');
    } else {
      excluded.push({
        item: 'definition',
        reason:
          subject.renderSet === null
            ? 'no render set has been applied for this instance'
            : `the applied render set directory ${subject.renderSet.directory} is no longer on disk`,
      });
    }

    // ---- environment ---------------------------------------------------------------------------
    const envFile = join(stage, 'instance', 'env.json');
    ensureDir(join(stage, 'instance'));
    const environment = environmentDocument(subject.envRows);
    writeFileAtomic(envFile, `${JSON.stringify(environment, null, 2)}\n`);
    record('instance/env.json', envFile);
    includes.push('environment');

    // Named only when the instance actually holds secrets: an entry for something that does not
    // exist is noise a reader has to dismiss.
    if (environment.secretNames.length > 0) {
      excluded.push({
        item: 'secrets',
        reason:
          'secret values are never exported; instance/env.json names every one so it can be supplied again',
      });
    }

    // ---- manifest and read-me ------------------------------------------------------------------
    const readme = join(stage, 'README.txt');
    writeFileAtomic(
      readme,
      readmeFor({
        exportId,
        exportedAt: now.toISOString(),
        instance: subject.instance,
        renderSet: subject.renderSet,
        environment,
        includes,
        excluded,
        databases,
        volumes,
      }),
    );
    record('README.txt', readme);

    for (const file of files) file.sha256 = await sha256File(join(stage, file.path));

    const manifest: ExportManifest = {
      version: 1,
      exportId,
      exportedAt: now.toISOString(),
      instance: subject.instance,
      renderSet:
        subject.renderSet === null
          ? null
          : {
              id: subject.renderSet.id,
              contentHash: subject.renderSet.contentHash,
              applied: subject.renderSet.applied,
            },
      includes,
      excluded,
      files,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    };
    const manifestFile = join(stage, 'manifest.json');
    writeFileAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    await log(
      `manifest written: ${files.length} file(s), ${manifest.totalBytes} bytes uncompressed`,
    );

    // ---- one archive ---------------------------------------------------------------------------
    const fileName = archiveFileName(exportId);
    await runHelper(
      options,
      [
        'run',
        '--rm',
        '-v',
        `${mountSource(options, stage)}:/src:ro`,
        '-v',
        `${mountSource(options, directory)}:/out`,
        HELPER_IMAGE,
        'tar',
        '-czf',
        `/out/${fileName}`,
        '-C',
        '/src',
        '.',
      ],
      ARCHIVE_TIMEOUT_MS,
    );

    const archive = join(directory, fileName);
    const bytes = statSync(archive).size;
    const sha256 = await sha256File(archive);

    const recordDocument: ExportRecord = { ...manifest, archive: { fileName, bytes, sha256 } };
    writeExportRecord(directory, recordDocument);
    await log(`archive written: ${fileName} (${bytes} bytes)`);

    return { exportId, fileName, bytes, sha256, includes, excluded };
  } finally {
    // The staging tree holds an unencrypted copy of the product's data; the archive is the artefact.
    // Removed on both paths: a failed capture must not leave a half-copied database on the host.
    removeTree(stage);
  }
}

async function dumpDatabases(
  options: ExportOptions,
  subject: ExportSubject,
  stage: string,
  exportId: string,
  log: (line: string, stream?: 'stdout' | 'system' | 'stderr') => Promise<void>,
  record: (relative: string, absolute: string) => void,
): Promise<number> {
  const engines = subject.services.flatMap((service) => {
    const engine = engineOf(service.imageRef);
    return engine === null ? [] : [{ ...service, engine }];
  });
  if (engines.length === 0) return 0;

  const directory = join(stage, 'database');
  ensureDir(directory);
  let written = 0;

  for (const service of engines) {
    const name = safeName(service.service);
    const file = join(directory, `${name}.${dumpExtension('plain')}`);
    const env = connectionEnvFrom(subject.envRows, service.engine);
    try {
      await runHelper(options, [
        'run',
        '--rm',
        '--network',
        instanceNetwork(subject.instance.slug),
        '-v',
        `${mountSource(options, directory)}:/backup`,
        ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        service.imageRef,
        ...dumpCommand(service.engine, `/backup/${name}.${dumpExtension('plain')}`, 'plain'),
      ]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await log(`${service.service}: the database could not be dumped — ${reason}`, 'stderr');
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: `${subject.instance.slug}: ${service.service} (${service.engine}) could not be dumped, so the export would hold none of its data: ${reason}`,
        remediation:
          'Start the instance and retry. An export that silently omits the database is worse than a failed one; nothing was kept.',
        cause: error,
      });
    }
    record(`database/${name}.${dumpExtension('plain')}`, file);
    written += 1;
    await log(
      `${service.service}: ${service.engine} dump written (${basename(file)}, export ${exportId})`,
    );
  }
  return written;
}

async function archiveVolumes(
  options: ExportOptions,
  subject: ExportSubject,
  stage: string,
  log: (line: string, stream?: 'stdout' | 'system' | 'stderr') => Promise<void>,
  record: (relative: string, absolute: string) => void,
  excluded: { item: string; reason: string }[],
): Promise<number> {
  if (subject.volumes.length === 0) {
    excluded.push({
      item: 'volumes',
      reason:
        'the applied definition declares no named data volume, so there is no file data to capture',
    });
    return 0;
  }

  const directory = join(stage, 'volumes');
  ensureDir(directory);
  let written = 0;

  for (const volume of subject.volumes) {
    // A registered volume the daemon no longer holds contains no data: failing the whole export for
    // it would trade a complete archive for no archive. It is named in `excluded` instead.
    if (!(await options.docker.volumeExists(volume))) {
      excluded.push({
        item: `volumes/${volume}`,
        reason: 'the daemon no longer holds this volume, so it contributed no data',
      });
      await log(
        `volume ${volume} is registered but absent from the daemon; not captured`,
        'system',
      );
      continue;
    }
    const file = `${safeName(volume)}.tar.gz`;
    await runHelper(options, [
      'run',
      '--rm',
      '-v',
      `${volume}:/src:ro`,
      '-v',
      `${mountSource(options, directory)}:/out`,
      HELPER_IMAGE,
      'tar',
      '-czf',
      `/out/${file}`,
      '-C',
      '/src',
      '.',
    ]);
    record(`volumes/${file}`, join(directory, file));
    written += 1;
    await log(`volume ${volume}: archive written`);
  }
  return written;
}

async function runHelper(
  options: ExportOptions,
  args: readonly string[],
  timeoutMs = HELPER_TIMEOUT_MS,
): Promise<ExecResult> {
  const result = await options.docker.runCli('docker', args, timeoutMs);
  if (result.code !== 0) {
    throw new AppError({
      code: 'ADAPTER_UNAVAILABLE',
      detail: `The export helper exited with ${result.code}: ${lastMeaningfulLine(result.stderr) || 'no output'}`,
      remediation:
        'Check that the Docker daemon is reachable (DOCKER_HOST) and that the helper image is pullable; the export was not written.',
    });
  }
  return result;
}

/** The bind source a helper container can mount; see `mount.ts` for why the two paths differ. */
function mountSource(options: ExportOptions, containerPath: string): string {
  return dockerMountSource(containerPath, options.pathMap);
}

/** Every file under `root`, relative to it, so the manifest path and the copied path agree. */
function listFiles(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry) => isFile(join(root, entry)));
}

function safeName(value: string): string {
  return SAFE_NAME.test(value) && !value.includes('..')
    ? value
    : value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function lastMeaningfulLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .pop() ?? ''
  );
}

type EnvironmentDocument = {
  readonly values: readonly { name: string; source: string; value: string | null }[];
  readonly secretNames: readonly string[];
};

/**
 * The environment a recipient needs to start the product again.
 *
 * Non-secret values are carried because they describe *this* deployment (its host, its database
 * name); secret values are not, because an export leaves the platform and a plaintext archive is not
 * where a credential belongs. The names are still listed: an operator who cannot see which values
 * are missing cannot restore the product at all.
 */
function environmentDocument(rows: readonly ExportEnvRow[]): EnvironmentDocument {
  const values = rows
    .map((row) => ({
      name: row.var_name,
      source: row.source,
      value: row.source === 'secret' ? null : (row.value_enc?.toString('utf8') ?? null),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    values,
    // A variable with `source = 'secret'` and a variable that simply has no value yet are different
    // facts; only the first is a credential the recipient must supply.
    secretNames: values.filter((entry) => entry.source === 'secret').map((entry) => entry.name),
  };
}

function readmeFor(input: {
  exportId: string;
  exportedAt: string;
  instance: ExportSubject['instance'];
  renderSet: ExportSubject['renderSet'];
  environment: EnvironmentDocument;
  includes: readonly ExportInclude[];
  excluded: readonly { item: string; reason: string }[];
  databases: number;
  volumes: number;
}): string {
  const secrets =
    input.environment.secretNames.length === 0
      ? '  none declared'
      : input.environment.secretNames.map((name) => `  ${name}`).join('\n');

  return [
    `SEAMNEX EXPORT — ${input.instance.slug} (${input.instance.entryKey})`,
    `Export id: ${input.exportId}`,
    `Exported at: ${input.exportedAt}`,
    `Instance state at export: ${input.instance.state}`,
    input.renderSet === null
      ? 'Render set: none'
      : `Render set: ${input.renderSet.id} (${input.renderSet.contentHash}) — ${
          input.renderSet.applied
            ? 'applied'
            : 'NOT applied; the deployment never completed, so render/ is the definition of record rather than what ran'
        }`,
    '',
    'This is a plain, unencrypted copy of one instance: the database dumps, the data volumes and',
    'the definition that was applied. It is produced so the business can keep the data without this',
    'platform. It is not a backup set — nothing here is encrypted, and the platform does not restore',
    'from it.',
    '',
    'Contents',
    '  manifest.json          every file with its SHA-256 and size',
    '  README.txt             this file',
    '  instance/env.json      resolved environment; secret values are named, never included',
    '  render/                the applied compose files and platform.env',
    '  database/*.sql         plain-SQL dump per database service',
    '  volumes/*.tar.gz       one archive per data volume, rooted at the volume mount point',
    '',
    `Captured: ${input.includes.length > 0 ? input.includes.join(', ') : 'nothing'}` +
      ` (${input.databases} database dump(s), ${input.volumes} volume(s))`,
    ...(input.excluded.length === 0
      ? []
      : [
          '',
          'Deliberately not captured',
          ...input.excluded.map((entry) => `  ${entry.item}: ${entry.reason}`),
        ]),
    '',
    'Secrets',
    '  The following values were injected at apply time and are NOT in this archive:',
    secrets,
    '',
    'Restoring by hand',
    '  1. Start the definition (the override carries no credentials on purpose):',
    '       cd render',
    '       docker compose -f docker-compose.platform.yml -f docker-compose.override.yml \\',
    '         --env-file platform.env up -d',
    '     Supply the values listed under Secrets through your own secret store or an extra',
    '     override file.',
    '  2. Load a database dump (PostgreSQL shown; MySQL/MariaDB use `mysql < file`):',
    '       psql "$DATABASE_URL" -f database/<service>.sql',
    '  3. Unpack each volume into the directory the service mounts:',
    '       tar -xzf volumes/<volume>.tar.gz -C <directory>',
    '',
    'Verifying',
    "  Each file digest is in manifest.json. The archive's own SHA-256 is in the sibling",
    `  ${input.exportId}.json file, which also repeats this manifest.`,
    '',
  ].join('\n');
}
