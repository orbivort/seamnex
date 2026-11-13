import { HttpResponse } from 'msw';

/**
 * A problem+json response, matching what the API sends.
 *
 * The content type is the point: the request pipeline only parses a failure as a `ProblemDetail`
 * when the response is `application/problem+json`, so a plain `HttpResponse.json` would be
 * normalised into `UNEXPECTED_RESPONSE` and assert the wrong sentence.
 */
export function problemResponse(
  status: number,
  code: string,
  title: string,
  detail: string,
  remediation = 'Retry the action. If it persists, report the endpoint and the response status.',
): Response {
  return HttpResponse.json(
    {
      type: `https://platform.seamnex.local/problems/${code.toLowerCase()}`,
      title,
      status,
      detail,
      code,
      fieldErrors: [],
      remediation,
    },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  ) as unknown as Response;
}
