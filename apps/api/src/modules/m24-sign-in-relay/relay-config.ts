import type { AppConfig } from '../../config/config';

/**
 * Misconfigurations that would otherwise be silent.
 *
 * The relay has three switches — `SEAMNEX_RELAY_ENABLED`, the entry allow-list, and where the edge
 * sends the launch hop — and every wrong combination degrades to the product's own login page, which
 * looks exactly like "this product has no relay". That ambiguity cost a full investigation
 * (2026-11-09): the allow-list named two products, the switch was off, and the hop pointed at the
 * gateway, so nothing ran and nothing said so.
 *
 * Pure on purpose: the wording is asserted by a unit test, and a boot log is not the place to
 * discover it is wrong.
 */
export function relayConfigurationWarnings(
  config: Pick<
    AppConfig,
    'SEAMNEX_RELAY_ENABLED' | 'SEAMNEX_RELAY_ENTRY_KEYS' | 'SEAMNEX_BOOTSTRAP_URL'
  >,
): string[] {
  const warnings: string[] = [];
  const entries = config.SEAMNEX_RELAY_ENTRY_KEYS.split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);

  if (!config.SEAMNEX_RELAY_ENABLED && entries.length > 0) {
    // The combination an operator reaches by configuring *which* products without configuring
    // *whether* the relay runs. Nothing in the launch path can reveal it: the ticket still mints.
    warnings.push(
      `SEAMNEX_RELAY_ENTRY_KEYS names ${entries.join(', ')} but SEAMNEX_RELAY_ENABLED is false: the allow-list has no effect and every launch falls back to the product's own login`,
    );
  }
  if (config.SEAMNEX_RELAY_ENABLED && entries.length === 0) {
    warnings.push(
      'SEAMNEX_RELAY_ENABLED is true but SEAMNEX_RELAY_ENTRY_KEYS is empty: no entry is eligible, so no credential is ever managed',
    );
  }
  if (config.SEAMNEX_RELAY_ENABLED && hopTargetsGateway(config.SEAMNEX_BOOTSTRAP_URL)) {
    // The gateway serves `/__seamnex/session` for a deployment that never enabled the relay, and
    // deliberately has no relay step. Enabling the relay without moving the hop changes nothing.
    warnings.push(
      `SEAMNEX_BOOTSTRAP_URL points at the forward-auth gateway (${config.SEAMNEX_BOOTSTRAP_URL}), which redeems the ticket but cannot relay; point it at the relay listener (http://relay:<SEAMNEX_RELAY_PORT>)`,
    );
  }
  return warnings;
}

/** `create-forward-auth-app.ts` binds `FORWARD_AUTH_PORT`; its service name is the stable alias. */
function hopTargetsGateway(bootstrapUrl: string): boolean {
  try {
    const url = new URL(bootstrapUrl);
    return url.hostname === 'auth-gateway' || url.port === '8090';
  } catch {
    // An unparseable URL is a different problem: the projection would fail to write it, loudly.
    return false;
  }
}
