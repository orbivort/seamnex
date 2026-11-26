import { Inject, Injectable } from '@nestjs/common';
import { operationKey } from '@seamnex/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OperationGroup } from '../operation-handlers';
import type { OperationHandler } from '../operation-handler';
import { JobService } from '../../jobs/job.service';
import { JobQueryService } from '../../jobs/job-query.service';
import { requireCollectionScope } from '../../common/policy/collection-scope';
import { JobStreamService } from '../../jobs/job-stream';
import {
  EXECUTOR_SERVICE,
  type ExecutorService,
} from '../../modules/m05-executor/executor.contract';
import { readIdempotencyKey } from '../../common/http/idempotency';
import { AppError } from '../../common/problem/app-error';
import { isUuid } from '../../common/http/uuid';

const key = (method: 'GET' | 'POST', path: string): string => operationKey({ method, path });

/** Deliverable 2.5 — list, detail, logs, stream, cancel and retry. */
@Injectable()
export class JobHandlers implements OperationGroup {
  readonly tag = 'jobs';

  constructor(
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(JobQueryService) private readonly query: JobQueryService,
    @Inject(JobStreamService) private readonly streams: JobStreamService,
    // A list read needs the instance ids its scope reaches (ADR-BE-44). The mapping lives in M05,
    // which owns the instance and catalog entry tables; this group only asks for the ids.
    @Inject(EXECUTOR_SERVICE) private readonly executor: ExecutorService,
  ) {}

  handlers(): ReadonlyMap<string, OperationHandler> {
    return new Map<string, OperationHandler>([
      [
        key('GET', '/jobs'),
        async (input) => {
          // ADR-BE-44: a scoped operator pages their own jobs, and the total is the size of the
          // filtered set — a page of rows the caller cannot see is not a page.
          const scope = requireCollectionScope(input.context);
          const visible =
            scope.kind === 'platform' ? undefined : await this.executor.instanceIdsInScope(scope);
          return {
            kind: 'body',
            body: await this.query.list(
              {
                ...(input.query.instanceId === undefined
                  ? {}
                  : { instanceId: input.query.instanceId }),
                ...(input.query.kind === undefined ? {} : { kind: input.query.kind }),
                ...(input.query.state === undefined ? {} : { state: input.query.state }),
                ...(input.query.cursor === undefined ? {} : { cursor: input.query.cursor }),
                ...(input.query.limit === undefined ? {} : { limit: input.query.limit }),
              },
              visible,
            ),
          };
        },
      ],
      [
        key('GET', '/jobs/:id'),
        async (input) => ({ kind: 'body', body: await this.detail(input.params.id) }),
      ],
      [
        key('GET', '/jobs/:id/logs'),
        async (input) => {
          const id = requireId(input.params.id);
          const lines = await this.jobs.logs(id, '0', 500);
          return {
            kind: 'body',
            body: lines.map((line) => ({
              seq: Number(line.seq),
              ts: line.ts.toISOString(),
              stream: line.stream,
              line: line.line,
            })),
          };
        },
      ],
      [
        key('POST', '/jobs/:id/cancel'),
        async (input) => {
          const id = requireId(input.params.id);
          const job = await this.jobs.cancel(id, input.context.subject.idpId);
          return { kind: 'body', body: await this.detail(job.id) };
        },
      ],
      [
        key('POST', '/jobs/:id/retry'),
        async (input) => {
          const id = requireId(input.params.id);
          const result = await this.jobs.retry(id, input.context.subject.idpId);
          return { kind: 'accepted', jobId: result.job.id };
        },
      ],
      [
        key('GET', '/jobs/:id/stream'),
        async (input) => {
          const id = requireId(input.params.id);
          // The stream hijacks the reply; the dispatcher writes nothing afterwards.
          await this.streams.open(
            input.reply as FastifyReply,
            id,
            lastEventId(input.headers),
            input.requestId,
          );
          return { kind: 'stream' };
        },
      ],
    ]);
  }

  private async detail(id: string | undefined): Promise<unknown> {
    return this.query.detail(requireId(id));
  }
}

function lastEventId(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  const value = headers['last-event-id'];
  return Array.isArray(value) ? value[0] : value;
}

function requireId(id: string | undefined): string {
  if (!isUuid(id)) throw new AppError({ code: 'NOT_FOUND', status: 404, detail: 'No such job.' });
  return id;
}

export { readIdempotencyKey };
export type { FastifyRequest };
