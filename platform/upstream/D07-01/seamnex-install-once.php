<?php

/**
 * First-boot install for OrangeHRM, driven from the environment the catalog declares.
 *
 * Kept in PHP rather than in the shell for one reason: the installer config is YAML, and every value
 * in it (names, e-mail addresses, passwords) comes from an operator. `json_encode` produces a
 * correctly quoted YAML scalar — YAML 1.2 is a JSON superset — so a password containing a colon, a
 * quote or a backslash cannot corrupt the document or the install that follows it.
 *
 * Idempotence lives in `lib/confs/Conf.php`, the marker OrangeHRM itself uses (`Config::isInstalled`),
 * on the mounted `orangehrm-conf` volume: a restart never reinstalls, never touches an existing
 * schema, and never re-prompts for anything.
 */

declare(strict_types=1);

const APP_DIR = '/var/www/html';
const CONF_FILE = APP_DIR . '/lib/confs/Conf.php';
const INSTALLER_CONFIG = APP_DIR . '/installer/cli_install_config.yaml';

function logLine(string $message): void
{
    fwrite(STDOUT, '[orangehrm-install] ' . $message . PHP_EOL);
}

/** A YAML scalar, JSON-quoted: valid YAML for any string, including quotes and newlines. */
function scalar(string $value): string
{
    return (string) json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function env(string $name, ?string $fallback = null): string
{
    $value = getenv($name);
    if ($value === false || trim($value) === '') {
        return $fallback ?? '';
    }
    return $value;
}

if (is_file(CONF_FILE)) {
    logLine('already installed (' . CONF_FILE . ' exists); skipping');
    exit(0);
}

/**
 * Wait for the database, bounded.
 *
 * The database is a sibling container: on a cold start the application can be up before MariaDB has
 * initialised, and the installer would then fail on a connection error that looks like a
 * configuration mistake. Two minutes is generous for a first initialisation and short enough that a
 * genuinely broken database surfaces as a failed deployment instead of a hung one.
 */
function waitForDatabase(int $attempts = 60, int $delaySeconds = 2): bool
{
    $host = env('ORANGEHRM_DATABASE_HOST', 'orangehrm-db');
    $port = env('ORANGEHRM_DATABASE_PORT', '3306');
    $user = env('ORANGEHRM_DATABASE_ROOT_USER', 'root');
    $password = env('ORANGEHRM_DATABASE_ROOT_PASSWORD');
    $lastError = '';

    for ($attempt = 1; $attempt <= $attempts; $attempt++) {
        try {
            new PDO(
                sprintf('mysql:host=%s;port=%s', $host, $port),
                $user,
                $password,
                [PDO::ATTR_TIMEOUT => 3, PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION],
            );
            logLine(sprintf('database %s:%s accepted a connection (attempt %d)', $host, $port, $attempt));
            return true;
        } catch (Throwable $error) {
            $lastError = $error->getMessage();
            sleep($delaySeconds);
        }
    }

    logLine(sprintf('database %s:%s did not answer within %ds: %s', $host, $port, $attempts * $delaySeconds, $lastError));
    return false;
}

$required = [
    'ORANGEHRM_DATABASE_ROOT_PASSWORD' => env('ORANGEHRM_DATABASE_ROOT_PASSWORD'),
    'ORANGEHRM_DATABASE_PASSWORD' => env('ORANGEHRM_DATABASE_PASSWORD'),
    'ORANGEHRM_ADMIN_PASSWORD' => env('ORANGEHRM_ADMIN_PASSWORD'),
];
$missing = array_keys(array_filter($required, static fn (string $value): bool => $value === ''));
if ($missing !== []) {
    logLine('cannot install, these variables are empty: ' . implode(', ', $missing));
    exit(1);
}

if (!waitForDatabase()) {
    exit(1);
}

$yaml = "database:\n"
    . '  hostName: ' . scalar(env('ORANGEHRM_DATABASE_HOST', 'orangehrm-db')) . "\n"
    . '  hostPort: ' . scalar(env('ORANGEHRM_DATABASE_PORT', '3306')) . "\n"
    . '  databaseName: ' . scalar(env('ORANGEHRM_DATABASE_NAME', 'orangehrm')) . "\n"
    . '  privilegedDatabaseUser: ' . scalar(env('ORANGEHRM_DATABASE_ROOT_USER', 'root')) . "\n"
    . '  privilegedDatabasePassword: ' . scalar($required['ORANGEHRM_DATABASE_ROOT_PASSWORD']) . "\n"
    // Two accounts on purpose: the application must not run as the account allowed to create
    // databases and grant privileges. `createDBUser()` creates this second account for one schema.
    . "  useSameDbUserForOrangeHRM: n\n"
    . '  orangehrmDatabaseUser: ' . scalar(env('ORANGEHRM_DATABASE_USER', 'orangehrm')) . "\n"
    . '  orangehrmDatabasePassword: ' . scalar($required['ORANGEHRM_DATABASE_PASSWORD']) . "\n"
    // The installer creates the schema itself and *refuses* a database that already exists, which is
    // why the compose file does not set MARIADB_DATABASE.
    . "  isExistingDatabase: n\n"
    // Declared by the catalog entry; when enabled the installer also writes the key file into
    // `lib/confs`, which the `orangehrm-conf` volume already covers.
    . '  enableDataEncryption: ' . (env('ORANGEHRM_DATA_ENCRYPTION', 'false') === 'true' ? 'y' : 'n') . "\n"
    . "\n"
    . "organization:\n"
    . '  name: ' . scalar(env('ORANGEHRM_ORGANIZATION_NAME', 'OrangeHRM')) . "\n"
    // ISO 3166-1 alpha-2: stored in `ohrm_organization_gen_info.country`, a two-character column.
    . '  country: ' . scalar(env('ORANGEHRM_ORGANIZATION_COUNTRY', 'DE')) . "\n"
    . "\n"
    . "admin:\n"
    . '  adminUserName: ' . scalar(env('ORANGEHRM_ADMIN_USERNAME', 'Admin')) . "\n"
    . '  adminPassword: ' . scalar($required['ORANGEHRM_ADMIN_PASSWORD']) . "\n"
    . '  adminEmployeeFirstName: ' . scalar(env('ORANGEHRM_ADMIN_FIRST_NAME', 'OrangeHRM')) . "\n"
    . '  adminEmployeeLastName: ' . scalar(env('ORANGEHRM_ADMIN_LAST_NAME', 'Admin')) . "\n"
    . '  workEmail: ' . scalar(env('ORANGEHRM_ADMIN_EMAIL', 'admin@example.com')) . "\n"
    . "  contactNumber: ~\n"
    // The installer posts this registration to OrangeHRM's service; consent is the operator's
    // decision and the platform does not assume it, so the value is read from the catalog entry.
    . '  registrationConsent: ' . (env('ORANGEHRM_REGISTRATION_CONSENT', 'false') === 'true' ? 'true' : 'false') . "\n"
    . "\n"
    . "license:\n"
    . "  agree: y\n";

if (@file_put_contents(INSTALLER_CONFIG, $yaml) === false) {
    logLine('cannot write ' . INSTALLER_CONFIG);
    exit(1);
}
@chmod(INSTALLER_CONFIG, 0640);
logLine('wrote the installer config from the environment');

chdir(APP_DIR);
$command = 'php installer/cli_install.php 2>&1';
logLine('running: ' . $command);
passthru($command, $status);

if (!is_file(CONF_FILE)) {
    /**
     * A failed install is not retryable in place: the installer creates the schema and the `orangehrm`
     * database user *before* it writes `Conf.php`, so a second attempt meets `CREATE DATABASE
     * "already exists"` (or `CREATE USER` on 1396) and would fail the same way on every restart. Say
     * which state the instance is in, so the operator resets the volume instead of retrying blindly.
     */
    $database = env('ORANGEHRM_DATABASE_NAME', 'orangehrm');
    try {
        $pdo = new PDO(
            sprintf('mysql:host=%s;port=%s', env('ORANGEHRM_DATABASE_HOST', 'orangehrm-db'), env('ORANGEHRM_DATABASE_PORT', '3306')),
            env('ORANGEHRM_DATABASE_ROOT_USER', 'root'),
            env('ORANGEHRM_DATABASE_ROOT_PASSWORD'),
            [PDO::ATTR_TIMEOUT => 3, PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION],
        );
        $exists = $pdo->query(
            'SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = ' . $pdo->quote($database),
        )->fetchColumn();
        if ((int) $exists > 0) {
            logLine(sprintf(
                'the schema `%s` already exists but %s does not: an earlier attempt was interrupted. '
                . 'The installer refuses an existing database, so reset the orangehrm-db volume '
                . '(delete the instance and deploy again) before retrying.',
                $database,
                CONF_FILE,
            ));
        }
    } catch (Throwable $error) {
        logLine('could not inspect the database state: ' . $error->getMessage());
    }
    logLine('the install did not produce ' . CONF_FILE . ' (exit ' . $status . ')');
    exit(1);
}

/**
 * Hand the application its own directories back.
 *
 * The install ran as root, and OrangeHRM's own image already treats `lib/confs`, `src/cache`,
 * `src/log` and `src/config` as the writable surface. Leaving them owned by root would give the
 * running application a read-only cache and log — an install that succeeds and then degrades.
 */
$writable = ['lib/confs', 'src/cache', 'src/log', 'src/config'];
foreach ($writable as $relative) {
    $path = APP_DIR . '/' . $relative;
    if (!is_dir($path)) {
        continue;
    }
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST,
    );
    @chown($path, 'www-data');
    @chgrp($path, 'www-data');
    foreach ($iterator as $item) {
        @chown($item->getPathname(), 'www-data');
        @chgrp($item->getPathname(), 'www-data');
    }
}

logLine('install complete; Conf.php written');
exit(0);
