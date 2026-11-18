#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { Resolver, lookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * NFR-4.1 / ISSUE-07 — make product hostnames resolve for clients that ask the operating system.
 *
 * A browser treats every name under `.localhost` as loopback by itself (RFC 6761), which is why
 * `https://<slug>.<zone>:8443` opens in Chrome, Edge and Firefox with nothing configured. Node, `curl`
 * and Playwright's API context call `getaddrinfo`, and no platform resolver implements that rule for
 * subdomains of `localhost` — they get NXDOMAIN while the browser works, which is the confusing half
 * of this problem. `docker/dns` answers the zone; this script connects the host to it.
 *
 * Windows gets an NRPT rule scoped to the one zone. That is deliberate: replacing the adapter's DNS
 * servers would route every other lookup through the container as well, and the container's own
 * `forward` line points back at the host — a loop. The rule is reversible by its own comment, and
 * nothing else on the machine changes. Other platforms are documented rather than guessed at: a
 * resolver layout this script cannot undo would be worse than a printed command.
 *
 *   pnpm dev:dns          # does the service answer, and does the OS consult it?
 *   pnpm dev:dns:apply    # add the rule (elevated shell on Windows)
 *   pnpm dev:dns:revert   # remove it again
 */

const root = dirname(import.meta.dirname);
const envPath = join(root, '.env');
const COMMENT = 'seamnex development product DNS';
/** The leading dot is NRPT's suffix form: it matches every name *under* the zone. */
const NRPT_NAMESPACE_PREFIX = '.';

/** The zone the edge publishes under — the same value `docker/dns/Corefile` is rendered with. */
function zone() {
  if (!existsSync(envPath)) return 'seamnex.localhost';
  const configured = parseEnv(readFileSync(envPath, 'utf8')).SEAMNEX_INGRESS_DOMAIN;
  return configured !== undefined && configured.length > 0 ? configured : 'seamnex.localhost';
}

function log(message) {
  process.stdout.write(`[dns] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[dns] ${message}\n`);
  process.exitCode = 1;
}

/** A name no route serves: only the DNS answer is under test. */
function probeName(zoneName) {
  return `dev-dns-probe.${zoneName}`;
}

/** Runs one PowerShell snippet and hands back its exit code and output. */
function powershell(script) {
  return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  });
}

/** Remove the rules this script owns. By name: `Remove-DnsClientNrptRule` takes no rule object. */
function removalScript() {
  return (
    `Get-DnsClientNrptRule | Where-Object { $_.Comment -eq '${COMMENT}' } | ` +
    `ForEach-Object { Remove-DnsClientNrptRule -Name $_.Name -ErrorAction Stop }`
  );
}

/**
 * Two answers, because they fail for different reasons: the container answering, and the operating
 * system consulting it. A container that is down is a `pnpm dev:stack` problem; a container that
 * answers but is not consulted is what `--apply` exists to fix.
 */
async function check(zoneName) {
  const name = probeName(zoneName);
  const direct = new Resolver();
  direct.setServers(['127.0.0.1']);

  let answered = null;
  try {
    answered = (await direct.resolve4(name))[0] ?? null;
  } catch (error) {
    log(
      `the DNS service did not answer ${name} on 127.0.0.1:53 (${error.code ?? 'error'}); ` +
        'start it with `pnpm dev:stack up -d dns`',
    );
  }

  let resolved = null;
  try {
    resolved = (await lookup(name)).address;
  } catch {
    // No answer from the OS resolver is the state `--apply` exists to fix; reported below, not thrown.
  }

  if (answered !== null) log(`the DNS service answers ${name} -> ${answered}`);
  if (resolved !== null) log(`the operating system resolves ${name} -> ${resolved}`);
  else {
    log(
      `the operating system does not resolve ${name}. Browsers still open product URLs; Node, ` +
        '`curl` and Playwright do not. Run `pnpm dev:dns:apply` in an elevated shell to route this ' +
        'zone here.',
    );
  }

  return answered !== null && resolved !== null;
}

function applyRule(zoneName) {
  const namespace = `${NRPT_NAMESPACE_PREFIX}${zoneName}`;
  // Replaced, not duplicated: two rules for one suffix would leave half the answers on the old server.
  const script =
    `${removalScript()}; ` +
    `Add-DnsClientNrptRule -Namespace '${namespace}' -NameServers '127.0.0.1' ` +
    `-Comment '${COMMENT}' -ErrorAction Stop`;
  const result = powershell(script);
  if (result.status === 0) {
    log(`route ${namespace} to 127.0.0.1 (NRPT rule "${COMMENT}")`);
    return true;
  }
  const message = (result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? 'unknown error';
  fail(
    `the NRPT rule could not be written: ${message}\n` +
      '  It needs an elevated PowerShell. Run it once, then `pnpm dev:dns` again.',
  );
  return false;
}

function revertRule() {
  const result = powershell(removalScript());
  if (result.status === 0) {
    log('the NRPT rule was removed; the adapter resolvers were never touched');
    return true;
  }
  fail((result.stderr || result.stdout).trim() || 'the NRPT rule could not be removed');
  return false;
}

/** What to configure by hand where this script will not touch the resolver. */
function manualInstructions(zoneName) {
  log(
    `this script writes a Windows NRPT rule. On another host, add a resolver for ${zoneName} ` +
      'yourself and then run `pnpm dev:dns` to verify it:\n' +
      `  macOS : echo 'nameserver 127.0.0.1' | sudo tee /etc/resolver/${zoneName}\n` +
      `  Linux : dnsmasq --server=/${zoneName}/127.0.0.1, or systemd-resolved with ` +
      `Domains=~${zoneName} pointed at 127.0.0.1`,
  );
  process.exitCode = 2;
}

const zoneName = zone();
const argument = process.argv.slice(2).find((value) => value.startsWith('--')) ?? '--check';

if (argument === '--check') {
  if (!(await check(zoneName))) process.exitCode = 1;
} else if (argument === '--apply') {
  if (process.platform !== 'win32') manualInstructions(zoneName);
  else if (!applyRule(zoneName) || !(await check(zoneName))) process.exitCode = 1;
} else if (argument === '--revert') {
  if (process.platform !== 'win32') manualInstructions(zoneName);
  else if (!revertRule()) process.exitCode = 1;
} else {
  fail(`unknown option ${argument}; use --check, --apply or --revert`);
}
