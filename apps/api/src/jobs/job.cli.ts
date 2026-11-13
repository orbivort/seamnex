import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { JobService } from './job.service';
import { SYNTHETIC_STEPS } from './synthetic-job';

/**
 * Operator/developer entry point for the synthetic job (exit criterion 3).
 *
 * Deliberately a CLI rather than an operation: the platform has no "create a job" endpoint in the
 * contract, and Phase 1 must not invent one. `GET /api/v1/jobs/{id}/stream` consumes the result.
 *
 *   pnpm --filter @seamnex/api exec tsx src/jobs/job.cli.ts enqueue
 *   pnpm --filter @seamnex/api exec tsx src/jobs/job.cli.ts show <jobId>
 */
async function main(): Promise<number> {
  const command = process.argv[2] ?? 'enqueue';
  const app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: true,
    logger: ['error'],
  });
  const jobs = app.get(JobService);

  try {
    switch (command) {
      case 'enqueue': {
        const result = await jobs.create({
          kind: 'synthetic',
          steps: SYNTHETIC_STEPS,
          requestedBy: 'cli',
          payload: { synthetic: true, createdBy: 'job.cli' },
        });
        process.stdout.write(
          `${JSON.stringify({ jobId: result.job.id, created: result.created, lane: result.job.lane })}\n`,
        );
        return 0;
      }
      case 'show': {
        const jobId = process.argv[3];
        if (jobId === undefined) {
          process.stderr.write('show requires a job id\n');
          return 1;
        }
        const job = await jobs.get(jobId);
        const steps = await jobs.steps(jobId);
        const logs = await jobs.logs(jobId, '0', 100);
        process.stdout.write(`${JSON.stringify({ job, steps, logs }, null, 2)}\n`);
        return job.state === 'failed' ? 1 : 0;
      }
      default: {
        process.stderr.write(`Unknown command "${command}". Expected enqueue or show.\n`);
        return 1;
      }
    }
  } finally {
    await jobs.close();
    await app.close();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
