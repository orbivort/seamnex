import { Controller, Get, Headers, Inject, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { problemFor } from '../common/problem/problem-catalog';
import { requestIdFor, sendProblem } from '../common/problem/send-problem';
import { AppError } from '../common/problem/app-error';
import { METRICS } from '../common/metrics/metrics';
import type { Metrics } from '../common/metrics/metrics';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import {
  OBSERVABILITY_SERVICE,
  type ObservabilityService,
} from '../modules/m21-observability/observability.contract';
import { HealthService, type LivenessReport } from './health.service';

/**
 * The only operations Phase 1 serves besides the contract document. They are anonymous by design
 * (ADR-BE-06) and are excluded from the OpenAPI document, which describes the product API.
 *
 * The failure bodies go through `sendProblem` like every other problem document: a probe that
 * answers `{ statusCode, error, message }` is a second error shape, and an operator reading two
 * different failure formats learns nothing from either.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(HealthService) private readonly health: HealthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(OBSERVABILITY_SERVICE) private readonly observability: ObservabilityService,
  ) {}

  @Get('healthz')
  liveness(): LivenessReport {
    return this.health.liveness();
  }

  @Get('readyz')
  async readiness(@Res() reply: FastifyReply): Promise<void> {
    const report = await this.health.readiness();
    this.metrics.dependencyUp
      .labels('postgres')
      .set(report.dependencies.find((d) => d.name === 'postgres')?.ok === true ? 1 : 0);
    this.metrics.dependencyUp
      .labels('redis')
      .set(report.dependencies.find((d) => d.name === 'redis')?.ok === true ? 1 : 0);

    if (!report.ok) {
      const failed = report.dependencies
        .filter((dependency) => !dependency.ok)
        .map((dependency) => dependency.name);
      sendProblem(reply, {
        problem: problemFor('UNAVAILABLE', {
          detail: `Not ready: ${failed.join(', ')} did not answer.`,
        }),
        requestId: requestIdFor(reply.request ?? {}),
      });
      return;
    }

    void reply.status(200).send(report);
  }

  @Get('metrics')
  async prometheus(@Res() reply: FastifyReply): Promise<void> {
    if (!this.config.SEAMNEX_METRICS_ENABLED) {
      sendProblem(reply, {
        problem: problemFor('NOT_FOUND', { detail: 'Metrics are disabled in this deployment.' }),
        requestId: requestIdFor(reply.request ?? {}),
      });
      return;
    }
    const body = await this.metrics.registry.metrics();
    void reply.status(200).header('content-type', this.metrics.registry.contentType).send(body);
  }

  /**
   * FR-2.6 / AC-45 — one instance's series, for the scrape target M21 published.
   *
   * Anonymous like `/metrics` because a scraper holds no session (ADR-BE-06). `SEAMNEX_METRICS_TOKEN`
   * is the escape hatch for a deployment that exposes the API beyond the scrape network: when it is
   * set, the request must carry it, and a request without it gets the same `404` as metrics being
   * disabled — a scraper learning "this path exists but you may not read it" is a smaller secret than
   * the numbers it protects.
   */
  @Get('metrics/instances/:id')
  async instanceMetrics(
    @Param('id') id: string,
    @Headers('authorization') authorization: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const token = this.config.SEAMNEX_METRICS_TOKEN;
    const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!this.config.SEAMNEX_METRICS_ENABLED || (token.length > 0 && supplied !== token)) {
      sendProblem(reply, {
        problem: problemFor('NOT_FOUND', { detail: 'Metrics are disabled in this deployment.' }),
        requestId: requestIdFor(reply.request ?? {}),
      });
      return;
    }

    let body: string;
    try {
      body = await this.observability.exposition(id);
    } catch (error) {
      // A path parameter that is not an instance is Prometheus' problem to see as a failed scrape,
      // not a `500`: rethrow anything that is not a deliberate not-found.
      if (error instanceof AppError && error.status === 404) {
        sendProblem(reply, {
          problem: problemFor('NOT_FOUND', { detail: error.detail }),
          requestId: requestIdFor(reply.request ?? {}),
        });
        return;
      }
      throw error;
    }
    void reply
      .status(200)
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(body);
  }
}
