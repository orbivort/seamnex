import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hashToken,
  MachineClientService,
} from '../../../../src/modules/m09-access-control/machine-client.service';
import { fakeDb } from '../../../support/fakes';

const TOKEN = `tok_${'a'.repeat(40)}`;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mc-1',
    name: 'n8n',
    scope: 'audit.read',
    enabled: true,
    last_used_at: null,
    ...overrides,
  };
}

function db(rows: Array<Record<string, unknown>>) {
  return fakeDb([
    ['FROM machine_client WHERE token_hash', rows],
    ['UPDATE machine_client', []],
  ]);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('hashToken', () => {
  it('stores only a SHA-256 digest, so a database read cannot impersonate a client', () => {
    const hash = hashToken(TOKEN);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(TOKEN);
    expect(hashToken(TOKEN)).toBe(hash);
    expect(hashToken(`${TOKEN}x`)).not.toBe(hash);
  });
});

describe('MachineClientService.authenticate', () => {
  it('refuses a token outside the accepted length before querying', async () => {
    const fake = db([row()]);
    const service = new MachineClientService(fake.pool);

    expect(await service.authenticate('short')).toBeNull();
    expect(await service.authenticate('t'.repeat(513))).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it('resolves an enabled client with the capabilities of its declared scope', async () => {
    const fake = db([row()]);
    const service = new MachineClientService(fake.pool);

    const principal = await service.authenticate(TOKEN);

    expect(principal).toEqual({
      id: 'mc-1',
      name: 'n8n',
      scopes: ['audit.view', 'audit.verify', 'audit.export'],
    });
    expect(fake.calls[0]?.params).toEqual([hashToken(TOKEN)]);
  });

  it('gives an unrecognised scope no capability rather than guessing', async () => {
    const service = new MachineClientService(db([row({ scope: 'administrator' })]).pool);
    expect(await service.authenticate(TOKEN)).toMatchObject({ scopes: [] });
  });

  it('refuses a disabled client', async () => {
    const service = new MachineClientService(db([row({ enabled: false })]).pool);
    expect(await service.authenticate(TOKEN)).toBeNull();
  });

  it('refuses an unknown client', async () => {
    const service = new MachineClientService(db([]).pool);
    expect(await service.authenticate(TOKEN)).toBeNull();
  });

  it('caches the decision for a minute so a bearer call is not a query per request', async () => {
    const fake = db([row()]);
    const service = new MachineClientService(fake.pool);

    await service.authenticate(TOKEN);
    const selects = fake.calls.filter((call) => call.sql.includes('FROM machine_client')).length;
    await service.authenticate(TOKEN);
    const after = fake.calls.filter((call) => call.sql.includes('FROM machine_client')).length;

    expect(selects).toBe(1);
    expect(after).toBe(1);
  });

  it('re-reads once the cache entry is older than a minute, so revocation lands', async () => {
    const fake = db([row()]);
    const service = new MachineClientService(fake.pool);
    const realNow = Date.now;
    let now = realNow();
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      await service.authenticate(TOKEN);
      now += 61_000;
      await service.authenticate(TOKEN);
      const selects = fake.calls.filter((call) => call.sql.includes('FROM machine_client')).length;
      expect(selects).toBe(2);
    } finally {
      vi.spyOn(Date, 'now').mockRestore();
    }
  });

  it('records last_used_at for an enabled client', async () => {
    const fake = db([row()]);
    await new MachineClientService(fake.pool).authenticate(TOKEN);

    const update = fake.calls.find((call) => call.sql.includes('UPDATE machine_client'));
    expect(update?.params).toEqual(['mc-1']);
  });

  it('skips the write when the client was used within the throttle window', async () => {
    const fake = db([row({ last_used_at: new Date() })]);
    await new MachineClientService(fake.pool).authenticate(TOKEN);

    expect(fake.calls.some((call) => call.sql.includes('UPDATE machine_client'))).toBe(false);
  });

  it('does not fail an authentication because the usage write failed', async () => {
    const fake = fakeDb([
      ['FROM machine_client WHERE token_hash', [row()]],
      ['UPDATE machine_client', () => Promise.reject(new Error('read-only replica'))],
    ]);

    await expect(new MachineClientService(fake.pool).authenticate(TOKEN)).resolves.toMatchObject({
      id: 'mc-1',
    });
  });
});
