import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CapacityRuler, Meter, Sparkline } from '../../../src/charts/Charts';

/**
 * Charts here are geometry, not a charting library: a sparkline draws whatever it is given and a
 * meter reports the ratio it clamped. The edge cases are the ones that turn a series into NaN or
 * a bar into a 100%-wide lie, so they are the tests.
 */
describe('Sparkline', () => {
  it('draws nothing but a placeholder for a series too short to have a shape', () => {
    const { container, rerender } = render(<Sparkline values={[]} label="Requests" />);
    const placeholder = container.firstElementChild as HTMLElement;
    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
    expect(placeholder.tagName).toBe('DIV');

    rerender(<Sparkline values={[3]} label="Requests" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('maps the series onto the viewBox and names the image', () => {
    render(<Sparkline values={[10, 2, 20]} label="Requests per minute" width={100} height={20} />);
    const svg = screen.getByRole('img', { name: 'Requests per minute' });
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 20');
    const points = svg.querySelector('polyline')?.getAttribute('points') ?? '';
    const pairs = points.split(' ');
    expect(pairs).toHaveLength(3);
    expect(pairs[0]?.startsWith('0.0,')).toBe(true);
    expect(pairs[2]?.startsWith('100.0,')).toBe(true);
  });

  it('keeps a flat series flat instead of dividing by a zero span', () => {
    render(<Sparkline values={[5, 5, 5]} label="Flat" width={60} height={20} />);
    const points =
      screen.getByRole('img', { name: 'Flat' }).querySelector('polyline')?.getAttribute('points') ??
      '';
    const ys = points.split(' ').map((pair) => pair.split(',')[1]);
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).not.toContain('NaN');
  });

  it('survives a hole in the series', () => {
    // A sparse array is the one way a caller reaches the `?? 0` default for the first sample.
    const sparse = [undefined, 4] as unknown as number[];
    render(<Sparkline values={sparse} label="Sparse" />);
    const svg = screen.getByRole('img', { name: 'Sparse' });
    // The chart still renders: a bad series is the caller's bug, not a crash.
    expect(svg.querySelector('polyline')).not.toBeNull();
  });

  it('defaults to the documented size and the accent stroke', () => {
    const { container } = render(<Sparkline values={[1, 2]} label="Requests" />);
    const svg = screen.getByRole('img', { name: 'Requests' });
    expect(svg.getAttribute('viewBox')).toBe('0 0 120 32');
    expect(svg.querySelector('polyline')?.getAttribute('stroke')).toBe('var(--color-primary)');
    expect(svg.getAttribute('class')).toContain('h-8 w-28');
    expect(container.firstElementChild).toBe(svg);
  });

  it('uses the colour token of the requested tone and keeps a caller class', () => {
    render(<Sparkline values={[1, 2]} label="Errors" tone="danger" className="extra-marker" />);
    const svg = screen.getByRole('img', { name: 'Errors' });
    expect(svg.querySelector('polyline')?.getAttribute('stroke')).toBe('var(--color-danger)');
    expect(svg.getAttribute('class')).toContain('extra-marker');

    render(<Sparkline values={[1, 2]} label="Errors" tone="muted" />);
    const muted = screen.getAllByRole('img', { name: 'Errors' })[1];
    expect(muted?.querySelector('polyline')?.getAttribute('stroke')).toBe(
      'var(--color-neutral-fill)',
    );
  });
});

describe('CapacityRuler', () => {
  it('reports the ratio as a meter and prints the absolute numbers', () => {
    render(<CapacityRuler label="Disk" used={25} total={50} unit="GB" />);
    const meter = screen.getByRole('meter', { name: 'Disk usage' });
    expect(meter.getAttribute('aria-valuenow')).toBe('50');
    expect(meter.getAttribute('aria-valuetext')).toBe('50 percent');
    expect(screen.getByText('25.0 / 50.0 GB')).toBeDefined();
    expect((meter.firstElementChild as HTMLElement).style.width).toBe('50%');
  });

  it('paints the bar by threshold', () => {
    const { rerender } = render(<CapacityRuler label="Disk" used={10} total={100} unit="GB" />);
    const fill = () => screen.getByRole('meter').firstElementChild as HTMLElement;
    expect(fill().className).toContain('bg-primary');

    rerender(<CapacityRuler label="Disk" used={80} total={100} unit="GB" />);
    expect(fill().className).toContain('bg-warning');

    rerender(<CapacityRuler label="Disk" used={95} total={100} unit="GB" />);
    expect(fill().className).toContain('bg-danger');
  });

  it('honours custom thresholds', () => {
    render(<CapacityRuler label="Disk" used={40} total={100} unit="GB" thresholds={[0.3, 0.35]} />);
    expect((screen.getByRole('meter').firstElementChild as HTMLElement).className).toContain(
      'bg-danger',
    );
  });

  it('never divides by a zero total, and never reports more than full', () => {
    const { rerender } = render(<CapacityRuler label="Disk" used={10} total={0} unit="GB" />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('0');

    rerender(<CapacityRuler label="Disk" used={500} total={100} unit="GB" />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('100');
    expect((screen.getByRole('meter').firstElementChild as HTMLElement).style.width).toBe('100%');
  });

  it('keeps a caller class', () => {
    const { container } = render(
      <CapacityRuler label="Disk" used={1} total={2} unit="GB" className="extra-marker" />,
    );
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');
  });
});

describe('Meter', () => {
  it('reports its ratio and hides the number unless asked', () => {
    const { rerender } = render(<Meter label="CPU" value={30} />);
    expect(screen.getByRole('meter', { name: 'CPU' }).getAttribute('aria-valuenow')).toBe('30');
    expect(screen.queryByText('30%')).toBeNull();

    rerender(<Meter label="CPU" value={30} showValue />);
    expect(screen.getByText('30%')).toBeDefined();
  });

  it('clamps to a full bar and survives a zero maximum', () => {
    const { rerender } = render(<Meter label="CPU" value={150} max={100} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('100');

    rerender(<Meter label="CPU" value={5} max={0} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('0');
  });

  it('uses the fill of the requested tone', () => {
    const { rerender } = render(<Meter label="CPU" value={10} tone="danger" />);
    const fill = () => screen.getByRole('meter').firstElementChild as HTMLElement;
    expect(fill().className).toContain('bg-danger');

    rerender(<Meter label="CPU" value={10} tone="caution" />);
    expect(fill().className).toContain('bg-warning');

    rerender(<Meter label="CPU" value={10} tone="positive" />);
    expect(fill().className).toContain('bg-success');

    rerender(<Meter label="CPU" value={10} />);
    expect(fill().className).toContain('bg-primary');
  });

  it('keeps a caller class', () => {
    const { container } = render(<Meter label="CPU" value={10} className="extra-marker" />);
    expect((container.firstElementChild as HTMLElement).className).toContain('extra-marker');
  });
});
