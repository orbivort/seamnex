import type { ExecResult } from './exec';

/**
 * 4D.5 — can the *product* reach the identity provider?
 *
 * This is the leg that broke and stayed invisible. EspoCRM redeemed an authorization code and then
 * failed the token request with `Status: 0` (curl: could not resolve host) because Keycloak was
 * attached to the control network only; the IdP had been re-created, the attachment went with the
 * old container, and nothing re-applied it. Every check the platform ran stayed green: the realm
 * answered, the client was registered, the redirect URI matched, and the platform's own probe
 * exchanged a code successfully — from the control network.
 *
 * The remedy is a probe that asks the same question the product asks, from the same place it asks
 * it: a throwaway container on the instance network resolving the product's own alias for the IdP.
 * `wget -S` prints the status line it received whatever happens next, and the failure branch is
 * separated into DNS and connect so the detail names the cause instead of "no answer".
 *
 * The target never appears inside the script: `sh -c` receives the alias, the port and the path as
 * positional parameters, so a slug or an alias cannot become shell syntax.
 */

const PROBE_IMAGE = 'busybox:1.36';

const PROBE_SCRIPT = [
  'out=$(wget -S -T 5 -O /dev/null "http://$1:$2$3" 2>&1)',
  'line=$(echo "$out" | grep -m1 "HTTP/1")',
  'if [ -n "$line" ]; then echo "ANSWER $line"; exit 0; fi',
  'case "$out" in',
  '  *"bad address"*) echo "DNS $1 does not resolve on this network"; exit 2;;',
  '  *"refused"*) echo "CONNECT nothing accepts connections on $1:$2"; exit 3;;',
  '  *) echo "FAIL ${out:-no output}"; exit 1;;',
  'esac',
].join('\n');

export type IdpProbeInput = {
  /** `docker` CLI runner of the calling module. */
  readonly runCli: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<ExecResult>;
  /** The instance network the product lives on, e.g. `seamnex-inst-crm`. */
  readonly network: string;
  /** The alias the product uses, e.g. `keycloak`. */
  readonly host: string;
  readonly port: number;
  /** Realm-relative path that answers without a credential, e.g. `/realms/seamnex/...`. */
  readonly path: string;
  readonly timeoutMs?: number;
};

export type IdpProbeResult = {
  readonly ok: boolean;
  /** `dns` and `connect` are the two failures worth telling apart; `http` is a 5xx answer. */
  readonly failure: 'none' | 'dns' | 'connect' | 'no-answer';
  /** One sentence, safe for a check row or a portal note. */
  readonly detail: string;
};

export async function probeIdpFromNetwork(input: IdpProbeInput): Promise<IdpProbeResult> {
  let result: ExecResult;
  try {
    result = await input.runCli(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        input.network,
        PROBE_IMAGE,
        'sh',
        '-c',
        PROBE_SCRIPT,
        'seamnex-idp-probe',
        input.host,
        String(input.port),
        input.path,
      ],
      input.timeoutMs ?? 30_000,
    );
  } catch (error) {
    // The probe container failing to start is a probe failure, not a product failure — but it is
    // still not evidence that the product can reach the IdP, so the check stays unproven.
    return {
      ok: false,
      failure: 'no-answer',
      detail: `the reachability probe could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const first = result.stdout.trim().split(/\r?\n/)[0] ?? '';
  if (result.code === 0 && first.startsWith('ANSWER')) {
    return {
      ok: true,
      failure: 'none',
      detail: `${input.host}:${input.port} answers from ${input.network} (${first.slice('ANSWER '.length)})`,
    };
  }
  if (first.startsWith('DNS')) {
    return {
      ok: false,
      failure: 'dns',
      detail: `${input.host} does not resolve from ${input.network}; the product's token, JWKS and userinfo calls fail before they leave the container`,
    };
  }
  if (first.startsWith('CONNECT')) {
    return {
      ok: false,
      failure: 'connect',
      detail: `${input.host} resolves from ${input.network} but nothing accepts connections on port ${input.port}`,
    };
  }
  return {
    ok: false,
    failure: 'no-answer',
    detail: `${input.host}:${input.port} did not answer from ${input.network}: ${first.slice(0, 160) || 'no output'}`,
  };
}
