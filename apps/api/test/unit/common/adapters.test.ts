import { describe, expect, it } from 'vitest';
import { adapterAvailable, requireAdapters, type AdapterId } from '../../../src/common/adapters';
import type { AppConfig } from '../../../src/config/config';
import { AppError } from '../../../src/common/problem/app-error';

const CONFIGURED = {
  SEAMNEX_ADAPTERS_MODE: 'real',
  SEAMNEX_DOCKER_HOST: 'unix:///var/run/docker.sock',
  SEAMNEX_TRAEFIK_DYNAMIC_DIR: '/etc/traefik/dynamic',
  SEAMNEX_KEYCLOAK_ADMIN_URL: 'https://keycloak.test',
  SEAMNEX_N8N_API_KEY: 'n8n-key',
  S3_BUCKET: 'backups',
  SEAMNEX_AGE_RECIPIENT: 'age1example',
} satisfies Partial<AppConfig>;

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...CONFIGURED, ...overrides } as unknown as AppConfig;
}

function caught(run: () => void): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the adapter gate to refuse');
}

describe('requireAdapters', () => {
  it('passes when every named adapter is enabled and configured', () => {
    expect(() => requireAdapters(config(), 'docker', 'traefik', 's3')).not.toThrow();
  });

  it('refuses the operation when adapters are disabled, naming each dependency', () => {
    const error = caught(() =>
      requireAdapters(config({ SEAMNEX_ADAPTERS_MODE: 'disabled' }), 'docker', 'n8n'),
    );
    expect(error.code).toBe('ADAPTER_UNAVAILABLE');
    expect(error.detail).toContain('SEAMNEX_ADAPTERS_MODE=disabled');
    expect(error.detail).toContain('the Docker Engine');
    expect(error.detail).toContain('the n8n REST API');
    expect(error.remediation).toContain('Set SEAMNEX_ADAPTERS_MODE=real');
  });

  it.each<[AdapterId, string, Partial<AppConfig>]>([
    ['docker', 'SEAMNEX_DOCKER_HOST', { SEAMNEX_DOCKER_HOST: '   ' }],
    ['traefik', 'SEAMNEX_TRAEFIK_DYNAMIC_DIR', { SEAMNEX_TRAEFIK_DYNAMIC_DIR: '' }],
    ['keycloak', 'SEAMNEX_KEYCLOAK_ADMIN_URL', { SEAMNEX_KEYCLOAK_ADMIN_URL: '' }],
    ['n8n', 'SEAMNEX_N8N_API_KEY', { SEAMNEX_N8N_API_KEY: '' }],
    ['s3', 'S3_BUCKET', { S3_BUCKET: '' }],
    ['age', 'SEAMNEX_AGE_RECIPIENT', { SEAMNEX_AGE_RECIPIENT: '' }],
  ])('refuses when the %s adapter is missing its %s setting', (id, setting, override) => {
    const error = caught(() => requireAdapters(config(override), id));
    expect(error.code).toBe('ADAPTER_UNAVAILABLE');
    expect(error.detail).toContain(setting);
    expect(error.remediation).toContain(setting);
  });

  it('reports the first unconfigured adapter when several are named', () => {
    const error = caught(() =>
      requireAdapters(config({ S3_BUCKET: '', SEAMNEX_AGE_RECIPIENT: '' }), 's3', 'age'),
    );
    expect(error.detail).toContain('S3_BUCKET');
    expect(error.detail).not.toContain('SEAMNEX_AGE_RECIPIENT');
  });

  it('does not refuse when no adapter is named', () => {
    expect(() => requireAdapters(config({ S3_BUCKET: '' }))).not.toThrow();
  });
});

describe('adapterAvailable', () => {
  it('is true only in real mode with the setting present', () => {
    expect(adapterAvailable(config(), 'docker')).toBe(true);
    expect(adapterAvailable(config({ SEAMNEX_ADAPTERS_MODE: 'disabled' }), 'docker')).toBe(false);
    expect(adapterAvailable(config({ SEAMNEX_DOCKER_HOST: '' }), 'docker')).toBe(false);
  });

  it('is true for every configured adapter in real mode', () => {
    for (const id of ['docker', 'traefik', 'keycloak', 'n8n', 's3', 'age'] as const) {
      expect(adapterAvailable(config(), id)).toBe(true);
    }
  });
});
