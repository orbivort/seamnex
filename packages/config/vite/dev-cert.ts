import { spawnSync } from 'node:child_process';
import { X509Certificate, createPublicKey } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/**
 * The certificate the Vite dev servers present, generated once per checkout and cached under `temp/`.
 *
 * Why this exists: NFR-4.1 is about the deployment edge, but a developer's first impression of the
 * platform is `pnpm dev`, and a plain-HTTP banner there teaches the opposite of what the product
 * enforces (ADR-BE-39). The dev servers therefore speak TLS with a locally issued certificate
 * (`https://localhost:5173`, `https://localhost:5174`).
 *
 * Why a CA and not a self-signed leaf: a client that verifies certificates cannot be taught to trust
 * a self-signed end-entity certificate. Chromium answers `ERR_CERT_AUTHORITY_INVALID`, Playwright's
 * `apiRequestContext` refuses the request, and the only escape is switching verification off — which
 * is exactly the habit this change exists to prevent. A development CA that issues the leaf gives
 * every one of those clients something it can be pointed at (`temp/certs/dev-ca.crt`), once, and the
 * leaf keeps the SANs a browser needs (`localhost`, `*.localhost`, both loopback IPs).
 *
 * Why it shells out to `openssl` instead of a package: Node has no certificate builder, and a vendored
 * ASN.1 writer is exactly the kind of homegrown crypto a review should reject. `openssl` is present on
 * every Linux and macOS host and ships with Git for Windows, so the alternative — a new dependency —
 * would buy convenience at the cost of a supply-chain entry for a development-only artefact.
 *
 * Nothing secret is committed: the keys live in `temp/` (already ignored), mode `0600` where the
 * platform supports it, and are regenerated rather than restored.
 */

/** Everything the dev servers are addressed by: `localhost`, its subdomains and both loopback IPs. */
const CERTIFICATE_NAMES = ['localhost', '*.localhost'] as const;
const CERTIFICATE_IPS = ['127.0.0.1', '::1'] as const;

/** Regenerate this long before `-days` runs out, so an expired certificate cannot surprise a demo. */
const RENEW_WHEN_DAYS_LEFT = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The CA outlives the leaf on purpose. Rotating the CA forces every developer to trust a new anchor,
 * so it is minted for ten years and only the leaf is reissued each year.
 */
const CA_DAYS = 3650;
const LEAF_DAYS = 365;

/** Where the generated pair and its metadata live, relative to the repository root. */
const CACHE_DIR = path.join('temp', 'certs');

const CACHE_FILES = {
  caKey: 'dev-ca.key',
  caCert: 'dev-ca.crt',
  key: 'dev.key',
  cert: 'dev.crt',
  meta: 'dev.json',
} as const;

/**
 * The lock that keeps two starters from minting into the same directory at once.
 *
 * `pnpm dev` runs the portal and the console through Turbo, which means two processes loading this
 * module in their own Vite config factory, at the same instant, against one `temp/certs`. Without the
 * lock both found the directory empty and both wrote `dev.key` and `dev.csr`; each then signed
 * whichever request the other had left behind, so one server came up holding a certificate for a key
 * it did not have (`ERR_OSSL_X509_KEY_VALUES_MISMATCH`, fatal in `server.https`) and the other found
 * its request deleted (`openssl x509` could not read `dev.csr`) and fell back to http.
 */
const LOCK_FILE = '.generation.lock';

/** A generation is a handful of `openssl` calls; a lock older than this belongs to a dead process. */
const LOCK_STALE_MS = 60_000;

/** Waiting is cheaper than a second generation: the winner's pair is reused as soon as it lands. */
const LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 50;

/**
 * Binaries tried after `PATH`. On Windows `openssl` is not on `PATH` even when Git is installed, and on
 * macOS the system LibreSSL lives under `/usr/bin` while Homebrew's OpenSSL is keg-only.
 */
const FALLBACK_BINARIES =
  process.platform === 'win32'
    ? [
        'C:/Program Files/Git/usr/bin/openssl.exe',
        'C:/Program Files/Git/mingw64/bin/openssl.exe',
        'C:/Program Files (x86)/Git/usr/bin/openssl.exe',
      ]
    : [
        '/usr/bin/openssl',
        '/usr/local/bin/openssl',
        '/opt/homebrew/bin/openssl',
        '/opt/local/bin/openssl',
      ];

export interface DevCertificate {
  /** Absolute path of the PEM private key. Vite reads the file itself. */
  readonly key: string;
  /** Absolute path of the PEM certificate, issued by the development CA. */
  readonly cert: string;
  /**
   * Absolute path of the CA certificate that issued `cert`.
   *
   * It exists to be trusted, not to be served: `NODE_EXTRA_CA_CERTS`, a Playwright context's
   * `ignoreHTTPSErrors: false` + trust store, or the OS store all take this file.
   */
  readonly ca: string;
}

