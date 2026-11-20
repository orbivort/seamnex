#!/bin/bash
#
# Container entrypoint for the Mautic render set: install once, then run the image's own entrypoint.
#
# The upstream image ships the product **uninstalled**. Its entrypoint checks the environment, waits
# for MySQL, logs "Mautic is not installed, skipping migrations" and starts Apache — on a schema-less
# database. Only `bin/console mautic:install` creates the schema and the administrator account, and
# the catalog entry already declares every value it needs, so the install runs here instead of
# waiting for an operator to open a shell.
#
# Four properties this script keeps:
#   1. **Idempotent.** `config/local.php` (on the `mautic-config` volume) is the marker the image
#      itself uses, so a restart never reinstalls and never touches a schema that already exists.
#   2. **Bounded.** The database wait is the image's own (31 attempts) and the install runs under a
#      timeout, so a broken database fails the deployment instead of hanging it.
#   3. **Survivable.** A failed install does *not* stop Apache: the container log carries the reason
#      and the platform's readiness probe fails the deployment honestly, instead of an instance that
#      reports ready with nothing behind it.
#   4. **Upstream stays in charge.** All roles end in `exec /entrypoint.sh`, so volume ownership,
#      migrations, role dispatch and the web server are the image's code, not a reimplementation.
set -eu

log() { printf '[mautic-bootstrap] %s\n' "$*"; }

CONF_DIR="${MAUTIC_VOLUME_CONFIG:-/var/www/html/config}"
CONF_FILE="$CONF_DIR/local.php"
CONSOLE="${MAUTIC_CONSOLE:-/var/www/html/bin/console}"
WWW_USER="${MAUTIC_WWW_USER:-www-data}"
ROLE="${DOCKER_MAUTIC_ROLE:-}"
INSTALL_TIMEOUT="${MAUTIC_INSTALL_TIMEOUT_SECONDS:-900}"
WAIT_LIMIT="${MAUTIC_INSTALL_WAIT_SECONDS:-900}"

# The marker test is the image's own (`wait_for_mautic_install.sh`): a `local.php` with a db driver
# and a site URL means the installer finished, not merely that it started.
installed() {
  php -r "include('${CONF_FILE}'); exit(!empty(\$parameters['db_driver']) && !empty(\$parameters['site_url']) ? 0 : 1);" 2>/dev/null
}

wait_for_install() {
  local waited=0
  until installed; do
    if [ "$waited" -ge "$WAIT_LIMIT" ]; then
      log "${ROLE}: no installation appeared within ${WAIT_LIMIT}s; exiting so the failure is visible"
      return 1
    fi
    if [ $((waited % 30)) -eq 0 ]; then
      log "${ROLE}: waiting for the web container to finish installing (${waited}s)"
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

install_once() {
  log 'first start: no installation found, running mautic:install'
  # The installer must run as www-data: it writes `config/local.php`, `var/cache` and `var/logs`,
  # which the web server then needs to own. `printf %q` keeps a password with a quote or a space
  # from being re-parsed by `su -c`.
  local cmd
  cmd="$(printf '%q ' php "$CONSOLE" mautic:install "$MAUTIC_SITE_URL" \
    "--db_host=${MAUTIC_DB_HOST}" \
    "--db_port=${MAUTIC_DB_PORT:-3306}" \
    "--db_name=${MAUTIC_DB_NAME}" \
    "--db_user=${MAUTIC_DB_USER}" \
    "--db_password=${MAUTIC_DB_PASSWORD}" \
    "--db_table_prefix=${MAUTIC_DB_TABLE_PREFIX-}" \
    "--admin_username=${MAUTIC_ADMIN_USERNAME:-admin}" \
    "--admin_email=${MAUTIC_ADMIN_EMAIL}" \
    "--admin_password=${MAUTIC_ADMIN_PASSWORD}" \
    "--admin_firstname=${MAUTIC_ADMIN_FIRSTNAME:-Mautic}" \
    "--admin_lastname=${MAUTIC_ADMIN_LASTNAME:-Admin}" \
    --no-interaction --force)"

  if timeout "$INSTALL_TIMEOUT" su -s /bin/bash "$WWW_USER" -c "$cmd"; then
    if installed; then
      log 'installation finished; the image entrypoint now runs migrations and starts the server'
    else
      log 'the installer exited successfully but no local.php was written; check the log above'
    fi
  else
    log 'installation did not complete; Apache starts anyway so the reason stays in this log'
  fi
}

# The edge terminates TLS and forwards plain HTTP, so every absolute URL the product builds from the
# request — the post-login redirect is the one that bites — comes out as `http://<route>:<edge port>`.
# Nothing serves that scheme on that port: a correct password lands on the edge's 404 *after* a
# successful sign-in, which reads as a broken product rather than as a proxy that was never trusted.
#
# Two things had to be discovered rather than guessed, and both cost a deployment:
#   - `TrustMiddleware` reads `trusted_proxies` from `local.php`, not from the container parameter
#     the (`MAUTIC_`-prefixed) environment variable would populate, so setting the variable changes
#     nothing about the redirect;
#   - naming that variable `MAUTIC_TRUSTED_PROXIES` *breaks the product*: every `MAUTIC_*` name maps
#     to a configuration parameter, and this one is an array read with Symfony's `resolve:` processor,
#     so a comma list answered every request with `Invalid JSON in env var "resolve:…"` — a 500.
# The variable therefore carries our own prefix and the value is written beside the marker instead.
#
# Idempotent by construction: the file is compared before it is rewritten, so a restart that changes
# nothing writes nothing, and the atomic rename keeps a half-written `local.php` from being read by a
# request that arrives mid-update.
apply_trusted_proxies() {
  local list="${SEAMNEX_MAUTIC_TRUSTED_PROXIES:-}"
  [ -n "$list" ] || return 0
  [ -f "$CONF_FILE" ] || return 0
  if php -r '
      include $argv[1];
      $want = array_values(array_filter(array_map("trim", explode(",", $argv[2]))));
      $have = isset($parameters["trusted_proxies"]) ? (array) $parameters["trusted_proxies"] : [];
      exit($have === $want ? 0 : 1);
    ' "$CONF_FILE" "$list"; then
    return 0
  fi
  php -r '
      $file = $argv[1];
      include $file;
      $parameters["trusted_proxies"] = array_values(
        array_filter(array_map("trim", explode(",", $argv[2])))
      );
      $body = "<?php\n\$parameters = " . var_export($parameters, true) . ";\n";
      $tmp = $file . ".tmp";
      if (file_put_contents($tmp, $body, LOCK_EX) === false) { exit(1); }
      @chmod($tmp, 0644);
      @chown($tmp, "www-data");
      @chgrp($tmp, "www-data");
      if (!rename($tmp, $file)) { @unlink($tmp); exit(1); }
    ' "$CONF_FILE" "$list" || {
    log 'could not write trusted_proxies; product URLs keep the scheme the proxy forwards'
    return 0
  }
  log "trusted_proxies set to ${list}"
}

