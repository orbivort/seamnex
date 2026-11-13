import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import type { AppConfig } from '../../../../src/config/config';

/**
 * The backup target. What this class owns is the guard, the bucket bootstrap and the projection of
 * SDK responses — the signature itself is the SDK's job, so the client is a double.
 */
const state = vi.hoisted(() => ({
  send: vi.fn(),
  commands: [] as Array<{ name: string; input: unknown }>,
}));

class Command {
  readonly name: string;
  readonly input: unknown;
  constructor(name: string, input: unknown) {
    this.name = name;
    this.input = input;
    state.commands.push({ name, input });
  }
}

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = state.send;
  },
  PutObjectCommand: class extends Command {
    constructor(input: unknown) {
      super('Put', input);
    }
  },
  GetObjectCommand: class extends Command {
    constructor(input: unknown) {
      super('Get', input);
    }
  },
  HeadObjectCommand: class extends Command {
    constructor(input: unknown) {
      super('Head', input);
    }
  },
  HeadBucketCommand: class extends Command {
    constructor(input: unknown) {
      super('HeadBucket', input);
    }
  },
  CreateBucketCommand: class extends Command {
    constructor(input: unknown) {
      super('CreateBucket', input);
    }
  },
  ListObjectsV2Command: class extends Command {
    constructor(input: unknown) {
      super('List', input);
    }
  },
  DeleteObjectCommand: class extends Command {
    constructor(input: unknown) {
      super('Delete', input);
    }
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    createReadStream: vi.fn(() => 'read-stream'),
    createWriteStream: vi.fn(() => 'write-stream'),
  };
});

vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

const { BackupObjectStore } = await import('../../../../src/modules/m16-backup-restore/s3.client');

const CONFIG = {
  SEAMNEX_ADAPTERS_MODE: 'real',
  S3_BUCKET: 'backups',
  S3_ENDPOINT: 'http://s3.test',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
} as unknown as AppConfig;

function streamOf(text: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text);
    },
  };
}

beforeEach(() => {
  state.send.mockReset();
  state.commands.length = 0;
});

describe('BackupObjectStore guard', () => {
  it('refuses every operation when the S3 adapter is disabled, before touching the SDK', async () => {
    const store = new BackupObjectStore({
      ...CONFIG,
      SEAMNEX_ADAPTERS_MODE: 'disabled',
    } as AppConfig);

    await expect(store.putText('k', 'v')).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    await expect(store.getText('k')).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    await expect(store.list('k')).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    await expect(store.remove('k')).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    expect(state.send).not.toHaveBeenCalled();
  });

  it('refuses when the bucket is not configured', async () => {
    const store = new BackupObjectStore({ ...CONFIG, S3_BUCKET: '' } as AppConfig);
    await expect(store.putText('k', 'v')).rejects.toMatchObject({
      detail: expect.stringContaining('S3_BUCKET'),
    });
  });
});

describe('BackupObjectStore writes', () => {
  it('creates the bucket once, then uploads text', async () => {
    state.send
      .mockRejectedValueOnce(new Error('NoSuchBucket'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const store = new BackupObjectStore(CONFIG);

    await store.putText('manifest.json', '{}');
    await store.putText('second.json', '{}');

    const kinds = state.commands.map((command) => command.name);
    expect(kinds).toEqual(['HeadBucket', 'CreateBucket', 'Put', 'Put']);
  });

  it('uploads a file and reports the size the store acknowledges', async () => {
    state.send
      .mockResolvedValueOnce({}) // HeadBucket: the bucket exists
      .mockResolvedValueOnce({}) // PutObject
      .mockResolvedValueOnce({ ContentLength: 1_024 }); // HeadObject
    const store = new BackupObjectStore(CONFIG);

    const result = await store.putFile('dump.sql', '/tmp/dump.sql', 'text/plain');

    expect(result).toEqual({ key: 'dump.sql', bytes: 1_024 });
    const put = state.commands.find((command) => command.name === 'Put');
    expect(put?.input).toMatchObject({
      Bucket: 'backups',
      Key: 'dump.sql',
      ContentType: 'text/plain',
    });
  });

  it('reports zero bytes when the store does not state a length', async () => {
    state.send
      .mockResolvedValueOnce({}) // HeadBucket
      .mockResolvedValueOnce({}) // PutObject
      .mockResolvedValueOnce({}); // HeadObject without a length
    expect(await new BackupObjectStore(CONFIG).putFile('x', '/tmp/x')).toEqual({
      key: 'x',
      bytes: 0,
    });
  });
});

describe('BackupObjectStore reads', () => {
  it('reads an object body as text', async () => {
    state.send.mockResolvedValue({ Body: streamOf('{"ok":true}') });
    expect(await new BackupObjectStore(CONFIG).getText('manifest.json')).toBe('{"ok":true}');
  });

  it('refuses an object with no body rather than returning an empty string', async () => {
    state.send.mockResolvedValue({});
    await expect(new BackupObjectStore(CONFIG).getText('x')).rejects.toThrow(/has no body/);
  });

  it('downloads to a path through a pipeline', async () => {
    state.send.mockResolvedValue({ Body: streamOf('data') });
    await expect(new BackupObjectStore(CONFIG).download('x', '/tmp/x')).resolves.toBeUndefined();
  });

  it('refuses to download an object with no body', async () => {
    state.send.mockResolvedValue({});
    await expect(new BackupObjectStore(CONFIG).download('x', '/tmp/x')).rejects.toThrow(
      /has no body/,
    );
  });

  it('reports existence from a successful HEAD and a failure as absent', async () => {
    state.send.mockResolvedValueOnce({});
    expect(await new BackupObjectStore(CONFIG).exists('x')).toBe(true);

    state.send.mockRejectedValueOnce(new Error('NotFound'));
    expect(await new BackupObjectStore(CONFIG).exists('x')).toBe(false);
  });

  it('projects a listing, defaulting the fields an object may omit', async () => {
    state.send.mockResolvedValue({
      Contents: [{ Key: 'a', Size: 1, LastModified: new Date('2026-01-01T00:00:00.000Z') }, {}],
    });

    const rows = await new BackupObjectStore(CONFIG).list('a');

    expect(rows[0]).toEqual({
      key: 'a',
      bytes: 1,
      lastModified: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(rows[1]).toEqual({ key: '', bytes: 0, lastModified: null });
  });

  it('returns an empty listing when the prefix matches nothing', async () => {
    state.send.mockResolvedValue({});
    expect(await new BackupObjectStore(CONFIG).list('none')).toEqual([]);
  });
});

describe('BackupObjectStore.remove', () => {
  it('deletes the object', async () => {
    state.send.mockResolvedValue({});
    await new BackupObjectStore(CONFIG).remove('x');
    expect(state.commands.some((command) => command.name === 'Delete')).toBe(true);
  });
});
