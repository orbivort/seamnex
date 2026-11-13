import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { AppConfig } from '../../../../src/config/config';
import { PostgresPortalBffService } from '../../../../src/modules/m10-portal-bff/portal-bff.service';

/**
 * The launcher tile is where "there is an update" is decided. The bug this pins: the running image
 * tag (`frappe/erpnext:v16.53.0`) and the catalog version (`16.53.0`) were compared as strings, so
 * every `v`-tagged deployment advertised an update against itself.
 */
const CONFIG = {
  SEAMNEX_PRODUCT_URL_SCHEME: 'http',
  SEAMNEX_PRODUCT_URL_PORT: '8020',
  SEAMNEX_INGRESS_DOMAIN: 'localhost',
  SEAMNEX_SSO_EVIDENCE_TTL_MINUTES: 60,
} as AppConfig;

function tileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date('2026-11-02T08:00:00.000Z');
  return {
    instance_id: 'inst-erp',
    entry_key: 'D06-01',
    slug: 'erpnext',
    product_role: 'member',
    source: 'direct',
    sync_state: 'applied',
    synced_at: now,
    state: 'ready',
    ready: true,
    reason: null,
    observed_at: now,
    payload: { product: 'ERPNext', domain: 'ERP & Business Operations' },
    entry_payload: {
      domain: 'ERP & Business Operations',
      product: 'ERPNext',
      description: 'One data model for the business.',
    },
    guarantee_class: 'native',
    host: 'erpnext.localhost',
    path_prefix: null,
    published: true,
    // The deployed values: `instance_route.auth_mode` carries the guarantee class itself
    // (migration 0015), not a hand-written shorthand.
    auth_mode: 'native',
    maintenance_title: null,
    idp_client_id: null,
    sso_ok: null,
    sso_detail: null,
    sso_checked_at: null,
    deployed_version: 'v16.53.0',
    entry_version: '16.53.0',
    latest_version: '16.53.0',
    ...overrides,
  };
}

async function launcherTile(overrides: Record<string, unknown> = {}) {
  const row = tileRow(overrides);
  const pool = { query: () => Promise.resolve({ rows: [row] }) } as unknown as Pool;
  const audit = { append: () => Promise.resolve() } as never;
  const service = new PostgresPortalBffService(pool, CONFIG, {} as never, {} as never, audit);
  const response = await service.launcher('sub-1');
  const [tile] = response.tiles;
  if (tile === undefined) throw new Error('no tile projected');
  return tile;
}

/**
 * The label is a promise about the next launch. A registered identity client is a registration and
 * not a login: EspoCRM answered `token request error` while every card said "Native SSO", because
 * the state was derived from the client row's existence.
 */
