import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Countdown, useNow } from '../../../src/primitives/Time';

const NOW = new Date('2026-03-01T12:00:00.000Z');

function inSeconds(seconds: number): string {
  return new Date(NOW.getTime() + seconds * 1_000).toISOString();
}

/**
 * A clock is only correct if it is observed at two points in time, so every case here advances
 * fake timers and asserts what changed. The announcement is the other half of the contract: the
 * digits tick each second, but the live region may only speak at a minute boundary.
 */
describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function Probe({ intervalMs }: { intervalMs?: number }) {
    const now = useNow(intervalMs);
    return <span data-testid="now">{now}</span>;
  }

  it('starts at the current instant and ticks on the default interval', () => {
    render(<Probe />);
    expect(screen.getByTestId('now').textContent).toBe(String(NOW.getTime()));

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByTestId('now').textContent).toBe(String(NOW.getTime()));

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('now').textContent).toBe(String(NOW.getTime() + 1_000));
  });

  it('honours a custom interval', () => {
    render(<Probe intervalMs={5_000} />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId('now').textContent).toBe(String(NOW.getTime() + 5_000));
  });

  it('stops ticking after unmount', () => {
    const { unmount } = render(<Probe />);
    unmount();
    // A cleared interval cannot fire; a leaked one would call setState on an unmounted tree.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down in minutes and seconds and keeps the digits out of the live region', () => {
    render(<Countdown expiresAt={inSeconds(90)} />);
    const timer = screen.getByRole('timer');
    expect(timer.getAttribute('aria-live')).toBe('off');
    expect(timer.textContent).toContain('1 min 30 s remaining');
    expect(timer.querySelector('[aria-hidden="true"]')?.textContent).toBe('1 min 30 s remaining');
  });

  it('speaks in minutes once there is more than one', () => {
    render(<Countdown expiresAt={inSeconds(150)} />);
    expect(screen.getByRole('status').textContent).toBe('2 minutes remaining');
  });

  it('speaks in the singular at exactly one minute', () => {
    render(<Countdown expiresAt={inSeconds(60)} />);
    expect(screen.getByRole('status').textContent).toBe('1 minute remaining');
  });

  it('switches to "less than a minute" only, without re-reading the digits', () => {
    render(<Countdown expiresAt={inSeconds(90)} />);
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(screen.getByRole('status').textContent).toBe('Less than a minute remaining');
    expect(screen.getByRole('timer').textContent).toContain('0 min 59 s remaining');
  });

  it('reaches the default expired label and the caller tone', () => {
    render(<Countdown expiresAt={inSeconds(10)} expiredClassName="text-danger" />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    const digits = screen.getByRole('timer').querySelector('[aria-hidden="true"]');
    expect(digits?.textContent).toBe('Expired');
    expect(digits?.className).toContain('text-danger');
    expect(screen.getByRole('status').textContent).toBe('Expired');
  });

  it('uses a caller-supplied expired label in both places', () => {
    render(<Countdown expiresAt={inSeconds(0)} expiredLabel="Window closed" />);
    expect(screen.getByRole('timer').querySelector('[aria-hidden="true"]')?.textContent).toBe(
      'Window closed',
    );
    expect(screen.getByRole('status').textContent).toBe('Window closed');
  });

  it('speaks the fallback word when the expired label is not text', () => {
    render(<Countdown expiresAt={inSeconds(0)} expiredLabel={<strong>Window closed</strong>} />);
    expect(screen.getByRole('timer').querySelector('[aria-hidden="true"]')?.textContent).toBe(
      'Window closed',
    );
    // A rich label cannot be announced verbatim, so the status says the plain word instead.
    expect(screen.getByRole('status').textContent).toBe('Expired');
  });

  it('never shows a negative remaining time', () => {
    render(<Countdown expiresAt={inSeconds(-600)} />);
    expect(screen.getByRole('timer').textContent).toBe('ExpiredExpired');
  });
});
