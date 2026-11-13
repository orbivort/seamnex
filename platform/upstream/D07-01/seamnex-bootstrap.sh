#!/bin/sh
#
# Container entrypoint for the OrangeHRM render set: install once, then run Apache.
#
# The upstream image ships the product **uninstalled** — `/` answers with the web installer and
# nothing creates the schema until an operator walks through it in a browser. A platform that reports
# "ready" on an installer page has deployed nothing an employee can use, and the catalog entry
# already declares every value the installer needs, so the install runs here instead.
#
# Three properties this script keeps:
#   1. **Idempotent.** `lib/confs/Conf.php` is the marker OrangeHRM itself uses (`Config::isInstalled`)
#      and it lives on the mounted `orangehrm-conf` volume, so a restart never reinstalls and never
#      touches a schema that already exists.
#   2. **Bounded.** The database is a sibling container; the wait is capped (inside the installer, with
#      a logged reason) so a broken database fails the deployment instead of hanging it.
#   3. **Survivable.** A failed install does *not* stop Apache. The operator still gets the product's
#      own web installer on the route, with the reason in the container log, rather than an instance
#      that reports ready with nothing behind it.
#
# The install itself is `seamnex-install-once.php`: the config it writes is YAML, and quoting operator
# values for YAML belongs in a language that can do it correctly rather than in shell string surgery.
set -eu

APP_DIR=/var/www/html
CONF_FILE="$APP_DIR/lib/confs/Conf.php"

log() { printf '[orangehrm-bootstrap] %s\n' "$*"; }

# The configuration directory is a named volume: on a fresh instance Docker creates it owned by root,
# while the application runs as www-data and must be able to write `Conf.php` into it.
chown -R www-data:www-data "$APP_DIR/lib/confs" 2>/dev/null || true

# The install runs as root because it writes `installer/cli_install_config.yaml` — a directory the
# application must not be able to modify at runtime — and the script hands the four writable
# directories back to www-data when it is done.
if [ -f "$CONF_FILE" ]; then
  log 'already installed; starting Apache'
elif php /usr/local/bin/seamnex-install-once.php; then
  log 'installation finished; starting Apache'
else
  log 'installation did not complete; Apache starts anyway so the web installer is reachable'
fi

exec docker-php-entrypoint apache2-foreground
