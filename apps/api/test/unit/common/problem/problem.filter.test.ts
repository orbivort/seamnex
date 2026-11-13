import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ProblemDetailSchema } from '@seamnex/domain';
import { z } from 'zod';
import { AppError } from '../../../../src/common/problem/app-error';
import { ProblemFilter } from '../../../../src/common/problem/problem.filter';

/**
 * The error path is the one code path that cannot fail. These tests exist because the two most
 * damaging Phase 1 defects lived here and the integration suite asserted only `code`, never
 * `status`: a 409 answered 400, and an uncatalogued code threw inside the filter.
 */

type Captured = {
  status: number | undefined;
  headers: Record<string, string>;
  body: unknown;
};

function render(exception: unknown): Captured {
  const captured: Captured = { status: undefined, headers: {}, body: undefined };

  const reply = {
    status(code: number) {
      captured.status = code;
      return reply;
    },
    header(name: string, value: string) {
      captured.headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      captured.body = body;
      return reply;
    },
  };

  const request = { url: '/api/v1/jobs/1/stream', headers: {}, requestId: 'rid-test' };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }),
  } as unknown as ArgumentsHost;

  new ProblemFilter().catch(exception, host);
  return captured;
}

describe('problem filter', () => {
  it('answers with the status the caller declared, not the catalogue default', () => {
    const { status, body } = render(
      new AppError({
        code: 'STATE_CONFLICT',
        status: 409,
        detail: 'A job in state queued cannot become cancelled.',
      }),
    );

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'STATE_CONFLICT', status: 409 });
  });

  it('falls back to the catalogue status when the caller omits one', () => {
    // `AUDIT_UNAVAILABLE` is a 503 in the catalogue; a caller must not silently downgrade it to 500.
    const { status } = render(new AppError({ code: 'AUDIT_UNAVAILABLE', detail: 'no audit row' }));
    expect(status).toBe(503);
  });

  it('degrades an uncatalogued code to a generic 500 instead of throwing in the filter', () => {
    const { status, body } = render(
      new AppError({ code: 'NOT_A_REAL_CODE', detail: 'internal detail that must not leak' }),
    );

    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('internal detail that must not leak');
  });

  it('never echoes a 5xx HttpException message to the client', () => {
    const { status, body } = render(
      new InternalServerErrorException('pg://seamnex:pw@db:5432/seamnex'),
    );

    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('pg://');
  });

  it('keeps a 4xx HttpException message and its status', () => {
    expect(render(new ConflictException('already applied')).status).toBe(409);
    expect(render(new ConflictException('already applied')).body).toMatchObject({
      code: 'STATE_CONFLICT',
    });
    expect(render(new BadRequestException('bad body')).status).toBe(400);
  });

  it('answers a 429 with the rate-limit code, not the job-stream ceiling', () => {
    // Both are 429 in RFC terms, but `STREAM_LIMIT` tells the caller to poll `GET /jobs/{id}`
    // instead of waiting for the interval in `Retry-After` — the wrong remediation for a throttle.
    const { status, body } = render(new HttpException('Too many attempts', 429));

    expect(status).toBe(429);
    expect(body).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
  });

  it('maps a ZodError to field errors', () => {
    const parsed = z.object({ slug: z.string().min(3) }).safeParse({ slug: 'x' });
    const { status, body } = render(parsed.success ? new Error('unreachable') : parsed.error);

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((body as { fieldErrors: unknown[] }).fieldErrors).toHaveLength(1);
  });

  it('answers an unknown throwable with a generic 500 and no stack', () => {
    const { status, body } = render(new TypeError('Cannot read properties of undefined'));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('Cannot read');
  });

  it('logs a 5xx, including a thrown non-Error, without leaking it to the client', () => {
    const captured = render({ statusCode: 500, message: 'internal detail' });
    expect(captured.status).toBe(500);
    expect(JSON.stringify(captured.body)).not.toContain('internal detail');
  });

  it('echoes the deliberate detail of a catalogued 5xx AppError', () => {
    const captured = render(new AppError({ code: 'AUDIT_UNAVAILABLE', detail: 'token=abc' }));
    expect(captured.status).toBe(503);
    expect(captured.body).toMatchObject({ detail: 'token=abc' });
  });

  it('echoes headers the error carries, such as retry-after', () => {
    const captured = render(
      new AppError({
        code: 'RATE_LIMITED',
        detail: 'slow down',
        headers: { 'retry-after': '30' },
      }),
    );
    expect(captured.status).toBe(429);
    expect(captured.headers['retry-after']).toBe('30');
  });

  it('always renders a contract-valid document and echoes the request id', () => {
    const cases: unknown[] = [
      new AppError({ code: 'NOT_FOUND', detail: 'No such job.' }),
      new ConflictException('conflict'),
      new InternalServerErrorException('boom'),
      new Error('boom'),
      { statusCode: 413, message: 'Request body is too large' },
    ];

    for (const exception of cases) {
      const captured = render(exception);
      const parsed = ProblemDetailSchema.safeParse(captured.body);
      expect(parsed.success, JSON.stringify(captured.body)).toBe(true);
      expect(captured.headers['x-request-id']).toBe('rid-test');
      expect(captured.headers['content-type']).toContain('application/problem+json');
      expect(captured.status).toBe((captured.body as { status: number }).status);
    }
  });
});
