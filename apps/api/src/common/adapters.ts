import type { AppConfig } from '../config/config';
import { AppError } from './problem/app-error';

/**
 * ADR-BE-12: real adapters only, with one honest off switch.
 *
 * `SEAMNEX_ADAPTERS_MODE=disabled` exists so a developer machine without Docker, n8n or S3 can still boot
 * the API and work on the read surface. It must refuse the *operation* with a `503` naming the
 * dependency — not let a job start and fail halfway, and not silently simulate a deployment that the
 * operator then believes happened. No fake implementation is registered anywhere.
 */

export type AdapterId = 'docker' | 'traefik' | 'keycloak' | 'n8n' | 's3' | 'age';

const SETTING: Record<AdapterId, (config: AppConfig) => string | null> = {
  docker: (config) => (config.SEAMNEX_DOCKER_HOST.trim().length > 0 ? null : 'SEAMNEX_DOCKER_HOST'),
  traefik: (config) =>
    config.SEAMNEX_TRAEFIK_DYNAMIC_DIR.trim().length > 0 ? null : 'SEAMNEX_TRAEFIK_DYNAMIC_DIR',
  keycloak: (config) =>
    config.SEAMNEX_KEYCLOAK_ADMIN_URL.trim().length > 0 ? null : 'SEAMNEX_KEYCLOAK_ADMIN_URL',
  n8n: (config) => (config.SEAMNEX_N8N_API_KEY.trim().length > 0 ? null : 'SEAMNEX_N8N_API_KEY'),
  s3: (config) => (config.S3_BUCKET.trim().length > 0 ? null : 'S3_BUCKET'),
  age: (config) =>
    config.SEAMNEX_AGE_RECIPIENT.trim().length > 0 ? null : 'SEAMNEX_AGE_RECIPIENT',
};

const LABEL: Record<AdapterId, string> = {
  docker: 'the Docker Engine (socket proxy)',
  traefik: 'the Traefik dynamic configuration directory',
  keycloak: 'the Keycloak Admin API',
  n8n: 'the n8n REST API',
  s3: 'the S3-compatible backup target',
  age: 'the age backup recipient',
};

/** Throws `ADAPTER_UNAVAILABLE` unless every named adapter is enabled and configured. */
export function requireAdapters(config: AppConfig, ...ids: readonly AdapterId[]): void {
  if (config.SEAMNEX_ADAPTERS_MODE === 'disabled') {
    throw new AppError({
      code: 'ADAPTER_UNAVAILABLE',
      detail: `SEAMNEX_ADAPTERS_MODE=disabled: ${ids.map((id) => LABEL[id]).join(', ')} cannot be used.`,
      remediation:
        'Set SEAMNEX_ADAPTERS_MODE=real on a host with the dependency, then retry. Nothing ran.',
    });
  }

  for (const id of ids) {
    const missing = SETTING[id](config);
    if (missing !== null) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `${LABEL[id]} is not configured (${missing} is empty).`,
        remediation: `Set ${missing}; the operation refused before changing anything.`,
      });
    }
  }
}

/** True when the adapter is usable, for a readiness probe or a capability listing. */
export function adapterAvailable(config: AppConfig, id: AdapterId): boolean {
  return config.SEAMNEX_ADAPTERS_MODE === 'real' && SETTING[id](config) === null;
}