export interface DevCertificateResult {
  /** Present when a usable pair exists; absent means the caller should serve plain HTTP. */
  readonly certificate?: DevCertificate;
  /** Why no certificate is available, phrased for a developer. Absent on success. */
  readonly reason?: string;
}

interface CertificateMeta {
  readonly names: readonly string[];
  readonly ips: readonly string[];
  readonly createdAt: string;
}

/** A path that runs `--version` successfully, or `null`. */
function probe(binary: string): string | null {
  const result = spawnSync(binary, ['version'], { encoding: 'utf8' });
  return result.status === 0 ? binary : null;
}

/**
 * The first usable `openssl`. The override exists for a host whose binary is somewhere unusual, or for
 * a CI image where the fallback list does not apply.
 */
function resolveOpenSsl(): string | null {
  const override = process.env.SEAMNEX_DEV_CERT_OPENSSL;
  if (override !== undefined && override.length > 0) {
    const found = probe(override);
    // Said out loud rather than silently ignored: a broken override is a configuration mistake, and
    // falling through would hide it behind "no certificate".
    if (found !== null) return found;
    return null;
  }

  const fromPath = probe(process.platform === 'win32' ? 'openssl.exe' : 'openssl');
  if (fromPath !== null) return fromPath;

  for (const candidate of FALLBACK_BINARIES) {
    if (existsSync(candidate)) {
      const found = probe(candidate);
      if (found !== null) return found;
    }
  }
  return null;
}

/** The `openssl` configuration for the CA: a constrained intermediate-style anchor, not a server. */
function caConfiguration(): string {
  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '[dn]',
    'CN = Seamnex development CA',
    '[v3_ca]',
    // `pathlen:0` keeps the anchor from signing another CA if the key ever leaks out of `temp/`.
    'basicConstraints = critical, CA:TRUE, pathlen:0',
    'keyUsage = critical, keyCertSign, cRLSign',
    'subjectKeyIdentifier = hash',
    '',
  ].join('\n');
}

/** The `openssl` configuration for the leaf: the SAN block is what makes it valid for both SPAs. */
function leafConfiguration(names: readonly string[], ips: readonly string[]): string {
  const altNames = [
    ...names.map((name, index) => `DNS.${index + 1} = ${name}`),
    ...ips.map((ip, index) => `IP.${index + 1} = ${ip}`),
  ].join('\n');

  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '[dn]',
    'CN = localhost',
    '[dev]',
    'basicConstraints = critical, CA:FALSE',
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    // Names the anchor that issued it, so a chain builder does not have to guess.
    'authorityKeyIdentifier = keyid:always',
    `subjectAltName = @alt`,
    '[alt]',
    altNames,
    '',
  ].join('\n');
}

/**
 * The two halves in `temp/certs` are one pair: the private key has to be the one the certificate's
 * public key was cut from. Nothing else in the cache check looks at a key file, so a certificate
 * signed for another process's key used to pass validation and then abort every start inside Node's
 * TLS context — the one failure a developer cannot get past by retrying.
 */
function keyMatchesCert(keyFile: string, certificate: X509Certificate): boolean {
  const fromKey = createPublicKey(readFileSync(keyFile)).export({ type: 'spki', format: 'der' });
  const fromCert = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return fromKey.equals(fromCert);
}

/**
 * A CA that is intact, self-signed, a CA, paired with its own key, and not about to expire.
 *
 * The key matters as much as the certificate: reusing a CA certificate whose key was lost or replaced
 * would issue leaves that nothing can verify, and the pair would then be rejected on every start.
 */
function usableCa(caKey: string, caCert: string): boolean {
  if (!existsSync(caKey) || !existsSync(caCert)) return false;

  try {
    const ca = new X509Certificate(readFileSync(caCert));
    if (!ca.ca) return false;
    if (Date.parse(ca.validTo) - Date.now() < RENEW_WHEN_DAYS_LEFT * DAY_MS) return false;
    // Self-signed and unmodified: the signature verifies against its own key.
    return ca.verify(ca.publicKey) && keyMatchesCert(caKey, ca);
  } catch {
    return false;
  }
}

/**
 * A cached leaf is reused only when the development CA actually issued it, it still covers every name
 * and it is not about to expire. A stale certificate is worse than none: the browser accepts it once,
 * then fails days later with an error that reads as "the server is down".
 */
