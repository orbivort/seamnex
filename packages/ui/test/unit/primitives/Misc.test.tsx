import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Avatar, CopyButton, Mono, Pagination } from '../../../src/primitives/Misc';

/**
 * Small utilities with the only imperative code in the library: the clipboard write, its
 * self-clearing confirmation, and the paging arithmetic that must not report "1–0 of 0".
 */
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

describe('Avatar', () => {
  it('is a decorative medium ink chip by default', () => {
    render(<Avatar initials="OP" />);
    const avatar = screen.getByText('OP');
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
    expect(avatar.className).toContain('size-8');
    expect(avatar.className).toContain('bg-ink');
  });

  it('steps through the size scale', () => {
    const { rerender } = render(<Avatar initials="OP" size="sm" />);
    expect(screen.getByText('OP').className).toContain('size-6');
    rerender(<Avatar initials="OP" size="lg" />);
    expect(screen.getByText('OP').className).toContain('size-10');
  });

  it('steps through the tone scale, including a caller class', () => {
    const { rerender } = render(<Avatar initials="OP" tone="teal" />);
    expect(screen.getByText('OP').className).toContain('bg-primary');
    rerender(<Avatar initials="OP" tone="paper" className="extra-marker" />);
    expect(screen.getByText('OP').className).toContain('bg-paper-deep');
    expect(screen.getByText('OP').className).toContain('extra-marker');
  });
});

describe('Mono', () => {
  it('is a quiet mono span that takes a caller class', () => {
    render(<Mono className="extra-marker">sha256:abc</Mono>);
    const span = screen.getByText('sha256:abc');
    expect(span.tagName).toBe('SPAN');
    expect(span.className).toContain('font-mono');
    expect(span.className).toContain('extra-marker');
  });
});

describe('CopyButton', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies the value and confirms it', async () => {
    render(<CopyButton value="inst-crm" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined();
    expect(writeText).toHaveBeenCalledWith('inst-crm');
  });

  it('takes a caller label', async () => {
    render(<CopyButton value="inst-crm" label="Copy instance id" />);
    const button = screen.getByRole('button', { name: 'Copy instance id' });
    expect(button.getAttribute('title')).toBe('Copy instance id');

    fireEvent.click(button);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined();
  });

  it('clears its own confirmation after a moment', async () => {
    vi.useFakeTimers();
    render(<CopyButton value="inst-crm" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined();
  });

  it('does not let an earlier copy clear a later confirmation', async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(window, 'clearTimeout');
    render(<CopyButton value="inst-crm" />);
    const button = screen.getByRole('button', { name: 'Copy' });

    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    // Still confirming: the second copy restarted the window.
    expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined();
    expect(clear).toHaveBeenCalled();
  });

  it('clears a pending timer on unmount', async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(window, 'clearTimeout');
    const { unmount } = render(<CopyButton value="inst-crm" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await act(async () => {
      await Promise.resolve();
    });
    clear.mockClear();
    unmount();

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('reports a refused clipboard instead of claiming success', async () => {
    const error = new Error('denied');
    writeText.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<CopyButton value="inst-crm" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(consoleError).toHaveBeenCalledWith('Clipboard unavailable', error);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined();
    consoleError.mockRestore();
  });

  it('does not schedule a confirmation it never showed', async () => {
    vi.useFakeTimers();
    const set = vi.spyOn(window, 'setTimeout');
    const { unmount } = render(<CopyButton value="inst-crm" />);
    unmount();

    // The cleanup runs with nothing pending, which must not throw.
    expect(set).not.toHaveBeenCalled();
  });
});

describe('Pagination', () => {
  it('reports an empty range without an off-by-one', () => {
    render(<Pagination page={0} pageSize={25} total={0} />);
    expect(screen.getByText('0–0 of 0')).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('counts from one and clamps the end to the total', () => {
    render(<Pagination page={1} pageSize={25} total={30} />);
    expect(screen.getByText('26–30 of 30')).toBeDefined();
  });

  it('disables previous on the first page even with a handler', () => {
    const onPrev = vi.fn();
    render(<Pagination page={0} pageSize={10} total={30} onPrev={onPrev} />);
    const previous = screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);
    fireEvent.click(previous);
    expect(onPrev).not.toHaveBeenCalled();
  });

  it('pages forward and back in the middle of a list', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(<Pagination page={1} pageSize={10} total={30} onPrev={onPrev} onNext={onNext} />);

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('disables next on the last page', () => {
    render(<Pagination page={2} pageSize={10} total={30} onNext={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Next page' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
