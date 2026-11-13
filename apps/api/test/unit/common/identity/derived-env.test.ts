import { describe, expect, it } from 'vitest';
import { derivedEnvValues, origin } from '../../../../src/common/identity/derived-env';

/**
 * The two values a catalog default cannot express.
 *
 * The default in `catalog/env/D01-01.json` names the deployment the entry was verified against
 * (`espocrm.localhost:8020`, `seamnex-espocrm`). Both are wrong for a second instance, and the failure is
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
    expect(derivedEnvValues({ ...base, entryKey: 'D11-01' })).toEqual({});
  });
});
