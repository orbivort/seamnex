import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProblemDetail } from '@seamnex/domain';
import { UnauthorizedNotice } from '../../src/unauthorized';
import { stubLocation } from '../location';

/**
 * A `401` cannot be repaired inside the app (FR-3.2), so this component is the whole response to
 * one: say the session lapsed, then leave for the sign-in route with the interrupted location
 * preserved. The signal is the real `seamnex:unauthorized` event the HTTP pipeline dispatches — mocking
 * `onUnauthorized` would test the mock instead of the wiring.
 */
const lapsed: ProblemDetail = {
  type: 'https://platform.seamnex.local/problems/unauthorized',
  title: 'Unauthorised',
  status: 401,
  detail: 'This session is no longer valid.',
  code: 'UNAUTHORIZED',
  fieldErrors: [],
  remediation: 'Sign in again to continue.',
};

function signalUnauthorized(): void {
  act(() => {
    window.dispatchEvent(new CustomEvent('seamnex:unauthorized', { detail: lapsed }));
  });
}

describe('UnauthorizedNotice', () => {
  it('renders nothing until a session lapses', () => {
    stubLocation('/instances');
    const { container } = render(<UnauthorizedNotice />);

    expect(container.textContent).toBe('');
  });

  it('names the lapse and leaves for sign-in with this location preserved', () => {
    vi.useFakeTimers();
    stubLocation('/instances?tab=2');
    render(<UnauthorizedNotice />);

    signalUnauthorized();

    expect(screen.getByText('Your session is no longer authorised')).toBeDefined();
    expect(screen.getByText(/This session is no longer valid\. Sign in again/)).toBeDefined();
    expect(window.location.assign).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1_400);
    });

    expect(window.location.assign).toHaveBeenCalledWith(
      `/sign-in?next=${encodeURIComponent('/instances?tab=2')}`,
    );
  });

  it('leaves immediately when the notice’s own control is pressed', () => {
    stubLocation('/dashboard');
    render(<UnauthorizedNotice />);

    signalUnauthorized();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(window.location.assign).toHaveBeenCalledWith(
      `/sign-in?next=${encodeURIComponent('/dashboard')}`,
    );
  });

  it('stays put on the sign-in screen, which owns its own error region', () => {
    vi.useFakeTimers();
    stubLocation('/sign-in?next=%2Fdashboard');
    render(<UnauthorizedNotice />);

    signalUnauthorized();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(screen.getByText('Your session is no longer authorised')).toBeDefined();
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('drops the pending redirect when the notice unmounts', () => {
    vi.useFakeTimers();
    stubLocation('/dashboard');
    const { unmount } = render(<UnauthorizedNotice />);

    signalUnauthorized();
    unmount();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it('stops listening once it is gone', () => {
    stubLocation('/dashboard');
    const { unmount } = render(<UnauthorizedNotice />);
    unmount();

    expect(() => signalUnauthorized()).not.toThrow();
    expect(screen.queryByText('Your session is no longer authorised')).toBeNull();
  });
});
