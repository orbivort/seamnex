import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { EXECUTOR_SERVICE, type ExecutorService } from '../m05-executor/executor.contract';
import { PostgresStatusHealthService } from './status-health.service';

/**
 * 4B.1 — the 30 s cycle, owned by the `status-sampler` role.
 *
 * A tick that overlaps the previous one is skipped rather than queued: a slow daemon must not build a
 * backlog of samples that describe the past. The interval is configurable so a test or a small
 * deployment can slow it down without a code change.
 *
 * The same cycle records the capacity sample. That is not a convenience: `capacity_snapshot` had no
 * writer at all, so the board and the wizard's admission step reported `404` on any host where
 * nobody had inserted a row by hand. The cadence is throttled separately
 * (`SEAMNEX_CAPACITY_SAMPLE_INTERVAL_MS`) because a capacity sample is a small time series, not a
 * per-instance probe.
 */
@Injectable()
export class SamplerService implements OnApplicationShutdown {
  private readonly logger = new Logger('m06-sampler');
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastCapacitySampleAt = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PostgresStatusHealthService) private readonly status: PostgresStatusHealthService,
    // M06 may call M05 and not M19 (module-boundaries.json), so the capacity sample is recorded
    // through the executor's contract rather than by reaching across the boundary.
    @Inject(EXECUTOR_SERVICE) private readonly executor: ExecutorService,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.config.SEAMNEX_SAMPLE_INTERVAL_MS);
    this.logger.log(`status sampler started (every ${this.config.SEAMNEX_SAMPLE_INTERVAL_MS} ms)`);
    void this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  onApplicationShutdown(): void {
    this.stop();
  }

  /** Exposed for a one-shot sample from the CLI and for the tests. */
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('previous sample still running; skipping this tick');
      return;
    }
    this.running = true;
    try {
      const summary = await this.status.sample();
      this.logger.debug(
        `sampled ${summary.instances} instance(s): ${summary.ready} ready, ${summary.degraded} degraded`,
      );
      await this.sampleCapacity();
    } catch (error) {
      this.logger.error(
        `sample cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * A capacity sample fails the cycle only by logging: a host that cannot be measured must not stop
   * the status sampler, which is what makes an instance's readiness observable at all.
   */
  private async sampleCapacity(): Promise<void> {
    if (Date.now() - this.lastCapacitySampleAt < this.config.SEAMNEX_CAPACITY_SAMPLE_INTERVAL_MS)
      return;
    this.lastCapacitySampleAt = Date.now();
    try {
      await this.executor.recordCapacitySample();
      this.logger.debug('capacity sampled');
    } catch (error) {
      this.logger.warn(
        `capacity sample failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
