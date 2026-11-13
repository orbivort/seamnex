import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type Redis from 'ioredis';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';
import type { AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config.module';
import {
  IDENTITY_PROVIDER,
  type IdentityProvider,
} from '../common/identity/identity-provider.contract';

export type DependencyState = {
  readonly name: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail?: string;
};

export type ReadinessReport = {
  readonly ok: boolean;
  readonly role: string;
  readonly checkedAt: string;
  readonly dependencies: readonly DependencyState[];
};

/**
 * The liveness body, which is also the only runtime answer to "which release is this?".
 *
 * The OpenAPI document is not this answer: it is committed and equals the served bytes, so it
 * carries the workspace copy of the last release instead (see `CONTRACT_DOCUMENT_VERSION`). Here
 * the values come from the image build, which is the deployment that actually exists.
 */
export type LivenessReport = {
  readonly status: 'ok';
  readonly role: string;
  readonly uptimeSeconds: number;
  /** The release tag this build was cut from, or `0.0.0` for a checkout that was never packaged. */
  readonly version: string;
  /** The commit inside that image, or `unknown` when the build supplied none. */
  readonly revision: string;
};

const CACHE_TTL_MS = 1_000;

/**
 * Readiness is cached for one second: a Kubernetes probe or a Traefik health check at 1 Hz per
 * replica must not turn into a database load test.
 */
@Injectable()
export class HealthService {
  private cached: { report: ReadinessReport; at: number } | undefined;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
  ) {}

  liveness(): LivenessReport {
    return {
      status: 'ok',
      role: this.config.SEAMNEX_ROLE,
      uptimeSeconds: Math.round(process.uptime()),
      version: this.config.SEAMNEX_BUILD_VERSION,
      revision: this.config.SEAMNEX_BUILD_REVISION,
    };
  }

  async readiness(force = false): Promise<ReadinessReport> {
    const now = Date.now();
    if (!force && this.cached !== undefined && now - this.cached.at < CACHE_TTL_MS) {
      return this.cached.report;
    }

    const [database, redis, idp] = await Promise.all([
      this.probeDatabase(),
      this.probeRedis(),
      this.probeIdentityProvider(),
    ]);
    /*
     * `idp` is reported but not required. The identity provider is only consulted when a sign-in
     * starts, so an outage must not pull the whole replica out of rotation and sign out everyone
     * who already holds a session — that turns a partial failure into a total one. It is `false`
     * here, and the sign-in path answers `503` on its own.
     */
    const report: ReadinessReport = {
      ok: database.ok && redis.ok,
      role: this.config.SEAMNEX_ROLE,
      checkedAt: new Date().toISOString(),
      dependencies: [database, redis, idp],
    };

    this.cached = { report, at: now };
    return report;
  }

  private async probeDatabase(): Promise<DependencyState> {
    const startedAt = process.hrtime.bigint();
    try {
      await this.pool.query('SELECT 1');
      return { name: 'postgres', ok: true, latencyMs: elapsedMs(startedAt) };
    } catch (error) {
      return {
        name: 'postgres',
        ok: false,
        latencyMs: elapsedMs(startedAt),
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Resolving the provider's browser configuration is the cheapest honest probe: for `oidc` it
   * reads (or re-reads) the discovery document, which is the first call a sign-in makes; for the
   * stub it is a constant, reported as such rather than as a healthy dependency it never contacts.
   */
  private async probeIdentityProvider(): Promise<DependencyState> {
    const startedAt = process.hrtime.bigint();
    try {
      const auth = await this.provider.authConfig();
      if (auth.provider === 'stub') {
        return {
          name: 'idp',
          ok: true,
          latencyMs: elapsedMs(startedAt),
          detail: 'stub provider (no network)',
        };
      }
      return { name: 'idp', ok: true, latencyMs: elapsedMs(startedAt) };
    } catch (error) {
      return {
        name: 'idp',
        ok: false,
        latencyMs: elapsedMs(startedAt),
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async probeRedis(): Promise<DependencyState> {
    const startedAt = process.hrtime.bigint();
    try {
      await this.redis.ping();
      return { name: 'redis', ok: true, latencyMs: elapsedMs(startedAt) };
    } catch (error) {
      return {
        name: 'redis',
        ok: false,
        latencyMs: elapsedMs(startedAt),
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function elapsedMs(startedAt: bigint): number {
  return Math.round((Number(process.hrtime.bigint() - startedAt) / 1_000_000) * 100) / 100;
}
