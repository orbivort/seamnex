# Security policy

**Applies to:** this repository — `apps/api`, `apps/portal`, `apps/console` and `packages/*` ·
**Owner:** platform maintainers and the security reviewer · **Last reviewed:** 2026-11-06 ·
**Version:** 1.0

Report vulnerabilities privately. This document covers the channel, what a report should contain, what
we commit to, and what is in scope.

## Reporting a vulnerability

**Never report a vulnerability in a public issue, pull request, discussion or social post.** A public
report exposes every self-hosted deployment before a fix exists.

| Channel                          | How                                                                                                                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Private advisory** (preferred) | Repository **Security** tab → **Advisories** → **Report a vulnerability**. Only you and the maintainers can read the report, and it stays private until an advisory is published.  |
| **Encrypted follow-up**          | Say in the advisory thread that you need encryption, **without technical details**; we reply with a key and its fingerprint. Do not send a proof of concept unencrypted by choice. |

The advisory form is the only private channel: the project has no dedicated security mailbox, and a
report sent to an address printed elsewhere may never reach a maintainer. If the form is unavailable
to you, open an issue that says only that you need a private security contact — no component, no
technique, no payload — and a maintainer will open a private channel. The channel is not a support
address, and no reply within the acknowledgement window means the report is waiting, not declined.

Never include production secrets, customer or personal data, or live credentials. Reproduce against a
test instance with test identities, and redact logs and screenshots.

### What a report should include

- **Summary** — the weakness in one or two sentences, with the affected component named (`apps/api`,
  `apps/portal`, a `packages/*` library, a deployment asset).
- **Affected version** — commit SHA, tag or branch, plus the facts that change the answer:
  `VITE_API_MODE` (`live` or `mock`), deployment topology, identity provider in use, and whether the
  instance is reachable from an untrusted network.
- **Reproduction** — the shortest reliable sequence, with prerequisites (role, entitlement, tenant,
  feature flag, configuration) and the exact request or UI path.
- **Proof of concept** — a script, HTTP transcript or screenshots, minimised to prove impact. Do not
  use it to read, modify or delete data you do not own.
- **Impact** — the trust boundary crossed, the subjects or tenants affected, whether confidentiality,
  integrity or availability is at stake, and what the attack requires (authentication, a role, user
  interaction, network position).
- **Your assessment** — severity, CVSS vector, related CWEs or a suggested fix, if you have one.
- **Disclosure and credit** — whether you plan to publish and when, and the name or handle to credit,
  or a request for anonymity.
- **Contact** — a safe way to reach you, with a time zone where coordination needs it.

A partial report is better than none. If you are unsure whether something is in scope, report it and
let us triage rather than spend time proving full exploitability.

## What you can expect

| Stage                                   | Target                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| Acknowledgement of the report           | Within **2 business days**                                                                    |
| Triage: confirmation, scope, severity   | Within **5 business days** of acknowledgement                                                 |
| Status updates while the report is open | At least every **10 business days**, or immediately on a material change                      |
| Fix — Critical                          | **7 days** from triage                                                                        |
| Fix — High                              | **30 days** from triage                                                                       |
| Fix — Medium                            | **90 days** from triage                                                                       |
| Fix — Low                               | Next scheduled release                                                                        |
| Coordinated disclosure                  | **90 days** from acknowledgement, or **30 days** after a fixed release ships, whichever first |

We tell you our severity assessment and the reasoning behind it, including when we disagree that
something is a vulnerability. If a target cannot be met we give a revised date before the deadline
passes rather than let it slip silently.

**Disclosure.** An advisory is published once a fix is available: affected versions, impact,
workarounds, and credit unless you asked for anonymity. Tell us at report time if you intend to
disclose earlier or if the vulnerability is already exploited in the wild, so we can plan the fix and
the advisory, and shorten the timeline.

**Confidentiality.** Reports stay private and are shared only with those who need them to triage and
fix. Your identity and the report content are not published without consent, except where a legal
obligation requires disclosure.

### Safe harbour

We will not pursue or support legal action against researchers who act in good faith under this
policy: test only your own or an authorised instance, use the minimum access needed to demonstrate the
issue, do not exfiltrate or retain data that is not yours, do not degrade service for other users, do
not use social engineering or physical intrusion, and give us the agreed time to fix before
publishing. If in doubt about a specific test, ask first. This safe harbour covers this project's
code; it grants no rights over third-party systems or data.

## Scope

### Supported versions

This repository is a **pre-1.0** with a single supported line: no long-term
support branches, no backports.

