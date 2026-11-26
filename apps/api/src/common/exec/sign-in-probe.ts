import type { ExecResult } from './exec';
import { BUSYBOX_IMAGE } from '../docker/images.generated';

/**
 * Does the product's own sign-in page offer the platform identity provider?
 *
 * `SsoProbe` answers a different question: it drives an authorization request and a code exchange
 * against the identity provider, from the control plane, with the client id and redirect URI the
 * platform registered. Every one of those stages passes while the product itself is not configured to
 * sign anyone in — the ERPNext deployment this check exists for had a registered Keycloak client, a
 * successful code exchange, and a site with no `Social Login Key` at all, so its sign-in page offered
 * nothing but a password form and the platform still recorded "single sign-on".
 *
 * The product's page is the one artefact that states the product's half of the contract, so it is read
 * here, from a container on the instance network: the compose policy forbids published ports and the
 * API process is attached to no instance's bridge, so an in-process `fetch` cannot reach it. The marker
 * is a literal the page carries only when the provider is offered — for Frappe the callback path in the
 * button's `redirect_uri`, which is the same string the client was registered on.
 *
 * The target and the marker travel as positional parameters of `sh -c`, so a slug or a marker cannot
 * become shell syntax.
 */

const PROBE_IMAGE = BUSYBOX_IMAGE;

const PROBE_SCRIPT = [
  'body=$(wget -q -T 5 -O - "http://$1:$2$3" 2>&1)',
  'if [ -z "$body" ]; then echo "SIGNIN no-answer"; exit 2; fi',
  'if printf "%s" "$body" | grep -q -F -- "$4"; then echo "SIGNIN offered"; exit 0; fi',
  'echo "SIGNIN absent"; exit 1',
].join('\n');

export type SignInPageProbeInput = {
  /** `docker` CLI runner of the calling module (each module owns its client). */
  readonly runCli: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<ExecResult>;
  /** Instance network the probe container joins, e.g. `seamnex-inst-erpnext`. */
  readonly network: string;
  /** Host to address; the platform aliases the product service as `<slug>`. */
  readonly host: string;
  readonly port: number;
  /** Path of the product's own sign-in page, e.g. `/login`. */
  readonly path: string;
  /** Literal the page contains only when the provider is offered. */
  readonly marker: string;
  readonly timeoutMs?: number;
};

export type SignInPageProbeResult = {
  readonly ok: boolean;
  /** `absent` is the defect this probe is for: the page answers and does not offer the provider. */
  readonly failure: 'none' | 'no-answer' | 'absent';
  /** One sentence, safe for a check row or a portal note. */
  readonly detail: string;
};

export async function probeSignInPage(input: SignInPageProbeInput): Promise<SignInPageProbeResult> {
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
        'seamnex-signin-probe',
        input.host,
        String(input.port),
        input.path,
        input.marker,
      ],
      input.timeoutMs ?? 30_000,
    );
  } catch (error) {
    // A probe container that cannot start is not evidence that the product does not offer the
    // provider — but it is also not evidence that it does, so the leg stays unproven.
    return {
      ok: false,
      failure: 'no-answer',
      detail: `the sign-in page probe could not run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const first = result.stdout.trim().split(/\r?\n/)[0] ?? '';
  if (result.code === 0 && first.startsWith('SIGNIN offered')) {
    return {
      ok: true,
      failure: 'none',
      detail: `${input.path} offers the identity provider (${input.marker})`,
    };
  }
  if (first.startsWith('SIGNIN absent')) {
    return {
      ok: false,
      failure: 'absent',
      detail: `${input.path} answers and does not offer the identity provider: the page carries no ${input.marker}`,
    };
  }
  return {
    ok: false,
    failure: 'no-answer',
    detail: `${input.host}:${input.port}${input.path} did not answer from ${input.network}`,
  };
}