function isUsable(
  key: string,
  cert: string,
  caKey: string,
  caCert: string,
  metaFile: string,
): boolean {
  if (!existsSync(key) || !existsSync(cert) || !existsSync(metaFile)) return false;

  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Partial<CertificateMeta>;
    const names = meta.names ?? [];
    const ips = meta.ips ?? [];
    if (
      !CERTIFICATE_NAMES.every((name) => names.includes(name)) ||
      !CERTIFICATE_IPS.every((ip) => ips.includes(ip))
    ) {
      return false;
    }

    if (!usableCa(caKey, caCert)) return false;

    const ca = new X509Certificate(readFileSync(caCert));
    const leaf = new X509Certificate(readFileSync(cert));
    const expiresAt = Date.parse(leaf.validTo);
    if (Number.isNaN(expiresAt)) return false;
    if (expiresAt - Date.now() < RENEW_WHEN_DAYS_LEFT * DAY_MS) return false;

    // The chain, not just the files: an issuer link and a signature that verifies are what a browser
    // checks. A leaf signed by a CA that has since been replaced fails here instead of in the browser.
    // The direction is the API's: `checkIssued` asks whether the receiver was issued by the argument,
    // and `verify` whether the receiver was signed by the given public key. Asking the CA instead
    // reads "was the CA issued by the leaf", which is false for every real pair — and made this
    // function reject the cached certificate on every start, so both dev servers re-minted one.
    if (!leaf.checkIssued(ca)) return false;
    if (!leaf.verify(ca.publicKey)) return false;

    // And the key: a certificate is half of a pair, and Node refuses to build a TLS context from
    // halves that were minted by different processes.
    if (!keyMatchesCert(key, leaf)) return false;

    // `checkHost`/`checkIP` read the SAN the browser will read: a certificate whose files are intact
    // but whose extensions were lost fails here instead of in the browser.
    return leaf.checkHost('localhost') !== undefined && leaf.checkIP('127.0.0.1') !== undefined;
  } catch {
    return false;
  }
}

/** One `openssl` call, with the failure reason trimmed to the line a developer can act on. */
function run(
  openssl: string,
  args: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const result = spawnSync(openssl, [...args], { encoding: 'utf8' });
  if (result.status === 0) return { ok: true };
  const last = (result.stderr ?? '').trim().split('\n').at(-1) ?? 'no output';
  return { ok: false, reason: `\`${openssl} ${args[0]}\` failed (${last})` };
}

/** Writes the anchor the leaf is issued from. Only called when no usable CA is on disk. */
function issueCa(
  openssl: string,
  files: typeof CACHE_FILES,
  directory: string,
): { ok: true } | { ok: false; reason: string } {
  const caKey = path.join(directory, files.caKey);
  const caCert = path.join(directory, files.caCert);
  const configuration = path.join(directory, 'dev-ca.cnf');
  writeFileSync(configuration, caConfiguration(), 'utf8');
  rmSync(caKey, { force: true });
  rmSync(caCert, { force: true });

  const generated = run(openssl, [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    String(CA_DAYS),
    '-keyout',
    caKey,
    '-out',
    caCert,
    '-config',
    configuration,
    '-extensions',
    'v3_ca',
  ]);
  return generated.ok ? { ok: true } : { ok: false, reason: generated.reason };
}

/** Issues the leaf from the CA. Always called when `isUsable` refused the cached pair. */
function issueLeaf(
  openssl: string,
  files: typeof CACHE_FILES,
  directory: string,
): { ok: true } | { ok: false; reason: string } {
  const caKey = path.join(directory, files.caKey);
  const caCert = path.join(directory, files.caCert);
  const key = path.join(directory, files.key);
  const cert = path.join(directory, files.cert);
  const request = path.join(directory, 'dev.csr');
  const configuration = path.join(directory, 'dev.cnf');
  writeFileSync(configuration, leafConfiguration(CERTIFICATE_NAMES, CERTIFICATE_IPS), 'utf8');

  // Any half-written pair from an interrupted run would otherwise be read as "cached but corrupt".
  rmSync(key, { force: true });
  rmSync(cert, { force: true });
  rmSync(request, { force: true });

  const created = run(openssl, [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-keyout',
    key,
    '-out',
    request,
    '-config',
    configuration,
  ]);
  if (!created.ok) return { ok: false, reason: created.reason };

  const signed = run(openssl, [
    'x509',
    '-req',
    '-in',
    request,
    '-CA',
    caCert,
    '-CAkey',
    caKey,
    // `-CAcreateserial` writes the serial beside the CA; it is a development artefact, not a secret.
    '-CAcreateserial',
    '-days',
    String(LEAF_DAYS),
    '-sha256',
    '-extfile',
    configuration,
    '-extensions',
    'dev',
    '-out',
    cert,
  ]);
  rmSync(request, { force: true });
  return signed.ok ? { ok: true } : { ok: false, reason: signed.reason };
}

