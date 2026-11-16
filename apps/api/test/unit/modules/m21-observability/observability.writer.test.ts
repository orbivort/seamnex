import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  publishedTargetIds,
  removeTarget,
  targetDocument,
  targetFileName,
  targetIsPublished,
  targetWrittenAt,
  writeTarget,
  type TargetSpec,
} from '../../../../src/modules/m21-observability/observability.writer';

/**
 * FR-2.6 — the `file_sd` directory is the only thing standing between "the instance exists" and
 * "Prometheus scrapes it", so each function here answers one question about a file: was it written,
 * is it still the same content, is it readable, and does a stale file belong to anyone. The failure
 * answers matter as much as the success ones — pruning reads a directory that may not exist yet,
 * and a delete of a file someone already removed is not an error.
 */
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

const SPEC: TargetSpec = {
  instanceId: INSTANCE_ID,
  slug: 'crm',
  entryKey: 'D01-01',
  product: 'EspoCRM',
  address: 'api:8080',
  metricsPath: `/api/v1/metrics/instances/${INSTANCE_ID}`,
};

const directories: string[] = [];

async function targetDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'seamnex-writer-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('targetDocument', () => {
  it('names the instance in its labels and the path Prometheus must scrape', () => {
    const document = JSON.parse(targetDocument(SPEC));

    expect(document).toEqual([
      {
        targets: ['api:8080'],
        labels: {
          __metrics_path__: SPEC.metricsPath,
          job: 'seamnex-instance',
          instance_id: INSTANCE_ID,
          instance_slug: 'crm',
          entry_key: 'D01-01',
          product: 'EspoCRM',
        },
      },
    ]);
  });

  it('is keyed by the instance id, which a rename cannot invalidate', () => {
    expect(targetFileName(INSTANCE_ID)).toBe(`instance-${INSTANCE_ID}.json`);
  });
});

describe('writeTarget', () => {
  it('writes the document and reports the change', async () => {
    const directory = await targetDirectory();

    await expect(writeTarget(directory, SPEC)).resolves.toEqual({
      file: `instance-${INSTANCE_ID}.json`,
      changed: true,
    });
    expect(
      JSON.parse(await readFile(join(directory, targetFileName(INSTANCE_ID)), 'utf8')),
    ).toEqual(JSON.parse(targetDocument(SPEC)));
    // The temp file used for the atomic rename is gone: only the target is left for Prometheus.
    await expect(readdir(directory)).resolves.toEqual([targetFileName(INSTANCE_ID)]);
  });

  it('reports no change when the file already carries the same document', async () => {
    const directory = await targetDirectory();
    await writeTarget(directory, SPEC);

    // A re-projection pass must not make Prometheus re-read every unchanged file.
    await expect(writeTarget(directory, SPEC)).resolves.toMatchObject({ changed: false });
  });

  it('rewrites the file when the labels moved', async () => {
    const directory = await targetDirectory();
    await writeTarget(directory, SPEC);

    await expect(writeTarget(directory, { ...SPEC, slug: 'crm-renamed' })).resolves.toMatchObject({
      changed: true,
    });
    const document = JSON.parse(
      await readFile(join(directory, targetFileName(INSTANCE_ID)), 'utf8'),
    );
    expect(document[0].labels.instance_slug).toBe('crm-renamed');
  });
});

describe('removeTarget', () => {
  it('answers whether a target was actually removed', async () => {
    const directory = await targetDirectory();
    await writeTarget(directory, SPEC);

    await expect(removeTarget(directory, INSTANCE_ID)).resolves.toBe(true);
    // Pruning loops over ids it read a moment ago; a second delete is a no-op, not a failure.
    await expect(removeTarget(directory, INSTANCE_ID)).resolves.toBe(false);
  });
});

describe('publishedTargetIds', () => {
  it('returns the ids of target files and ignores everything else', async () => {
    const directory = await targetDirectory();
    await writeFile(join(directory, targetFileName(INSTANCE_ID)), '[]\n', 'utf8');
    await writeFile(join(directory, targetFileName(OTHER_ID)), '[]\n', 'utf8');
    // The atomic-write temp file and an operator's stray file are not targets.
    await writeFile(join(directory, `${targetFileName(INSTANCE_ID)}.tmp`), '{}', 'utf8');
    await writeFile(join(directory, 'notes.txt'), 'hand-written', 'utf8');

    await expect(publishedTargetIds(directory)).resolves.toEqual([INSTANCE_ID, OTHER_ID]);
  });

  it('answers no ids for a directory that does not exist yet', async () => {
    const directory = join(await targetDirectory(), 'absent');

    // On a first deploy nothing has been published, and the prune pass must not throw.
    await expect(publishedTargetIds(directory)).resolves.toEqual([]);
  });
});

describe('targetWrittenAt', () => {
  it('dates a published target and answers null for one that is not there', async () => {
    const directory = await targetDirectory();
    await writeTarget(directory, SPEC);

    await expect(targetWrittenAt(directory, INSTANCE_ID)).resolves.toBeInstanceOf(Date);
    await expect(targetWrittenAt(directory, OTHER_ID)).resolves.toBeNull();
  });
});

describe('targetIsPublished', () => {
  it('accepts a non-empty target list and rejects everything else', async () => {
    const directory = await targetDirectory();
    await writeTarget(directory, SPEC);
    await expect(targetIsPublished(directory, INSTANCE_ID)).resolves.toBe(true);

    const path = join(directory, targetFileName(INSTANCE_ID));
    await writeFile(path, '[]\n', 'utf8');
    // An empty list is a file, but not a published target: the report must say `missing`.
    await expect(targetIsPublished(directory, INSTANCE_ID)).resolves.toBe(false);

    await writeFile(path, 'not json', 'utf8');
    await expect(targetIsPublished(directory, INSTANCE_ID)).resolves.toBe(false);

    await expect(targetIsPublished(directory, OTHER_ID)).resolves.toBe(false);
  });
});