describe('launcher tile sign-in claim', () => {
  const client = { idp_client_id: 'seamnex-espocrm' };
  const fresh = new Date(Date.now() - 60_000);

  it('claims single sign-on only while a recent end-to-end check passed', async () => {
    const tile = await launcherTile({
      ...client,
      sso_ok: true,
      sso_checked_at: fresh,
      sso_detail: 'ok',
    });

    expect(tile.ssoState).toBe('sso');
    expect(tile.authLabel).toBe('Native SSO');
    expect(tile.ssoHealth.ok).toBe(true);
  });

  it('reports an unverified path when the last check failed', async () => {
    const tile = await launcherTile({
      ...client,
      sso_ok: false,
      sso_checked_at: fresh,
      sso_detail: 'stage 0 (product network): keycloak does not resolve',
    });

    expect(tile.ssoState).toBe('sso_unverified');
    expect(tile.authLabel).toBe('SSO unverified');
    expect(tile.ssoHealth.detail).toContain('does not resolve');
  });

  it('reports an unverified path when the passing check is older than the evidence window', async () => {
    const stale = new Date(Date.now() - 3 * 60 * 60 * 1_000);
    const tile = await launcherTile({
      ...client,
      sso_ok: true,
      sso_checked_at: stale,
      sso_detail: 'ok',
    });

    expect(tile.ssoState).toBe('sso_unverified');
  });

  it('reports a sign-in requirement when no identity client exists', async () => {
    const tile = await launcherTile({ idp_client_id: null });

    expect(tile.ssoState).toBe('sign_in_required');
    expect(tile.ssoHealth.checked).toBe(false);
  });

  /**
   * The proxy gate with a leftover identity client, which is OpenProject's real shape: the platform
   * registers a client for every instance, so `idp_client_id` is not null even though the product
   * cannot sign anyone in. Reading that row as native OIDC made the launch dialog promise a
   * redirect the Community edition cannot make (ADR-BE-15).
   */
  it('does not read a gate’s registered client as native single sign-on', async () => {
    const tile = await launcherTile({
      entry_key: 'D09-01',
      guarantee_class: 'fa_gate',
      auth_mode: 'fa_gate',
      ...client,
      sso_ok: true,
      sso_checked_at: fresh,
      sso_detail: 'stage 1 passed',
    });

    expect(tile.ssoState).toBe('sign_in_required');
    expect(tile.authLabel).toBe('Sign-in required');
  });

  it('still gates the route, so the launch needs a ticket', async () => {
    const instanceId = randomUUID();
    const row = tileRow({
      instance_id: instanceId,
      entry_key: 'D09-01',
      guarantee_class: 'fa_gate',
      auth_mode: 'fa_gate',
      ...client,
    });
    const pool = { query: () => Promise.resolve({ rows: [row] }) } as unknown as Pool;
    const audit = { append: () => Promise.resolve() } as never;
    const service = new PostgresPortalBffService(pool, CONFIG, {} as never, {} as never, audit);
    const target = await service.launchTarget('sub-1', instanceId);

    expect(target.bootstrapRequired).toBe(true);
    /*
     * The dialog's second paragraph is the per-entry note, not the generic "edge forwards your
     * session" sentence. ADR-BE-22 changed what the note says — the platform now signs the user in
     * to the product with an account it holds — but not what the tile claims: the route is still
     * gated, so the launch still needs a ticket, and the label is still "Sign-in required".
     */
    expect(target.note).toContain('does not ask for a second password');
    expect(target.note).toContain('rotated monthly');
    expect(target.note).not.toContain('arrives already signed in');
    // The credential is the platform's, and the sentence has to say so rather than deny it.
    expect(target.note).not.toContain('does not hold');
  });
});

describe('launcher tile version claim', () => {
  it('does not advertise the version the deployment already runs', async () => {
    const tile = await launcherTile({ deployed_version: 'v16.53.0', latest_version: '16.53.0' });

    expect(tile.version).toBe('16.53.0');
    expect(tile.availableVersion).toBeNull();
  });

  it('does not advertise a pre-release of the running release', async () => {
    const tile = await launcherTile({ latest_version: '16.53.0-rc.1' });

    expect(tile.availableVersion).toBeNull();
  });

  it('does not advertise an older catalog pin after a rollback', async () => {
    const tile = await launcherTile({ deployed_version: 'v16.53.0', latest_version: '16.52.9' });

    expect(tile.availableVersion).toBeNull();
  });

  it('does not treat a missing version as an update', async () => {
    const tile = await launcherTile({
      deployed_version: null,
      entry_version: null,
      latest_version: '16.53.0',
    });

    expect(tile.version).toBeNull();
    expect(tile.availableVersion).toBeNull();
  });

  it('advertises a genuinely newer catalog version, without the prefix from the tag', async () => {
    const tile = await launcherTile({ deployed_version: 'v16.53.0', latest_version: '16.54.0' });

    expect(tile.version).toBe('16.53.0');
    expect(tile.availableVersion).toBe('16.54.0');
  });

  it('falls back to the catalog pin when the instance keeps no service rows', async () => {
    const tile = await launcherTile({
      deployed_version: null,
      entry_version: '16.53.0',
      latest_version: '16.53.0',
    });

    expect(tile.version).toBe('16.53.0');
    expect(tile.availableVersion).toBeNull();
  });
});
