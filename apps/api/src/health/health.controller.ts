import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { problemFor } from '../common/problem/problem-catalog';
import { requestIdFor, sendProblem } from '../common/problem/send-problem';
import { METRICS } from '../common/metrics/metrics';
import type { Metrics } from '../common/metrics/metrics';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
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
}
