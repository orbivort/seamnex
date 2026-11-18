# Licences of the image this tree builds

This file travels **inside** the image (`/usr/share/doc/seamnex/orangehrm-licences.md`) and is named by
its `org.opencontainers.image.licenses` label. It exists because a container image is a distribution:
whoever pulls it receives three different bodies of code under three different sets of terms, and a
label that names only one of them is a claim the recipient cannot check.

It is an inventory, not legal advice, and it is deliberately explicit about the one thing this tree has
not verified.

| Layer | What it is | Terms | Status |
|---|---|---|---|
| Platform additions | `seamnex-bootstrap.sh`, `seamnex-install-once.php`, the Apache `X-Forwarded-Proto` rule, this file | GPL-3.0-only (this repository's licence, `ADR-BE-19`) | Known |
| Base image | `php:8.3-apache-bookworm` — PHP, Apache HTTP Server, Debian packages | PHP-3.01, Apache-2.0, and the mixed (predominantly MIT/BSD/LGPL) set of Debian | Known, inherited |
| OrangeHRM 5.9 | `orangehrm-5.9.zip` from SourceForge, MD5-verified at build time | The release archive's own `LICENSE`, **not reproduced here** | **Unverified — see below** |

## The unverified part, stated plainly

The catalogue entry records `licenseId: "GPL-3.0"`. Nothing in this tree proves that: the archive is
fetched during the build, so the licence text arrives inside the image and nobody has read it into the
repository. Two things must be confirmed against the artefact before this image is redistributed or
offered as a service:

1. **The identifier and the version.** `GPL-3.0` and `GPL-3.0-only` are not interchangeable here. The
   platform itself is pinned at `GPL-3.0-only` (`scripts/check-license.mjs`), and a `GPL-2.0-only`
   product **may not be combined** with it (`THIRD-PARTY-NOTICES.md` §7) — it could only reach the
   platform across a network boundary as a separately deployed product. If OrangeHRM 5.9 turns out to
   be GPL-2.0-only, this image as built is not conveyable, and the render set has to separate the
   platform-authored installer from the product rather than ship them in one layer stack.
2. **The bundled component inventory.** The application carries a `vendor/` tree. Read
   `license/`, `composer.json` and `vendor/composer/installed.json` inside the built image and add a
   row per licence family that carries an obligation (LGPL and anything source-available especially).

The label uses the SPDX custom-reference form `LicenseRef-OrangeHRM-Upstream` for exactly this reason:
the image's own terms are `GPL-3.0-only`, and the product's are a reference to a licence this tree has
not yet read. Replace it with the real identifier in the same commit that records the review.

## Obligations that follow either way

- **Source.** GPL-3.0 §6 applies to the object code in this image, including the platform additions.
  Whoever conveys the image (a `docker save`, an exported appliance, a copy of the host's image store)
  must accompany it with the corresponding source or a written offer. Building it on the operator's own
  host and running it there is not conveying — and this image is never pushed to a registry: it is
  built by the deployment, in the platform's namespace, and `pull_policy: never` keeps it there. The
  export path is therefore the only place the obligation can arise, which is why `docker save` on an
  appliance export is a licensing step as well as a backup one.
- **Notices.** The copyright notices and licence texts of every component above travel with the image
  and are not to be stripped from downstream copies.
- **Modification.** This tree adds files; it does not patch the product. Keep it that way. A patched
  PHP file makes the image a modified version under GPL-3.0 §5, which obliges the distributor to state
  the change and date it — and invalidates the "unmodified upstream archive" claim the Dockerfile
  makes when it verifies the MD5.
- **Registration.** The installer can register the instance with OrangeHRM's service. Consent is the
  operator's, so `ORANGEHRM_REGISTRATION_CONSENT` defaults to `false` and the platform never enables
  it on their behalf. The installer's own licence agreement is treated the same way:
  `ORANGEHRM_INSTALLER_LICENSE_AGREED` defaults to `false` and the install refuses until an operator
  sets it.
