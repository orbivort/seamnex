import { runRoleFromEnvironment } from '../bootstrap/run-role';

/**
 * `pnpm start:role` — one binary that starts whatever `SEAMNEX_ROLE` names, which is what the container
 * uses. The nine `main-*.ts` entrypoints are the same call with the role fixed, so a supervisor can
 * point at either form.
 *
 * The role is resolved *inside* the lifecycle: reading it with `loadConfig()` here would parse the
 * environment before the guard that turns a bad one into a fatal log and exit code 1.
 */
void runRoleFromEnvironment();