| Version or track                     | Supported                 | Notes                                                       |
| ------------------------------------ | ------------------------- | ----------------------------------------------------------- |
| `main` (latest commit)               | Yes — full                | Fixes land here first.                                      |
| Latest tagged `0.1.x` pre-release    | Yes — security fixes only | A fix ships as a new patch tag; older tags are not patched. |
| Earlier tags, forks, vendored copies | No                        | Re-test against `main` or the latest tag before reporting.  |

Supported runtimes are the pinned ones — Node.js 24 LTS (`engines.node`), PostgreSQL 18, Redis 7. A
defect that reproduces only outside those majors is an upgrade question, not a vulnerability.

### In scope

- **`apps/api` — control plane:** authentication and session handling (cookie, CSRF, forward-auth,
  step-up), the policy decision point and route policy, tenant and entitlement boundaries, Docker
  execution and container lifecycle, backup and restore, workflow execution, governance and
  break-glass, audit and error surfaces.
- **`apps/portal`, `apps/console`:** XSS and injection, unsafe rendering of server-supplied data,
  client-side authorisation that trusts a client-provided role or hint, credential or token leakage,
  CSRF in `live` mode.
- **`packages/api-client`:** transport, CSRF handling, error and `401` surfacing.
- **`packages/db`:** migrations, seeds and SQL construction.
- **`packages/domain`:** the capability matrix and authorisation model.
- **`packages/shell`, `packages/ui`, `packages/utils`, `packages/config`:** shared shell, components,
  utilities and build/lint configuration that ships to production.
- **Deployment assets owned by this project:** `docker/`, `platform/` (except vendored upstream
  fixtures), `scripts/`, and the documented configuration defaults (proxy trust, cookies, key
  handling).

A vulnerability that only appears with a specific optional component enabled is still in scope — name
the component.

### Out of scope

- **The mock platform.** `VITE_API_MODE=mock` (`packages/mocks`, MSW handlers, fixtures) and
  `pnpm build:demo` are an in-browser simulation with no real authentication, data or network
  boundary; a finding there describes the fixture. Demo builds that deliberately bundle the mock
  worker are the same case.
- **Documented prototype gaps.** Authentication and session UI are not built (EX-1) and workflow
  authoring is display-only (EX-2). A missing sign-in screen is a known scope decision; a way to bypass
  the session boundary that does exist is not.
- **Accepted risks.** The platform holds no password by design and delegates credential policy to the
  identity provider, and the development stub's PKCE exchange is self-certified. Both are recorded as
  accepted risk in ADR-BE-13; a report that restates them without a new attack path is closed as
  accepted risk.
- **Development affordances reachable only in a development stack.** The identity shim, the
  `dev-admin` / `123456` seed, the `stub:` identity provider, the development root key in
  `temp/seamnex-root-key`, Mailpit and the published dev ports are documented conveniences. They are
  in scope only when an instance presented as production exposes them — report that as "development
  affordance exposed in a production configuration", and we treat it as a packaging or documentation
  defect.
- **Operator-side deployment decisions.** TLS termination, network exposure, host hardening,
  identity-provider policy, secret storage, and disabling the documented safeguards on a self-hosted
  instance are the operator's responsibility. Misconfiguration is not a vulnerability in this project
  unless our own defaults, templates or documentation caused it.
- **Third-party software.** Vulnerabilities in upstream products (`platform/upstream/*`, Keycloak,
  PostgreSQL, Redis, Traefik, n8n, the S3 target) belong upstream; we will relay a report but cannot
  patch them. Dependency advisories are tracked by Renovate, and a CVE in a direct dependency with no
  reachable path through this code is maintenance, not a security report. Licence matters are covered
  by [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
- **Reports without a demonstrated security impact.** Scanner output with no proof of concept or
  attack path; missing hardening headers on their own; best-practice, style or information-only
  observations; self-XSS; issues that require an already-compromised browser, host or dependency
  install; and behaviour on browsers or runtimes the project does not support.
- **Volume denial of service, spam, social engineering, physical access, and credentials in public
  commit history that were never valid.** Tell us anyway if a secret looks live — we will rotate it,
  but it is handled as an incident, not a vulnerability report.

A real weakness that falls outside this list is still welcome; we would rather triage and decline than
miss something.

## Changes to this policy

The version and review date at the top identify the current text; the file history is the
authoritative record of what changed. The policy may be updated at any time, is reviewed at least once
every 12 months, and before each release that changes the authentication, authorisation or deployment
surface. Reports are handled under the policy in force when they are received; a later revision that
improves our commitments applies to open reports, and no revision retroactively weakens the handling
of a report already under way. Where this policy conflicts with applicable law or a contractual
obligation, those prevail.
