import type * as NodeFs from 'node:fs';
import type * as NodeOs from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import {
  PostgresCapacityService,
  availableMemoryMb,
  measureDisk,
} from '../../../../src/modules/m19-capacity/capacity.service';

/**
 * Admission is the one place where "we did not measure" must never read as "there is room". The
 * tests therefore follow the fallback chain explicitly: a persisted snapshot, then a live probe of
 * the machine, then `source: 'unknown'` with `admissible: false`. The arithmetic itself comes from
 * `@seamnex/domain` and is exercised there; what is asserted here is the wiring, the rounding at the
 * contract boundary, and the ledger that is read instead of summed twice.
 */
const MIB = 1024 * 1024;

const h = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  statfsSync: vi.fn(),
  readFileSync: vi.fn(),
  cpus: vi.fn(),
  totalmem: vi.fn(),
  freemem: vi.fn(),
}));

vi.mock('@seamnex/db', () => ({ withTransaction: h.withTransaction }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  statfsSync: h.statfsSync,
  readFileSync: h.readFileSync,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  cpus: h.cpus,
  totalmem: h.totalmem,
  freemem: h.freemem,
}));

const SNAPSHOT = {
  host: { cpuCores: 8, memoryMb: 16_384, diskMb: 100_000 },
  allocated: { cpuCores: 2, memoryMb: 4_096, diskMb: 20_000 },
  platformReserve: { cpuCores: 1, memoryMb: 2_048, diskMb: 10_240 },
  oversubscriptionFactor: 1.25,
  diskPath: '/var/lib/seamnex',
  diskAvailableMb: 50_000,
  memoryAvailableMb: 8_000,
  instanceUsage: [],
  verdict: {
    admissible: true,
    headline: 'Room for more',
    detail: 'detail',
    shortfall: { cpuMilli: 0, memoryMb: 0, diskMb: 0 },
    reserveNote: 'reserve',
  },
  forecast: [],
};

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const db = fakeDb(routes);
  h.withTransaction.mockImplementation(async (_pool: unknown, fn: (tx: unknown) => unknown) =>
    fn(db.client),
  );
  const service = new PostgresCapacityService(db.pool, {
    SEAMNEX_INSTANCE_DATA_DIR: '/var/lib/seamnex',
  } as unknown as AppConfig);
  return { db, service };
}

const SNAPSHOT_SELECT = 'FROM capacity_snapshot ORDER BY ts DESC LIMIT 1';
const LEDGER = 'WITH declared';

beforeEach(() => {
  vi.clearAllMocks();
  h.cpus.mockReturnValue(new Array(8).fill({ model: 'test' }));
  h.totalmem.mockReturnValue(16 * 1024 * MIB);
  h.freemem.mockReturnValue(4 * 1024 * MIB);
  h.statfsSync.mockReturnValue({ bsize: 4_096, blocks: 25_000_000, bavail: 12_500_000 });
  h.readFileSync.mockImplementation(() => {
    throw new Error('not linux');
  });
});

