import { http, HttpResponse } from 'msw';
import { at } from '../fixtures/context';
import { appendAudit, getState } from '../store';
import { enqueueJob } from './job-factory';
import { actorFor, deny, paginate, problem, requireCapability, roleOf } from './utils';

export const jobHandlers = [
  http.get('/api/v1/jobs', ({ request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const url = new URL(request.url);
    const instanceId = url.searchParams.get('instanceId');
    const kind = url.searchParams.get('kind');
    const state = url.searchParams.get('state');
    const items = getState()
      .jobs.filter((job) => {
        const matchesInstance = !instanceId || job.instanceId === instanceId;
        const matchesKind = !kind || job.kind === kind;
        const matchesState = !state || job.state === state;
        return matchesInstance && matchesKind && matchesState;
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return HttpResponse.json(paginate(items, request));
  }),

  http.get('/api/v1/jobs/:id', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const job = getState().jobs.find((item) => item.id === String(params.id));
    if (!job) {
      return problem(
        404,
        'JOB_NOT_FOUND',
        'Job not found',
        `No job matches ${String(params.id)}.`,
        'Open the job list and retry.',
      );
    }
    return HttpResponse.json(job);
  }),

  http.get('/api/v1/jobs/:id/logs', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const job = getState().jobs.find((item) => item.id === String(params.id));
    if (!job) {
      return problem(
        404,
        'JOB_NOT_FOUND',
        'Job not found',
        `No job matches ${String(params.id)}.`,
        'Open the job list and retry.',
      );
    }
    return HttpResponse.json(getState().jobLogs[job.id] ?? []);
  }),

  /**
   * Server-sent events: one `job` frame per tick plus every new log line. The client falls
   * back to the polling queries if the stream cannot be established.
   */
  http.get('/api/v1/jobs/:id/stream', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const jobId = String(params.id);
    if (!getState().jobs.some((item) => item.id === jobId)) {
      return problem(
        404,
        'JOB_NOT_FOUND',
        'Job not found',
        `No job matches ${jobId}.`,
        'Open the job list and retry.',
      );
    }

    const encoder = new TextEncoder();
    let sent = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: string, data: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const close = () => {
          if (closed) return;
          closed = true;
          if (timer !== null) clearInterval(timer);
          controller.close();
        };
        const tick = () => {
          const current = getState().jobs.find((item) => item.id === jobId);
          if (!current) {
            close();
            return;
          }
          emit('job', current);
          const logs = getState().jobLogs[jobId] ?? [];
          for (const line of logs.slice(sent)) emit('log', line);
          sent = logs.length;
          if (
            current.state === 'succeeded' ||
            current.state === 'failed' ||
            current.state === 'cancelled'
          )
            close();
        };
        timer = setInterval(tick, 500);
        tick();
      },
      cancel() {
        closed = true;
        if (timer !== null) clearInterval(timer);
      },
    });

    return new HttpResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }),

  http.post('/api/v1/jobs/:id/cancel', ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'job cancel');
    if (guard) return guard;
    const job = getState().jobs.find((item) => item.id === String(params.id));
    if (!job) {
      return problem(
        404,
        'JOB_NOT_FOUND',
        'Job not found',
        'The job no longer exists.',
        'Refresh the job list.',
      );
    }
    if (job.state === 'succeeded' || job.state === 'failed') {
      return problem(
        409,
        'JOB_TERMINAL',
        'Job already finished',
        `Job ${job.id} is ${job.state}.`,
        'Only queued or running jobs can be cancelled.',
      );
    }
    job.state = 'cancelled';
    job.finishedAt = at(0);
    const logs = getState().jobLogs[job.id] ?? [];
    logs.push({ seq: logs.length, ts: at(0), stream: 'system', line: 'job cancelled by operator' });
    getState().jobLogs[job.id] = logs;
    appendAudit({
      action: 'job.cancelled',
      targetType: 'job',
      targetId: job.id,
      targetLabel: job.label,
      outcome: 'success',
      detail: `Job ${job.id} (${job.kind}) cancelled by an operator.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(job);
  }),

  http.post('/api/v1/jobs/:id/retry', ({ params, request }) => {
    const role = roleOf(request);
    const guard = deny(role, ['R1'], 'job retry');
    if (guard) return guard;
    const job = getState().jobs.find((item) => item.id === String(params.id));
    if (!job) {
      return problem(
        404,
        'JOB_NOT_FOUND',
        'Job not found',
        'The job no longer exists.',
        'Refresh the job list.',
      );
    }
    const accepted = enqueueJob({
      kind: job.kind,
      instanceId: job.instanceId,
      entryKey: job.entryKey,
      label: `${job.label} (retry)`,
      requestedBy: 'Sofia Almeida',
      summary: `Retry of ${job.id}.`,
      steps: job.steps.map((step) => step.name),
    });
    appendAudit({
      action: 'job.retried',
      targetType: 'job',
      targetId: accepted.jobId,
      targetLabel: `${job.label} (retry)`,
      outcome: 'success',
      detail: `Retry of ${job.id} accepted; new job ${accepted.jobId}.`,
      actor: actorFor(role),
    });
    return HttpResponse.json(accepted, { status: 202 });
  }),
];
