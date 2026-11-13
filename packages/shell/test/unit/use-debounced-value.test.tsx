import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDebouncedValue } from '../../src/use-debounced-value';

/**
 * The hook exists to keep a search box from issuing one request per keystroke, so the cases that
 * matter are the boundaries: nothing moves early, the last value wins, and the pending timer is
 * dropped when the value changes again.
 *
 * `afterEach` in `test/setup.ts` returns the real clock, so no case below has to remember it.
 */
function renderDebounced(initial: string, delayMs = 250) {
  return renderHook(({ value }: { value: string }) => useDebouncedValue(value, delayMs), {
    initialProps: { value: initial },
  });
}

describe('useDebouncedValue', () => {
  it('starts at the initial value', () => {
    vi.useFakeTimers();
    const { result } = renderDebounced('a');
    expect(result.current).toBe('a');
  });

  it('holds the previous value until the delay has fully elapsed', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderDebounced('a');

    rerender({ value: 'ab' });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('ab');
  });

  it('drops the pending update when the value changes again', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderDebounced('a');

    rerender({ value: 'ab' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ value: 'abc' });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    // `ab` never surfaced: the second change cleared the first timer.
    expect(result.current).toBe('abc');
  });

  it('honours a non-default delay', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderDebounced('a', 1_000);

    rerender({ value: 'b' });
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('b');
  });
});
