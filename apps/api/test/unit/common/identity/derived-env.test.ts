import { describe, expect, it } from 'vitest';
import {
  derivedEnvValues,
  mirroredEnvValues,
  origin,
} from '../../../../src/common/identity/derived-env';

/**
 * The two values a catalog default cannot express.
 *
 * The default in `catalog/env/D01-01.json` names the deployment the entry was verified against
 * (`https://espocrm.seamnex.localhost:8443`, `seamnex-espocrm`). Both are wrong for a second instance, and the failure is
 * not local: the platform registers the client against the instance's own route, so a product that
 * keeps the default sends a redirect URI the IdP never registered and Keycloak refuses the
 * authorization request before a code exists.
 */
describe('derived identity environment values', () => {
  const base = {
    entryKey: 'D01-01',
    slug: 'crm',
    host: 'crm.localhost',
    scheme: 'http' as const,
    port: '8020',
  };

  it('derives the site URL from the instance route, not from the catalog default', () => {
    expect(derivedEnvValues(base)).toMatchObject({ ESPOCRM_SITE_URL: 'http://crm.localhost:8020' });
  });

  it('derives the client id from the slug the platform registers under', () => {
    expect(derivedEnvValues(base)).toMatchObject({ ESPOCRM_CONFIG_OIDC_CLIENT_ID: 'seamnex-crm' });
  });

  it('resolves the pre-rename shorthand the environment files still carry', () => {
    expect(derivedEnvValues({ ...base, entryKey: 'D01-01' })).toEqual(derivedEnvValues(base));
    expect(derivedEnvValues({ ...base, entryKey: 'D01-01' })).not.toEqual({});
  });

  it('omits the port when the scheme uses its default, so the URL matches a registered route', () => {
    expect(origin({ scheme: 'https', host: 'crm.seamnex.local', port: '' })).toBe(
      'https://crm.seamnex.local',
    );
  });

  it('derives nothing for an entry that declares no instance-shaped value', () => {
    expect(derivedEnvValues({ ...base, entryKey: 'D07-01' })).toEqual({});
  });

  /*
   * The rest of the table. Each of these was a catalog literal correct for exactly one deployment:
   * the failure showed up as a product that answered its own placeholder vhost (`404`) or mailed a
   * link to a host nobody serves, and only after the route moved.
   */
  it('moves both OpenProject host names together, as bare hosts', () => {
    expect(derivedEnvValues({ ...base, entryKey: 'D09-01' })).toEqual({
      OPENPROJECT_HOST__NAME: 'crm.localhost',
      SERVER_NAME: 'crm.localhost',
    });
  });

  /*
   * ERPNext carries two shapes from one route: a Frappe site name (bare host — a directory and a
   * `server_name`) and the origin `host_name` is built from. Writing the site name into `host_name`
   * was the deployment's own default once, and it printed `http://crm.localhost` on an edge that
   * serves `https` on `:8443`, so every link the product emitted was unreachable.
   */
  it('derives the ERPNext site name as the bare route host and the origin as a URL', () => {
    expect(derivedEnvValues({ ...base, entryKey: 'D06-01' })).toEqual({
      ERPNEXT_SITE_NAME: 'crm.localhost',
      ERPNEXT_SITE_ORIGIN: 'http://crm.localhost:8020',
      // `registerIdentity` names the Keycloak client `seamnex-<slug>`; the site's Social Login Key
      // has to present that id, or the registration succeeds and the first login fails.
      ERPNEXT_SSO_CLIENT_ID: 'seamnex-crm',
    });
  });

  it('omits the port from the ERPNext origin when the edge uses the scheme default', () => {
    expect(
      derivedEnvValues({
        ...base,
        entryKey: 'D06-01',
        host: 'erp.seamnex.localhost',
        scheme: 'https',
        port: '',
      }),
    ).toEqual({
      ERPNEXT_SITE_NAME: 'erp.seamnex.localhost',
      ERPNEXT_SITE_ORIGIN: 'https://erp.seamnex.localhost',
      ERPNEXT_SSO_CLIENT_ID: 'seamnex-crm',
    });
  });

  it('derives the product URLs Mautic and Metabase print into their own output', () => {
    expect(derivedEnvValues({ ...base, entryKey: 'D02-01' })).toEqual({
      MAUTIC_SITE_URL: 'http://crm.localhost:8020',
    });
    expect(derivedEnvValues({ ...base, entryKey: 'D11-01' })).toEqual({
      MB_SITE_URL: 'http://crm.localhost:8020',
    });
  });
});

/**
 * The mirror, not the derivation: the same address in a variable the image re-applies.
 *
 * EspoCRM reads `ESPOCRM_SITE_URL` in its install action only, so a product keeps the `siteUrl` of
 * the day it was installed. When the instance moved from `http://espocrm.localhost:8020` to
 * `https://espocrm.seamnex.localhost:8443` that stale value made every sign-in fail in the identity
 * provider's popup with `invalid_redirect_uri`. `ESPOCRM_CONFIG_*` is applied by `applyConfigEnv` on
 * every start, so the effective site URL has to be written there too.
 */
describe('mirrored identity environment values', () => {
  it('writes the site URL into the variable the entry applies on every start', () => {
    expect(
      mirroredEnvValues('D01-01', {
        ESPOCRM_SITE_URL: 'https://crm.seamnex.localhost:8443',
        ESPOCRM_LANGUAGE: 'en_US',
      }),
    ).toEqual({
      ESPOCRM_SITE_URL: 'https://crm.seamnex.localhost:8443',
      ESPOCRM_CONFIG_SITE_URL: 'https://crm.seamnex.localhost:8443',
      ESPOCRM_LANGUAGE: 'en_US',
    });
  });

  it('mirrors the value it was given, so an override is not replaced by the derived one', () => {
    expect(mirroredEnvValues('D01-01', { ESPOCRM_SITE_URL: 'https://crm.example.test' })).toEqual({
      ESPOCRM_SITE_URL: 'https://crm.example.test',
      ESPOCRM_CONFIG_SITE_URL: 'https://crm.example.test',
    });
  });

  it('invents nothing when the source variable is absent or empty', () => {
    expect(mirroredEnvValues('D01-01', { ESPOCRM_LANGUAGE: 'en_US' })).toEqual({
      ESPOCRM_LANGUAGE: 'en_US',
    });
    expect(mirroredEnvValues('D01-01', { ESPOCRM_SITE_URL: '' })).toEqual({ ESPOCRM_SITE_URL: '' });
  });

  it('leaves an entry without a mirror untouched', () => {
    expect(mirroredEnvValues('D09-01', { SERVER_NAME: 'crm.localhost' })).toEqual({
      SERVER_NAME: 'crm.localhost',
    });
  });
});
