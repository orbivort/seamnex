# Certificates

Two certificate stories meet in this repository: the development CA that signs the TLS the two Vite dev
servers present, and the deployment edge that terminates TLS for the products (ADR-BE-39, NFR-4.1). This
page documents both: what is on disk, what issues what, how long it lives, how to trust it once, what each
warning means, and the retention rule for the untracked material under `temp/certs`.

In the development stack the two coincide: the edge serves the same leaf the dev servers do, so the one
anchor trusted for `https://localhost:5173` also covers `https://<slug>.seamnex.localhost:8443` for every
slug, present and future (see [name resolution](#name-resolution-which-a-certificate-cannot-fix), which is
the half a certificate cannot solve).

It is the operational companion to `packages/config/vite/dev-cert.ts`, which is the only code that mints
anything. If this page and that module disagree, the module wins — and the page is the bug.

## What exists

Nothing under `temp/` is tracked. `temp/` is in `.gitignore`, and `pnpm clean` deliberately never descends
into it (`scripts/clean.mjs`), so no `clean`, `clean:all` or `install` removes the certificates.

| Artefact                    | Path                            | Lifetime       | Consumed by                       |
| --------------------------- | ------------------------------- | -------------- | --------------------------------- |
| Development CA certificate  | `temp/certs/dev-ca.crt`         | 3650 days      | the client trust store, once      |
| Development CA private key  | `temp/certs/dev-ca.key`         | as the CA      | `openssl x509 -req`, when signing |
| Leaf certificate            | `temp/certs/dev.crt`            | 365 days       | `server.https`, `preview.https`   |
| Leaf private key            | `temp/certs/dev.key`            | as the leaf    | `server.https`, `preview.https`   |
| Cache metadata              | `temp/certs/dev.json`           | informational  | the reuse decision (SAN list)     |
| OpenSSL inputs and serial   | `dev-ca.cnf`, `dev.cnf`, `.srl` | scratch        | `openssl`                         |
| Certificate signing request | `temp/certs/dev.csr`            | one generation | deleted immediately after signing |
| Generation lock             | `temp/certs/.generation.lock`   | one generation | the process minting the pair      |

A generation only happens when the cache is refused. `dev.csr` and the lock are transient; the two `.cnf`
inputs and the CA serial stay behind as scratch.

## The two objects

Measured from a current pair (`openssl x509 -in temp/certs/dev.crt -noout -text`), not paraphrased:

| Field               | Development CA                     | Leaf                                                                                                       |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Subject             | `CN=Seamnex development CA`        | `CN=localhost`                                                                                             |
| Key                 | RSA 2048, SHA-256, self-signed     | RSA 2048, SHA-256, signed by the CA                                                                        |
| Validity            | 10 years                           | 1 year                                                                                                     |
| Basic constraints   | critical, `CA:TRUE, pathlen:0`     | critical, `CA:FALSE`                                                                                       |
| Key usage           | critical, `keyCertSign`, `cRLSign` | critical, `digitalSignature`, `keyEncipherment`                                                            |
| Extended key usage  | —                                  | `serverAuth`                                                                                               |
| Subject alternative | —                                  | `DNS:localhost`, `DNS:*.localhost`, `DNS:*.<SEAMNEX_INGRESS_DOMAIN>`, `IP:127.0.0.1`, `IP:0:0:0:0:0:0:0:1` |
| Key identifiers     | `SKID` (hash)                      | `AKID` matching the CA's `SKID`, own `SKID`                                                                |

`pathlen:0` keeps the anchor from signing another CA if `dev-ca.key` ever leaks out of `temp/`.

### Why a CA and not a self-signed leaf

A client that verifies certificates cannot be taught to trust a self-signed end-entity certificate:
Chromium answers `ERR_CERT_AUTHORITY_INVALID`, Playwright's `apiRequestContext` refuses the request, and the
only escape is switching verification off — the habit the design exists to prevent. A CA gives every one of
those clients a single thing to be pointed at, once, while the leaf under it is reissued.

## Lifecycle

`resolveDevCertificate(repoRoot)` runs synchronously inside Vite's config factory, before any server
options are built:

1. **Validate the cache.** If it passes, return the three paths. The cost is a few file reads (~4 ms).
2. **Resolve OpenSSL.** `openssl` on `PATH`, the override in `SEAMNEX_DEV_CERT_OPENSSL`, then the paths Git
   for Windows, Homebrew, MacPorts and `/usr/bin` install to. No binary means no certificate, and the
   servers start over HTTP with a banner naming the variable.
3. **Take `temp/certs/.generation.lock`** and wait for whoever holds it — `pnpm dev` starts the portal and
   the console as two processes against this one directory. The lock is created with `wx`; a lock older
   than 60 s is treated as a crashed process and reclaimed; the waiter gives up after 20 s and reports it.
4. **Re-validate under the lock**, because the usual outcome of waiting is that the other process finished.
5. **Mint what is missing**: the CA only when it is unusable, then always a leaf.
6. **Read the result back** before handing it to Vite. A pair that does not verify becomes a `reason` — the
   HTTP banner — instead of an exception inside Node's TLS setup, where nothing else can be read.

Timings on a developer laptop: cold generation ~0.9 s, warm start ~4 ms, and a leaf is reissued
automatically seven days before it expires.

### What makes the cache unusable

Any of the following forces a reissue. The first five are cheap checks on files and metadata; the rest
are chain checks.

| Condition                                                           | Result                 |
| ------------------------------------------------------------------- | ---------------------- |
| `dev.key`, `dev.crt` or `dev.json` is missing                       | regenerate leaf        |
| `dev.json` does not list every required name and IP                 | regenerate leaf        |
| The leaf expires within 7 days                                      | regenerate leaf        |
| The leaf's SAN no longer covers `localhost` or `127.0.0.1`          | regenerate leaf        |
| `dev.key` is not the key `dev.crt` was issued for                   | regenerate leaf        |
| The CA is missing, not a CA, not self-signed, or expiring in 7 days | regenerate CA and leaf |
| `dev-ca.key` is not the key `dev-ca.crt` belongs to                 | regenerate CA and leaf |
| The leaf was not issued by the on-disk CA, or its signature fails   | regenerate leaf        |

Editing `CERTIFICATE_NAMES` or `CERTIFICATE_IPS` in the module therefore reissues on the next start
without any manual step.

## Trusting the CA

Trust is per client, not per repository, and it is the developer's action: nothing in the codebase installs
a root. One file, `temp/certs/dev-ca.crt`, is what every client below is pointed at.

| Client                               | Command or path                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Chrome, Edge on Windows (user store) | `certutil -user -addstore Root temp\certs\dev-ca.crt` — restart the browser afterwards                       |
| macOS (login or system keychain)     | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain temp/certs/dev-ca.crt` |
| Chromium on Linux                    | `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Seamnex development CA" -i temp/certs/dev-ca.crt`          |
| System store on Debian-like Linux    | copy to `/usr/local/share/ca-certificates/` as a `.crt`, then `update-ca-certificates`                       |
| Firefox (any OS)                     | its own NSS store: Settings → Certificates → Authorities → Import, "Trust this CA to identify websites"      |
| Node, Playwright, `curl` on Node 24  | `NODE_EXTRA_CA_CERTS=temp\certs\dev-ca.crt`, or `node --use-system-ca` to read the Windows store             |

Chrome, Edge and Safari all read the host's certificate store; Firefox keeps its own, and Node uses its own
bundle. Trusting the CA in Windows therefore fixes the browser surfaces and nothing scripted.

### Verify the trust, do not assume it

```powershell
# The anchor the client will use, and the anchor on disk: the thumbprints must match.
Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -like '*Seamnex*' } |
  Select-Object Subject, Thumbprint, NotAfter
(New-Object System.Security.Cryptography.X509Certificates.X509Certificate2("temp\certs\dev-ca.crt")).Thumbprint
```

```powershell
# The chain Windows builds for the served leaf; it must end without UntrustedRoot.
$leaf = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2("temp\certs\dev.crt")
$ca   = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2("temp\certs\dev-ca.crt")
$chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
[void]$chain.ChainPolicy.ExtraStore.Add($ca)
$chain.ChainPolicy.RevocationMode = 'NoCheck'
$chain.Build($leaf); $chain.ChainStatus | ForEach-Object { "$($_.Status): $($_.StatusInformation.Trim())" }
```

Removing a stale anchor whose subject collides with the current one matters: `certutil -user -delstore Root
<thumbprint>` first, then add. Two roots with `CN=Seamnex development CA` and different keys make the
client pick the wrong one and report a signature failure that reads like a corrupt certificate.

## What each warning means

| Symptom                                                                                                   | Cause                                                                                                                                                                 | Fix                                                                                         |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ERR_CERT_AUTHORITY_INVALID` — issuer not trusted                                                         | the CA was rotated (`temp/certs` deleted, leaf reissued under a new CA) and the store still holds the old one                                                         | trust `temp\certs\dev-ca.crt`, remove the stale entry, restart the browser                  |
| The same error, first run ever                                                                            | nothing was trusted yet                                                                                                                                               | the command above                                                                           |
| `ERR_CERT_COMMON_NAME_INVALID`                                                                            | the URL is a Vite **Network** address (`https://192.168.x.x:5174`), or a product host outside `SEAMNEX_INGRESS_DOMAIN` — the leaf carries `*.<domain>`, nothing wider | use `localhost`, add the address to `CERTIFICATE_IPS`, or publish under the configured zone |
| `ERR_NAME_NOT_RESOLVED` in Node, `curl` or a Playwright API context, while the browser opens the same URL | the operating system resolver has no rule for the zone: browsers implement RFC 6761 on their own, `getaddrinfo` does not                                              | `pnpm dev:dns:apply` in an elevated shell, then `pnpm dev:dns`                              |
| `ERR_CERT_DATE_INVALID`                                                                                   | clock skew (suspended VM, WSL drift) puts the leaf's `notBefore` in the future                                                                                        | fix the clock; a reissue cannot help                                                        |
| A product URL shows `CN=TRAEFIK DEFAULT CERT`, untrusted and wrong host                                   | the edge's default certificate is not the mounted leaf: `temp/certs` was empty when the edge started, or the leaf was re-minted and the edge still holds the old one  | `pnpm dev:stack up -d traefik` after a mint; `restart traefik` after a reissue              |
| `ERR_SSL_PROTOCOL_ERROR`, `ERR_CONNECTION_REFUSED`                                                        | the server is on plain HTTP (no OpenSSL, generation refused) and the browser was upgraded                                                                             | read the `[vite] dev server starting over http: …` banner                                   |
| `ERR_OSSL_X509_KEY_VALUES_MISMATCH` in the terminal                                                       | the key and the certificate on disk belong to different generations                                                                                                   | delete `temp/certs`, re-run `pnpm dev` — the module now detects this                        |
| `unable to load certificate request input … dev.csr`                                                      | a second process deleted the CSR mid-signing                                                                                                                          | the generation lock prevents it; delete `temp/certs` if a lock is wedged                    |
| `could not take .generation.lock within 20s`                                                              | a crashed process left the lock, or generation is genuinely stuck                                                                                                     | wait for the 60 s staleness window, or delete `temp/certs`                                  |
| `does not verify against its key or its CA`                                                               | generation produced a pair the module refuses to serve                                                                                                                | delete `temp/certs`, re-run, and report the banner if it repeats                            |

A red interstitial is not a functional failure: after clicking through, the session is still TLS and
`Secure` cookies still work. It is a habit failure — and scripted clients (Playwright, Node, `curl`) abort
the handshake outright, which is usually the first "works in the browser, fails in CI" report.

Never resolve any of these with `--ignore-certificate-errors`, `--allow-insecure-localhost` or
`NODE_TLS_REJECT_UNAUTHORIZED=0`: they are per-profile or per-process switches that hide exactly the class
of failure the platform enforces elsewhere.

## Retention and rotation policy

`temp/certs` is a disposable local cache, not state. It also holds two private keys, so it gets the same
care as the rest of the key material under `temp/` — the development root key, `temp/seamnex-root-key`, is
the other one.

| Situation                                                              | Action                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| Normal start, nothing reported                                         | keep — reuse costs milliseconds, and the CA stays trusted |
| A warning in the banner, or a mismatch reported                        | `Remove-Item -Recurse -Force temp\certs`, then `pnpm dev` |
| The tree was copied, synced to a cloud folder, or attached to a ticket | delete and re-mint; then re-trust the new CA              |
| A new machine, a moved checkout, a different OpenSSL                   | delete and re-mint on the new host; trust once there      |
| Before a demo, or while investigating a TLS symptom                    | keep — a rotation costs a re-trust on every client        |

Rules that follow from the table:

- **Never delete `temp/certs` as "cleanup".** A rotation is the usual cause of
  `ERR_CERT_AUTHORITY_INVALID`, and the CA is already minted for ten years and reissued only by necessity.
- **Never commit it, and never disable the ignore.** `git add -f temp/` would publish a CA private key.
- **Never copy the directory between hosts, into images, into CI or into a backup.** A transplanted key is
  the one way this development convenience becomes a real exposure; a deterministic mint is always cheaper.
- **Make test harnesses use a scratch root.** `resolveDevCertificate(repoRoot)` takes the root as a
  parameter precisely so a race or rotation test can be pointed at `temp/agent/<name>` and leave the
  developer's trusted anchor untouched. A harness pointed at the repository root rotates the CA.
- **Expect the private keys to be `0600` where the platform has modes**, best-effort on Windows. They are
  development-only and must never be presented as an authentication mechanism anywhere else.

## The deployment edge is a different story

The CA above signs nothing outside a checkout. Products are served by the edge, which owns its own
certificate and its own mode (ADR-BE-39):

| Mode       | Selected by                      | Behaviour                                                                                                                                         |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internal` | `SEAMNEX_EDGE_TLS_MODE=internal` | the edge terminates with its own default certificate on `127.0.0.1:8443` — in the development stack the leaf from `temp/certs`; the stack default |
| `acme`     | `SEAMNEX_EDGE_TLS_MODE=acme`     | Traefik obtains a certificate for the public name through `SEAMNEX_TRAEFIK_ACME_EMAIL`; needs public DNS and published 80/443                     |

`instance_route.tls_mode` records the mode the route runs in, and the console reports it per instance. A
development install has no public DNS name to validate, which is why ACME is listed as a gap in
[`bootstrap.md`](bootstrap.md#what-this-does-not-do) rather than configured by default.

### The development edge serves the same leaf

A product route carries `tls: {}` (`tlsMode: 'internal'`), which Traefik reads as "terminate here with
the default certificate". Left unset, that default is Traefik's own `CN=TRAEFIK DEFAULT CERT`: self-signed,
with a SAN of `*.traefik.default`. A browser then reports an untrusted issuer **and** a hostname mismatch
on the product URL, and scripted clients abort the handshake — the CA trusted for the dev servers was
never presented by the edge at all.

The development stack therefore points the edge at the leaf this page already describes:

| Piece        | Where                                                                        |
| ------------ | ---------------------------------------------------------------------------- |
| Declaration  | `docker/traefik/dynamic/tls.yml` — `tls.stores.default`                      |
| Certificate  | `temp/certs/dev.crt`, mounted read-only as `/certs/dev.crt`                  |
| Private key  | `temp/certs/dev.key`, mounted read-only as `/certs/dev.key`                  |
| Generated by | `packages/config/vite/dev-cert.ts`, run by `scripts/compose.mjs` before `up` |

The leaf carries `DNS:*.<SEAMNEX_INGRESS_DOMAIN>`, which the development value puts at
`*.seamnex.localhost`. **One wildcard, every slug, no re-mint per deployment** — but it has to be two
labels deep. No verifier matches a wildcard whose base has no dot, so `*.localhost` would leave every
product URL with `ERR_CERT_COMMON_NAME_INVALID`:

```text
# today's leaf, one label down: the shape that cannot work
openssl verify -CAfile temp\certs\dev-ca.crt -verify_hostname espocrm.localhost temp\certs\dev.crt
# CN=localhost
# error 62 at 0 depth lookup: hostname mismatch

# the shipped shape: a scratch CA with SAN DNS:*.seamnex.localhost
openssl verify -CAfile ca.crt -verify_hostname orangehrm.seamnex.localhost leaf.crt   # leaf.crt: OK
```

That is why `.env.example` defaults `SEAMNEX_INGRESS_DOMAIN` to `seamnex.localhost` rather than
`localhost`, and why the dev stack runs a DNS service next to the edge.

### Name resolution, which a certificate cannot fix

Browsers implement RFC 6761 themselves: Chrome, Edge and Firefox map **any** name ending in `.localhost`
to loopback, at any depth, with no configuration — so `https://orangehrm.seamnex.localhost:8443` opens in
a browser on a fresh machine. The operating system does not do this for subdomains (`dns.lookup` answers
`ENOTFOUND` for `orangehrm.localhost` and `orangehrm.seamnex.localhost` alike), which is what breaks Node,
`curl` and Playwright's API context.

`docker/dns` closes that gap without a hosts file:

| Piece        | Where                                                                |
| ------------ | -------------------------------------------------------------------- |
| Server       | `dns` service in `docker/compose.dev.yml`, CoreDNS pinned by tag     |
| Zone         | `docker/dns/Corefile`, rendered from `SEAMNEX_INGRESS_DOMAIN`        |
| Answer       | `<anything>.<zone>` → `127.0.0.1` (and `::1` for AAAA), nothing else |
| Host wiring  | `pnpm dev:dns:apply` — one Windows NRPT rule scoped to the zone      |
| Verification | `pnpm dev:dns` — service answer and OS answer, reported separately   |
| Removal      | `pnpm dev:dns:revert`                                                |

The rule is scoped to the one zone on purpose. Replacing the adapter's DNS servers would send every other
lookup into the container, whose `forward` line points back at the host — a loop. With an NRPT rule the
rest of the machine keeps its resolvers, and the rule is reversible by name. On macOS and Linux the CLI
prints the equivalent per-zone resolver entry instead of editing it.

Three consequences worth knowing:

- **A refusal is not fatal.** Without OpenSSL nothing is minted, `scripts/compose.mjs` prints the reason and
  the start continues; the edge then falls back to `CN=TRAEFIK DEFAULT CERT`, which is the old behaviour.
- **Browsers need nothing; scripts need the rule.** An unconfigured host still opens product URLs in a
  browser and fails them in `curl` — `pnpm dev:dns` says which of the two is missing.
- **A re-minted leaf needs a restart.** The file provider watches YAML in the dynamic directory, not the
  mounted pair, so `pnpm dev:stack restart traefik` applies a new leaf — the same restart
  [`bootstrap.md`](bootstrap.md) records for routes on Docker Desktop.

## References

- `packages/config/vite/dev-cert.ts` — generation, validation, locking, and the reasons in the banner.
- `packages/config/vite/app.ts` — where the pair is attached to `server.https` and `preview.https`, and
  where the HTTP fallback is announced.
- [`bootstrap.md`](bootstrap.md) — the install path that ends with trusting this CA.
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md), [`README.md`](../../README.md) — the one-line trust commands
  a developer meets first.
- [`CHANGELOG.md`](../../CHANGELOG.md) — the TLS additions under `## [Unreleased]`, including the
  generation race fixed in `packages/config/vite/dev-cert.ts`.
