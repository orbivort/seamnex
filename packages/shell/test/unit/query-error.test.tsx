import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@seamnex/api-client';
import type { ProblemDetail } from '@seamnex/domain';
import { QueryError } from '../../src/query-error';

/**
 * `QueryError` is the one place a query or mutation failure becomes a panel, so the cases that
 * matter are the three inputs it forwards differently: an `ApiError` (rendered verbatim), anything
 * else (`toProblem` synthesises a network problem), and the two optional props whose *absence* is
 * itself a branch — no retry, and the default density.
 */
const forbidden: ProblemDetail = {
  type: 'https://platform.seamnex.local/problems/forbidden',
  title: 'You cannot read this',
  status: 403,
  detail: 'The role you hold has no read scope for this resource.',
  code: 'FORBIDDEN',
  fieldErrors: [],
  remediation: 'Ask the platform owner for access.',
};

describe('QueryError', () => {
  it('renders the problem carried by an ApiError', () => {
    render(<QueryError error={new ApiError(forbidden)} />);

    expect(screen.getByText('You cannot read this')).toBeDefined();
    expect(screen.getByText(/no read scope/)).toBeDefined();
    expect(screen.getByText(/FORBIDDEN · HTTP 403/)).toBeDefined();
  });

  it('synthesises a problem for a thrown transport failure', () => {
    render(<QueryError error={new Error('socket closed')} />);

    expect(screen.getByText('The platform API could not be reached')).toBeDefined();
    expect(screen.getByText('socket closed')).toBeDefined();
    expect(screen.getByText(/NETWORK_ERROR · HTTP 503/)).toBeDefined();
  });

  it('synthesises a problem for a value that is not an error at all', () => {
    render(<QueryError error="something odd" />);

    expect(screen.getByText('The platform API could not be reached')).toBeDefined();
    expect(screen.getByText('something odd')).toBeDefined();
  });

  it('renders no retry control unless a handler is supplied', () => {
    render(<QueryError error={new ApiError(forbidden)} />);

    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('hands the retry click to the supplied handler', () => {
    const onRetry = vi.fn();
    render(<QueryError error={new ApiError(forbidden)} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders at the requested density', () => {
    const { container: compact } = render(<QueryError error={new ApiError(forbidden)} compact />);
    expect((compact.firstElementChild as HTMLElement).className).toContain('py-4');

    const { container: roomy } = render(
      <QueryError error={new ApiError(forbidden)} compact={false} />,
    );
    expect((roomy.firstElementChild as HTMLElement).className).toContain('py-6');
  });
});
