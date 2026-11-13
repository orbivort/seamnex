import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayConfigurationWarnings } from '../../../../src/modules/m24-sign-in-relay/relay-config';
import {
  joinTargetFor,
  localContainerId,
} from '../../../../src/modules/m24-sign-in-relay/relay-origin';

/**
 * The three switches that make a relayed product look unrelayed.
 *
 * Every wrong combination below degraded to the product's own login form, and the launch path looked
 * healthy throughout: the ticket minted, the session cookie was planted, the browser arrived. Nothing
 * in a request or a browser could distinguish "the relay declined" from "there is no relay", which is
 * why these warnings exist at boot.
 */
describe('relayConfigurationWarnings', () => {
  const base = {
    SEAMNEX_RELAY_ENABLED: true,
    SEAMNEX_RELAY_ENTRY_KEYS: 'D09-01,D07-01',
    SEAMNEX_BOOTSTRAP_URL: 'http://relay:8091',
  };

  it('says nothing when the switch, the allow-list and the hop agree', () => {
    expect(relayConfigurationWarnings(base)).toEqual([]);
  });

  it('reports an allow-list that the off switch makes inert', () => {
    const warnings = relayConfigurationWarnings({
      ...base,
      SEAMNEX_RELAY_ENABLED: false,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/D09-01, D07-01/);
    expect(warnings[0]).toMatch(/SEAMNEX_RELAY_ENABLED is false/);
  });

  it('reports a hop pointed at the gateway, which redeems but cannot relay', () => {
    const warnings = relayConfigurationWarnings({
      ...base,
      SEAMNEX_BOOTSTRAP_URL: 'http://auth-gateway:8090',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cannot relay/);
    expect(warnings[0]).toMatch(/http:\/\/relay/);
  });

  it('reports an enabled relay with nothing eligible', () => {
    const warnings = relayConfigurationWarnings({
      ...base,
      SEAMNEX_RELAY_ENTRY_KEYS: ' , ',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/SEAMNEX_RELAY_ENTRY_KEYS is empty/);
  });

  it('treats an empty allow-list with the switch off as consistent', () => {
    expect(
      relayConfigurationWarnings({
        ...base,
        SEAMNEX_RELAY_ENABLED: false,
        SEAMNEX_RELAY_ENTRY_KEYS: '',
      }),
    ).toEqual([]);
  });

  it('accepts the gateway on another port as the hop without mistaking a relay for it', () => {
    // The dev projection names the service; the port check catches a deployment that renames it.
    expect(
      relayConfigurationWarnings({ ...base, SEAMNEX_BOOTSTRAP_URL: 'http://forward-auth:8090' }),
    ).toHaveLength(1);
    expect(
      relayConfigurationWarnings({ ...base, SEAMNEX_BOOTSTRAP_URL: 'http://relay:8091' }),
    ).toEqual([]);
  });
});

/**
 * Which container gets attached to the product network.
 *
 * A fixed name can only be right for one of the two callers: the relay signs in, the scheduler
 * provisions. Configured as one name, the scheduler attached the relay and then dialled
 * `http://<slug>:<port>` from its own namespace, where it resolves nothing — `product_unavailable`
 * every five minutes, with the sweep looking idle rather than broken.
 */
describe('joinTargetFor', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('joins the caller itself, using the container id Docker puts in HOSTNAME', () => {
    vi.stubEnv('HOSTNAME', '8a1fae139f9a');

    expect(localContainerId()).toBe('8a1fae139f9a');
    expect(joinTargetFor({ SEAMNEX_RELAY_CONTAINER: '' })).toBe('8a1fae139f9a');
    expect(joinTargetFor({ SEAMNEX_RELAY_CONTAINER: '   ' })).toBe('8a1fae139f9a');
  });

  it('honours an explicit sidecar without consulting the hostname', () => {
    vi.stubEnv('HOSTNAME', '8a1fae139f9a');

    expect(joinTargetFor({ SEAMNEX_RELAY_CONTAINER: 'seamnex-dev-relay-1' })).toBe(
      'seamnex-dev-relay-1',
    );
  });

  it('answers empty outside Docker, where there is nothing to join', () => {
    vi.stubEnv('HOSTNAME', '');

    // The caller then records `product_unavailable` instead of dialling an unresolvable name.
    expect(joinTargetFor({ SEAMNEX_RELAY_CONTAINER: '' })).toBe('');
  });
});
