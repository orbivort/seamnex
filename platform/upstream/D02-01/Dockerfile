# D02-01 Mautic 7.2.2 — a thin layer over the official image.
#
# The upstream image (`mautic/mautic:7.2.2-apache`) ships Mautic **uninstalled**: its entrypoint
# validates the environment, waits for MySQL, then starts Apache. Nothing creates the schema, so `/`
# answers with an error page until a human runs `mautic:install` in a shell. A platform that reports
# "ready" on that page has deployed nothing an employee can use, and the catalog entry already
# declares every value the installer needs.
#
# The only change is the entrypoint: `seamnex-bootstrap.sh` installs once, then delegates to the image's
# own `/entrypoint.sh`, so the volume checks, migrations, role dispatch and Apache startup remain
# upstream's code rather than a copy of it.
#
# Pinned by tag (the compose file also carries the image name); the catalog entry records the digest
# of the built image. Build with:  docker build -t seamnex/mautic:7.2.2 platform/upstream/D02-01
FROM mautic/mautic:7.2.2-apache

COPY seamnex-bootstrap.sh /usr/local/bin/seamnex-bootstrap.sh
RUN chmod 0755 /usr/local/bin/seamnex-bootstrap.sh

ENTRYPOINT ["/usr/local/bin/seamnex-bootstrap.sh"]
