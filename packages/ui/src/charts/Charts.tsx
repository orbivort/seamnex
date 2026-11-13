import { cn } from '@seamnex/utils';

const STROKE = {
  accent: 'var(--color-primary)',
  positive: 'var(--color-success)',
  caution: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  muted: 'var(--color-neutral-fill)',
};

export function Sparkline({
  values,
  tone = 'accent',
  label,
  width = 120,
  height = 32,
  className,
}: {
  values: number[];
  tone?: keyof typeof STROKE;
  label: string;
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) {
    return <div className={cn('h-8 w-28 rounded-xs bg-paper-deep', className)} aria-hidden />;
  }
  // A loop, not `Math.min(...values)`: spreading an unbounded series can exhaust the argument
  // limit, and it allocates an argument list per render.
  let min = values[0] ?? 0;
  let max = values[0] ?? 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('h-8 w-28 overflow-visible', className)}
      preserveAspectRatio="none"
    >
      <polyline
        points={points}
        fill="none"
        stroke={STROKE[tone]}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function CapacityRuler({
  label,
  used,
  total,
  unit,
  thresholds = [0.75, 0.9],
  className,
}: {
  label: string;
  used: number;
  total: number;
  unit: string;
  thresholds?: [number, number];
  className?: string;
}) {
  const ratio = total <= 0 ? 0 : Math.min(used / total, 1);
  const tone =
    ratio >= thresholds[1] ? 'bg-danger' : ratio >= thresholds[0] ? 'bg-warning' : 'bg-primary';
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted label-caps-sans">{label}</span>
        <span className="font-mono text-micro text-muted">
          {used.toFixed(1)} / {total.toFixed(1)} {unit}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${label} usage`}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${Math.round(ratio * 100)} percent`}
        className="relative h-2 w-full overflow-hidden rounded-xs border border-line bg-paper-deep"
      >
        <div
          className={cn('h-full transition-[width] duration-500', tone)}
          style={{ width: `${ratio * 100}%` }}
        />
        <span aria-hidden className="absolute inset-y-0 left-3/4 w-px bg-panel/70" />
        <span aria-hidden className="absolute inset-y-0 left-9/10 w-px bg-panel/70" />
      </div>
    </div>
  );
}

export function Meter({
  label,
  value,
  max = 100,
  tone = 'accent',
  showValue,
  className,
}: {
  label: string;
  value: number;
  max?: number;
  tone?: 'accent' | 'positive' | 'caution' | 'danger';
  showValue?: boolean;
  className?: string;
}) {
  const ratio = max <= 0 ? 0 : Math.min(value / max, 1);
  const bar =
    tone === 'danger'
      ? 'bg-danger'
      : tone === 'caution'
        ? 'bg-warning'
        : tone === 'positive'
          ? 'bg-success'
          : 'bg-primary';
  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-baseline justify-between text-micro text-muted">
        <span>{label}</span>
        {showValue ? <span className="font-mono">{Math.round(ratio * 100)}%</span> : null}
      </div>
      {/* Same contract as `CapacityRuler`: a bar that reports a value must report it to AT too. */}
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${Math.round(ratio * 100)} percent`}
        className="h-1 w-full overflow-hidden rounded-full bg-paper-deep"
      >
        <div className={cn('h-full', bar)} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