/** A lock left behind by a process that died mid-generation. */
function isStaleLock(lockFile: string): boolean {
  try {
    return Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS;
  } catch {
    // Gone between the failed create and this stat: the next attempt simply takes it.
    return false;
  }
}

/**
 * Takes the generation lock, waiting for a starter that got there first.
 *
 * The lock is a file created with `wx`, which is the only atomic "create if absent" every supported
 * filesystem offers without a dependency. `false` means the caller must not mint: either the lock
 * cannot be created at all, or it stayed held past `LOCK_WAIT_MS`. Degrading to http is deliberate —
 * blocking the dev server for ever on a stale lock would be worse than a banner that says why.
 */
function acquireGenerationLock(lockFile: string): boolean {
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      writeFileSync(lockFile, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }

    if (isStaleLock(lockFile)) {
      rmSync(lockFile, { force: true });
      continue;
    }

    if (Date.now() >= deadline) return false;

    // A sleep without a timer: this runs inside Vite's config factory, which cannot await. `Atomics.wait`
    // on a buffer nobody shares blocks the thread for exactly this long and nothing else.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
  }
}

/**
 * The certificate pair, generating it on first use.
 *
 * Synchronous on purpose: this runs inside Vite's config factory, where the returned paths have to
 * exist before the server options are handed back. The cost is a few `openssl` invocations per
 * checkout (about a tenth of a second each), after which every start is a file read.
 */
export function resolveDevCertificate(repoRoot: string): DevCertificateResult {
  const directory = path.join(repoRoot, CACHE_DIR);
  const caKey = path.join(directory, CACHE_FILES.caKey);
  const caCert = path.join(directory, CACHE_FILES.caCert);
  const key = path.join(directory, CACHE_FILES.key);
  const cert = path.join(directory, CACHE_FILES.cert);
  const metaFile = path.join(directory, CACHE_FILES.meta);

  if (isUsable(key, cert, caKey, caCert, metaFile)) {
    return { certificate: { key, cert, ca: caCert } };
  }

  const openssl = resolveOpenSsl();
  if (openssl === null) {
    return {
      reason:
        'no OpenSSL binary found, so the dev servers cannot mint a certificate and will start over ' +
        'http. Install OpenSSL, or point SEAMNEX_DEV_CERT_OPENSSL at one',
    };
  }

  mkdirSync(directory, { recursive: true });

  const lockFile = path.join(directory, LOCK_FILE);
  if (!acquireGenerationLock(lockFile)) {
    return {
      reason:
        `could not take ${LOCK_FILE} within ${LOCK_WAIT_MS / 1000}s, so no certificate was minted; ` +
        'the dev servers will start over http. Delete temp/certs and re-run `pnpm dev`',
    };
  }

  try {
    // Checked again under the lock: the usual outcome of waiting is that the other process finished,
    // and its pair is exactly the one this process wanted.
    if (isUsable(key, cert, caKey, caCert, metaFile)) {
      return { certificate: { key, cert, ca: caCert } };
    }

    // The CA is reused across leaf rotations: re-trusting a new anchor every year is the friction that
    // makes a developer switch verification off entirely.
    if (!usableCa(caKey, caCert)) {
      const ca = issueCa(openssl, CACHE_FILES, directory);
      if (!ca.ok) {
        return { reason: `${ca.reason}; the dev servers will start over http` };
      }
    }

    const leaf = issueLeaf(openssl, CACHE_FILES, directory);
    if (!leaf.ok) {
      return { reason: `${leaf.reason}; the dev servers will start over http` };
    }

    // The CA key is a private key like any other. Windows has no mode bits, so the call is best-effort.
    for (const secret of [caKey, key]) {
      try {
        chmodSync(secret, 0o600);
      } catch {
        // Ignored: the files are under `temp/`, which is not shared.
      }
    }

    const meta: CertificateMeta = {
      names: CERTIFICATE_NAMES,
      ips: CERTIFICATE_IPS,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    // Read back rather than assume: a pair that fails here would have crashed Vite inside Node's TLS
    // setup, before any of this module's messages could be read. Reported as a reason, it is a banner.
    if (!isUsable(key, cert, caKey, caCert, metaFile)) {
      return {
        reason:
          'the generated certificate does not verify against its key or its CA; the dev servers will ' +
          'start over http. Delete temp/certs and re-run `pnpm dev`',
      };
    }

    return { certificate: { key, cert, ca: caCert } };
  } finally {
    rmSync(lockFile, { force: true });
  }
}