describe('snapshot', () => {
  it('returns the newest persisted snapshot with its timestamp', async () => {
    const { service } = setup([
      [SNAPSHOT_SELECT, [{ ts: new Date('2026-03-04T05:06:07.000Z'), per_instance: SNAPSHOT }]],
    ]);

    await expect(service.snapshot()).resolves.toMatchObject({
      ts: '2026-03-04T05:06:07.000Z',
      host: SNAPSHOT.host,
    });
  });

  it('measures and records one when nothing has been recorded yet', async () => {
    const { db, service } = setup([
      [SNAPSHOT_SELECT, []],
      ['FROM settings WHERE key', [{ value: 2 }]],
      [LEDGER, [{ cpu_milli: '2000', memory_mb: '4096', disk_mb: '20480' }]],
      [
        'FROM instance i',
        [
          {
            id: 'inst-1',
            entry_key: 'D01-01',
            product: 'EspoCRM',
            slug: 'crm',
            state: 'ready',
            resources: { cpu: 2, memoryMb: 4096, diskMb: 20480 },
          },
          {
            id: 'inst-2',
            entry_key: 'D02-01',
            product: null,
            slug: 'bare',
            state: 'deploying',
            resources: null,
          },
        ],
      ],
      ['INSERT INTO capacity_snapshot', []],
    ]);

    const snapshot = await service.snapshot();

    expect(snapshot.host).toEqual({ cpuCores: 8, memoryMb: 16_384, diskMb: expect.any(Number) });
    // The ledger, not the host total, is what "allocated" means.
    expect(snapshot.allocated).toEqual({ cpuCores: 2, memoryMb: 4_096, diskMb: 20_480 });
    expect(snapshot.oversubscriptionFactor).toBe(2);
    expect(snapshot.instanceUsage).toEqual([
      {
        instanceId: 'inst-1',
        entryKey: 'D01-01',
        product: 'EspoCRM',
        slug: 'crm',
        state: 'ready',
        cpuCores: 2,
        memoryMb: 4_096,
        diskMb: 20_480,
        diskQuotaMb: 20_480,
      },
      {
        // An instance that has not been given a shape yet is listed at zero, labelled by its entry
        // key, rather than being omitted from the board that is meant to explain the host.
        instanceId: 'inst-2',
        entryKey: 'D02-01',
        product: 'D02-01',
        slug: 'bare',
        state: 'deploying',
        cpuCores: 0,
        memoryMb: 0,
        diskMb: 0,
        diskQuotaMb: 0,
      },
    ]);
    expect(snapshot.forecast).toHaveLength(14);
    // The verdict names the axes that failed; a host with room names none.
    expect(snapshot.verdict.shortfall).toEqual([]);

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO capacity_snapshot'));
    expect(insert?.params[0]).toBe(snapshot.ts);
    expect(JSON.parse(String(insert?.params[1]))).toEqual(snapshot.host);
  });

  it('refuses with a coded problem when the host cannot be measured at all', async () => {
    const { service } = setup([['FROM capacity_snapshot ORDER BY ts DESC LIMIT 1', []]]);
    h.cpus.mockReturnValue([]);

    await expect(service.snapshot()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('record', () => {
  it('returns null instead of recording a host with no capacity', async () => {
    // Zeros would make every later admission look refused against a host that has no room at all.
    const { db, service } = setup();
    h.totalmem.mockReturnValue(0);

    await expect(service.record()).resolves.toBeNull();
    expect(db.calls).toHaveLength(0);
  });

  it('measures the instance-data volume before falling back to the working directory', async () => {
    const { db, service } = setup([
      ['FROM settings WHERE key', []],
      [LEDGER, []],
      ['FROM instance i', []],
      ['INSERT INTO capacity_snapshot', []],
    ]);
    h.statfsSync.mockImplementation((path: unknown) => {
      if (path === '/var/lib/seamnex') throw new Error('not mounted');
      return { bsize: 4_096, blocks: 1_000_000, bavail: 250_000 };
    });

    const snapshot = await service.record();

    expect(snapshot?.diskPath).toBe(process.cwd());
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO capacity_snapshot'))).toBe(true);
  });

  it('returns null when no filesystem can be measured', async () => {
    const { service } = setup();
    h.statfsSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    await expect(service.record()).resolves.toBeNull();
  });

  it('accepts a numeric oversubscription factor stored as text, and refuses an unusable one', async () => {
    const { service } = setup([
      ['FROM settings WHERE key', [{ value: '1.5' }]],
      [LEDGER, []],
      ['FROM instance i', []],
      ['INSERT INTO capacity_snapshot', []],
    ]);

    await expect(service.record()).resolves.toMatchObject({ oversubscriptionFactor: 1.5 });
  });

  it('falls back to the documented factor when the stored value is nonsense', async () => {
    for (const value of ['lots', 0.5, null]) {
      const { service } = setup([
        ['FROM settings WHERE key', [{ value }]],
        [LEDGER, []],
        ['FROM instance i', []],
        ['INSERT INTO capacity_snapshot', []],
      ]);

      await expect(service.record(), String(value)).resolves.toMatchObject({
        oversubscriptionFactor: 1.25,
      });
    }
  });

  it('reports a host measurement failure and records nothing', async () => {
    const { db, service } = setup();
    h.totalmem.mockImplementation(() => {
      throw 'sysinfo unavailable';
    });

    await expect(service.record()).resolves.toBeNull();
    expect(db.calls).toHaveLength(0);
  });
});

describe('admit', () => {
  it('judges against the persisted snapshot and the live ledger', async () => {
    const { service } = setup([
      [SNAPSHOT_SELECT, [{ ts: new Date(), per_instance: SNAPSHOT }]],
      [LEDGER, [{ cpu_milli: '3000', memory_mb: '9000', disk_mb: '30000' }]],
    ]);

    const decision = await service.admit({
      resources: { cpuMilli: 1_000, memoryMb: 1_024, diskMb: 1_024 },
    });

    expect(decision.source).toBe('snapshot');
    expect(decision.admissible).toBe(true);
    // The contract is integer milli-cores and whole mebibytes; a fraction here failed the preview's
    // own re-validation with `expected int`.
    for (const value of [
      decision.limits.cpuMilli,
      decision.limits.memoryMb,
      decision.limits.diskMb,
      decision.used.cpuMilli,
      decision.used.memoryMb,
      decision.used.diskMb,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(decision.shortfall).toEqual({ cpuMilli: 0, memoryMb: 0, diskMb: 0 });
  });

  it('reports a shortfall for a request that does not fit', async () => {
    const { service } = setup([
      [SNAPSHOT_SELECT, [{ ts: new Date(), per_instance: SNAPSHOT }]],
      [LEDGER, [{ cpu_milli: '60000', memory_mb: '40000', disk_mb: '900000' }]],
    ]);

    const decision = await service.admit({
      resources: { cpuMilli: 8_000, memoryMb: 8_192, diskMb: 20_480 },
    });

    expect(decision.admissible).toBe(false);
    expect(decision.shortfall.memoryMb).toBeGreaterThan(0);
    // Rounding at the boundary keeps the three figures in the payload consistent with each other.
    expect(decision.used.memoryMb - decision.limits.memoryMb).toBe(decision.shortfall.memoryMb);
  });

  it('probes the host when no snapshot has been recorded', async () => {
    const { service } = setup([
      [SNAPSHOT_SELECT, []],
      ['FROM settings WHERE key', []],
      [LEDGER, []],
    ]);

    await expect(
      service.admit({ resources: { cpuMilli: 500, memoryMb: 512, diskMb: 1_024 } }),
    ).resolves.toMatchObject({ source: 'measured' });
  });

  it('excludes the instance being reconfigured from the ledger', async () => {
    const { db, service } = setup([
      [SNAPSHOT_SELECT, [{ ts: new Date(), per_instance: SNAPSHOT }]],
      [LEDGER, []],
    ]);

    await service.admit({
      instanceId: '6d1f2f0e-0000-4000-8000-000000000001',
      resources: { cpuMilli: 500, memoryMb: 512, diskMb: 1_024 },
    });

    const ledger = db.calls.find((call) => call.sql.includes(LEDGER));
    expect(ledger?.params).toEqual(['6d1f2f0e-0000-4000-8000-000000000001']);
  });

  it('refuses when neither a snapshot nor a measurement exists', async () => {
    const { service } = setup([
      [SNAPSHOT_SELECT, []],
      [LEDGER, []],
    ]);
    h.cpus.mockReturnValue([]);

    const decision = await service.admit({
      resources: { cpuMilli: 500, memoryMb: 512, diskMb: 1_024 },
    });

    expect(decision).toMatchObject({ admissible: false, source: 'unknown' });
  });

  it('treats a ledger row with no figures as an empty ledger', async () => {
    const { service } = setup([
      [SNAPSHOT_SELECT, [{ ts: new Date(), per_instance: SNAPSHOT }]],
      [LEDGER, []],
    ]);

    // `used` answers "what would be committed after this deployment": the ledger, the platform
    // reserve and the request itself, so an empty ledger is not the same as zero usage.
    await expect(
      service.admit({ resources: { cpuMilli: 100, memoryMb: 128, diskMb: 256 } }),
    ).resolves.toMatchObject({
      used: { cpuMilli: 1_100, memoryMb: 2_176, diskMb: 10_496 },
    });
  });
});

describe('reservations', () => {
  it('replaces the live hold in one transaction', async () => {
    const { db, service } = setup([
      ['SET released_at = now()', []],
      ['INSERT INTO capacity_reservation', []],
    ]);

    await service.reserve({
      instanceId: 'inst-1',
      resources: { cpuMilli: 2_000, memoryMb: 4_096, diskMb: 8_192 },
    });

    expect(h.withTransaction).toHaveBeenCalledOnce();
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO capacity_reservation'));
    expect(insert?.params).toEqual(['inst-1', 2_000, 4_096, 8_192]);
  });

  it('releases the live hold without deleting the history', async () => {
    const { db, service } = setup([['SET released_at = now()', []]]);

    await service.release('inst-1');

    expect(db.calls[0]?.sql).toContain('released_at IS NULL');
    expect(db.calls[0]?.params).toEqual(['inst-1']);
  });
});

describe('forecast', () => {
  it('extrapolates the admission utilisation of the current snapshot', async () => {
    const { service } = setup([[SNAPSHOT_SELECT, [{ ts: new Date(), per_instance: SNAPSHOT }]]]);

    const points = await service.forecast();

    expect(points).toHaveLength(14);
    expect(points[0]?.day).toBe('1');
    expect(points[13]?.day).toBe('14');
    // A point is a percentage of the admission limit, clamped to 0–100.
    for (const point of points) {
      for (const value of [point.cpuPercent, point.memoryPercent, point.diskPercent]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  it('falls back to the admission decision when no snapshot can be produced', async () => {
    const { service } = setup([
      ['FROM capacity_snapshot ORDER BY ts DESC LIMIT 1', []],
      [LEDGER, []],
    ]);
    h.cpus.mockReturnValue([]);

    const points = await service.forecast();

    expect(points).toHaveLength(14);
    expect(points[0]?.day).toBe('1');
    // A host that could not be measured still gets a curve, clamped like every other one.
    for (const value of [points[0]?.cpuPercent, points[0]?.memoryPercent, points[0]?.diskPercent]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe('measurements', () => {
  it('reports capacity and free space of a filesystem', () => {
    h.statfsSync.mockReturnValue({ bsize: 1_024, blocks: 2_000_000, bavail: 1_000_000 });

    expect(measureDisk('/data')).toEqual({
      path: '/data',
      totalMb: 1_953,
      availableMb: 976,
    });
  });

  it('treats a filesystem with no capacity, or one it cannot read, as unmeasured', () => {
    h.statfsSync.mockReturnValue({ bsize: 1_024, blocks: 0, bavail: 0 });
    expect(measureDisk('/data')).toBeNull();

    h.statfsSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(measureDisk('/data')).toBeNull();
  });

  it('prefers MemAvailable when the kernel exposes it', () => {
    h.readFileSync.mockReturnValue('MemTotal:  16777216 kB\nMemAvailable:  8388608 kB\n');

    expect(availableMemoryMb(16_384)).toBe(8_192);
  });

  it('falls back to libuv, then to zero, when /proc is not there', () => {
    expect(availableMemoryMb(16_384)).toBe(4_096);

    h.freemem.mockImplementation(() => {
      throw new Error('no sysinfo');
    });
    expect(availableMemoryMb(16_384)).toBe(0);
  });

  it('never reports more available memory than the host has', () => {
    h.readFileSync.mockReturnValue('MemAvailable:  8388608 kB\n');

    expect(availableMemoryMb(1_024)).toBe(1_024);
  });

  it('never reports a negative figure', () => {
    h.freemem.mockReturnValue(-1);

    expect(availableMemoryMb(16_384)).toBe(0);
  });
});