# The relay provisions a per-user account for every entitled person and signs in as it, so it needs
# the product's REST API. Mautic ships it **off**, and its server-to-server login is a second switch
# that is off independently: with only `api_enabled` set, every call answers `403 api_disabled`; with
# basic auth left off it answers `403` again with "Basic Auth disabled". Both were measured on this
# render set on 2026-11-20.
#
# The switches are written into `local.php` because that is where the product reads them — the same
# lesson as `trusted_proxies` above, where the `MAUTIC_*` environment variable populated a parameter
# nothing consulted. Our own prefix keeps `MAUTIC_*` from being mapped onto a parameter of the same
# name. Idempotent by comparison, like the trusted-proxy write.
apply_api_settings() {
  local want="${SEAMNEX_MAUTIC_API_ENABLED:-1}"
  [ -f "$CONF_FILE" ] || return 0
  case "$want" in
    0 | 1) ;;
    *)
      log "SEAMNEX_MAUTIC_API_ENABLED must be 0 or 1, not '${want}'; leaving the API as it is"
      return 0
      ;;
  esac
  if php -r '
      include $argv[1];
      exit(((int) ($parameters["api_enabled"] ?? 0) === (int) $argv[2]
        && (int) ($parameters["api_enable_basic_auth"] ?? 0) === (int) $argv[2]) ? 0 : 1);
    ' "$CONF_FILE" "$want"; then
    return 0
  fi
  php -r '
      $file = $argv[1];
      include $file;
      $parameters["api_enabled"] = (int) $argv[2];
      $parameters["api_enable_basic_auth"] = (int) $argv[2];
      $body = "<?php\n\$parameters = " . var_export($parameters, true) . ";\n";
      $tmp = $file . ".tmp";
      if (file_put_contents($tmp, $body, LOCK_EX) === false) { exit(1); }
      @chmod($tmp, 0644);
      @chown($tmp, "www-data");
      @chgrp($tmp, "www-data");
      if (!rename($tmp, $file)) { @unlink($tmp); exit(1); }
    ' "$CONF_FILE" "$want" || {
    log 'could not write the API switches; the relay cannot provision accounts'
    return 0
  }
  log "api_enabled and api_enable_basic_auth set to ${want}"
}

case "$ROLE" in
  mautic_web)
    # The same three checks the image runs, executed *before* the install because the install needs a
    # database that answers. They are idempotent, so the image runs them again without side effects.
    /startup/check_volumes_exist_ownership.sh
    /startup/check_environment_variables.sh
    /startup/check_database_connection.sh
    if installed; then
      log 'already installed; skipping the installer'
    else
      install_once
    fi
    apply_trusted_proxies
    apply_api_settings
    ;;
  mautic_cron | mautic_worker)
    # The image's `wait_for_mautic_install.sh` waits forever. Unbounded is the wrong default: a failed
    # install would leave a "running" container that never processes a campaign. Bounding it turns
    # that into a visible restart loop instead.
    wait_for_install
    ;;
esac

exec /entrypoint.sh "$@"
