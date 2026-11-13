import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProblemDetail } from '@seamnex/domain';
import {
  Alert,
  EmptyState,
  ErrorState,
  InlineNote,
  ProgressBar,
  Skeleton,
  SkeletonLines,
  Spinner,
  StaleNotice,
} from '../../../src/primitives/Feedback';
import { toneBox } from '../../../src/primitives/tone';

const problem: ProblemDetail = {
  type: 'about:blank',
  title: 'Instance not found',
  status: 404,
  detail: 'No instance matches inst-crm.',
  code: 'INSTANCE_NOT_FOUND',
  fieldErrors: [],
  remediation: 'Pick another instance from the catalog.',
};

/**
 * Feedback primitives carry the loudest announcements in the product. Two things are pinned
 * here: the live-region role a tone earns (`alert` for danger, `status` for everything else),
 * and that a numeric bar reports the number it clamped, not the one it was given.
 */
describe('Alert', () => {
  it('is an alert region for danger, with the danger icon', () => {
    const { container } = render(<Alert tone="danger" title="Rollback failed" />);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain(toneBox('danger'));
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('is a polite status for caution, and keeps its icon', () => {
    const { container } = render(<Alert tone="caution" title="Degraded" />);
    expect(screen.getByRole('status')).toBeDefined();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders no icon for the tones that do not have one', () => {
    const { container } = render(<Alert tone="info" title="Scheduled maintenance" />);
    expect(screen.getByRole('status')).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders the body and the action when supplied', () => {
    render(
      <Alert
        tone="positive"
        title="Patched"
        className="extra-marker"
        action={<button type="button">Undo</button>}
      >
        The patch is live in eu-west-1.
      </Alert>,
    );
    expect(screen.getByText('The patch is live in eu-west-1.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDefined();
    expect(screen.getByRole('status').className).toContain('extra-marker');
  });

  it('omits the body and the action slot when there is nothing to show', () => {
    const { container } = render(<Alert tone="info" title="Scheduled maintenance" />);
    expect(container.querySelectorAll('div')).toHaveLength(2);
  });
});

describe('EmptyState', () => {
  it('uses the default icon and the roomy padding', () => {
    const { container } = render(<EmptyState title="No instances" description="Deploy one." />);
    expect(screen.getByText('No instances').tagName).toBe('P');
    expect(screen.getByText('Deploy one.').className).toContain('text-muted');
    expect(container.firstElementChild?.className).toContain('py-14');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('takes a caller icon, an action and the compact padding', () => {
    const { container } = render(
      <EmptyState
        title="No instances"
        description="Deploy one."
        compact
        icon={<span data-testid="custom-icon" />}
        action={<button type="button">Deploy</button>}
      />,
    );
    expect(screen.getByTestId('custom-icon')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeDefined();
    expect(container.firstElementChild?.className).toContain('py-8');
  });

  it('omits the action slot when there is no action', () => {
    const { container } = render(<EmptyState title="No instances" description="Deploy one." />);
    expect(container.querySelectorAll('div')).toHaveLength(1);
  });
});

describe('Skeleton', () => {
  it('hides the placeholder from assistive tech', () => {
    const { container } = render(<Skeleton className="extra-marker h-4" />);
    const node = container.firstElementChild as HTMLElement;
    expect(node.getAttribute('aria-hidden')).toBe('true');
    expect(node.className).toContain('h-4');
  });
});

describe('SkeletonLines', () => {
  it('draws three lines by default, the last one shortened', () => {
    const { container } = render(<SkeletonLines className="extra-marker" />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('aria-busy')).toBe('true');
    expect(wrapper.getAttribute('aria-live')).toBe('polite');
    expect(wrapper.className).toContain('extra-marker');
    const lines = wrapper.querySelectorAll('div');
    expect(lines).toHaveLength(3);
    expect(lines[2]?.className).toContain('w-2/3');
    expect(lines[0]?.className).toContain('w-full');
  });

  it('honours an explicit line count', () => {
    const { container } = render(<SkeletonLines lines={1} />);
    const lines = (container.firstElementChild as HTMLElement).querySelectorAll('div');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.className).toContain('w-2/3');
  });
});

describe('Spinner', () => {
  it('announces itself with the default label', () => {
    render(<Spinner />);
    expect(screen.getByRole('status').textContent).toBe('Loading');
  });

  it('takes a caller label', () => {
    render(<Spinner label="Minting ticket…" />);
    expect(screen.getByRole('status').textContent).toBe('Minting ticket…');
  });
});

describe('ProgressBar', () => {
  it('reports the clamped value, not the one it was given', () => {
    const { rerender } = render(<ProgressBar value={140} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');

    rerender(<ProgressBar value={-20} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it('prints the label and the rounded percentage when asked', () => {
    render(<ProgressBar value={62.4} label="Rollout" showValue tone="positive" />);
    expect(screen.getByText('Rollout')).toBeDefined();
    expect(screen.getByText('62%')).toBeDefined();
    expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe('Rollout');
    const fill = screen.getByRole('progressbar').firstElementChild as HTMLElement;
    expect(fill.className).toContain('bg-success');
    expect(fill.style.width).toBe('62.4%');
  });

  it('falls back to a named, unlabelled bar with the accent fill', () => {
    const { container } = render(<ProgressBar value={50} className="extra-marker" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe('Progress');
    expect(screen.queryByText('50%')).toBeNull();
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');
    expect((screen.getByRole('progressbar').firstElementChild as HTMLElement).className).toContain(
      'bg-primary',
    );
  });

  it('shows the value without a label', () => {
    render(<ProgressBar value={12} showValue />);
    expect(screen.getByText('12%')).toBeDefined();
  });

  it('shows the label without the value', () => {
    render(<ProgressBar value={12} label="Rollout" />);
    expect(screen.getByText('Rollout')).toBeDefined();
    expect(screen.queryByText('12%')).toBeNull();
  });
});

describe('ErrorState', () => {
  it('renders the problem and its remediation', () => {
    render(<ErrorState problem={problem} />);
    expect(screen.getByText('Instance not found')).toBeDefined();
    expect(screen.getByText('No instance matches inst-crm.')).toBeDefined();
    expect(screen.getByText('Pick another instance from the catalog.')).toBeDefined();
    expect(screen.getByText('INSTANCE_NOT_FOUND · HTTP 404')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });

  it('offers a retry only when the caller can retry', () => {
    const onRetry = vi.fn();
    render(<ErrorState problem={problem} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('names every refused field, with a fallback for a body-level error', () => {
    render(
      <ErrorState
        problem={{
          ...problem,
          status: 422,
          fieldErrors: [
            { field: 'hostname', code: 'required', message: 'Hostname is required.' },
            { field: '', code: 'refused', message: 'The request was refused.' },
          ],
        }}
        compact
      />,
    );
    expect(screen.getByText('hostname')).toBeDefined();
    expect(screen.getByText('body')).toBeDefined();
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe('hostname — Hostname is required.');
    expect(items[1]?.textContent).toContain('The request was refused.');
  });

  it('omits the field list when the problem has none, and uses the compact padding', () => {
    const { container } = render(<ErrorState problem={problem} compact />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(container.firstElementChild?.className).toContain('py-4');
  });

  it('uses the roomy padding by default', () => {
    const { container } = render(<ErrorState problem={problem} />);
    expect(container.firstElementChild?.className).toContain('py-6');
  });
});

describe('InlineNote', () => {
  it('is a quiet paragraph that takes a caller class', () => {
    render(<InlineNote className="extra-marker">Read-only view.</InlineNote>);
    const note = screen.getByText('Read-only view.');
    expect(note.tagName).toBe('P');
    expect(note.className).toContain('extra-marker');
  });
});

describe('StaleNotice', () => {
  it('names the last successful response when there is one', () => {
    render(<StaleNotice lastKnownAt={new Date(Date.now() - 120_000).toISOString()} />);
    const notice = screen.getByRole('status');
    expect(notice.className).toContain(toneBox('caution'));
    expect(notice.textContent).toContain('Showing the last known status from');
  });

  it('says nothing has been recorded when nothing has', () => {
    render(<StaleNotice lastKnownAt={null} className="extra-marker" />);
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('No successful response has been recorded');
    expect(notice.className).toContain('extra-marker');
  });
});
